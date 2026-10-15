import { describe, expect, it } from '@jest/globals';

import { pointStages } from '../points';
import { countSteps, setPendingReveal, takePendingReveal } from '../reveal';

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
    setPendingReveal({ points: pointStages(10, 1), question: null, checkinId: 'c1', isTest: false, preview: false });
    expect(takePendingReveal()?.checkinId).toBe('c1');
    expect(takePendingReveal()).toBeNull();
  });
});
