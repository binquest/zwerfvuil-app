import { describe, expect, it } from '@jest/globals';

import { BADGE_OFFSET, badgeCentre, bonusArc, particle, shakeOffset } from '../motion';

describe('shakeOffset', () => {
  it('is still at the start and the end', () => {
    expect(shakeOffset(0, 8, 2)).toEqual({ x: 0, y: 0, rotation: 0 });
    expect(shakeOffset(1, 8, 2)).toEqual({ x: 0, y: 0, rotation: 0 });
  });

  it('stays within its amplitude and dies down', () => {
    let early = 0;
    let late = 0;
    for (let i = 1; i < 100; i++) {
      const t = i / 100;
      const { x, y, rotation } = shakeOffset(t, 8, 2);
      expect(Math.abs(x)).toBeLessThanOrEqual(8);
      expect(Math.abs(y)).toBeLessThanOrEqual(8 * 0.6);
      expect(Math.abs(rotation)).toBeLessThanOrEqual(2);
      if (t < 0.3) early = Math.max(early, Math.abs(x));
      if (t > 0.7) late = Math.max(late, Math.abs(x));
    }
    expect(late).toBeLessThan(early / 4);
  });
});

describe('bonusArc', () => {
  const from = { x: 0, y: 300 };
  const to = { x: 95, y: -55 };

  it('starts below the number and lands on the badge', () => {
    expect(bonusArc(0, from, to, 120)).toEqual(from);
    expect(bonusArc(1, from, to, 120)).toEqual(to);
  });

  it('rises above the badge on the way', () => {
    const highest = Math.min(...Array.from({ length: 101 }, (_, i) => bonusArc(i / 100, from, to, 120).y));
    expect(highest).toBeLessThan(to.y);
  });
});

describe('badgeCentre', () => {
  it('is on the top-right corner of the number, whatever its width', () => {
    for (const width of [80, 170, 320]) {
      const { x, y } = badgeCentre(width, 132);
      // The badge (52 wide) ends BADGE_OFFSET.right outside the right edge of the number.
      expect(x + 26).toBeCloseTo(width / 2 - BADGE_OFFSET.right, 5);
      expect(y - 16).toBeCloseTo(-132 / 2 + BADGE_OFFSET.top, 5);
    }
  });

  it('never covers a digit: the whole badge is right of the number', () => {
    for (const width of [80, 170, 320]) {
      const { x } = badgeCentre(width, 132);
      expect(x - 26).toBeGreaterThan(width / 2);
    }
  });

  it('stays on a 375 pt wide screen even for the widest number', () => {
    // The number is centred on the screen; its widest (four digits at 84 pt) is about 200 pt.
    const { x } = badgeCentre(200, 132);
    expect(375 / 2 + x + 26).toBeLessThan(375);
  });
});

describe('particle', () => {
  it('only shows the particles of this burst, while it runs', () => {
    expect(particle(15, 12, 0.5).opacity).toBe(0);
    expect(particle(3, 12, 0).opacity).toBe(0);
    expect(particle(3, 12, 1).opacity).toBe(0);
    expect(particle(3, 12, 0.5).opacity).toBe(0.5);
  });

  it('flies outwards as the burst runs', () => {
    const near = particle(2, 12, 0.1);
    const far = particle(2, 12, 0.8);
    expect(Math.hypot(far.x, far.y)).toBeGreaterThan(Math.hypot(near.x, near.y));
  });
});
