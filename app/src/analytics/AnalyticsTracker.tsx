import { useSegments } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { analyticsLifecycle, track } from './index';
import { screenName } from './props';

/** Memory buffer into the SQLite queue. */
const PERSIST_MS = 5_000;
/** Queue to the server (also when going to the background and at the next start). */
const SEND_MS = 30_000;

/**
 * Drives analytics from the root layout: the cold start, sign-in and
 * sign-out, the app going to and coming back from the background, screen
 * views and the timers. Renders nothing.
 */
export function AnalyticsTracker({ userId }: { userId: string | null }) {
  const started = useRef(false);
  const screen = screenName(useSegments());

  // Before the screen view below: a cold start opens the session first.
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      analyticsLifecycle.start(userId);
    } else {
      analyticsLifecycle.userChanged(userId);
    }
  }, [userId]);

  // 'root': no route yet (the navigator is still starting).
  useEffect(() => {
    if (screen !== 'root') track('screen_view', { screen });
  }, [screen]);

  useEffect(() => {
    // Only background -> active is a warm start (the tracker ignores
    // 'active' after Control Center or a permission prompt: 'inactive').
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') analyticsLifecycle.background();
      else if (state === 'active') analyticsLifecycle.foreground();
    });
    const persist = setInterval(analyticsLifecycle.persist, PERSIST_MS);
    const send = setInterval(analyticsLifecycle.tick, SEND_MS);
    return () => {
      subscription.remove();
      clearInterval(persist);
      clearInterval(send);
    };
  }, []);

  return null;
}
