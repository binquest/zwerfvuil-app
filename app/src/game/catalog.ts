// The game catalog (game_catalog()): the numbers of game_config, used for
// labels ("×1,1 per week, up to ×2,14") and the Dev mode preview, the
// discovery milestones, the levels, the avatars, the quests and the chest
// rewards (phase 6). Pure, so it is unit tested; fetching is in
// useGameCatalog.ts.
import { formatMultiplier } from '../lib/points';
import type { Score } from '../lib/score';
import { parseAvatarDefs, type AvatarDef } from './avatars';
import { parseLevels, type Level } from './levels';

export interface GameConfig {
  checkinBaseChips: number;
  streakMultiplier: number;
  streakMaxSteps: number;
  bonusQuestionPoints: number;
  /** Extra chips for a discovery (0 = no discovery step). */
  discoveryChips: number;
  /** Streak freezes a user can hold (phase 6; 2 when the server sent none). */
  maxFreezes: number;
  /** Chests can be opened up to this many days back, today included. */
  chestOpenDays: number;
}

export interface Milestone {
  threshold: number;
  points: number;
  /** Streak freezes earned with it (1 at 50; parsed as 0 when the server sent none). */
  freezes?: number;
}

/** A quest that can be handed out (the active templates). */
export interface QuestTemplate {
  key: string;
  period: 'day' | 'week';
  slot: 'easy' | 'medium' | 'hard' | 'weekly';
  title: string;
  target: number;
  rewardPoints: number;
  rewardFreezes: number;
}

/** What the daily chest can hold, with its weight (the chance in "Kansen"). */
export interface ChestRewardDef {
  key: string;
  kind: 'points' | 'freeze' | 'avatar';
  amount: number | null;
  avatarKey: string | null;
  weight: number;
}

export interface GameCatalog {
  config: GameConfig;
  /** Ascending by threshold. */
  milestones: Milestone[];
  /** Ascending by level. */
  levels: Level[];
  /** The active avatars, by sort. */
  avatars: AvatarDef[];
  /** The active quest templates (phase 6). */
  quests: QuestTemplate[];
  /** The chest rewards that can be drawn, by sort (phase 6). */
  chestRewards: ChestRewardDef[];
}

function parseQuestTemplates(value: unknown): QuestTemplate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((q): QuestTemplate[] => {
    if (!q || typeof q !== 'object') return [];
    const { key, period, slot, title, target, reward_points, reward_freezes } = q as Record<string, unknown>;
    if (typeof key !== 'string' || typeof title !== 'string' || !isNumber(target) || !isNumber(reward_points)) return [];
    if (period !== 'day' && period !== 'week') return [];
    if (slot !== 'easy' && slot !== 'medium' && slot !== 'hard' && slot !== 'weekly') return [];
    return [{ key, period, slot, title, target, rewardPoints: reward_points, rewardFreezes: isNumber(reward_freezes) ? reward_freezes : 0 }];
  });
}

