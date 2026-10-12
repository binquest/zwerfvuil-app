// Distances and check-in availability on the client. The server recomputes
// everything with PostGIS; this only drives the UI.

export interface LatLon {
  latitude: number;
  longitude: number;
}

export const CHECKIN_RADIUS_M = 25;
export const MAX_ACCURACY_M = 30;

const EARTH_RADIUS_M = 6371008.8;

/** Great-circle distance in metres (within ~0.3% of the server's spheroid distance). */
export function distanceMeters(a: LatLon, b: LatLon): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The nearest bin that can earn points, or null when there is none. */
export function nearestEligibleBin<T extends LatLon & { eligible: boolean }>(
  bins: readonly T[],
  from: LatLon,
): { bin: T; distanceM: number } | null {
  let best: { bin: T; distanceM: number } | null = null;
  for (const bin of bins) {
    if (!bin.eligible) continue;
    const distanceM = distanceMeters(from, bin);
    if (!best || distanceM < best.distanceM) best = { bin, distanceM };
  }
  return best;
}

export interface Position extends LatLon {
  accuracy: number | null;
  fake: boolean;
}

export type Availability = { enabled: boolean; message: string };

/** Whether the check-in button is active, with a Dutch explanation. */
export function checkinAvailability(
  position: Position | null,
  nearest: { distanceM: number } | null,
): Availability {
  if (!position) return { enabled: false, message: 'Je locatie wordt bepaald…' };
  if (!nearest) return { enabled: false, message: 'Geen vuilbak gevonden in de testregio.' };
  if (!position.fake && (position.accuracy === null || position.accuracy > MAX_ACCURACY_M)) {
    const accuracy = position.accuracy === null ? '?' : Math.round(position.accuracy);
    return { enabled: false, message: `Je gps is nog niet nauwkeurig genoeg (±${accuracy} m). Wacht even.` };
  }
  if (nearest.distanceM > CHECKIN_RADIUS_M) {
    return {
      enabled: false,
      message: `Nog ${formatDistance(nearest.distanceM - CHECKIN_RADIUS_M)} tot je dicht genoeg bij een vuilbak bent.`,
    };
  }
  return { enabled: true, message: `Je staat bij een vuilbak (${formatDistance(nearest.distanceM)}).` };
}

/** "8 m", "137 m", "1,2 km" */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.max(0, Math.round(meters))} m`;
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}
