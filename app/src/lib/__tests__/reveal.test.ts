import { describe, expect, it } from '@jest/globals';

import { pointStages } from '../points';
import {
  bonusBeat,
  countSteps,
  revealBeats,
  revealDuration,
  setPendingReveal,
  stageDuration,
  stageScale,
  takePendingReveal,
} from '../reveal';

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

  it('handles no distance', () => {
    expect(countSteps(12, 12)).toEqual([12]);
  });
});

describe('revealBeats', () => {
  it('counts to the base and ends on the total without a streak', () => {
    const beats = revealBeats(pointStages(10, 0));
    expect(beats.map((b) => b.kind)).toEqual(['count', 'total']);
    expect(beats[1]).toMatchObject({ kind: 'total', value: 10 });
  });

  it('chains one stage per streak week, each from the previous value', () => {
    const beats = revealBeats(pointStages(10, 3));
    expect(beats.map((b) => b.kind)).toEqual(['count', 'stage', 'stage', 'stage', 'total']);
    expect(beats.slice(1, 4).map((b) => (b.kind === 'stage' ? [b.from, b.to] : null))).toEqual([
      [10, 11],
      [11, 12],
      [12, 13],
    ]);
  });

  it('makes every stage faster and bigger than the last', () => {
    for (let k = 2; k <= 8; k++) {
      expect(stageDuration(k)).toBeLessThanOrEqual(stageDuration(k - 1));
      expect(stageScale(k)).toBeGreaterThan(stageScale(k - 1));
    }
    expect(stageDuration(1)).toBeGreaterThan(stageDuration(8));
  });

  it('stays short enough to watch: under 7 seconds even with the maximum streak', () => {
    expect(revealDuration(revealBeats(pointStages(10, 8)))).toBeLessThan(7000);
  });

  it('adds the bonus as a short count from the total', () => {
    expect(bonusBeat(13)).toMatchObject({ kind: 'count', from: 13, to: 18, steps: [14, 15, 16, 17, 18] });
  });
});

describe('pending reveal', () => {
  it('is read once', () => {
    setPendingReveal({ points: pointStages(10, 1), question: null, checkinId: 'c1', isTest: false, preview: false });
    expect(takePendingReveal()?.checkinId).toBe('c1');
    expect(takePendingReveal()).toBeNull();
  });
});
