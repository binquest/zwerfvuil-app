// The planner of the local notifications (docs/GAMIFICATION.md, chapter 3,
// chapter 8 and phase 7). Pure: it gets the game state, the settings and what
// the last plans did, and returns what to schedule. The app plans again after
// every fresh my_game_state, so a plan only has to be right until the next
// visit: without opening the app nobody can check in, open a chest or finish
// a quest.
//
// Rules: at most one notification per day, never between 21:00 and 9:00,
// priority streak > chest > quest, every kind can be switched off, and after
// three ignored notifications in a row only the streak reminder remains.
import type { NotificationKind } from '@/analytics/events';
import { addDays, daysBetween, isoWeekday, type Quest, type StreakState, type TodayState } from '@/game/today';

export type { NotificationKind };

/** The start values of chapter 3 (game_config would not reach an offline phone). */
export const NOTIFICATION_RULES = {
  /** Quiet from 21:00 until 9:00. */
  quietFrom: 21,
  quietUntil: 9,
  /** Streak in danger: Sunday 17:00 when nothing counts this week yet. */
  streakHour: 17,
  /** The quest reminder (and the chest reminder): 18:00, to choose from 9 to 20. */
  defaultQuestHour: 18,
  questHourMin: 9,
  questHourMax: 20,
  /** Days planned ahead, today included. */
  horizonDays: 7,
  /** Nothing sooner than this after planning (the player is in the app). */
  minLeadMinutes: 30,
  /** After this many ignored in a row: only the streak reminder. */
  calmAfterIgnored: 3,
  /** The app opened this soon after a notification: it was not ignored. */
  answeredWithinHours: 2,
  /** Days with a notification kept for "one per day". */
  keepDays: 14,
} as const;

/** The kinds in the order of their priority, with their names in Settings. */
export const NOTIFICATION_KINDS: readonly NotificationKind[] = ['streak', 'chest', 'quest'];
export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  streak: 'Reeks in gevaar',
  chest: 'Kist klaar',
  quest: 'Quest-herinnering',
};

export interface NotificationSettings {
  streak: boolean;
  quest: boolean;
  chest: boolean;
  /** The hour of the quest and chest reminder (9 to 20). */
  questHour: number;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  streak: true,
  quest: true,
  chest: true,
  questHour: NOTIFICATION_RULES.defaultQuestHour,
};

/** A whole hour from 9 to 20 (anything else is clamped). */
export function clampQuestHour(hour: number): number {
  if (!Number.isFinite(hour)) return NOTIFICATION_RULES.defaultQuestHour;
  return Math.min(NOTIFICATION_RULES.questHourMax, Math.max(NOTIFICATION_RULES.questHourMin, Math.round(hour)));
}

/** Settings as stored (anything), with defaults for what is missing or wrong. */
export function parseSettings(value: unknown): NotificationSettings {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const flag = (x: unknown, fallback: boolean) => (typeof x === 'boolean' ? x : fallback);
  return {
    streak: flag(v.streak, true),
    quest: flag(v.quest, true),
    chest: flag(v.chest, true),
    questHour: clampQuestHour(typeof v.questHour === 'number' ? v.questHour : NaN),
  };
}

// ---------------------------------------------------------------------------
// Local time
// ---------------------------------------------------------------------------

/** The local date (YYYY-MM-DD) of a moment on this phone. */
export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `hour`:00 local time on `day` (YYYY-MM-DD), also on a day with a clock change. */
export function atLocal(day: string, hour: number): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hour, 0, 0, 0);
}

/** Within the quiet hours (21:00 to 9:00 local time). */
export function isQuietTime(date: Date): boolean {
  const hour = date.getHours();
  return hour >= NOTIFICATION_RULES.quietFrom || hour < NOTIFICATION_RULES.quietUntil;
}

// ---------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------

export interface NotificationContent {
  title: string;
  body: string;
}

function weeksLabel(weeks: number): string {
  return weeks === 1 ? '1 week' : `${weeks} weken`;
}

/** Streak in danger (Sunday, nothing this week yet). */
export function streakContent(streak: Pick<StreakState, 'weeks' | 'freezes'>): NotificationContent {
  if (streak.weeks < 1) {
    return { title: 'Nog geen inworp deze week', body: 'Eén inworp vandaag en je reeks begint.' };
  }
  if (streak.freezes > 0) {
    return {
      title: 'Je reeks wacht op je',
      body: `Nog geen inworp deze week. Zonder inworp vandaag kost je reeks van ${weeksLabel(streak.weeks)} een bevriezer.`,
    };
  }
  return {
    title: 'Je reeks staat op het spel',
    body: `Nog geen inworp deze week: je reeks van ${weeksLabel(streak.weeks)} stopt vannacht. Eén inworp volstaat.`,
  };
}

