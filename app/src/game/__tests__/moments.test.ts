import { describe, expect, it } from '@jest/globals';

import { appStart, canPresent, enqueueMoment, nextMoment, type Moment } from '../moments';
import { progressFraction } from '../progress';
import { activeViewport } from '../toasts';

describe('the moments queue', () => {
  it('shows the earliest kind first, then the one queued first', () => {
    const queue: Moment[] = [
      { kind: 'chest', key: 'chest:1' },
      { kind: 'missed', key: 'missed:1' },
      { kind: 'approval', key: 'approval:1' },
      { kind: 'missed', key: 'missed:2' },
    ];
    expect(nextMoment(queue)?.key).toBe('approval:1');
    expect(nextMoment(queue.filter((m) => m.kind !== 'approval'))?.key).toBe('missed:1');
    expect(nextMoment([])).toBeNull();
  });

  it('never queues the same moment twice', () => {
    const once = enqueueMoment([], { kind: 'chest', key: 'chest:2026-10-15' });
    expect(enqueueMoment(once, { kind: 'chest', key: 'chest:2026-10-15' })).toHaveLength(1);
  });

  it('presents only on a tab screen with nothing on top', () => {
    expect(canPresent(['(tabs)', '(map)'], false)).toBe(true);
    expect(canPresent(['(tabs)', '(map)'], true)).toBe(false);
    for (const modal of [['camera'], ['reveal'], ['bin', '[id]'], ['login'], []]) expect(canPresent(modal, false)).toBe(false);
  });

  it('counts a cold start and background -> active as starts, not Control Center or a dialog', () => {
    expect(appStart(null, 'active')).toBe('cold');
    expect(appStart('background', 'active')).toBe('warm');
    expect(appStart('inactive', 'active')).toBeNull();
    expect(appStart('active', 'background')).toBeNull();
    expect(appStart(null, 'background')).toBeNull();
  });
});

describe('toasts', () => {
  it('show on the viewport registered last, unless it holds them', () => {
    expect(activeViewport([])).toBeNull();
    expect(activeViewport([{ id: 1, hold: false }])).toBe(1);
    expect(activeViewport([{ id: 1, hold: false }, { id: 2, hold: false }])).toBe(2);
    // The reveal is on top: the toast waits instead of appearing behind it.
    expect(activeViewport([{ id: 1, hold: false }, { id: 3, hold: true }])).toBeNull();
  });
});

describe('progressFraction', () => {
  it('is 0..1 for any input', () => {
    expect([progressFraction(3, 10), progressFraction(12, 10), progressFraction(-1, 10)]).toEqual([0.3, 1, 0]);
    expect([progressFraction(3, 0), progressFraction(Number.NaN, 10)]).toEqual([0, 0]);
  });
});
