// The test region (Oude Houtlei, Gent + 600 m), shared with the OSM scripts.
import region from '../../../config/region.json';
import { distanceMeters, type LatLon } from './geo';

export const REGION_NAME = region.name;
export const REGION_CENTER: LatLon = { latitude: region.center.lat, longitude: region.center.lon };
export const REGION_BBOX = region.bbox;

export const REGION_OUTLINE: LatLon[] = [
  { latitude: region.bbox.south, longitude: region.bbox.west },
  { latitude: region.bbox.south, longitude: region.bbox.east },
  { latitude: region.bbox.north, longitude: region.bbox.east },
  { latitude: region.bbox.north, longitude: region.bbox.west },
];

export function isInRegion(point: LatLon): boolean {
  const { west, south, east, north } = region.bbox;
  return point.longitude >= west && point.longitude <= east && point.latitude >= south && point.latitude <= north;
}

/** Map region showing the whole test area with a small margin. */
export const INITIAL_MAP_REGION = {
  ...REGION_CENTER,
  latitudeDelta: (region.bbox.north - region.bbox.south) * 1.1,
  longitudeDelta: (region.bbox.east - region.bbox.west) * 1.1,
};

/** Radius around the centre that covers the whole bbox, for nearby_bins. */
export const REGION_RADIUS_M = Math.ceil(
  distanceMeters(REGION_CENTER, { latitude: region.bbox.north, longitude: region.bbox.east }) + 50,
);
