import { describe, expect, it } from '@jest/globals';

import type { Quest, QuestStatus, StreakState, TodayState } from '@/game/today';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  EMPTY_RECORD,
  answered,
  atLocal,
  isQuietTime,
  localDay,
  newlyPlanned,
  notificationTarget,
  parseNotificationData,
  parseRecord,
  parseSettings,
  planDays,
  planNotifications,
  pretendStreak,
  settle,
  type NotificationRecord,
  type PlanInput,
  type PlannedNotification,
} from '../planner';

// The week of Monday 19 October 2026; Sunday the 25th the clocks go back.
const WEEK = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];

function streak(over: Partial<StreakState> = {}): StreakState {
  return {
    weeks: 3,
    thisWeek: false,
    freezes: 0,
    maxFreezes: 2,
    frozenWeeks: [],
    weekStart: WEEK[0],
    days: WEEK.map((date) => ({ date, state: 'none' as const })),
    ...over,
  };
}

function quest(slot: Quest['slot'], status: QuestStatus, title: string): Quest {
  return {
    id: slot,
    period: 'day',
    slot,
    templateKey: slot,
    title,
    progress: status === 'open' ? 0 : 1,
    progressCertain: status === 'granted' ? 1 : 0,
    target: 1,
    reward: 5,
    freezes: 0,
    status,
    completedAt: null,
  };
}

const OPEN = [quest('easy', 'open', 'Eén inworp'), quest('medium', 'open', 'Twee inworpen'), quest('hard', 'open', 'Een nieuwe vuilbak')];
const DONE = [quest('easy', 'granted', 'Eén inworp'), quest('medium', 'pending', 'Twee inworpen'), quest('hard', 'pending', 'Een nieuwe vuilbak')];

function today(over: Partial<TodayState> = {}): TodayState {
  return { date: WEEK[1], quests: OPEN, weekly: null, chest: null, chestsReady: [], pendingCheckins: 0, ...over };
}

/** Tuesday 20 October, 10:00 on this phone. */
const TUESDAY_10 = new Date(2026, 9, 20, 10, 0);
const SUNDAY_10 = new Date(2026, 9, 25, 10, 0);

function plan(over: Partial<PlanInput> = {}): PlannedNotification[] {
  return planNotifications({
    now: TUESDAY_10,
    streak: streak(),
    today: today(),
    settings: DEFAULT_NOTIFICATION_SETTINGS,
    ignoredInARow: 0,
    notifiedDays: [],
    ...over,
  });
}

const pad = (n: number) => String(n).padStart(2, '0');
function brief(list: readonly PlannedNotification[]): string[] {
  return list.map((n) => `${n.type} ${localDay(n.at)} ${pad(n.at.getHours())}:${pad(n.at.getMinutes())}`);
}

