import { describe, expect, it } from '@jest/globals';

import { DEFAULT_CONFIG, SERVER_SCORES } from '../../feedback/reveal/__fixtures__/scores';
import { parseScore } from '../../lib/score';
import { expectedStreakWeeks, parseCatalog, previewScore, streakMultiplierLabel } from '../catalog';

describe('parseCatalog', () => {
  it('reads the numbers of game_catalog()', () => {
    const answer = { config: { checkin_base_chips: 10, streak_multiplier: 1.1, streak_max_steps: 8, bonus_question_points: 5, later_key: 3 } };
    expect(parseCatalog(answer)).toEqual({ config: DEFAULT_CONFIG });
  });

  it('refuses an answer without a number the app needs', () => {
    expect(parseCatalog(null)).toBeNull();
    expect(parseCatalog({})).toBeNull();
    expect(parseCatalog({ config: { checkin_base_chips: 10, streak_multiplier: '1.1', streak_max_steps: 8, bonus_question_points: 5 } })).toBeNull();
  });
});

describe('previewScore (the Dev mode preview and the expected reveal)', () => {
  it('is the server score for the same streak', () => {
    for (const weeks of [0, 1, 3, 10]) expect(previewScore(DEFAULT_CONFIG, weeks)).toEqual(parseScore(SERVER_SCORES[weeks]));
  });

  it('works for any base and config', () => {
    expect(previewScore(DEFAULT_CONFIG, 3, 100).steps[1]).toMatchObject({ stages: [{ total: 110 }, { total: 121 }, { total: 133 }] });
    const config = { ...DEFAULT_CONFIG, checkinBaseChips: 12, streakMultiplier: 1.2, streakMaxSteps: 2 };
    expect(previewScore(config, 5)).toEqual({
      steps: [
        { kind: 'base', label: 'BASIS', chips: 12, mult: 1, total: 12 },
        {
          kind: 'streak',
          label: 'REEKS',
          weeks: 5,
          perWeek: 1.2,
          stages: [
            { mult: 1.2, total: 14 },
            { mult: 1.44, total: 17 },
          ],
        },
      ],
      total: 17,
    });
  });
});

describe('labels', () => {
  it('shows the combined multiplier, capped at the maximum', () => {
    expect(streakMultiplierLabel(DEFAULT_CONFIG, 0)).toBe('×1');
    expect(streakMultiplierLabel(DEFAULT_CONFIG, 3)).toBe('×1,33');
    expect(streakMultiplierLabel(DEFAULT_CONFIG, 8)).toBe('×2,14');
    expect(streakMultiplierLabel(DEFAULT_CONFIG, 30)).toBe('×2,14');
  });
});

describe('expectedStreakWeeks', () => {
  it('is this week\'s streak, or last week\'s plus this week', () => {
    expect(expectedStreakWeeks({ weeks: 3, thisWeek: true })).toBe(3);
    expect(expectedStreakWeeks({ weeks: 3, thisWeek: false })).toBe(4);
    expect(expectedStreakWeeks({ weeks: 0, thisWeek: false })).toBe(1);
    expect(expectedStreakWeeks(null)).toBe(1);
  });

  it('follows a Dev mode streak override', () => {
    expect(expectedStreakWeeks({ weeks: 3, thisWeek: true }, 0)).toBe(0);
    expect(expectedStreakWeeks(null, 7)).toBe(7);
  });
});
