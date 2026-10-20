// The celebrations on their own screen (celebrate.tsx, docs/GAMIFICATION.md
// chapter 4 step 11 and chapter 5): after a reveal (milestone, quests done,
// the chest ready, badges), of missed moments, and of the decisions since the
// last visit (approval.ts). What the screen shows is handed over before it
// opens; its timeline is pure, so the order, the sounds and the Reduce Motion
// rules are unit tested.
import type { Event } from '../feedback/reveal/timeline';
import { VOLUME } from '../feedback/reveal/tuning';
import type { UnseenResults } from './approval';
import type { BadgeNews } from './badges';
import type { CheckinGame, MilestoneNews, MissedMoment, MissedQuest } from './discoveries';

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
   * Right after a reveal: a milestone, the quests done, the chest that became
   * ready, the freezes and the badges of the check-in (and of its bonus
   * answer); `discovered` is the counter after it.
   */
  | (CelebrationBase & {
      kind: 'reveal';
      milestone: MilestoneNews | null;
      badges: BadgeNews[];
      quests: MissedQuest[];
      /** The day whose chest became ready (closing opens it), or null. */
      chestDay: string | null;
      freezes: number;
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

/** What the reveal's celebration shows: from `game`, plus what the bonus answer added after it (`later`: moments after game.asOf). */
export function revealNews(
  game: CheckinGame | null,
  later: readonly MissedMoment[] = [],
): { milestone: MilestoneNews | null; badges: BadgeNews[]; quests: MissedQuest[]; chestDay: string | null; freezes: number } {
  let milestone = game?.milestone ?? null;
  const badges = new Map((game?.badges ?? []).map((b) => [b.key, b]));
  const quests = new Map<string, MissedQuest>();
  for (const q of game?.quests ?? []) {
    if (!q.completedNow || q.status === 'open') continue;
    quests.set(q.id, {
      id: q.id,
      period: q.period,
      slot: q.slot,
      templateKey: q.templateKey,
      title: q.title,
      reward: q.reward,
      freezes: q.freezes,
      status: q.status,
    });
  }
  let chestDay = game?.chest?.readyNow && game.chest.status === 'ready' ? game.chest.day : null;
  let freezes = (game?.freezes ?? []).filter((f) => f.source !== 'chest').length;
  for (const m of later) {
    if (m.kind === 'quest') quests.set(m.quest.id, m.quest);
    else if (m.kind === 'chest') chestDay = m.day;
    else if (m.kind === 'badge') badges.set(m.badge.key, m.badge);
    else if (m.kind === 'freeze') freezes += 1;
    else if (m.kind === 'milestone' && (!milestone || m.threshold > milestone.threshold)) milestone = m;
  }
  return { milestone, badges: [...badges.values()], quests: [...quests.values()], chestDay, freezes };
}

/** True when the reveal has something to celebrate on its own screen. */
export function hasRevealNews(news: ReturnType<typeof revealNews>): boolean {
  return !!news.milestone || news.badges.length > 0 || news.quests.length > 0 || news.chestDay !== null || news.freezes > 0;
}

// The fanfare's chord lands here (scripts/generate-sfx.mjs, milestoneFanfare).
export const MILESTONE_CHORD_MS = 360;
export const CONFETTI_PIECES = 40;
/** The reward card comes in after the chord. */
export const REWARD_DELAY_MS = 300;

/**
 * A milestone: the fanfare, confetti on its chord (none with Reduce Motion),
 * a success haptic, then the reward. Discoveries without a milestone: their
 * fanfare, a medium haptic and the list, without confetti. Quests (or the
 * chest) without either: the ding and a light haptic. Only badges: the chime
 * and a light haptic.
 */
export function buildCelebrationTimeline({
  milestone,
  discoveries = true,
  quests = false,
  reduceMotion,
}: {
  milestone: boolean;
  discoveries?: boolean;
  quests?: boolean;
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
  if (!discoveries && quests) {
    return [
      { atMs: 0, type: 'sound', id: 'quest_ding', volume: VOLUME.quest },
      { atMs: 0, type: 'haptic', kind: 'light' },
      { atMs: REWARD_DELAY_MS, type: 'reward' },
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
