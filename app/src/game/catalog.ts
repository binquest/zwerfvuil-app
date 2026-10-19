// The game catalog (game_catalog()): the numbers of game_config, used for
// labels ("×1,1 per week, up to ×2,14") and the Dev mode preview, the
// discovery milestones, the levels and the avatars. Pure, so it is unit
// tested; fetching is in useGameCatalog.ts.
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
}

export interface Milestone {
  threshold: number;
  points: number;
}

export interface GameCatalog {
  config: GameConfig;
  /** Ascending by threshold. */
  milestones: Milestone[];
  /** Ascending by level. */
  levels: Level[];
  /** The active avatars, by sort. */
  avatars: AvatarDef[];
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The answer of game_catalog(), or null when a number the app needs is missing. */
export function parseCatalog(value: unknown): GameCatalog | null {
  const config = (value as { config?: Record<string, unknown> } | null)?.config;
  if (!config || typeof config !== 'object') return null;
  const { checkin_base_chips, streak_multiplier, streak_max_steps, bonus_question_points, discovery_chips } = config;
  if (!isNumber(checkin_base_chips) || !isNumber(streak_multiplier) || !isNumber(streak_max_steps) || !isNumber(bonus_question_points)) {
    return null;
  }
  const rawMilestones = (value as { milestones?: unknown }).milestones;
  const milestones = (Array.isArray(rawMilestones) ? rawMilestones : [])
    .filter((m): m is Milestone => !!m && typeof m === 'object' && isNumber(m.threshold) && isNumber(m.points))
    .map((m) => ({ threshold: m.threshold, points: m.points }))
    .sort((a, b) => a.threshold - b.threshold);
  return {
    config: {
      checkinBaseChips: checkin_base_chips,
      streakMultiplier: streak_multiplier,
      streakMaxSteps: streak_max_steps,
      bonusQuestionPoints: bonus_question_points,
      discoveryChips: isNumber(discovery_chips) ? discovery_chips : 0,
    },
    milestones,
    levels: parseLevels((value as { levels?: unknown }).levels),
    avatars: parseAvatarDefs((value as { avatars?: unknown }).avatars),
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
