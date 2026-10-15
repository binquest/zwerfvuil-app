// Helpers that turn app data into event props (unit tested).

import type { DistanceBucket } from './events';

/** Distance to a bin in coarse classes: never the location itself. */
export function distanceBucket(meters: number | null | undefined): DistanceBucket {
  if (meters == null || !Number.isFinite(meters) || meters < 0) return 'unknown';
  if (meters < 10) return '0_10';
  if (meters < 25) return '10_25';
  if (meters < 50) return '25_50';
  return '50_plus';
}

/** Milliseconds rounded to 100 ms, as in the taxonomy (response_ms). */
export const roundTo100 = (ms: number) => Math.max(0, Math.round(ms / 100) * 100);

/**
 * The screen of an Expo Router route, without parameters: the route segments
 * without groups ('(tabs)/(profile)/leaderboard' -> 'leaderboard'), or the
 * last group when there are only groups ('(tabs)/(map)' -> 'map').
 */
export function screenName(segments: readonly string[]): string {
  const named = segments.filter((s) => !(s.startsWith('(') && s.endsWith(')')));
  if (named.length > 0) return named.join('/');
  const group = segments.at(-1);
  return group ? group.slice(1, -1) : 'root';
}
