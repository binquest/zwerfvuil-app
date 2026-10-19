import { describe, expect, it } from '@jest/globals';

import { DEFAULT_CONFIG, SERVER_DISCOVERY_SCORE, SERVER_SCORES } from '../../feedback/reveal/__fixtures__/scores';
import { parseScore } from '../../lib/score';
import { expectedStreakWeeks, nextMilestone, parseCatalog, previewScore, streakMultiplierLabel } from '../catalog';

const CONFIG_JSON = { checkin_base_chips: 10, streak_multiplier: 1.1, streak_max_steps: 8, bonus_question_points: 5, discovery_chips: 5 };

describe('parseCatalog', () => {
  it('reads the numbers of game_catalog()', () => {
    const answer = { config: { ...CONFIG_JSON, later_key: 3 } };
    expect(parseCatalog(answer)).toEqual({ config: DEFAULT_CONFIG, milestones: [], levels: [], avatars: [] });
  });

  it('reads the levels and avatars, sorted', () => {
    const answer = {
      config: CONFIG_JSON,
      levels: [
        { level: 2, min_points: 10, title: 'Blikjesbuddy' },
        { level: 1, min_points: 0, title: 'Wegwerp-rookie' },
        { level: 3, title: 'zonder drempel' },
      ],
      avatars: [
        { key: 'vos', name: 'Vos', rarity: 'common', unlock_type: 'default', unlock_param: null, sort: 2, placeholder_symbol: 'pawprint.fill', placeholder_color: '#C8553D' },
        { key: 'spruit', name: 'Spruit', rarity: 'common', unlock_type: 'default', unlock_param: null, sort: 1, placeholder_symbol: 'leaf.fill', placeholder_color: '#4E9A52' },
        { key: 'kapot', name: 'Kapot' },
      ],
    };
    const catalog = parseCatalog(answer);
    expect(catalog?.levels).toEqual([
      { level: 1, title: 'Wegwerp-rookie', minPoints: 0 },
      { level: 2, title: 'Blikjesbuddy', minPoints: 10 },
    ]);
    expect(catalog?.avatars.map((a) => a.key)).toEqual(['spruit', 'vos']);
    expect(catalog?.avatars[1]).toEqual({
      key: 'vos', name: 'Vos', rarity: 'common', unlockType: 'default', sort: 2, symbol: 'pawprint.fill', color: '#C8553D',
    });
  });

  it('reads the milestones, sorted, and skips malformed ones', () => {
    const answer = {
      config: CONFIG_JSON,
      milestones: [{ threshold: 20, points: 50 }, { threshold: 10, points: 50 }, { threshold: '30', points: 50 }, null],
    };
    expect(parseCatalog(answer)?.milestones).toEqual([
      { threshold: 10, points: 50 },
      { threshold: 20, points: 50 },
    ]);
  });

  it('treats missing discovery chips as none', () => {
    const { discovery_chips: _, ...older } = CONFIG_JSON;
    expect(parseCatalog({ config: older })?.config.discoveryChips).toBe(0);
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

  it('is the server score for a discovery on the first check-in of the week', () => {
    expect(previewScore(DEFAULT_CONFIG, 4, undefined, { discovery: true, streakExtended: true })).toEqual(
      parseScore(SERVER_DISCOVERY_SCORE),
    );
  });

  it('has no discovery step when the discovery chips are 0', () => {
    expect(previewScore({ ...DEFAULT_CONFIG, discoveryChips: 0 }, 3, undefined, { discovery: true })).toEqual(
      previewScore(DEFAULT_CONFIG, 3),
    );
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
      streakExtended: false,
    });
  });
});

describe('nextMilestone', () => {
  const milestones = [10, 20, 30].map((threshold) => ({ threshold, points: threshold === 30 ? 150 : 50 }));

  it('gives the next threshold and the one before it', () => {
    expect(nextMilestone(milestones, 0)).toEqual({ threshold: 10, points: 50, previous: 0 });
    expect(nextMilestone(milestones, 10)).toEqual({ threshold: 20, points: 50, previous: 10 });
    expect(nextMilestone(milestones, 25)).toEqual({ threshold: 30, points: 150, previous: 20 });
  });

  it('is null when every milestone is reached', () => {
    expect(nextMilestone(milestones, 30)).toBeNull();
    expect(nextMilestone([], 0)).toBeNull();
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
