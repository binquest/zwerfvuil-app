import { describe, expect, it } from '@jest/globals';

import { scoreFor } from '../../feedback/reveal/__fixtures__/scores';
import { countSteps, revealSummary, setPendingReveal, takePendingReveal } from '../reveal';

describe('countSteps', () => {
  it('counts every point for small numbers', () => {
    expect(countSteps(0, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('uses at most 18 steps and always ends on the target', () => {
    const steps = countSteps(0, 100);
    expect(steps).toHaveLength(18);
    expect(steps.at(-1)).toBe(100);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });

  it('takes a smaller maximum', () => {
    expect(countSteps(0, 100, 10)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  it('handles no distance', () => {
    expect(countSteps(12, 12)).toEqual([12]);
  });
});

describe('pending reveal', () => {
  it('is read once', () => {
    setPendingReveal({ score: scoreFor(1), question: null, checkinId: 'c1', isTest: false, preview: false });
    expect(takePendingReveal()?.checkinId).toBe('c1');
    expect(takePendingReveal()).toBeNull();
  });
});

describe('revealSummary (what VoiceOver says instead of the animation)', () => {
  it('says the total, that it waits for approval, and the streak', () => {
    expect(revealSummary(scoreFor(3))).toBe('13 punten, wacht op goedkeuring. Reeks van 3 weken.');
    expect(revealSummary(scoreFor(1))).toBe('11 punten, wacht op goedkeuring. Reeks van 1 week.');
  });

  it('leaves out a streak of 0 weeks and says when it is a preview', () => {
    expect(revealSummary(scoreFor(0), true)).toBe('10 punten, voorbeeld.');
  });
});
