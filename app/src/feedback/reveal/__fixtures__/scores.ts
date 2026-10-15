// Scores for tests: what the server sends (private.checkin_score), so the
// tests build the reveal exactly as the app does.
import { previewScore, type GameConfig } from '../../../game/catalog';
import type { Score } from '../../../lib/score';
import { buildRevealTimeline } from '../timeline';

/** The numbers of game_config as the migrations set them. */
export const DEFAULT_CONFIG: GameConfig = { checkinBaseChips: 10, streakMultiplier: 1.1, streakMaxSteps: 8, bonusQuestionPoints: 5 };

/**
 * The score of a check-in with `weeks` of streak. With the default config and
 * base this is the server's answer (SERVER_SCORES proves it for a few streaks).
 */
export function scoreFor(weeks: number, base = DEFAULT_CONFIG.checkinBaseChips, config = DEFAULT_CONFIG): Score {
  return previewScore(config, weeks, base);
}

/** The reveal of that score. */
export function reveal(weeks: number, options: { reduceMotion?: boolean; bonus?: boolean; base?: number; config?: GameConfig } = {}) {
  return buildRevealTimeline({
    score: scoreFor(weeks, options.base, options.config),
    reduceMotion: options.reduceMotion ?? false,
    bonus: options.bonus,
  });
}

/**
 * The server's answers, as JSON, copied from
 * supabase/tests/database/11_scoring.test.sql and the Deno integration test.
 */
export const SERVER_SCORES: Record<number, unknown> = {
  0: {
    steps: [
      { kind: 'base', label: 'BASIS', chips: 10, mult: 1, total: 10 },
      { kind: 'streak', label: 'REEKS', weeks: 0, per_week: 1.1, stages: [] },
    ],
    total: 10,
  },
  1: {
    steps: [
      { kind: 'base', label: 'BASIS', chips: 10, mult: 1, total: 10 },
      { kind: 'streak', label: 'REEKS', weeks: 1, per_week: 1.1, stages: [{ mult: 1.1, total: 11 }] },
    ],
    total: 11,
  },
  3: {
    steps: [
      { kind: 'base', label: 'BASIS', chips: 10, mult: 1, total: 10 },
      {
        kind: 'streak',
        label: 'REEKS',
        weeks: 3,
        per_week: 1.1,
        stages: [
          { mult: 1.1, total: 11 },
          { mult: 1.21, total: 12 },
          { mult: 1.331, total: 13 },
        ],
      },
    ],
    total: 13,
  },
  10: {
    steps: [
      { kind: 'base', label: 'BASIS', chips: 10, mult: 1, total: 10 },
      {
        kind: 'streak',
        label: 'REEKS',
        weeks: 10,
        per_week: 1.1,
        stages: [
          { mult: 1.1, total: 11 },
          { mult: 1.21, total: 12 },
          { mult: 1.331, total: 13 },
          { mult: 1.4641, total: 15 },
          { mult: 1.61051, total: 16 },
          { mult: 1.771561, total: 18 },
          { mult: 1.9487171, total: 19 },
          { mult: 2.14358881, total: 21 },
        ],
      },
    ],
    total: 21,
  },
};
