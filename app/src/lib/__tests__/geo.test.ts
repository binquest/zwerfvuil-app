import { describe, expect, it } from '@jest/globals';

import {
  checkinAvailability,
  distanceMeters,
  formatDistance,
  nearestEligibleBin,
  type Position,
} from '../geo';

// ~1 m of latitude in degrees.
const M = 1 / 111_195;
const ORIGIN = { latitude: 51.0523, longitude: 3.7169 };
const at = (metersNorth: number) => ({ latitude: ORIGIN.latitude + metersNorth * M, longitude: ORIGIN.longitude });
const position = (metersNorth: number, accuracy: number | null = 5, fake = false): Position => ({
  ...at(metersNorth),
  accuracy,
  fake,
});

describe('distanceMeters', () => {
  it('measures short distances to within a few centimetres', () => {
    expect(distanceMeters(ORIGIN, at(25))).toBeCloseTo(25, 1);
  });

  it('is zero for the same point and symmetric', () => {
    expect(distanceMeters(ORIGIN, ORIGIN)).toBe(0);
    expect(distanceMeters(ORIGIN, at(100))).toBeCloseTo(distanceMeters(at(100), ORIGIN), 6);
  });
});

describe('nearestEligibleBin', () => {
  const bins = [
    { id: 1, ...at(5), eligible: false },
    { id: 2, ...at(40), eligible: true },
    { id: 3, ...at(12), eligible: true },
  ];

  it('picks the closest eligible bin and ignores excluded ones', () => {
    const nearest = nearestEligibleBin(bins, ORIGIN);
    expect(nearest?.bin.id).toBe(3);
    expect(nearest?.distanceM).toBeCloseTo(12, 1);
  });

  it('returns null without eligible bins', () => {
    expect(nearestEligibleBin([bins[0]], ORIGIN)).toBeNull();
    expect(nearestEligibleBin([], ORIGIN)).toBeNull();
  });
});

describe('checkinAvailability', () => {
  it('is enabled within 25 m with a good fix', () => {
    expect(checkinAvailability(position(0, 8), { distanceM: 24.9 })).toEqual({
      enabled: true,
      message: 'Je staat bij een vuilbak (25 m).',
    });
  });

  it('is disabled beyond 25 m and says how far to go', () => {
    const result = checkinAvailability(position(0), { distanceM: 62 });
    expect(result.enabled).toBe(false);
    expect(result.message).toBe('Nog 37 m tot je dicht genoeg bij een vuilbak bent.');
  });

  it('is disabled with an inaccurate or unknown fix', () => {
    expect(checkinAvailability(position(0, 31), { distanceM: 3 }).enabled).toBe(false);
    expect(checkinAvailability(position(0, null), { distanceM: 3 }).message).toContain('±? m');
  });

  it('ignores accuracy for the dev fake location', () => {
    expect(checkinAvailability(position(0, null, true), { distanceM: 3 }).enabled).toBe(true);
  });

  it('explains missing location or bins', () => {
    expect(checkinAvailability(null, { distanceM: 3 }).message).toBe('Je locatie wordt bepaald…');
    expect(checkinAvailability(position(0), null).enabled).toBe(false);
  });
});

describe('formatDistance', () => {
  it('formats metres and kilometres the Belgian way', () => {
    expect(formatDistance(7.6)).toBe('8 m');
    expect(formatDistance(999.4)).toBe('999 m');
    expect(formatDistance(1234)).toBe('1,2 km');
    expect(formatDistance(-3)).toBe('0 m');
  });
});
