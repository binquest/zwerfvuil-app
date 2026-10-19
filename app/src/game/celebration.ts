// The celebrations on their own screen (celebrate.tsx, docs/GAMIFICATION.md
// chapter 4 step 11 and chapter 5): after a reveal, of missed moments, and of
// the decisions since the last visit (approval.ts). What the screen shows is
// handed over before it opens; its timeline is pure, so the order, the sounds
// and the Reduce Motion rules are unit tested.
import type { Event } from '../feedback/reveal/timeline';
import { VOLUME } from '../feedback/reveal/tuning';
import type { UnseenResults } from './approval';
import type { BadgeNews } from './badges';
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
  /**
   * Right after a reveal: a milestone and/or the badges the check-in earned;
   * `discovered` is the counter after it.
   */
  | (CelebrationBase & {
      kind: 'reveal';
      milestone: MilestoneNews | null;
      badges: BadgeNews[];
      discovered: number | null;
      totalBins: number | null;
    })
  /** Moments missed since the last visit (my_unseen). */
  | (CelebrationBase & { kind: 'missed'; moments: MissedMoment[]; total: number })
  /** The decisions since the last visit (my_unseen `results`); closing marks them seen. */
  | (CelebrationBase & { kind: 'approval'; results: UnseenResults });

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
 * a success haptic, then the reward. Discoveries without a milestone: their
 * fanfare, a medium haptic and the list, without confetti. Only badges: the
 * chime and a light haptic.
 */
export function buildCelebrationTimeline({
  milestone,
  discoveries = true,
  reduceMotion,
}: {
  milestone: boolean;
  discoveries?: boolean;
  reduceMotion: boolean;
}): Event[] {
  if (milestone) {
    return [
      { atMs: 0, type: 'sound', id: 'milestone_fanfare', volume: VOLUME.milestone },
      { atMs: MILESTONE_CHORD_MS, type: 'haptic', kind: 'success' },
      { atMs: MILESTONE_CHORD_MS, type: 'confetti', pieces: reduceMotion ? 0 : CONFETTI_PIECES },
      { atMs: MILESTONE_CHORD_MS + REWARD_DELAY_MS, type: 'reward' },
    ];
  }
  if (!discoveries) {
    return [
      { atMs: 0, type: 'sound', id: 'approve_chime', volume: VOLUME.approve },
      { atMs: 0, type: 'haptic', kind: 'light' },
      { atMs: REWARD_DELAY_MS, type: 'reward' },
    ];
  }
  return [
    { atMs: 0, type: 'sound', id: 'discover_fanfare', volume: VOLUME.fanfare },
    { atMs: 0, type: 'haptic', kind: 'medium' },
    { atMs: REWARD_DELAY_MS, type: 'reward' },
  ];
}
