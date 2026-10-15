// One-shot sounds outside the mixed soundtrack (soundtrack.ts): the chord of a
// skip and the tock of a skipped bonus question. A small module-level set of
// preloaded, primed players ("voices"), triggered without awaiting anything.
//
// Why it looks like this (expo-audio 57 on iOS):
// - Every player keeps the audio session active. By default expo-audio turns the
//   session off 100 ms after the last sound ends or pauses, and every play()
//   turns it on again, which cuts off or delays the start of the next sound.
// - play() never waits for a seek. A voice is rewound right after it finishes
//   (pause + exact seekTo(0, 0, 0)), so the next trigger is a plain play().
//   seekTo without tolerances lets AVPlayer land anywhere near 0.
// - A sound can have more than one voice: a voice still ringing is not cut off
//   by the next trigger; only when all are busy is the oldest one restarted.
// - initSfx() plays each voice once at volume 0, so the first real sound does
//   not pay for starting the decoder and the hardware.
// - The voices are created once and kept. Every AVPlayer start costs main-thread
//   time (measured on the phone: up to 150 ms stalls with two dozen of them per
//   reveal), and expo-audio's remove() only unregisters a player: the native
//   player lives on until the JS object is garbage collected.
//
// The audio mode follows the ring/silent switch (playsInSilentMode: false) and
// mixes with the user's music.
import { createAudioPlayer, setAudioModeAsync, setIsAudioActiveAsync, type AudioPlayer, type AudioStatus } from 'expo-audio';

import { AUDIO_LEAD_MS } from '../reveal/tuning';
import { ONE_SHOT_VOICES, SFX_SOURCES, type SfxId } from './sources';

export { AUDIO_LEAD_MS };
export type { SfxId };

/** How long initSfx waits for every file to load. */
export const READY_TIMEOUT_MS = 800;
/** Priming plays every voice silently this long: enough to start the decoder and the hardware. */
const PRIME_PLAY_MS = 40;
/** The seeks after priming give up after this long. */
const PRIME_SEEK_TIMEOUT_MS = 1000;
/** A finish event this much earlier than the current play can end belongs to an earlier play. */
const FINISH_TOLERANCE_MS = 15;
/** Used until a file reports its duration. */
const FALLBACK_DURATION_MS = 400;
/** stopAll lowers the volume in steps of this long. */
const FADE_STEP_MS = 10;

interface Voice {
  id: SfxId;
  player: AudioPlayer;
  durationMs: number;
  /** When the current play ends; 0 when idle. */
  busyUntil: number;
  startedAt: number;
  /** At the start: the next trigger is a plain play(). */
  rewound: boolean;
  /** Changes with every trigger, so a seek that completes late does not mark a playing voice as rewound. */
  seekToken: number;
  fading: boolean;
  volume: number;
  subscription: { remove(): void } | null;
}

const pools = new Map<SfxId, Voice[]>();
const fades = new Set<ReturnType<typeof setInterval>>();
let readyPromise: Promise<boolean> | null = null;
let readySince: number | null = null;
let modePromise: Promise<void> | null = null;
// Bumped by releaseSfx: an init still running for a released set stops.
let generation = 0;

const now = () => performance.now();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sets the audio mode once (silent switch respected, mixing with other audio). */
export function ensureAudioMode(): Promise<void> {
  modePromise ??= setAudioModeAsync({
    playsInSilentMode: false,
    interruptionMode: 'mixWithOthers',
    shouldPlayInBackground: false,
    allowsRecording: false,
  }).catch(() => {
    // Sounds are a bonus; try again next time.
    modePromise = null;
  });
  return modePromise;
}

function isLoaded(voice: Voice): boolean {
  try {
    return voice.player.isLoaded;
  } catch {
    return false;
  }
}

function rewind(voice: Voice): void {
  voice.rewound = false;
  const token = voice.seekToken;
  voice.player.seekTo(0, 0, 0).then(
    () => {
      if (voice.seekToken === token) voice.rewound = true;
    },
    () => {},
  );
}

function onStatus(voice: Voice, status: AudioStatus): void {
  if (!status.didJustFinish) return;
  // A late event of a play that was restarted since: the voice is playing again.
  if (now() < voice.busyUntil - FINISH_TOLERANCE_MS) return;
  voice.busyUntil = 0;
  try {
    voice.player.pause();
  } catch {
    return;
  }
  rewind(voice);
}

function createVoice(id: SfxId): Voice {
  const player = createAudioPlayer(SFX_SOURCES[id], { keepAudioSessionActive: true, updateInterval: 1000 });
  const voice: Voice = {
    id,
    player,
    durationMs: FALLBACK_DURATION_MS,
    busyUntil: 0,
    startedAt: 0,
    rewound: true,
    seekToken: 0,
    fading: false,
    volume: 1,
    subscription: null,
  };
  voice.subscription = player.addListener('playbackStatusUpdate', (status) => onStatus(voice, status));
  return voice;
}

/** Volume scale for one more voice: 1/sqrt(k) with k voices sounding, at least 0.5. */
function headroom(t: number): number {
  let active = 1;
  for (const pool of pools.values()) {
    for (const voice of pool) if (!voice.fading && voice.busyUntil > t) active++;
  }
  return Math.max(0.5, 1 / Math.sqrt(active));
}

