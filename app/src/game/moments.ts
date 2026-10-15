// What appears when the app opens, in one queue (docs/GAMIFICATION.md,
// chapter 5): the rules of the MomentsPresenter, pure and unit tested.
//   - One order for everything: onboarding, update ready, the approval
//     celebration, missed moments, the notification question, chest ready.
//   - Only on a tab screen without an open modal, and one at a time.
//   - A warm start is background -> active only (not Control Center or a
//     permission dialog, which go through inactive).

export const MOMENT_ORDER = ['onboarding', 'update', 'approval', 'missed', 'notifications', 'chest'] as const;

export type MomentKind = (typeof MOMENT_ORDER)[number];

export interface Moment {
  kind: MomentKind;
  /** Unique per moment (e.g. "approval:<until>"), so the same one is never queued twice. */
  key: string;
}

export type AppStart = 'cold' | 'warm';

/** The moment to show next: the earliest kind in MOMENT_ORDER, then the one queued first. */
export function nextMoment<M extends Moment>(queue: readonly M[]): M | null {
  let best: M | null = null;
  for (const moment of queue) {
    if (!best || MOMENT_ORDER.indexOf(moment.kind) < MOMENT_ORDER.indexOf(best.kind)) best = moment;
  }
  return best;
}

/** Adds `moment` unless one with its key is queued already. */
export function enqueueMoment<M extends Moment>(queue: readonly M[], moment: M): M[] {
  return queue.some((m) => m.key === moment.key) ? [...queue] : [...queue, moment];
}

/** True on a tab screen with nothing on top (no camera, reveal, sheet or celebration) and nothing showing. */
export function canPresent(segments: readonly string[], presenting: boolean): boolean {
  return !presenting && segments[0] === '(tabs)';
}

/** The kind of start a change of app state is: the first active state is cold, background -> active warm. */
export function appStart(previous: string | null, next: string): AppStart | null {
  if (next !== 'active') return null;
  if (previous === null) return 'cold';
  return previous === 'background' ? 'warm' : null;
}
