// Plays a timeline with its mixed soundtrack: the sounds come from one file,
// the visuals and haptics follow it on the audio clock. The silent start (the
// chips coming in) does not wait for AVPlayer to really start: the clock holds
// just before the first sound until it does. Without a soundtrack (Dev mode
// "without sound", or the sounds were not ready in time) the same timeline runs
// on performance.now() alone.
import { DRIFT_CHECK_MS } from '../sfx/clock';
import { READY_TIMEOUT_MS } from '../sfx/engine';
import { prepareSoundtrack, warmUpSounds, type Soundtrack } from '../sfx/soundtrack';
import type { SoundState } from './diagnostics';
import { runTimeline, type TimelineRun } from './run';
import type { Event } from './timeline';

/** Stop checking the clock this long before the soundtrack ends (its position stops there). */
const LAST_CHECK_BEFORE_END_MS = 100;

export interface PlaybackStart {
  sound: SoundState;
  timings?: { mixMs: number; mixCached: boolean; loadMs: number; startMs: number };
}

export interface PlaybackHooks {
  /** The soundtrack really started (or the timeline runs without sound). */
  onStarted?(start: PlaybackStart): void;
  /** Clock minus audio at a check, and the corrections so far. */
  onClockCheck?(errorMs: number | null, corrections: number): void;
}

export interface Playback {
  /** Stops the timeline and fades out the soundtrack. */
  cancel(fadeMs?: number): void;
}

function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/** When the first sound of `events` plays: the provisional clock holds there. */
export function firstSoundMs(events: readonly Event[]): number {
  const first = events.find((event) => event.type === 'sound');
  return first ? first.atMs : 0;
}

/** Mixes and loads the soundtrack of `events` ahead of time (the +5 while the question shows). */
export function preloadTimeline(events: readonly Event[], soundtrack: Soundtrack): void {
  (async () => {
    if (!(await warmUpSounds())) return;
    const prepared = await prepareSoundtrack(events);
    await soundtrack.load(prepared.uri);
  })().catch(() => {
    // playTimeline tries again, or plays without sound.
  });
}

export function playTimeline(
  events: readonly Event[],
  soundtrack: Soundtrack | null,
  onEvents: (batch: Event[], lateMs: number) => void,
  hooks: PlaybackHooks = {},
): Playback {
  let cancelled = false;
  let run: TimelineRun | null = null;
  let checker: ReturnType<typeof setInterval> | null = null;

  const runSilently = (sound: SoundState) => {
    if (cancelled) return;
    hooks.onStarted?.({ sound });
    run = runTimeline(events, onEvents);
  };

  if (!soundtrack) {
    runSilently('off');
  } else {
    (async () => {
      if (!(await within(warmUpSounds(), READY_TIMEOUT_MS, false))) throw new Error('sounds not ready');
      const prepared = await prepareSoundtrack(events);
      const loadMs = await soundtrack.load(prepared.uri);
      if (cancelled) return;
      const { clock, started } = soundtrack.start(firstSoundMs(events));
      // The visuals start now; the clock holds at the first sound until the audio runs.
      run = runTimeline(events, onEvents, clock.now, 0);
      const start = await started;
      if (cancelled) return;
      hooks.onStarted?.({
        sound: start.started ? 'on' : 'did not start',
        timings: { mixMs: prepared.mixMs, mixCached: prepared.cached, loadMs, startMs: start.latencyMs },
      });
      checker = setInterval(() => {
        if (clock.now() > prepared.durationMs - LAST_CHECK_BEFORE_END_MS) {
          if (checker) clearInterval(checker);
          checker = null;
          return;
        }
        hooks.onClockCheck?.(clock.check(), clock.corrections());
      }, DRIFT_CHECK_MS);
    })().catch(() => {
      if (!run) runSilently('not ready');
    });
  }

  return {
    cancel(fadeMs = 30) {
      cancelled = true;
      run?.cancel();
      if (checker) clearInterval(checker);
      checker = null;
      soundtrack?.stop(fadeMs);
    },
  };
}
