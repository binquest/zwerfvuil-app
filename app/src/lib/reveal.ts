// What the reveal screen shows, handed over by the camera (or the Dev mode
// preview) before it opens the screen. The reveal itself is a timeline:
// src/feedback/reveal/timeline.ts.

import type { CheckinGame } from '../game/discoveries';
import { formatPoints, formatWeeks } from './format';
import type { BonusQuestion } from './points';
import { discoveryStep, streakWeeks, type Score } from './score';

/** What the reveal screen shows; set by the camera (or the Dev mode preview) before opening it. */
export interface RevealData {
  /** The steps and the total, from the server (the preview builds its own). */
  score: Score;
  /** What the check-in made new: the banner's numbers, a milestone after the reveal. */
  game?: CheckinGame | null;
  question: BonusQuestion | null;
  /** The check-in the bonus question belongs to; null in the preview. */
  checkinId: string | null;
  /** Dev mode: a test check-in (or a preview). */
  isTest: boolean;
  /** Preview from Dev mode: nothing is sent to the server. */
  preview: boolean;
  /** Dev mode diagnostics: play the preview without loading the sound engine at all. */
  noSound?: boolean;
  /** Dev mode preview: answering the bonus question awards its points (default) or not. */
  previewAwarded?: boolean;
  /** Dev mode preview: play as if Reduce Motion were on, whatever the system setting. */
  forceReduceMotion?: boolean;
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

/**
 * What VoiceOver says instead of the animation: "22 punten, wacht op
 * goedkeuring. Nieuwe vuilbak ontdekt. Reeks verlengd: 4 weken."
 */
export function revealSummary(score: Score, preview = false): string {
  const weeks = streakWeeks(score);
  const parts = [`${formatPoints(score.total)}, ${preview ? 'voorbeeld' : 'wacht op goedkeuring'}.`];
  if (discoveryStep(score)) parts.push('Nieuwe vuilbak ontdekt.');
  if (score.streakExtended && weeks > 0) parts.push(weeks === 1 ? 'Reeks gestart.' : `Reeks verlengd: ${formatWeeks(weeks)}.`);
  else if (weeks > 0) parts.push(`Reeks van ${formatWeeks(weeks)}.`);
  return parts.join(' ');
}

const MAX_COUNT_STEPS = 18;

/** The values shown while counting from `from` to `to`, at most `maxSteps` of them, ending at `to`. */
export function countSteps(from: number, to: number, maxSteps = MAX_COUNT_STEPS): number[] {
  const distance = to - from;
  if (distance <= 0) return [to];
  const steps = Math.min(distance, maxSteps);
  const values = Array.from({ length: steps }, (_, i) => from + Math.round((distance * (i + 1)) / steps));
  return values.filter((v, i) => i === 0 || v !== values[i - 1]);
}
