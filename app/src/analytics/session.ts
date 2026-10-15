// Sessions (docs/ANALYTICS.md): a new session at a cold start, at a sign-in,
// and when the app comes back after more than 30 minutes in the background.
// session_end is sent as soon as it is certain that a session is over: at the
// next start, the next sign-in or the return after the gap. Pure logic with
// injected I/O, unit tested in __tests__/session.test.ts.

import type { EventName, EventProps } from './events';

export const SESSION_GAP_MS = 30 * 60_000;

export interface SessionState {
  sessionId: string;
  userId: string;
  startedAt: number;
  /** Last moment the app was certainly in use; ends the session's duration. */
  lastActiveAt: number;
}

export type Emit = <N extends EventName>(name: N, props: EventProps[N], session: SessionState) => void;

export interface SessionDeps {
  now: () => number;
  uuid: () => string;
  /** The session of the previous run, if any (survives a restart). */
  load: () => SessionState | null;
  save: (session: SessionState | null) => void;
  emit: Emit;
}

export interface SessionTracker {
  readonly current: SessionState | null;
  /** The app starts, with the signed-in user (or none). */
  coldStart(userId: string | null): void;
  /** Sign-in, sign-out or another account. */
  userChanged(userId: string | null): void;
  /** AppState went to 'background'. */
  background(): void;
  /** AppState went from 'background' to 'active' ('inactive' does not count). */
  foreground(): void;
  /** The app is in use: keeps the end of the session up to date. */
  touch(): void;
}

const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000));

export function createSessionTracker(deps: SessionDeps): SessionTracker {
  let current: SessionState | null = null;
  let foregroundSince = deps.now();
  let inBackground = false;

  const save = () => deps.save(current ? { ...current } : null);

  const end = (session: SessionState) =>
    deps.emit('session_end', { duration_s: seconds(session.lastActiveAt - session.startedAt) }, session);

  const begin = (userId: string) => {
    const at = deps.now();
    current = { sessionId: deps.uuid(), userId, startedAt: at, lastActiveAt: at };
    save();
    deps.emit('session_start', {}, current);
  };

  return {
    get current() {
      return current;
    },

    coldStart(userId) {
      const previous = deps.load();
      if (previous) end(previous);
      current = null;
      save();
      inBackground = false;
      foregroundSince = deps.now();
      if (!userId) return;
      begin(userId);
      deps.emit('app_open', { kind: 'cold' }, current!);
    },

    userChanged(userId) {
      if ((current?.userId ?? null) === userId) return;
      if (current) {
        current.lastActiveAt = deps.now();
        end(current);
      }
      current = null;
      save();
      if (userId) begin(userId);
    },

    background() {
      if (inBackground) return;
      inBackground = true;
      if (!current) return;
      const at = deps.now();
      deps.emit('app_background', { foreground_s: seconds(at - foregroundSince) }, current);
      current.lastActiveAt = at;
      save();
    },

    foreground() {
      if (!inBackground) return;
      inBackground = false;
      const at = deps.now();
      foregroundSince = at;
      if (!current) return;
      if (at - current.lastActiveAt > SESSION_GAP_MS) {
        end(current);
        begin(current.userId);
      } else {
        current.lastActiveAt = at;
        save();
      }
      deps.emit('app_open', { kind: 'warm' }, current!);
    },

    touch() {
      if (!current || inBackground) return;
      current.lastActiveAt = deps.now();
      save();
    },
  };
}
