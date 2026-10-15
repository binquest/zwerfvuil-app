// Test helpers for the golden reveal (reveal-v1.json): the timelines of the
// reveal as they were before the steps came from the server (phase 2, made
// from commit 6609a29), as a hash per case, so a test can prove that the new
// timeline plays exactly the same events and mixes exactly the same sound.

/** Every case of the golden file: base points, streak weeks, Reduce Motion, bonus question. */
export const GOLDEN_CASES = [10, 1, 7, 250].flatMap((base) =>
  Array.from({ length: 11 }, (_, weeks) => weeks).flatMap((weeks) =>
    [false, true].flatMap((reduceMotion) => [false, true].map((bonus) => ({ base, weeks, reduceMotion, bonus }))),
  ),
);

export type GoldenCase = (typeof GOLDEN_CASES)[number];

export const caseKey = (c: GoldenCase) => `${c.base}/${c.weeks}/${c.reduceMotion ? 'reduce' : 'motion'}/${c.bonus ? 'bonus' : 'plain'}`;

/**
 * JSON with sorted keys, numbers rounded to 9 decimals: the multiplier of a
 * mult event was 1.1 ** stage in JavaScript (1.2100000000000002) and is the
 * server's 1.21 now.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === 'number') return Math.round(v * 1e9) / 1e9;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    }
    return v;
  });
}

/** djb2, as a short stable fingerprint of a canonical string. */
export function fingerprint(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${hash.toString(36)}-${text.length}`;
}
