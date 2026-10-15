import { describe, expect, it } from '@jest/globals';

import { formatPoints, formatWeeks } from '../format';
import {
  formatMultiplier,
  parseBonusQuestion,
  parsePoints,
  pointStages,
  totalMultiplier,
} from '../points';

describe('pointStages (mirror of checkin_point_stages)', () => {
  it('is the base without a streak', () => {
    expect(pointStages(10, 0)).toEqual({ base: 10, multiplier: 1.1, streakWeeks: 0, stages: [], total: 10 });
  });

  it('adds one x1.1 stage per streak week, rounding each stage like the server', () => {
    expect(pointStages(10, 2).stages).toEqual([11, 12]);
    expect(pointStages(10, 8).stages).toEqual([11, 12, 13, 15, 16, 18, 19, 21]);
  });

  it('caps at 8 stages but keeps the real streak', () => {
    const points = pointStages(10, 10);
    expect(points.stages).toHaveLength(8);
    expect([points.streakWeeks, points.total]).toEqual([10, 21]);
  });

  it('works for any base (Dev mode preview)', () => {
    expect(pointStages(100, 3)).toMatchObject({ stages: [110, 121, 133], total: 133 });
  });
});

describe('formatting', () => {
  it('writes multipliers the Dutch way', () => {
    expect(formatMultiplier(1.1)).toBe('×1,1');
    expect(totalMultiplier(8)).toBe('×2,14');
    expect(totalMultiplier(0)).toBe('×1');
  });

  it('uses singular and plural', () => {
    expect([formatPoints(1), formatPoints(16)]).toEqual(['1 punt', '16 punten']);
    expect([formatWeeks(1), formatWeeks(3)]).toEqual(['1 week', '3 weken']);
  });
});

describe('parsing the submit-checkin response', () => {
  it('reads the points', () => {
    expect(parsePoints({ base: 10, multiplier: 1.1, streak_weeks: 2, stages: [11, 12], total: 12 })).toEqual({
      base: 10,
      multiplier: 1.1,
      streakWeeks: 2,
      stages: [11, 12],
      total: 12,
    });
  });

  it('refuses malformed points', () => {
    expect(parsePoints(null)).toBeNull();
    expect(parsePoints({ base: '10', multiplier: 1.1, streak_weeks: 0, stages: [], total: 10 })).toBeNull();
    expect(parsePoints({ base: 10, multiplier: 1.1, streak_weeks: 0, stages: ['11'], total: 11 })).toBeNull();
  });

  it('reads a bonus question and keeps only well-formed options', () => {
    const question = parseBonusQuestion({
      key: 'bin_fullness',
      prompt: 'Hoe vol zat de vuilbak?',
      options: [{ key: 'empty', label: 'Bijna leeg' }, { key: 'full', label: 'Vol' }, { nope: true }],
      points: 5,
    });
    expect(question).toEqual({
      key: 'bin_fullness',
      prompt: 'Hoe vol zat de vuilbak?',
      options: [
        { key: 'empty', label: 'Bijna leeg' },
        { key: 'full', label: 'Vol' },
      ],
      points: 5,
    });
  });

  it('drops a question without enough options', () => {
    expect(parseBonusQuestion({ key: 'x', prompt: 'X?', options: [{ key: 'a', label: 'A' }] })).toBeNull();
    expect(parseBonusQuestion(null)).toBeNull();
  });
});
