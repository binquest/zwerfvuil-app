// The celebrations after a reveal and of missed moments (celebrate.tsx,
// docs/GAMIFICATION.md chapter 4, step 11): what the screen shows, handed over
// before it opens, and its timeline. Pure, so the order, the sounds and the
// Reduce Motion rules are unit tested.
import type { Event } from '../feedback/reveal/timeline';
import { VOLUME } from '../feedback/reveal/tuning';
import type { MilestoneNews, MissedMoment } from './discoveries';

interface CelebrationBase {
  /** Server time to mark seen when the celebration closes (null: nothing to mark). */
  asOf: string | null;
  /** Dev mode preview: nothing is marked seen, events are test events. */
  preview: boolean;
  /** Dev mode preview: as if Reduce Motion were on. */
  forceReduceMotion?: boolean;
  noSound?: boolean;
  /** Called when the celebration closes (the presenter's done). */
  onClose?: () => void;
}

export type CelebrationData =
  /** A milestone right after a reveal; `discovered` is the counter after it. */
  | (CelebrationBase & { kind: 'milestone'; milestone: MilestoneNews; discovered: number | null; totalBins: number | null })
  /** Moments missed since the last visit (my_unseen). */
  | (CelebrationBase & { kind: 'missed'; moments: MissedMoment[]; total: number });

let pending: CelebrationData | null = null;

export function setPendingCelebration(data: CelebrationData): void {
  pending = data;
}

/** The data for the celebration screen; read once. */
export function takePendingCelebration(): CelebrationData | null {
  const data = pending;
  pending = null;
  return data;
}

// The fanfare's chord lands here (scripts/generate-sfx.mjs, milestoneFanfare).
export const MILESTONE_CHORD_MS = 360;
export const CONFETTI_PIECES = 40;
/** The reward card comes in after the chord. */
export const REWARD_DELAY_MS = 300;

/**
 * A milestone: the fanfare, confetti on its chord (none with Reduce Motion),
 * a success haptic, then the reward. Only discoveries: their fanfare, a
 * medium haptic and the list, without confetti.
 */
export function buildCelebrationTimeline({ milestone, reduceMotion }: { milestone: boolean; reduceMotion: boolean }): Event[] {
  if (milestone) {
    return [
      { atMs: 0, type: 'sound', id: 'milestone_fanfare', volume: VOLUME.milestone },
      { atMs: MILESTONE_CHORD_MS, type: 'haptic', kind: 'success' },
      { atMs: MILESTONE_CHORD_MS, type: 'confetti', pieces: reduceMotion ? 0 : CONFETTI_PIECES },
      { atMs: MILESTONE_CHORD_MS + REWARD_DELAY_MS, type: 'reward' },
    ];
  }
  return [
    { atMs: 0, type: 'sound', id: 'discover_fanfare', volume: VOLUME.fanfare },
    { atMs: 0, type: 'haptic', kind: 'medium' },
    { atMs: REWARD_DELAY_MS, type: 'reward' },
  ];
}