function trigger(voice: Voice, volume: number, t: number): void {
  const { player } = voice;
  const restart = !voice.rewound || voice.busyUntil > t;
  voice.seekToken++;
  try {
    player.volume = volume;
    // Not awaited: a restart seeks and plays in the same tick.
    if (restart) player.seekTo(0, 0, 0).catch(() => {});
    player.play();
  } catch {
    return;
  }
  voice.volume = volume;
  voice.rewound = false;
  voice.startedAt = t;
  voice.busyUntil = t + voice.durationMs;
}

/**
 * Plays sound `id` now. Synchronous and fire-and-forget: returns nothing, never
 * waits. Uses a free voice (a rewound one first); when all are busy, restarts
 * the one that started longest ago. Only sounds with voices (ONE_SHOT_VOICES) play.
 */
export function play(id: SfxId, volume = 1): void {
  const pool = pools.get(id);
  if (!pool?.length) return;
  const t = now();
  const usable = pool.filter((voice) => !voice.fading);
  const free = usable.filter((voice) => voice.busyUntil <= t);
  const voice =
    free.find((v) => v.rewound) ?? free[0] ?? usable.reduce<Voice | undefined>((a, b) => (!a || b.startedAt < a.startedAt ? b : a), undefined);
  if (!voice) return;
  trigger(voice, volume * headroom(t), t);
}

function fadeOut(voice: Voice, fadeMs: number): void {
  if (voice.fading) return;
  voice.fading = true;
  const finish = () => {
    try {
      voice.player.pause();
    } catch {
      // Released meanwhile.
    }
    voice.fading = false;
    voice.busyUntil = 0;
    rewind(voice);
  };
  const steps = Math.round(fadeMs / FADE_STEP_MS);
  if (steps < 1) {
    finish();
    return;
  }
  const from = voice.volume;
  let step = 0;
  const timer = setInterval(() => {
    step++;
    try {
      voice.player.volume = from * (1 - step / steps);
    } catch {
      // Released meanwhile.
    }
    if (step >= steps) {
      clearInterval(timer);
      fades.delete(timer);
      finish();
    }
  }, fadeMs / steps);
  fades.add(timer);
}

/** Fades out and stops every one-shot that sounds (a skip). */
export function stopAll(fadeMs = 30): void {
  const t = now();
  for (const pool of pools.values()) {
    for (const voice of pool) if (voice.busyUntil > t) fadeOut(voice, fadeMs);
  }
}

async function prepare(voices: Voice[], gen: number): Promise<boolean> {
  const deadline = now() + READY_TIMEOUT_MS;
  while (voices.some((voice) => !isLoaded(voice)) && now() < deadline) await sleep(20);
  if (gen !== generation) return false;
  const loaded = voices.filter(isLoaded);
  for (const voice of loaded) {
    const seconds = voice.player.duration;
    if (seconds > 0) voice.durationMs = seconds * 1000;
  }
  await ensureAudioMode();
  if (gen !== generation) return false;

  // Prime: play every voice silently, then put it back at the start.
  for (const voice of loaded) {
    try {
      voice.player.volume = 0;
      voice.player.play();
    } catch {
      // Released meanwhile.
    }
  }
  await sleep(PRIME_PLAY_MS);
  if (gen !== generation) return false;
  for (const voice of loaded) {
    try {
      voice.player.pause();
    } catch {
      // Released meanwhile.
    }
  }
  await Promise.race([
    Promise.all(loaded.map((voice) => voice.player.seekTo(0, 0, 0).catch(() => {}))),
    sleep(PRIME_SEEK_TIMEOUT_MS),
  ]);
  if (gen !== generation) return false;
  for (const voice of loaded) {
    try {
      voice.player.volume = 1;
    } catch {
      // Released meanwhile.
    }
    voice.volume = 1;
    voice.busyUntil = 0;
    voice.rewound = true;
  }
  const ready = loaded.length === voices.length;
  if (ready) readySince = now();
  return ready;
}

/**
 * Creates and primes the one-shot voices, once; later calls return the same
 * promise. Resolves true when every file loaded within READY_TIMEOUT_MS.
 */
export function initSfx(voiceCounts: Partial<Record<SfxId, number>> = ONE_SHOT_VOICES): Promise<boolean> {
  if (readyPromise) return readyPromise;
  const gen = ++generation;
  ensureAudioMode();
  const voices: Voice[] = [];
  try {
    for (const [id, count] of Object.entries(voiceCounts) as [SfxId, number][]) {
      const pool = Array.from({ length: count }, () => createVoice(id));
      pools.set(id, pool);
      voices.push(...pool);
    }
  } catch {
    releaseSfx();
    return Promise.resolve(false);
  }
  readyPromise = prepare(voices, gen).catch(() => false);
  return readyPromise;
}

/** When (performance.now()) every voice was loaded and primed; null until then. */
export function sfxReadySince(): number | null {
  return readySince;
}

/**
 * Removes every player and lets the audio session go. initSfx can start again
 * afterwards. Not for every reveal: see the notes at the top.
 */
export function releaseSfx(): void {
  generation++;
  readySince = null;
  for (const timer of fades) clearInterval(timer);
  fades.clear();
  for (const pool of pools.values()) {
    for (const voice of pool) {
      voice.subscription?.remove();
      try {
        voice.player.remove();
      } catch {
        // Already gone.
      }
    }
  }
  pools.clear();
  readyPromise = null;
  setIsAudioActiveAsync(false).catch(() => {});
}