describe('the plan', () => {
  it('plans the quest reminder at 18:00 and the streak on Sunday 17:00, one a day', () => {
    // Without a visit every notification counts as ignored: after three only the streak.
    expect(brief(plan())).toEqual([
      'quest 2026-10-20 18:00',
      'quest 2026-10-21 18:00',
      'quest 2026-10-22 18:00',
      'streak 2026-10-25 17:00',
    ]);
  });

  it('puts the streak reminder at 17:00 local time, also on the day the clocks go back', () => {
    const sunday = plan().find((n) => n.type === 'streak');
    expect(sunday?.at.getTime()).toBe(atLocal('2026-10-25', 17).getTime());
    expect(sunday?.at.getHours()).toBe(17);
  });

  it('drops the streak reminder once this week counts (after a check-in)', () => {
    expect(brief(plan({ streak: streak({ thisWeek: true }) })).some((n) => n.startsWith('streak'))).toBe(false);
  });

  it('finds Sunday from the date of the server when the week start is missing', () => {
    expect(brief(plan({ streak: streak({ weekStart: null }) }))).toContain('streak 2026-10-25 17:00');
  });

  it('words the streak reminder after the streak and the freezes', () => {
    const text = (over: Partial<StreakState>) => plan({ streak: streak(over), settings: { ...DEFAULT_NOTIFICATION_SETTINGS, quest: false } })[0];
    expect(text({ weeks: 3 })).toMatchObject({
      title: 'Je reeks staat op het spel',
      body: 'Nog geen inworp deze week: je reeks van 3 weken stopt vannacht. Eén inworp volstaat.',
    });
    expect(text({ weeks: 1 }).body).toContain('je reeks van 1 week stopt');
    expect(text({ weeks: 2, freezes: 1 })).toMatchObject({
      title: 'Je reeks wacht op je',
      body: 'Nog geen inworp deze week. Zonder inworp vandaag kost je reeks van 2 weken een bevriezer.',
    });
    expect(text({ weeks: 0 })).toMatchObject({ title: 'Nog geen inworp deze week', body: 'Eén inworp vandaag en je reeks begint.' });
  });

  it('names the open quests of today, and is general for the days to come', () => {
    const [tue, wed] = plan();
    expect(tue).toMatchObject({ title: 'Nog 3 quests vandaag', body: 'Eén inworp en nog 2. Haal ze en je dagkist gaat open.' });
    expect(wed).toMatchObject({ title: 'Nieuwe quests vandaag' });
    const one = plan({ today: today({ quests: [DONE[0], DONE[1], OPEN[2]] }) })[0];
    expect(one).toMatchObject({ title: 'Nog één quest vandaag', body: 'Een nieuwe vuilbak. Haal hem en je dagkist gaat open.' });
  });

  it('has no quest reminder today when all of today is done', () => {
    expect(brief(plan({ today: today({ quests: DONE }) }))[0]).toBe('quest 2026-10-21 18:00');
  });

  it('plans nothing sooner than 30 minutes from now, and nothing in the past', () => {
    expect(brief(plan({ now: new Date(2026, 9, 20, 17, 45) }))[0]).toBe('quest 2026-10-21 18:00');
    expect(brief(plan({ now: new Date(2026, 9, 20, 17, 20) }))[0]).toBe('quest 2026-10-20 18:00');
    expect(brief(plan({ now: new Date(2026, 9, 20, 19, 0) }))[0]).toBe('quest 2026-10-21 18:00');
  });

  it('plans one week ahead at most', () => {
    const week = planDays({
      now: new Date(2026, 9, 26, 10, 0),
      streak: streak({ weekStart: '2026-10-26' }),
      today: today({ date: '2026-10-26' }),
      settings: DEFAULT_NOTIFICATION_SETTINGS,
      notifiedDays: [],
    });
    expect(brief(week)).toEqual([
      'quest 2026-10-26 18:00',
      'quest 2026-10-27 18:00',
      'quest 2026-10-28 18:00',
      'quest 2026-10-29 18:00',
      'quest 2026-10-30 18:00',
      'quest 2026-10-31 18:00',
      'streak 2026-11-01 17:00',
    ]);
  });
});

describe('one a day', () => {
  it('lets the streak win on Sunday', () => {
    const sunday = plan({ now: SUNDAY_10, today: today({ date: WEEK[6] }) });
    expect(brief(sunday)).toEqual(['streak 2026-10-25 17:00', 'quest 2026-10-26 18:00', 'quest 2026-10-27 18:00']);
  });

  it('skips a day that already had a notification', () => {
    expect(brief(plan({ notifiedDays: ['2026-10-20'] }))[0]).toBe('quest 2026-10-21 18:00');
  });
});

describe('quiet hours', () => {
  it('are 21:00 to 9:00', () => {
    expect(isQuietTime(new Date(2026, 9, 20, 20, 59))).toBe(false);
    expect(isQuietTime(new Date(2026, 9, 20, 21, 0))).toBe(true);
    expect(isQuietTime(new Date(2026, 9, 21, 8, 59))).toBe(true);
    expect(isQuietTime(new Date(2026, 9, 21, 9, 0))).toBe(false);
  });

  it('keep the chosen hour between 9 and 20', () => {
    expect(parseSettings({ questHour: 23 }).questHour).toBe(20);
    expect(parseSettings({ questHour: 6 }).questHour).toBe(9);
    expect(parseSettings({ questHour: 12.4 }).questHour).toBe(12);
    for (let hour = 0; hour < 24; hour++) {
      const list = planDays({ now: new Date(2026, 9, 20, 0, 0), streak: streak(), today: today(), settings: { ...DEFAULT_NOTIFICATION_SETTINGS, questHour: hour }, notifiedDays: [] });
      expect(list.length).toBeGreaterThan(0);
      expect(list.some((n) => isQuietTime(n.at))).toBe(false);
    }
  });
});

