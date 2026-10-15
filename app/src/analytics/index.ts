// Usage analytics (docs/ANALYTICS.md): `track(name, props)` from anywhere in
// the app. Events go into a memory buffer, then in batches into a SQLite queue
// on the phone, then to log_events on the server. <AnalyticsTracker/> in the
// root layout drives sessions, screen views, the app state and the timers.
// Never blocking, never a crash: every entry point swallows its errors.

import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';

import { describeError, devLog } from '@/lib/devlog';
import { supabase } from '@/lib/supabase';

import type { EventName, EventProps } from './events';
import { createEventQueue } from './queue';
import { createSessionTracker, type SessionState } from './session';
import { createSqliteStore } from './store';
import { sendEvents, type Scalar } from './wire';

export type { EventName, EventProps } from './events';

const SESSION_KEY = 'analytics.session';
const APP_VERSION = Constants.expoConfig?.version ?? null;

function log(message: string, detail?: unknown) {
  devLog('analytics', false, { message, detail: detail instanceof Error ? describeError(detail) : detail });
}

const queue = createEventQueue({
  store: createSqliteStore(),
  transport: (events) => sendEvents((fn, args) => supabase.rpc(fn, args), events, Platform.OS),
  now: Date.now,
  log,
});

function enqueue<N extends EventName>(name: N, props: EventProps[N], session: SessionState, isTest: boolean) {
  queue.add({
    id: randomUUID(),
    userId: session.userId,
    sessionId: session.sessionId,
    name,
    props: props as Record<string, Scalar>,
    clientTs: new Date().toISOString(),
    isTest,
    appVersion: APP_VERSION,
    updateId: Updates.isEnabled ? (Updates.updateId ?? null) : null,
  });
}

// The session survives a restart in localStorage (expo-sqlite's, installed by
// lib/supabase), so the next start can send its session_end.
const sessions = createSessionTracker({
  now: Date.now,
  uuid: randomUUID,
  load: () => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? (JSON.parse(raw) as SessionState) : null;
    } catch {
      return null;
    }
  },
  save: (session) => {
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch (error) {
      log('could not save the session', error);
    }
  },
  emit: (name, props, session) => enqueue(name, props, session, false),
});

/**
 * Logs an event for the signed-in user, in the current session. Without a
 * user it is dropped. `isTest`: events from Dev mode previews.
 */
export function track<N extends EventName>(name: N, props: EventProps[N], options?: { isTest?: boolean }): void {
  try {
    const session = sessions.current;
    if (session) enqueue(name, props, session, options?.isTest ?? false);
  } catch (error) {
    log('track failed', error);
  }
}

/**
 * Holds persisting and sending while a reveal or celebration plays; returns
 * the release. In a screen: `useEffect(() => holdAnalytics(), [])`.
 */
export function holdAnalytics(): () => void {
  return queue.hold();
}

function safely(what: string, task: () => void) {
  try {
    task();
  } catch (error) {
    log(`${what} failed`, error);
  }
}

const flush = () => void queue.flush(sessions.current?.userId ?? null);

/** For <AnalyticsTracker/> only. */
export const analyticsLifecycle = {
  start(userId: string | null) {
    safely('start', () => sessions.coldStart(userId));
    flush();
  },
  userChanged(userId: string | null) {
    safely('user change', () => sessions.userChanged(userId));
    flush();
  },
  background() {
    safely('background', () => sessions.background());
    flush();
  },
  foreground() {
    safely('foreground', () => sessions.foreground());
    flush();
  },
  persist() {
    void queue.persist();
  },
  tick() {
    safely('touch', () => sessions.touch());
    flush();
  },
};
