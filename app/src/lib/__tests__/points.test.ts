import { describe, expect, it } from '@jest/globals';

import { formatPoints, formatWeeks } from '../format';
import { formatMultiplier, parseBonusQuestion } from '../points';

describe('formatting', () => {
  it('writes multipliers the Dutch way', () => {
    expect(formatMultiplier(1.1)).toBe('×1,1');
    expect(formatMultiplier(1.1 ** 8)).toBe('×2,14');
    expect(formatMultiplier(1)).toBe('×1');
  });

  it('uses singular and plural', () => {
    expect([formatPoints(1), formatPoints(16)]).toEqual(['1 punt', '16 punten']);
    expect([formatWeeks(1), formatWeeks(3)]).toEqual(['1 week', '3 weken']);
  });
});

describe('parseBonusQuestion', () => {
  it('reads a bonus question with its points and keeps only well-formed options', () => {
    const question = parseBonusQuestion({
      key: 'bin_fullness',
      prompt: 'Hoe vol zat de vuilbak?',
      options: [{ key: 'empty', label: 'Bijna leeg' }, { key: 'full', label: 'Vol' }, { nope: true }],
      points: 7,
    });
    expect(question).toEqual({
      key: 'bin_fullness',
      prompt: 'Hoe vol zat de vuilbak?',
      options: [
        { key: 'empty', label: 'Bijna leeg' },
        { key: 'full', label: 'Vol' },
      ],
      points: 7,
    });
  });

  it('drops a question without enough options or without its points', () => {
    expect(parseBonusQuestion({ key: 'x', prompt: 'X?', options: [{ key: 'a', label: 'A' }], points: 5 })).toBeNull();
    const twoOptions = [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B' },
    ];
    expect(parseBonusQuestion({ key: 'x', prompt: 'X?', options: twoOptions })).toBeNull();
    expect(parseBonusQuestion(null)).toBeNull();
  });
});