describe('priority', () => {
  it('reminds of a chest that became ready today, before the quests', () => {
    const list = plan({ today: today({ quests: DONE, chestsReady: [WEEK[1]] }) });
    expect(brief(list)[0]).toBe('chest 2026-10-20 18:00');
    expect(list[0]).toMatchObject({ title: 'Je dagkist staat klaar', chestDay: WEEK[1] });
  });

  it('reminds once, the day after, of the chest of yesterday', () => {
    const list = plan({ now: new Date(2026, 9, 21, 10, 0), today: today({ date: WEEK[2], chestsReady: [WEEK[1]] }) });
    expect(brief(list).slice(0, 2)).toEqual(['chest 2026-10-21 18:00', 'quest 2026-10-22 18:00']);
    expect(list[0]).toMatchObject({ title: 'Je kist van gisteren staat nog klaar', chestDay: WEEK[1] });
  });

  it('moves the chest to the next day when it is too late today', () => {
    const list = plan({ now: new Date(2026, 9, 20, 19, 0), today: today({ quests: DONE, chestsReady: [WEEK[1]] }) });
    expect(brief(list)[0]).toBe('chest 2026-10-21 18:00');
    expect(list.filter((n) => n.type === 'chest')).toHaveLength(1);
  });

  it('leaves older chests to the tab badge', () => {
    const list = plan({ today: today({ quests: DONE, chestsReady: ['2026-10-18'] }) });
    expect(list.some((n) => n.type === 'chest')).toBe(false);
  });

  it('puts the streak before the chest', () => {
    const list = plan({ now: SUNDAY_10, today: today({ date: WEEK[6], quests: DONE, chestsReady: [WEEK[6]] }) });
    expect(brief(list).slice(0, 2)).toEqual(['streak 2026-10-25 17:00', 'chest 2026-10-26 18:00']);
  });
});

describe('switches', () => {
  const off = (over: Partial<typeof DEFAULT_NOTIFICATION_SETTINGS>) => ({ ...DEFAULT_NOTIFICATION_SETTINGS, ...over });

  it('turn each kind off', () => {
    expect(brief(plan({ settings: off({ quest: false }) }))).toEqual(['streak 2026-10-25 17:00']);
    expect(plan({ settings: off({ streak: false }) }).some((n) => n.type === 'streak')).toBe(false);
    const chestOff = plan({ settings: off({ chest: false }), today: today({ quests: DONE, chestsReady: [WEEK[1]] }) });
    expect(brief(chestOff)[0]).toBe('quest 2026-10-21 18:00');
    expect(plan({ settings: off({ streak: false, quest: false, chest: false }) })).toEqual([]);
  });

  it('use the chosen hour for the quest and the chest', () => {
    const list = plan({ settings: off({ questHour: 12 }), today: today({ quests: DONE, chestsReady: [WEEK[1]] }) });
    expect(brief(list).slice(0, 2)).toEqual(['chest 2026-10-20 12:00', 'quest 2026-10-21 12:00']);
  });
});

describe('fewer after three ignored', () => {
  it('keeps only the streak reminder from the third ignored on', () => {
    expect(brief(plan({ ignoredInARow: 2 }))).toEqual(['quest 2026-10-20 18:00', 'streak 2026-10-25 17:00']);
    expect(brief(plan({ ignoredInARow: 3 }))).toEqual(['streak 2026-10-25 17:00']);
    expect(brief(plan({ ignoredInARow: 7 }))).toEqual(['streak 2026-10-25 17:00']);
    expect(plan({ ignoredInARow: 3, streak: streak({ thisWeek: true }) })).toEqual([]);
  });

  it('counts what fired without an answer, and starts again after a tap', () => {
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).toISOString();
    let record: NotificationRecord = {
      ...EMPTY_RECORD,
      plan: [
        { id: 'a', type: 'quest', day: '2026-10-20', at: at(20, 18) },
        { id: 'b', type: 'quest', day: '2026-10-21', at: at(21, 18) },
        { id: 'c', type: 'quest', day: '2026-10-22', at: at(22, 18) },
        { id: 'd', type: 'streak', day: '2026-10-25', at: at(25, 17) },
      ],
    };
    // Thursday 23:00: three fired, the last one five hours ago.
    record = settle(record, new Date(2026, 9, 22, 23, 0));
    expect(record).toEqual({
      plan: [{ id: 'd', type: 'streak', day: '2026-10-25', at: at(25, 17) }],
      ignoredInARow: 3,
      notifiedDays: ['2026-10-20', '2026-10-21', '2026-10-22'],
    });
    // The tap on Sunday: answered, the counter starts again.
    record = answered(record, 'd', new Date(2026, 9, 25, 17, 5));
    expect(record).toMatchObject({ plan: [], ignoredInARow: 0 });
    expect(record.notifiedDays).toContain('2026-10-25');
  });

  it('does not count a notification when the app opened within two hours after it', () => {
    const record: NotificationRecord = { ...EMPTY_RECORD, ignoredInARow: 2, plan: [{ id: 'a', type: 'quest', day: '2026-10-20', at: new Date(2026, 9, 20, 18, 0).toISOString() }] };
    expect(settle(record, new Date(2026, 9, 20, 19, 30)).ignoredInARow).toBe(0);
    expect(settle(record, new Date(2026, 9, 20, 20, 30)).ignoredInARow).toBe(3);
    expect(settle(EMPTY_RECORD, new Date())).toBe(EMPTY_RECORD);
  });

  it('keeps two weeks of days', () => {
    const record: NotificationRecord = { ...EMPTY_RECORD, notifiedDays: ['2026-10-01', '2026-10-10'], plan: [{ id: 'a', type: 'quest', day: '2026-10-20', at: new Date(2026, 9, 20, 18).toISOString() }] };
    expect(settle(record, new Date(2026, 9, 20, 18, 30)).notifiedDays).toEqual(['2026-10-10', '2026-10-20']);
  });
});

