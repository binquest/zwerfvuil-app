import { describe, expect, it } from '@jest/globals';

import { distanceBucket, roundTo100, screenName } from '../props';

describe('distanceBucket', () => {
  it('puts a distance in a coarse class', () => {
    expect([0, 9.9, 10, 24.9, 25, 49, 50, 900].map(distanceBucket)).toEqual([
      '0_10',
      '0_10',
      '10_25',
      '10_25',
      '25_50',
      '25_50',
      '50_plus',
      '50_plus',
    ]);
  });

  it('is unknown without a usable distance', () => {
    expect([null, undefined, Number.NaN, -1, Infinity].map(distanceBucket)).toEqual(Array(5).fill('unknown'));
  });
});

describe('roundTo100', () => {
  it('rounds to 100 ms and never below 0', () => {
    expect([0, 49, 50, 1234, -20].map(roundTo100)).toEqual([0, 0, 100, 1200, 0]);
  });
});

describe('screenName', () => {
  it('drops groups and keeps the route without parameters', () => {
    expect(screenName(['(tabs)', '(profile)', 'leaderboard'])).toBe('leaderboard');
    expect(screenName(['(tabs)', '(admin)', 'dev-mode'])).toBe('dev-mode');
    expect(screenName(['bin', '[id]'])).toBe('bin/[id]');
    expect(screenName(['reveal'])).toBe('reveal');
  });

  it('names an index route after its group', () => {
    expect(screenName(['(tabs)', '(map)'])).toBe('map');
    expect(screenName([])).toBe('root');
  });
});
