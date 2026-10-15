// The game catalog (game_catalog()): for now the numbers of game_config, used
// for labels ("×1,1 per week, up to ×2,14") and the Dev mode preview. Pure, so
// it is unit tested; fetching is in useGameCatalog.ts.
import { formatMultiplier } from '../lib/points';
import type { Score } from '../lib/score';

export interface GameConfig {
  checkinBaseChips: number;
  streakMultiplier: number;
  streakMaxSteps: number;
  bonusQuestionPoints: number;
}

export interface GameCatalog {
  config: GameConfig;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The answer of game_catalog(), or null when a number the app needs is missing. */
export function parseCatalog(value: unknown): GameCatalog | null {
  const config = (value as { config?: Record<string, unknown> } | null)?.config;
  if (!config || typeof config !== 'object') return null;
  const { checkin_base_chips, streak_multiplier, streak_max_steps, bonus_question_points } = config;
  if (!isNumber(checkin_base_chips) || !isNumber(streak_multiplier) || !isNumber(streak_max_steps) || !isNumber(bonus_question_points)) {
    return null;
  }
  return {
    config: {
      checkinBaseChips: checkin_base_chips,
      streakMultiplier: streak_multiplier,
      streakMaxSteps: streak_max_steps,
      bonusQuestionPoints: bonus_question_points,
    },
  };
}

/** The combined streak multiplier after `weeks` weeks ("×1,33"), capped at the maximum. */
export function streakMultiplierLabel(config: GameConfig, weeks: number): string {
  return formatMultiplier(config.streakMultiplier ** Math.min(Math.max(0, weeks), config.streakMaxSteps));
}

/**
 * A score like private.checkin_score makes it, for a reveal the server did
 * not compute: the Dev mode preview (any base) and the reveal the app expects
 * while a check-in uploads (to mix its sound ahead). Never shown as real points.
 */
export function previewScore(config: GameConfig, streakWeeks: number, base = config.checkinBaseChips): Score {
  const weeks = Math.max(0, Math.floor(streakWeeks));
  const stages = Array.from({ length: Math.min(weeks, config.streakMaxSteps) }, (_, i) => {
    const mult = config.streakMultiplier ** (i + 1);
    // The server's exact decimal (1.331), not the float noise of 1.1 ** 3.
    return { mult: Math.round(mult * 1e12) / 1e12, total: Math.round(base * mult) };
  });
  return {
    steps: [
      { kind: 'base', label: 'BASIS', chips: base, mult: 1, total: base },
      { kind: 'streak', label: 'REEKS', weeks, perWeek: config.streakMultiplier, stages },
    ],
    total: stages.at(-1)?.total ?? base,
  };
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
