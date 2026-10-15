// What the reveal shows (the number, the MULT badge, whether it landed),
// derived from its events: the screen applies every event as it plays, and a
// skip, the app going to the background or VoiceOver jump to endState(events).
// Both come from the same reducer, so skipping at any moment ends exactly where
// playing it out does (tested).
import type { Event } from './timeline';

export interface RevealState {
  /** The big number. */
  value: number;
  /** PUNTEN once a step set it (a discovery, a step that adds chips); null while it follows the base count. */
  chips: number | null;
  /** The streak stages shown so far. */
  stage: number;
  /** The combined multiplier on the MULT badge (from the server's stage). */
  multiplier: number;
  /** The streak reached its maximum ("MULT · MAX"). */
  max: boolean;
  /** The total has slammed in. */
  landed: boolean;
  /** The chips a discovery added (0 = no discovery, or not yet). */
  discovery: number;
}

export const INITIAL_REVEAL_STATE: RevealState = {
  value: 0,
  chips: null,
  stage: 0,
  multiplier: 1,
  max: false,
  landed: false,
  discovery: 0,
};

/** The state after `event`; the same object when the event changes nothing shown. */
export function applyRevealEvent(state: RevealState, event: Event): RevealState {
  switch (event.type) {
    case 'count':
      return { ...state, value: event.value };
    case 'mult':
      return { ...state, value: event.total, stage: event.stage, multiplier: event.multiplier, max: state.max || event.max };
    case 'slam':
      return { ...state, value: event.to, landed: true };
    case 'bins':
      return {
        ...state,
        value: event.total,
        chips: event.chips ?? state.chips,
        multiplier: event.multiplier ?? state.multiplier,
        discovery: state.discovery + event.discovery,
      };
    default:
      return state;
  }
}

/** Where the reveal of `events` ends. */
export function endState(events: readonly Event[], from: RevealState = INITIAL_REVEAL_STATE): RevealState {
  return events.reduce(applyRevealEvent, from);
}

/** "×1,00" .. "×2,14": the MULT badge, always two decimals. */
export function multiplierLabel(multiplier: number): string {
  return `×${multiplier.toFixed(2).replace('.', ',')}`;
}
