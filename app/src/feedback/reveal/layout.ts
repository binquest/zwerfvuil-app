// Where the pop-ups of the reveal fly to: the centres of the bins, the total
// and the context line, as offsets from the centre of the pop-up anchor. The
// screen measures them with onLayout (all in the same column); pure, so it is
// unit tested.
import type { PopupTarget } from './timeline';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FlightTargets = Record<PopupTarget, { x: number; y: number }>;

/** The measured parts: the anchor, the bins row and its two bins (relative to the row), the total and the context line. */
export type RevealRects = Partial<Record<'anchor' | 'row' | 'chips' | 'mult' | 'total' | 'context', Rect>>;

/** The offsets of every target from the anchor's centre, or null until every part is measured. */
export function flightTargets(r: RevealRects): FlightTargets | null {
  const { anchor, row, chips, mult, total, context } = r;
  if (!anchor || !row || !chips || !mult || !total || !context) return null;
  const cx = anchor.x + anchor.width / 2;
  const cy = anchor.y + anchor.height / 2;
  const centre = (x: number, y: number, rect: Rect) => ({ x: x + rect.width / 2 - cx, y: y + rect.height / 2 - cy });
  return {
    chips: centre(row.x + chips.x, row.y + chips.y, chips),
    mult: centre(row.x + mult.x, row.y + mult.y, mult),
    total: centre(total.x, total.y, total),
    context: centre(context.x, context.y, context),
  };
}