describe('stored data', () => {
  it('reads settings and the record defensively', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(parseSettings({ streak: false, quest: 'no', questHour: 'x' })).toEqual({ ...DEFAULT_NOTIFICATION_SETTINGS, streak: false });
    expect(parseRecord('nonsense')).toEqual(EMPTY_RECORD);
    expect(
      parseRecord({
        plan: [{ id: 'a', type: 'quest', day: '2026-10-20', at: '2026-10-20T16:00:00.000Z' }, { id: 'b', type: 'party', day: 'x', at: 'y' }],
        ignoredInARow: -1,
        notifiedDays: ['2026-10-19', 5],
      }),
    ).toEqual({ plan: [{ id: 'a', type: 'quest', day: '2026-10-20', at: '2026-10-20T16:00:00.000Z' }], ignoredInARow: 0, notifiedDays: ['2026-10-19'] });
  });

  it('sees which notifications are new since the previous plan', () => {
    const list = plan();
    const previous = [{ id: 'x', type: list[0].type, day: list[0].day, at: list[0].at.toISOString() }];
    expect(newlyPlanned(list, previous)).toEqual(list.slice(1));
    expect(newlyPlanned(list, [])).toEqual(list);
  });
});

describe('a tap', () => {
  it('reads the data of a notification', () => {
    expect(parseNotificationData({ source: 'planner', type: 'chest', chestDay: '2026-10-20' })).toEqual({ source: 'planner', type: 'chest', chestDay: '2026-10-20' });
    expect(parseNotificationData({ source: 'test', type: 'streak' })).toEqual({ source: 'test', type: 'streak', chestDay: null });
    expect(parseNotificationData({ source: 'other', type: 'streak' })).toBeNull();
    expect(parseNotificationData(undefined)).toBeNull();
  });

  it('opens the chest while it is still ready, otherwise Today', () => {
    const chest = { source: 'planner' as const, type: 'chest' as const, chestDay: '2026-10-20' };
    expect(notificationTarget(chest, ['2026-10-20'])).toEqual({ screen: 'chest', day: '2026-10-20' });
    expect(notificationTarget(chest, null)).toEqual({ screen: 'chest', day: '2026-10-20' });
    expect(notificationTarget(chest, [])).toEqual({ screen: 'today' });
    expect(notificationTarget({ source: 'planner', type: 'streak', chestDay: null }, [])).toEqual({ screen: 'today' });
    expect(notificationTarget({ source: 'test', type: 'quest', chestDay: null }, null)).toEqual({ screen: 'today' });
  });
});

describe('Dev mode: as if nothing counted this week', () => {
  it('plans the Sunday reminder until the next real check-in', () => {
    const counted = streak({ thisWeek: true });
    expect(brief(plan({ streak: pretendStreak(counted, 4, 4) }))).toContain('streak 2026-10-25 17:00');
    // One real check-in later the switch has ended: the reminder goes.
    expect(brief(plan({ streak: pretendStreak(counted, 4, 5) })).some((n) => n.startsWith('streak'))).toBe(false);
    expect(pretendStreak(counted, null, 4)).toBe(counted);
  });
});
