// Local notifications in the app (docs/GAMIFICATION.md, phase 7): plans them
// again after every fresh my_game_state (at every opening and after every
// check-in; offline the previous plan stays), counts a notification shown in
// the open app as answered, and opens the right screen on a tap, also on a
// cold start (getLastNotificationResponse). Opening waits for a tab screen
// with nothing on top, so it never jumps over the camera or a celebration.
import * as Notifications from 'expo-notifications';
import { router, useSegments } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { track } from '@/analytics';
import { lastHandledTap, markTapHandled } from '@/notifications/memory';
import { notificationTarget, parseNotificationData, type NotificationData } from '@/notifications/planner';
import { clearNotifications, installNotificationHandler, noteAnswered, syncNotifications } from '@/notifications/scheduler';
import { useGame } from '@/providers/GameProvider';

installNotificationHandler();

/** Mounted while signed in; `ready` once the app (not the onboarding) shows. */
export function NotificationCenter({ ready }: { ready: boolean }) {
  const { state, loadError } = useGame();
  const segments = useSegments();
  const [target, setTarget] = useState<NotificationData | null>(null);

  // A new state object = a fresh my_game_state.
  useEffect(() => {
    if (state) void syncNotifications(state);
  }, [state]);

  // Signed out: nothing of this player may still come.
  useEffect(() => () => void clearNotifications(), []);

  useEffect(() => {
    const handle = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const id = response.notification.request.identifier;
      Notifications.clearLastNotificationResponse();
      // A cold start's tap can come twice (the last response and the listener).
      if (lastHandledTap() === id) return;
      markTapHandled(id);
      const data = parseNotificationData(response.notification.request.content.data);
      if (!data) return;
      if (data.source === 'planner') void noteAnswered(id);
      track('notification_opened', { type: data.type }, { isTest: data.source === 'test' });
      setTarget(data);
    };
    handle(Notifications.getLastNotificationResponse());
    const tapped = Notifications.addNotificationResponseReceivedListener(handle);
    const received = Notifications.addNotificationReceivedListener((notification) => {
      if (parseNotificationData(notification.request.content.data)?.source === 'planner') {
        void noteAnswered(notification.request.identifier);
      }
    });
    return () => {
      tapped.remove();
      received.remove();
    };
  }, []);

  const opened = useRef<NotificationData | null>(null);
  useEffect(() => {
    if (!target || opened.current === target || !ready || segments[0] !== '(tabs)') return;
    // A chest: first know whether it is still ready (the state of this start).
    if (target.type === 'chest' && !state && !loadError) return;
    opened.current = target;
    const to = notificationTarget(target, state?.today?.chestsReady ?? null);
    if (to.screen === 'chest') router.push({ pathname: '/chest', params: { day: to.day } });
    else router.navigate('/(tabs)/(today)/today');
  }, [target, ready, segments, state, loadError]);

  return null;
}
