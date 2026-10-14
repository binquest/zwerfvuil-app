// The points reveal after a check-in, as a list of beats: count up to the
// base, then one beat per streak stage, each bigger, faster and higher, then
// the total. Pure, so the timing is unit tested; the screen plays the beats.

import { BONUS_POINTS, type BonusQuestion, type CheckinPoints, MAX_STAGES } from './points';

export type Beat =
  | { kind: 'count'; from: number; to: number; steps: number[]; durationMs: number }
  | { kind: 'stage'; stage: number; from: number; to: number; durationMs: number; scale: number }
  | { kind: 'total'; value: number; durationMs: number };

/** What the reveal screen shows; set by the camera (or the Dev mode preview) before opening it. */
export interface RevealData {
  points: CheckinPoints;
  question: BonusQuestion | null;
  /** The check-in the bonus question belongs to; null in the preview. */
  checkinId: string | null;
  /** Dev mode: a test check-in (or a preview). */
  isTest: boolean;
  /** Preview from Dev mode: nothing is sent to the server. */
  preview: boolean;
}

let pending: RevealData | null = null;

export function setPendingReveal(data: RevealData): void {
  pending = data;
}

/** The data for the reveal screen; read once. */
export function takePendingReveal(): RevealData | null {
  const data = pending;
  pending = null;
  return data;
}

const COUNT_STEP_MS = 55;
const MAX_COUNT_STEPS = 18;
const FIRST_STAGE_MS = 720;
const STAGE_SPEEDUP = 0.84;
const MIN_STAGE_MS = 300;
const TOTAL_MS = 900;

/** The values shown while counting from `from` to `to`, at most MAX_COUNT_STEPS of them, ending at `to`. */
export function countSteps(from: number, to: number, maxSteps = MAX_COUNT_STEPS): number[] {
  const distance = to - from;
  if (distance <= 0) return [to];
  const steps = Math.min(distance, maxSteps);
  const values = Array.from({ length: steps }, (_, i) => from + Math.round((distance * (i + 1)) / steps));
  return values.filter((v, i) => i === 0 || v !== values[i - 1]);
}

/** Duration of streak stage `stage` (1-based): each one faster than the last. */
export function stageDuration(stage: number): number {
  return Math.max(MIN_STAGE_MS, Math.round(FIRST_STAGE_MS * STAGE_SPEEDUP ** (stage - 1)));
}

/** How far the number punches out on stage `stage`: each one bigger. */
export function stageScale(stage: number): number {
  return Math.round((1.14 + 0.07 * Math.min(stage, MAX_STAGES)) * 100) / 100;
}

export function revealBeats(points: CheckinPoints): Beat[] {
  const steps = countSteps(0, points.base);
  const beats: Beat[] = [{ kind: 'count', from: 0, to: points.base, steps, durationMs: steps.length * COUNT_STEP_MS }];
  let previous = points.base;
  points.stages.forEach((value, i) => {
    beats.push({
      kind: 'stage',
      stage: i + 1,
      from: previous,
      to: value,
      durationMs: stageDuration(i + 1),
      scale: stageScale(i + 1),
    });
    previous = value;
  });
  beats.push({ kind: 'total', value: points.total, durationMs: TOTAL_MS });
  return beats;
}

/** The beat after a correct bonus answer. */
export function bonusBeat(total: number, bonus = BONUS_POINTS): Beat {
  const steps = countSteps(total, total + bonus);
  return { kind: 'count', from: total, to: total + bonus, steps, durationMs: steps.length * 90 };
}

export function revealDuration(beats: Beat[]): number {
  return beats.reduce((sum, beat) => sum + beat.durationMs, 0);
}
