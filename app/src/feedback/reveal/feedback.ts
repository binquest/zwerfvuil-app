// Turns the sound and haptic events of a timeline into sound and haptics. The
// screen handles the visual events itself.
import { fireHaptic } from '../haptics';
import { loop, play, stopLoop } from '../sfx/engine';
import type { Event } from './timeline';

/**
 * Plays the sound or haptic of `event` and returns true; returns false for a
 * visual event. With `withSound` false (the sounds were not ready in time) only
 * the haptics play.
 */
export function playFeedback(event: Event, withSound: boolean): boolean {
  switch (event.type) {
    case 'sound':
      if (withSound) {
        if (event.loop) loop(event.id, event.volume);
        else play(event.id, event.volume);
      }
      return true;
    case 'soundStop':
      if (withSound) stopLoop(event.id);
      return true;
    case 'haptic':
      fireHaptic(event.kind);
      return true;
    default:
      return false;
  }
}
