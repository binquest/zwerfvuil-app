// Dev mode: a sound stress test for both sound paths, to hear cut-offs.
//   1. 20 ticks 40 ms apart, mixed into a soundtrack (the path every reveal uses).
//   2. Then 6 chords 120 ms apart through the one-shot pool (2 voices), so
//      voices get restarted (the path of a skip).
import { play } from '../sfx/engine';
import { revealSoundtrack } from '../sfx/soundtrack';
import type { SoundState } from './diagnostics';
import { playTimeline } from './playback';
import type { Event, SfxId } from './timeline';
import { TICK_PITCHES, VOLUME } from './tuning';

export const STRESS_TICKS = 20;
export const STRESS_SPACING_MS = 40;
export const STRESS_CHORDS = 6;
export const STRESS_CHORD_SPACING_MS = 120;
/** The gap between the last tick and the first chord. */
const PAUSE_MS = 400;
/** How long the last chord rings before the test reports. */
const CHORD_RING_MS = 1200;

/** 20 ticks, 40 ms apart, cycling through the five tick pitches. */
export function buildStressTimeline(): Event[] {
  return Array.from({ length: STRESS_TICKS }, (_, i) => ({
    atMs: i * STRESS_SPACING_MS,
    type: 'sound' as const,
    id: `tick_${i % TICK_PITCHES}` as SfxId,
    volume: VOLUME.tick,
  }));
}

export interface StressResult {
  sound: SoundState;
  mixMs?: number;
  mixCached?: boolean;
  startMs?: number;
  chords: number;
}

/** Runs the test; `onDone` gets the result when the last chord has rung. Returns a function that stops it. */
export function runSoundStressTest(onDone: (result: StressResult) => void): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
  const playback = playTimeline(buildStressTimeline(), revealSoundtrack, () => {}, {
    onStarted: (start) => {
      const result: StressResult = {
        sound: start.sound,
        mixMs: start.timings?.mixMs,
        mixCached: start.timings?.mixCached,
        startMs: start.timings?.startMs,
        chords: STRESS_CHORDS,
      };
      const chordsAt = STRESS_TICKS * STRESS_SPACING_MS + PAUSE_MS;
      for (let i = 0; i < STRESS_CHORDS; i++) later(chordsAt + i * STRESS_CHORD_SPACING_MS, () => play('total_chord', VOLUME.total));
      later(chordsAt + STRESS_CHORDS * STRESS_CHORD_SPACING_MS + CHORD_RING_MS, () => onDone(result));
    },
  });
  return () => {
    timers.forEach(clearTimeout);
    playback.cancel(30);
  };
}

/** One line for the Dev mode screen, in Dutch. */
export function describeStressResult(result: StressResult): string {
  if (result.sound !== 'on') return `Geen geluid (${result.sound === 'off' ? 'uit' : result.sound === 'not ready' ? 'niet op tijd klaar' : 'startte niet'}).`;
  const mix = result.mixCached ? 'mix uit cache' : `mix ${Math.round(result.mixMs ?? 0)} ms`;
  return `${STRESS_TICKS} ticks om de ${STRESS_SPACING_MS} ms gemixt (${mix}, start ${Math.round(result.startMs ?? 0)} ms), daarna ${result.chords} akkoorden om de ${STRESS_CHORD_SPACING_MS} ms via de pool.`;
}
