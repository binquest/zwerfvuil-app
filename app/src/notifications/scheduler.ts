// Local notifications on this phone (docs/GAMIFICATION.md, phase 7): puts the
// planner's plan in iOS with DATE triggers after every fresh my_game_state,
// settles what fired (own plan: tapped, shown in the app or ignored) and
// clears what iOS still shows of ours (getPresentedNotificationsAsync). No
// push: nothing leaves the phone except the events.
import * as Notifications from 'expo-notifications';

import { track } from '@/analytics';
import type { GameState } from '@/game/discoveries';

import { loadRecord, loadSettings, pretendNoCheckinAt, saveRecord, setPretendNoCheckinAt } from './memory';
import {
  answered,
  newlyPlanned,
  parseNotificationData,
  planNotifications,
  pretendStreak,
  settle,
  type NotificationContent,
  type NotificationKind,
  type PlanEntry,
} from './planner';

export type PermissionState = 'granted' | 'denied' | 'undetermined';

/** While the app is open a notification still shows, as a banner. */
export function installNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export async function notificationPermission(): Promise<PermissionState> {
  try {
    const permission = await Notifications.getPermissionsAsync();
    if (permission.granted) return 'granted';
    return permission.status === 'undetermined' ? 'undetermined' : 'denied';
  } catch {
    return 'denied';
  }
}

/** The system prompt (iOS asks only once; after that only Settings can change it). */
export async function requestNotificationPermission(from: 'moment' | 'settings'): Promise<PermissionState> {
  let state: PermissionState = 'denied';
  try {
    const permission = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    state = permission.granted ? 'granted' : 'denied';
  } catch {
    // Treated as denied.
  }
  track('notification_permission', { status: state === 'granted' ? 'granted' : 'denied', prompt: 'system', from });
  return state;
}

// One change of the record at a time: a plan, a tap, signing out.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work);
  chain = run.catch(() => undefined);
  return run;
}

let latest: GameState | null = null;
let queued: Promise<void> | null = null;

/**
 * Plans again from `state` (call it after every fresh my_game_state, and after
 * a change of the settings or the permission). Calls while one waits share it
 * and use the newest state. Without a state (not loaded, offline) the
 * previous plan stays.
 */
export function syncNotifications(state: GameState): Promise<void> {
  latest = state;
  queued ??= serial(async () => {
    queued = null;
    try {
      await planFrom(latest);
    } catch {
      // The previous plan stays; the next fresh state tries again.
    }
  });
  return queued;
}

async function planFrom(state: GameState | null): Promise<void> {
  const now = new Date();
  const previous = loadRecord();
  const record = settle(previous, now);
  const granted = (await notificationPermission()) === 'granted';
  const checkins = state?.stats?.checkins ?? null;
  const pretendAt = pretendNoCheckinAt();
  if (pretendAt !== null && state && checkins !== pretendAt) setPretendNoCheckinAt(null);
  const plan =
    granted && state?.today
      ? planNotifications({
          now,
          streak: pretendStreak(state.streak, pretendAt, checkins),
          today: state.today,
          settings: loadSettings(),
          ignoredInARow: record.ignoredInARow,
          notifiedDays: record.notifiedDays,
        })
      : [];
  await cancelPlanned();
  const entries: PlanEntry[] = [];
  try {
    for (const p of plan) {
      const id = await Notifications.scheduleNotificationAsync({
        content: { title: p.title, body: p.body, sound: 'default', data: { source: 'planner', type: p.type, chestDay: p.chestDay } },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: p.at },
      });
      entries.push({ id, type: p.type, day: p.day, at: p.at.toISOString() });
    }
  } finally {
    saveRecord({ ...record, plan: entries });
  }
  for (const p of newlyPlanned(plan, previous.plan)) {
    track('notification_scheduled', { type: p.type, in_hours: Math.round((p.at.getTime() - now.getTime()) / 3_600_000) });
  }
  // The player is in the app: what iOS still shows of ours is old news.
  await dismissPresented();
}

async function cancelPlanned(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    scheduled
      .filter((request) => parseNotificationData(request.content.data)?.source === 'planner')
      .map((request) => Notifications.cancelScheduledNotificationAsync(request.identifier)),
  );
}

async function dismissPresented(): Promise<void> {
  const presented = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    presented
      .filter((n) => parseNotificationData(n.request.content.data)?.source === 'planner')
      .map((n) => Notifications.dismissNotificationAsync(n.request.identifier)),
  );
}

/** A notification of the planner was tapped or shown in the open app: not ignored. */
export function noteAnswered(id: string): Promise<void> {
  return serial(async () => saveRecord(answered(loadRecord(), id, new Date())));
}

/** Signed out: nothing of this player may still come. */
export function clearNotifications(): Promise<void> {
  latest = null;
  return serial(async () => {
    try {
      await cancelPlanned();
      await dismissPresented();
    } catch {
      // Nothing scheduled, or no access: nothing to clear.
    }
    saveRecord(null);
    setPretendNoCheckinAt(null);
  });
}

/** What the planner has in iOS now (Dev mode): the entries iOS still holds. */
export async function scheduledPlan(): Promise<{ entries: PlanEntry[]; ignoredInARow: number }> {
  const record = loadRecord();
  const ids = new Set((await Notifications.getAllScheduledNotificationsAsync()).map((request) => request.identifier));
  return { entries: record.plan.filter((e) => ids.has(e.id)), ignoredInARow: record.ignoredInARow };
}

/** A test notification in 5 s (Dev mode); false without permission. */
export async function scheduleTestNotification(
  type: NotificationKind,
  content: NotificationContent,
  chestDay: string | null,
): Promise<boolean> {
  if ((await notificationPermission()) !== 'granted') return false;
  await Notifications.scheduleNotificationAsync({
    content: { ...content, sound: 'default', data: { source: 'test', type, chestDay } },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 5 },
  });
  return true;
}
