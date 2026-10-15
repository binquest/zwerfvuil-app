import { describe, expect, it } from '@jest/globals';

import { bonusArc, multiplierLabel, particle, shakeOffset } from '../motion';

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

describe('multiplierLabel', () => {
  it('goes from ×1,00 to ×2,14 over eight stages', () => {
    expect(multiplierLabel(0)).toBe('×1,00');
    expect(multiplierLabel(1)).toBe('×1,10');
    expect(multiplierLabel(8)).toBe('×2,14');
  });
});
