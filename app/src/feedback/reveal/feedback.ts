// Turns the haptic events of a timeline into haptics. Its sound events are
// already in the mixed soundtrack (sfx/soundtrack.ts); the screen handles the
// visual events itself.
import { fireHaptic } from '../haptics';
import type { Event } from './timeline';

/** Fires the haptic of `event`; true for every haptic or sound event, false for a visual one. */
export function playFeedback(event: Event): boolean {
  if (event.type === 'haptic') {
    fireHaptic(event.kind);
    return true;
  }
  return event.type === 'sound' || event.type === 'soundStop';
}