function parseChestRewards(value: unknown): ChestRewardDef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((r): ChestRewardDef[] => {
    if (!r || typeof r !== 'object') return [];
    const { key, kind, amount, avatar_key, weight } = r as Record<string, unknown>;
    if (typeof key !== 'string' || !isNumber(weight) || weight <= 0) return [];
    if (kind !== 'points' && kind !== 'freeze' && kind !== 'avatar') return [];
    return [{ key, kind, amount: isNumber(amount) ? amount : null, avatarKey: typeof avatar_key === 'string' ? avatar_key : null, weight }];
  });
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The answer of game_catalog(), or null when a number the app needs is missing. */
export function parseCatalog(value: unknown): GameCatalog | null {
  const config = (value as { config?: Record<string, unknown> } | null)?.config;
  if (!config || typeof config !== 'object') return null;
  const { checkin_base_chips, streak_multiplier, streak_max_steps, bonus_question_points, discovery_chips, max_freezes, chest_open_days } =
    config;
  if (!isNumber(checkin_base_chips) || !isNumber(streak_multiplier) || !isNumber(streak_max_steps) || !isNumber(bonus_question_points)) {
    return null;
  }
  const rawMilestones = (value as { milestones?: unknown }).milestones;
  const milestones = (Array.isArray(rawMilestones) ? rawMilestones : [])
    .filter((m): m is Milestone => !!m && typeof m === 'object' && isNumber(m.threshold) && isNumber(m.points))
    .map((m) => ({ threshold: m.threshold, points: m.points, freezes: isNumber(m.freezes) ? m.freezes : 0 }))
    .sort((a, b) => a.threshold - b.threshold);
  return {
    config: {
      checkinBaseChips: checkin_base_chips,
      streakMultiplier: streak_multiplier,
      streakMaxSteps: streak_max_steps,
      bonusQuestionPoints: bonus_question_points,
      discoveryChips: isNumber(discovery_chips) ? discovery_chips : 0,
      maxFreezes: isNumber(max_freezes) ? max_freezes : 2,
      chestOpenDays: isNumber(chest_open_days) ? chest_open_days : 7,
    },
    milestones,
    levels: parseLevels((value as { levels?: unknown }).levels),
    avatars: parseAvatarDefs((value as { avatars?: unknown }).avatars),
    quests: parseQuestTemplates((value as { quests?: unknown }).quests),
    chestRewards: parseChestRewards((value as { chest_rewards?: unknown }).chest_rewards),
  };
}

/** The combined streak multiplier after `weeks` weeks ("×1,33"), capped at the maximum. */
export function streakMultiplierLabel(config: GameConfig, weeks: number): string {
  return formatMultiplier(config.streakMultiplier ** Math.min(Math.max(0, weeks), config.streakMaxSteps));
}

export interface PreviewOptions {
  /** A discovery: the discovery chips as their own step (none when they are 0). */
  discovery?: boolean;
  /** The first check-in of the week: the streak flame. */
  streakExtended?: boolean;
}

/**
 * A score like private.checkin_score makes it, for a reveal the server did
 * not compute: the Dev mode preview (any base) and the reveal the app expects
 * while a check-in uploads (to mix its sound ahead). Never shown as real points.
 */
export function previewScore(
  config: GameConfig,
  streakWeeks: number,
  base = config.checkinBaseChips,
  { discovery = false, streakExtended = false }: PreviewOptions = {},
): Score {
  const weeks = Math.max(0, Math.floor(streakWeeks));
  const add = discovery ? config.discoveryChips : 0;
  const chips = base + add;
  const stages = Array.from({ length: Math.min(weeks, config.streakMaxSteps) }, (_, i) => {
    const mult = config.streakMultiplier ** (i + 1);
    // The server's exact decimal (1.331), not the float noise of 1.1 ** 3.
    return { mult: Math.round(mult * 1e12) / 1e12, total: Math.round(chips * mult) };
  });
  return {
    steps: [
      { kind: 'base', label: 'BASIS', chips: base, mult: 1, total: base },
      ...(add > 0 ? [{ kind: 'discovery' as const, label: 'NIEUW', chips, add, mult: 1, total: chips }] : []),
      { kind: 'streak', label: 'REEKS', weeks, perWeek: config.streakMultiplier, stages },
    ],
    total: stages.at(-1)?.total ?? chips,
    streakExtended,
  };
}

/** The next milestone above `discovered` and the one before it (0 when none), or null when all are reached. */
export function nextMilestone(milestones: Milestone[], discovered: number): (Milestone & { previous: number }) | null {
  const next = milestones.find((m) => m.threshold > discovered);
  if (!next) return null;
  const previous = milestones.filter((m) => m.threshold <= discovered).at(-1)?.threshold ?? 0;
  return { ...next, previous };
}

/**
 * The streak a check-in made now will most likely get: this week's streak, or
 * last week's plus this week. A Dev mode streak override wins. Only for
 * mixing the reveal's sound ahead; the server decides.
 */
export function expectedStreakWeeks(streak: { weeks: number; thisWeek: boolean } | null, override: number | null = null): number {
  if (override !== null) return override;
  if (!streak) return 1;
  return streak.thisWeek ? Math.max(1, streak.weeks) : streak.weeks + 1;
}
