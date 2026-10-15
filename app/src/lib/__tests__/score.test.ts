import { describe, expect, it } from '@jest/globals';

import { SERVER_DISCOVERY_SCORE, SERVER_SCORES } from '../../feedback/reveal/__fixtures__/scores';
import { baseStep, discoveryStep, parseScore, streakStep, streakWeeks } from '../score';

describe('parseScore', () => {
  it('reads the steps the server sends, with their running totals', () => {
    expect(parseScore(SERVER_SCORES[3])).toEqual({
      steps: [
        { kind: 'base', label: 'BASIS', chips: 10, mult: 1, total: 10 },
        {
          kind: 'streak',
          label: 'REEKS',
          weeks: 3,
          perWeek: 1.1,
          stages: [
            { mult: 1.1, total: 11 },
            { mult: 1.21, total: 12 },
            { mult: 1.331, total: 13 },
          ],
        },
      ],
      total: 13,
      streakExtended: false,
    });
  });

  it('reads a discovery step and the flame of the first check-in of the week', () => {
    const score = parseScore(SERVER_DISCOVERY_SCORE)!;
    expect(discoveryStep(score)).toEqual({ kind: 'discovery', label: 'NIEUW', chips: 15, add: 5, mult: 1, total: 15 });
    expect(score.streakExtended).toBe(true);
    expect(score.total).toBe(22);
  });

  it('refuses a malformed discovery step', () => {
    const base = { kind: 'base', label: 'BASIS', chips: 10, mult: 1, total: 10 };
    expect(parseScore({ steps: [base, { kind: 'discovery', label: 'NIEUW', chips: 15, mult: 1, total: 15 }], total: 15 })).toBeNull();
  });

  it('keeps a step of a kind it does not know, with its label and total', () => {
    const score = parseScore({ steps: [{ kind: 'bounty', label: 'PREMIE ×2', chips: 15, mult: 2.93, total: 44, factor: 2 }], total: 44 });
    expect(score?.steps).toEqual([{ kind: 'other', name: 'bounty', label: 'PREMIE ×2', total: 44 }]);
  });

  it('refuses a malformed score', () => {
    const base = { kind: 'base', label: 'BASIS', chips: 10, mult: 1, total: 10 };
    for (const value of [
      null,
      'score',
      { steps: [], total: 10 },
      { steps: [base] },
      { steps: [base], total: '10' },
      { steps: [{ ...base, total: '10' }], total: 10 },
      { steps: [{ kind: 'base', chips: 10, mult: 1, total: 10 }], total: 10 },
      { steps: [base, { kind: 'streak', label: 'REEKS', weeks: 1, per_week: 1.1, stages: [{ mult: 1.1 }] }], total: 11 },
      { steps: [base, { kind: 'streak', label: 'REEKS', weeks: 1, stages: [] }], total: 10 },
    ]) {
      expect(parseScore(value)).toBeNull();
    }
  });

  it('finds the base and the streak, and the streak in weeks', () => {
    const score = parseScore(SERVER_SCORES[10])!;
    expect(baseStep(score)?.total).toBe(10);
    expect(streakStep(score)?.stages).toHaveLength(8);
    expect(streakWeeks(score)).toBe(10);
    const plain = parseScore({ steps: [{ kind: 'base', label: 'BASIS', chips: 10, mult: 1, total: 10 }], total: 10 })!;
    expect([streakStep(plain), streakWeeks(plain)]).toEqual([null, 0]);
  });
});
