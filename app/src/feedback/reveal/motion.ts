// The math behind the reveal's motion, as worklets: pure functions that run on
// the UI thread inside Reanimated styles, and in unit tests as plain functions.

const TWO_PI = Math.PI * 2;

/** Oscillations of a shake over its whole duration (sideways, up-down, rotation). */
const SHAKE_CYCLES = { x: 5, y: 7, rotation: 4 };

/**
 * A decaying sine shake at progress `t` (0..1): strong at the start, still at
 * the end. The three axes run at different speeds so it never looks like a
 * straight line.
 */
export function shakeOffset(t: number, px: number, rotationDeg: number): { x: number; y: number; rotation: number } {
  'worklet';
  if (t <= 0 || t >= 1) return { x: 0, y: 0, rotation: 0 };
  const decay = (1 - t) * (1 - t);
  return {
    x: px * Math.sin(t * TWO_PI * SHAKE_CYCLES.x) * decay,
    y: px * 0.6 * Math.sin(t * TWO_PI * SHAKE_CYCLES.y + 1.3) * decay,
    rotation: rotationDeg * Math.sin(t * TWO_PI * SHAKE_CYCLES.rotation) * decay,
  };
}

/** Where the flying "+5" chip is at progress `t`: an arc from below the number to its badge. */
export function bonusArc(t: number, from: { x: number; y: number }, to: { x: number; y: number }, lift: number): { x: number; y: number } {
  'worklet';
  const u = Math.min(1, Math.max(0, t));
  const controlY = Math.min(from.y, to.y) - lift;
  return {
    x: from.x + (to.x - from.x) * u,
    y: (1 - u) * (1 - u) * from.y + 2 * (1 - u) * u * controlY + u * u * to.y,
  };
}

/** The badge's own size, roughly: the flying chip aims at its centre. */
const BADGE_SIZE = { width: 52, height: 32 };
/** Space between the number and its badge. */
const BADGE_GAP = 6;
/** The +5 badge sits just right of the number, level with its top, never over a digit (style offsets). */
export const BADGE_OFFSET = { right: -(BADGE_SIZE.width + BADGE_GAP), top: -14 };

/** Where the badge's centre is, relative to the centre of a number box of `width` × `height`. */
export function badgeCentre(width: number, height: number): { x: number; y: number } {
  'worklet';
  return {
    x: width / 2 - BADGE_OFFSET.right - BADGE_SIZE.width / 2,
    y: -height / 2 + BADGE_OFFSET.top + BADGE_SIZE.height / 2,
  };
}

/** Particle `index` of `count` at burst progress `t`: flies out from the number and fades. */
export function particle(index: number, count: number, t: number): { x: number; y: number; opacity: number; scale: number } {
  'worklet';
  if (index >= count || t <= 0 || t >= 1) return { x: 0, y: 0, opacity: 0, scale: 0 };
  // A fixed pseudo-random spread per particle, so every burst looks alike.
  const wobble = Math.sin((index + 1) * 12.9898) * 0.35;
  const angle = (index / count) * TWO_PI + wobble;
  const distance = (90 + (index % 3) * 30) * (1 - (1 - t) * (1 - t) * (1 - t));
  return {
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
    opacity: 1 - t,
    scale: 1 - 0.6 * t,
  };
}

/** "×1,00" .. "×2,14": the combined multiplier after `stage` stages, in Dutch notation. */
export function multiplierLabel(stage: number, multiplier = 1.1): string {
  return `×${(multiplier ** stage).toFixed(2).replace('.', ',')}`;
}
