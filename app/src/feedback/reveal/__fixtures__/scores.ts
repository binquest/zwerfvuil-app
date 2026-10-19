// Scores for tests: what the server sends (private.checkin_score), so the
// tests build the reveal exactly as the app does.
import { previewScore, type GameConfig } from '../../../game/catalog';
import type { Score } from '../../../lib/score';
import { buildRevealTimeline } from '../timeline';

/** The numbers of game_config as the migrations set them. */
export const DEFAULT_CONFIG: GameConfig = {
  checkinBaseChips: 10,
  streakMultiplier: 1.1,
  streakMaxSteps: 8,
  bonusQuestionPoints: 5,
  discoveryChips: 5,
};

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
 * supabase/tests/database/11_scoring.test.sql and the Deno integration test:
 * check-ins at a bin the user had discovered before, not the first of the week.
 */
export const SERVER_SCORES: Record<number, unknown> = {
  0: {
    steps: [
      { kind: 'base', label: 'BASIS', chips: 10, mult: 1, total: 10 },
      { kind: 'streak', label: 'REEKS', weeks: 0, per_week: 1.1, stages: [] },
    ],
    total: 10,
    streak_extended: false,
    parts: { checkin: 10 },
  },
  1: {
    steps: [
      { kind: 'base', label: 'BASIS', chips: 10, mult: 1, total: 10 },
      { kind: 'streak', label: 'REEKS', weeks: 1, per_week: 1.1, stages: [{ mult: 1.1, total: 11 }] },
    ],
    total: 11,
    streak_extended: false,
    parts: { checkin: 11 },
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
    streak_extended: false,
    parts: { checkin: 13 },
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
    streak_extended: false,
    parts: { checkin: 21 },
  },
};

/**
 * The server's answer for a discovery that is also the first check-in of the
 * week, with a 4-week streak (docs/GAMIFICATION.md 2.7 and 12_discoveries).
 */
export const SERVER_DISCOVERY_SCORE: unknown = {
  steps: [
    { kind: 'base', label: 'BASIS', chips: 10, mult: 1, total: 10 },
    { kind: 'discovery', label: 'NIEUW', chips: 15, mult: 1, total: 15, add: 5 },
    {
      kind: 'streak',
      label: 'REEKS',
      weeks: 4,
      per_week: 1.1,
      stages: [
        { mult: 1.1, total: 17 },
        { mult: 1.21, total: 18 },
        { mult: 1.331, total: 20 },
        { mult: 1.4641, total: 22 },
      ],
    },
  ],
  total: 22,
  streak_extended: true,
  parts: { checkin: 15, discovery: 7 },
};
