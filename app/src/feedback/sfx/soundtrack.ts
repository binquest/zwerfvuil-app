// The soundtrack of a reveal: every sound of its timeline mixed into one WAV
// file (mix.ts), played by one player. One AVPlayer start per reveal instead of
// two dozen keeps the main thread free (measured on the phone: stalls of up to
// 150 ms with separate players, under 10 ms without them), and the rhythm sits
// in the file instead of depending on JS timers.
//
// The visuals and haptics follow the soundtrack through an audio clock
// (clock.ts): anchored once when playback has really started, corrected now
// and then.
import { Asset } from 'expo-asset';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';

import type { Event } from '../reveal/timeline';
import { createAudioClock, waitForStart, type AudioClock, type StartResult } from './clock';
import { ensureAudioMode, initSfx } from './engine';
import { mixKey, mixTimeline } from './mix';
import { SFX_IDS, SFX_SOURCES, type SfxId } from './sources';
import { decodeWav, encodeWav, SAMPLE_RATE } from './wav';

/** How long a mixed file may take to load in its player. */
export const LOAD_TIMEOUT_MS = 1000;
/** How long play() may take to really start. */
export const START_TIMEOUT_MS = 500;
/** At most this many mixed files stay in the cache (about 0.3 MB per second of sound). */
const MAX_CACHED_FILES = 12;
const FILE_PREFIX = 'reveal-';

const now = () => performance.now();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Samples = Partial<Record<SfxId, Float32Array>>;

let samplesPromise: Promise<Samples> | null = null;
let samplesLoadMs: number | null = null;

/** Reads and decodes every source sound, once. */
export function loadSamples(): Promise<Samples> {
  samplesPromise ??= (async () => {
    const started = now();
    const entries = await Promise.all(
      SFX_IDS.map(async (id) => {
        const asset = Asset.fromModule(SFX_SOURCES[id]);
        if (!asset.localUri) await asset.downloadAsync();
        const bytes = await new File(asset.localUri ?? asset.uri).bytes();
        return [id, decodeWav(bytes)] as const;
      }),
    );
    samplesLoadMs = now() - started;
    return Object.fromEntries(entries) as Samples;
  })().catch((error) => {
    samplesPromise = null;
    throw error;
  });
  return samplesPromise;
}

/** How long loading the source sounds took (the first time); null until done. */
export function sampleLoadMs(): number | null {
  return samplesLoadMs;
}

/** Everything a reveal needs, started early (camera, Dev mode screen). True when ready. */
export function warmUpSounds(): Promise<boolean> {
  return Promise.all([initSfx(), loadSamples().then(() => true, () => false)]).then(([voices, samples]) => voices && samples);
}

export interface PreparedSoundtrack {
  uri: string;
  durationMs: number;
  /** Mixing, encoding and writing; 0 when the file was already there. */
  mixMs: number;
  cached: boolean;
}

function pruneCache(): void {
  try {
    const files = Paths.cache
      .list()
      .filter((entry): entry is File => entry instanceof File && entry.name.startsWith(FILE_PREFIX))
      .map((file) => ({ file, time: file.info().modificationTime ?? 0 }))
      .sort((a, b) => b.time - a.time);
    for (const { file } of files.slice(MAX_CACHED_FILES)) file.delete();
  } catch {
    // The cache is the system's to clean as well.
  }
}

/** Mixes the sound events of `events` into a file (or reuses the file of an identical timeline). */
export async function prepareSoundtrack(events: readonly Event[]): Promise<PreparedSoundtrack> {
  const file = new File(Paths.cache, `${FILE_PREFIX}${mixKey(events)}.wav`);
  if (file.exists) {
    const bytes = file.size ?? 44;
    return { uri: file.uri, durationMs: ((bytes - 44) / 2 / SAMPLE_RATE) * 1000, mixMs: 0, cached: true };
  }
  const samples = await loadSamples();
  const started = now();
  const mixed = mixTimeline(events, samples);
  file.create({ overwrite: true });
  file.write(encodeWav(mixed));
  const mixMs = now() - started;
  pruneCache();
  return { uri: file.uri, durationMs: (mixed.length / SAMPLE_RATE) * 1000, mixMs, cached: false };
}

/** One soundtrack player, kept and given a new file per reveal (no new native player each time). */
export class Soundtrack {
  private player: AudioPlayer | null = null;
  private uri: string | null = null;
  private fade: ReturnType<typeof setInterval> | null = null;

  /**
   * Loads `uri` and puts it at the start; resolves with how long that took,
   * rejects after LOAD_TIMEOUT_MS. The file already in the player (loaded
   * ahead, like the +5 during the question) is only rewound.
   */
  async load(uri: string): Promise<number> {
    await ensureAudioMode();
    const started = now();
    this.stopFade();
    const reuse = this.player !== null && this.uri === uri;
    if (!this.player) this.player = createAudioPlayer({ uri }, { keepAudioSessionActive: true, updateInterval: 1000 });
    else if (!reuse) this.player.replace({ uri });
    this.uri = uri;
    const player = this.player;
    while (!player.isLoaded) {
      if (now() - started > LOAD_TIMEOUT_MS) {
        this.uri = null;
        throw new Error('soundtrack did not load');
      }
      await sleep(10);
    }
    if (reuse) {
      player.pause();
      await player.seekTo(0, 0, 0);
    }
    return now() - started;
  }

  /** Where playback is, in ms; null without a player. A native call: not every frame. */
  positionMs(): number | null {
    try {
      return this.player ? this.player.currentTime * 1000 : null;
    } catch {
      return null;
    }
  }

  /** Plays from the start and resolves once it really plays, with the clock anchored on that moment. */
  async start(): Promise<{ clock: AudioClock; start: StartResult }> {
    const player = this.player;
    if (!player) throw new Error('no soundtrack loaded');
    this.stopFade();
    player.volume = 1;
    const playedAt = now();
    player.play();
    const start = await waitForStart(() => this.positionMs(), playedAt, START_TIMEOUT_MS);
    return { clock: createAudioClock(start.anchor, () => this.positionMs()), start };
  }

  /** Fades out and stops (a skip, or leaving the screen). */
  stop(fadeMs = 30): void {
    const player = this.player;
    if (!player) return;
    this.stopFade();
    const steps = Math.max(1, Math.round(fadeMs / 10));
    let step = 0;
    const finish = () => {
      try {
        player.pause();
        player.seekTo(0, 0, 0).catch(() => {});
        player.volume = 1;
      } catch {
        // Gone meanwhile.
      }
    };
    if (fadeMs <= 0) {
      finish();
      return;
    }
    this.fade = setInterval(() => {
      step++;
      try {
        player.volume = 1 - step / steps;
      } catch {
        // Gone meanwhile.
      }
      if (step >= steps) {
        this.stopFade();
        finish();
      }
    }, fadeMs / steps);
  }

  private stopFade(): void {
    if (this.fade) clearInterval(this.fade);
    this.fade = null;
  }
}

/** The reveal and the +5 each have their own player: the +5 is loaded while the reveal's chord still rings. */
export const revealSoundtrack = new Soundtrack();
export const bonusSoundtrack = new Soundtrack();
