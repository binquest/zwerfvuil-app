import { describe, expect, it } from '@jest/globals';

import { distanceMeters } from '../geo';
import { INITIAL_MAP_REGION, isInRegion, REGION_BBOX, REGION_CENTER, REGION_RADIUS_M } from '../region';

describe('test region', () => {
  it('is centred on the Oude Houtlei in Gent', () => {
    expect(distanceMeters(REGION_CENTER, { latitude: 51.0523, longitude: 3.7169 })).toBeLessThan(50);
  });

  it('knows what is inside the bbox', () => {
    expect(isInRegion(REGION_CENTER)).toBe(true);
    expect(isInRegion({ latitude: 51.056, longitude: 3.714 })).toBe(true);
    expect(isInRegion({ latitude: 51.0357, longitude: 3.7106 })).toBe(false); // station Gent-Sint-Pieters
  });

  it('loads bins from a radius that covers every corner of the bbox', () => {
    const corners = [
      { latitude: REGION_BBOX.north, longitude: REGION_BBOX.east },
      { latitude: REGION_BBOX.north, longitude: REGION_BBOX.west },
      { latitude: REGION_BBOX.south, longitude: REGION_BBOX.east },
      { latitude: REGION_BBOX.south, longitude: REGION_BBOX.west },
    ];
    for (const corner of corners) expect(distanceMeters(REGION_CENTER, corner)).toBeLessThan(REGION_RADIUS_M);
    expect(REGION_RADIUS_M).toBeLessThanOrEqual(5000); // nearby_bins limit
  });

  it('starts the map on the whole region', () => {
    expect(INITIAL_MAP_REGION.latitudeDelta).toBeGreaterThan(REGION_BBOX.north - REGION_BBOX.south);
    expect(INITIAL_MAP_REGION.longitudeDelta).toBeGreaterThan(REGION_BBOX.east - REGION_BBOX.west);
  });
});
