import { describe, expect, it } from '@jest/globals';

import { flightTargets } from '../layout';

describe('flightTargets', () => {
  // A 340 pt wide column: the anchor on top, the bins row, the total, the context line.
  const rects = {
    anchor: { x: 0, y: 100, width: 340, height: 30 },
    row: { x: 30, y: 146, width: 280, height: 64 },
    chips: { x: 0, y: 0, width: 120, height: 64 },
    mult: { x: 160, y: 0, width: 120, height: 64 },
    total: { x: 110, y: 234, width: 120, height: 132 },
    context: { x: 60, y: 402, width: 220, height: 16 },
  };

  it('gives the centre of every target, seen from the anchor centre', () => {
    expect(flightTargets(rects)).toEqual({
      chips: { x: 30 + 60 - 170, y: 146 + 32 - 115 },
      mult: { x: 30 + 160 + 60 - 170, y: 146 + 32 - 115 },
      total: { x: 0, y: 234 + 66 - 115 },
      context: { x: 0, y: 402 + 8 - 115 },
    });
  });

  it('is null until every part is measured', () => {
    const { context: _, ...missing } = rects;
    expect(flightTargets(missing)).toBeNull();
    expect(flightTargets({})).toBeNull();
  });
});
