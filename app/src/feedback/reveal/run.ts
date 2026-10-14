// Plays a timeline: every event at its absolute time from the start, all events
// with the same time in one call (so a sound, its haptic and its state change
// happen in the same JS tick). Each delay is computed again from the start time,
// so late timers do not add up into drift; if the JS thread was blocked, the
// events that are due run at once, in order.
import type { Event } from './timeline';

export interface TimelineRun {
  /** Stops everything that has not run yet. */
  cancel(): void;
}

/** `lateMs`: how long after its planned time the batch runs (for the Dev mode diagnostics). */
export function runTimeline(
  events: readonly Event[],
  onEvents: (batch: Event[], lateMs: number) => void,
  now: () => number = () => performance.now(),
): TimelineRun {
  const batches: { atMs: number; events: Event[] }[] = [];
  for (const event of events) {
    const last = batches.at(-1);
    if (last && last.atMs === event.atMs) last.events.push(event);
    else batches.push({ atMs: event.atMs, events: [event] });
  }
  batches.sort((a, b) => a.atMs - b.atMs);

  const start = now();
  let next = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const step = () => {
    timer = null;
    while (!cancelled && next < batches.length && start + batches[next].atMs <= now()) {
      const batch = batches[next++];
      try {
        onEvents(batch.events, now() - (start + batch.atMs));
      } catch (error) {
        // One failing event must not stop the rest of the reveal.
        console.warn('reveal event failed', error);
      }
    }
    if (cancelled || next >= batches.length) return;
    timer = setTimeout(step, Math.max(0, start + batches[next].atMs - now()));
  };
  step();

  return {
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