/** The quest reminder: today's open quests, or null for a day still to come. */
export function questContent(open: readonly Pick<Quest, 'title'>[] | null): NotificationContent {
  if (!open || open.length === 0) {
    return { title: 'Nieuwe quests vandaag', body: 'Je quests van vandaag staan klaar. Haal ze en je dagkist gaat open.' };
  }
  if (open.length === 1) {
    return { title: 'Nog één quest vandaag', body: `${open[0].title}. Haal hem en je dagkist gaat open.` };
  }
  return {
    title: `Nog ${open.length} quests vandaag`,
    body: `${open[0].title} en nog ${open.length - 1}. Haal ze en je dagkist gaat open.`,
  };
}

/** The chest reminder, on the day the chest became ready or the day after. */
export function chestContent(sameDay: boolean): NotificationContent {
  return sameDay
    ? { title: 'Je dagkist staat klaar', body: 'Je haalde je quests van vandaag. Open je kist voor je beloning.' }
    : { title: 'Je kist van gisteren staat nog klaar', body: 'Open hem voor je beloning.' };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface PlannedNotification extends NotificationContent {
  type: NotificationKind;
  /** The local day it fires. */
  day: string;
  at: Date;
  /** The chest it is about (chest only). */
  chestDay: string | null;
}

export interface PlanInput {
  now: Date;
  streak: StreakState;
  today: TodayState;
  settings: NotificationSettings;
  /** Notifications in a row without an answer, before now. */
  ignoredInARow: number;
  /** Local days on which a notification already fired. */
  notifiedDays: readonly string[];
}

/** The notifications to schedule from now on: at most one per day, fewer after three ignored. */
export function planNotifications(input: PlanInput): PlannedNotification[] {
  return calmDown(planDays(input), input.ignoredInARow);
}

/** The most important notification of each day of the coming week, if any. */
export function planDays(input: Omit<PlanInput, 'ignoredInARow'>): PlannedNotification[] {
  const { now, streak, today } = input;
  const settings = parseSettings(input.settings);
  const earliest = now.getTime() + NOTIFICATION_RULES.minLeadMinutes * 60_000;
  const notified = new Set(input.notifiedDays);
  const weekEnd = addDays(streak.weekStart ?? addDays(today.date, 1 - isoWeekday(today.date)), 6);
  // The newest ready chest, while it is from today or yesterday: one reminder.
  const readyChest = today.chestsReady.find((day) => daysBetween(day, today.date) <= 1) ?? null;
  let chestPlanned = false;

  const candidates = (day: string): PlannedNotification[] => {
    const list: PlannedNotification[] = [];
    if (settings.streak && !streak.thisWeek && day === weekEnd) {
      list.push({ type: 'streak', day, at: atLocal(day, NOTIFICATION_RULES.streakHour), chestDay: null, ...streakContent(streak) });
    }
    if (settings.chest && readyChest && !chestPlanned && (day === readyChest || day === addDays(readyChest, 1))) {
      list.push({ type: 'chest', day, at: atLocal(day, settings.questHour), chestDay: readyChest, ...chestContent(day === readyChest) });
    }
    if (settings.quest && day >= today.date) {
      const known = day === today.date && today.quests.length > 0;
      const open = known ? today.quests.filter((q) => q.status === 'open') : null;
      if (!open || open.length > 0) {
        list.push({ type: 'quest', day, at: atLocal(day, settings.questHour), chestDay: null, ...questContent(open) });
      }
    }
    return list.filter((c) => c.at.getTime() >= earliest && !isQuietTime(c.at));
  };

  const picked: PlannedNotification[] = [];
  const first = localDay(now);
  for (let i = 0; i < NOTIFICATION_RULES.horizonDays; i++) {
    const day = addDays(first, i);
    if (notified.has(day)) continue;
    const best = candidates(day)[0];
    if (!best) continue;
    if (best.type === 'chest') chestPlanned = true;
    picked.push(best);
  }
  return picked;
}

/**
 * Dev mode, "Doe alsof deze week nog niets telt": the streak as if nothing
 * counted this week, while the real check-ins are still the `pretendAt` of
 * when it was switched on. The next real check-in ends it (a test check-in
 * does not, as it does not count for the streak either).
 */
export function pretendStreak(streak: StreakState, pretendAt: number | null, checkins: number | null): StreakState {
  return pretendAt !== null && checkins === pretendAt ? { ...streak, thisWeek: false } : streak;
}

/**
 * Fewer after three ignored: every planned notification counts as ignored
 * until the app opens again (which plans anew), so from the third on only the
 * streak reminder stays.
 */
export function calmDown(plan: readonly PlannedNotification[], ignoredInARow: number): PlannedNotification[] {
  let ignored = ignoredInARow;
  return plan.filter((p) => {
    if (ignored >= NOTIFICATION_RULES.calmAfterIgnored && p.type !== 'streak') return false;
    ignored += 1;
    return true;
  });
}

// ---------------------------------------------------------------------------
// What the plans did
// ---------------------------------------------------------------------------

/** A scheduled notification of the planner. */
export interface PlanEntry {
  id: string;
  type: NotificationKind;
  day: string;
  /** ISO time it fires. */
  at: string;
}

export interface NotificationRecord {
  /** What is scheduled (from the last plan). */
  plan: PlanEntry[];
  ignoredInARow: number;
  /** Local days on which a notification fired (the last two weeks). */
  notifiedDays: string[];
}

export const EMPTY_RECORD: NotificationRecord = { plan: [], ignoredInARow: 0, notifiedDays: [] };

const KINDS: readonly NotificationKind[] = ['streak', 'quest', 'chest'];

function isDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** The record as stored (anything), or an empty one. */
export function parseRecord(value: unknown): NotificationRecord {
  if (!value || typeof value !== 'object') return EMPTY_RECORD;
  const v = value as Record<string, unknown>;
  const plan = Array.isArray(v.plan)
    ? v.plan.flatMap((e: unknown): PlanEntry[] => {
        if (!e || typeof e !== 'object') return [];
        const { id, type, day, at } = e as Record<string, unknown>;
        const kind = KINDS.find((k) => k === type);
        if (typeof id !== 'string' || !kind || !isDay(day) || typeof at !== 'string' || Number.isNaN(Date.parse(at))) return [];
        return [{ id, type: kind, day, at }];
      })
    : [];
  const ignored = typeof v.ignoredInARow === 'number' && v.ignoredInARow >= 0 ? Math.floor(v.ignoredInARow) : 0;
  const days = Array.isArray(v.notifiedDays) ? v.notifiedDays.filter(isDay) : [];
  return { plan, ignoredInARow: ignored, notifiedDays: days };
}

function keepRecent(days: readonly string[], now: Date): string[] {
  const today = localDay(now);
  return [...new Set(days)].filter((d) => daysBetween(d, today) < NOTIFICATION_RULES.keepDays).sort();
}

/**
 * Settles what fired since the last plan: each one counts as ignored, unless
 * the app opened within two hours after it (a tap is settled by `answered`).
 */
export function settle(record: NotificationRecord, now: Date): NotificationRecord {
  const fired = record.plan.filter((e) => Date.parse(e.at) <= now.getTime()).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (fired.length === 0) return record;
  let ignored = record.ignoredInARow;
  for (const e of fired) {
    const answered = now.getTime() - Date.parse(e.at) <= NOTIFICATION_RULES.answeredWithinHours * 3_600_000;
    ignored = answered ? 0 : ignored + 1;
  }
  return {
    plan: record.plan.filter((e) => !fired.includes(e)),
    ignoredInARow: ignored,
    notifiedDays: keepRecent([...record.notifiedDays, ...fired.map((e) => e.day)], now),
  };
}

/** A notification was tapped (or shown while the app was open): not ignored. */
export function answered(record: NotificationRecord, id: string, now: Date): NotificationRecord {
  const entry = record.plan.find((e) => e.id === id);
  return {
    plan: record.plan.filter((e) => e.id !== id),
    ignoredInARow: 0,
    notifiedDays: entry ? keepRecent([...record.notifiedDays, entry.day], now) : record.notifiedDays,
  };
}

/** The planned notifications that were not in the previous plan (same kind and time). */
export function newlyPlanned(plan: readonly PlannedNotification[], previous: readonly PlanEntry[]): PlannedNotification[] {
  const known = new Set(previous.map((e) => `${e.type}@${Date.parse(e.at)}`));
  return plan.filter((p) => !known.has(`${p.type}@${p.at.getTime()}`));
}

// ---------------------------------------------------------------------------
// A tap
// ---------------------------------------------------------------------------

/** What a notification carries: who made it, its kind and the chest it is about. */
export interface NotificationData {
  source: 'planner' | 'test';
  type: NotificationKind;
  chestDay: string | null;
}

export function parseNotificationData(value: unknown): NotificationData | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const type = KINDS.find((k) => k === v.type);
  if ((v.source !== 'planner' && v.source !== 'test') || !type) return null;
  return { source: v.source, type, chestDay: isDay(v.chestDay) ? v.chestDay : null };
}

export type NotificationTarget = { screen: 'today' } | { screen: 'chest'; day: string };

/** The screen a tap opens: the chest for a chest that is still ready, otherwise Today. */
export function notificationTarget(data: NotificationData, chestsReady: readonly string[] | null): NotificationTarget {
  if (data.type === 'chest' && data.chestDay && (chestsReady === null || chestsReady.includes(data.chestDay))) {
    return { screen: 'chest', day: data.chestDay };
  }
  return { screen: 'today' };
}
