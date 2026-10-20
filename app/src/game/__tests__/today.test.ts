import { beforeEach, describe, expect, it } from '@jest/globals';
import type { ChestRewardDef } from '../catalog';
import {
  chestBadge,
  chestCard,
  chestChances,
  dayDots,
  dayLabel,
  freezeLine,
  isoWeekday,
  parseChestNews,
  parseQuestNewsList,
  parseStreak,
  parseToday,
  pendingLine,
  questRow,
  questsDone,
  streakDanger,
  streakStatusLine,
  streakWeeksLabel,
  tipText,
  tipsToShow,
  weeklyRow,
  type Chest,
  type Quest,
  type StreakState,
} from '../today';
import { chestAnnounced, markChestAnnounced, markTipsSeen, resetTips, seenTips } from '../todayMemory';

// Monday 19 October 2026 to Sunday 25 October.
const MONDAY = '2026-10-19';
const TUESDAY = '2026-10-20';
const THURSDAY = '2026-10-22';
const FRIDAY = '2026-10-23';
const SATURDAY = '2026-10-24';
const SUNDAY = '2026-10-25';

const QUEST_JSON = {
  id: 'q1',
  period: 'day',
  period_start: TUESDAY,
  slot: 'medium',
  template_key: 'two_checkins',
  title: 'Doe 2 inworpen',
  progress: 1,
  progress_certain: 0,
  target: 2,
  reward: 10,
  freezes: 0,
  status: 'open',
  completed_at: null,
};

const quest = (over: Partial<Quest> = {}): Quest => ({
  id: 'q1',
  period: 'day',
  slot: 'medium',
  templateKey: 'two_checkins',
  title: 'Doe 2 inworpen',
  progress: 1,
  progressCertain: 0,
  target: 2,
  reward: 10,
  freezes: 0,
  status: 'open',
  completedAt: null,
  ...over,
});

const streak = (over: Partial<StreakState> = {}): StreakState => ({
  weeks: 5,
  thisWeek: false,
  freezes: 0,
  maxFreezes: 2,
  frozenWeeks: [],
  weekStart: MONDAY,
  days: [],
  ...over,
});

describe('parseToday', () => {
  const answer = {
    today: TUESDAY,
    quests: [
      { ...QUEST_JSON, id: 'e', slot: 'easy', title: 'Doe een inworp', progress: 1, target: 1, reward: 5, status: 'pending', completed_at: 'x' },
      QUEST_JSON,
      { ...QUEST_JSON, id: 'h', slot: 'hard', progress: 3 },
      { id: 'broken' },
    ],
    weekly: { ...QUEST_JSON, id: 'w', period: 'week', period_start: MONDAY, slot: 'weekly', target: 4, reward: 40, ends_on: SUNDAY },
    chest: { id: 7, day: TUESDAY, status: 'locked', quests_done: 1, quests_total: 3, reward: null },
    chests_ready: ['2026-10-18', 'nope'],
    pending_checkins: 3,
  };

  it('reads the quests, the challenge, the chest and the ready chests', () => {
    const today = parseToday(answer);
    expect(today?.date).toBe(TUESDAY);
    expect(today?.quests.map((q) => `${q.slot}:${q.progress}/${q.target}:${q.status}`)).toEqual([
      'easy:1/1:pending',
      'medium:1/2:open',
      'hard:2/2:open',
    ]);
    expect(today?.weekly).toMatchObject({ id: 'w', target: 4, reward: 40, endsOn: SUNDAY });
    expect(today?.chest).toEqual({ id: 7, day: TUESDAY, status: 'locked', questsDone: 1, questsTotal: 3, reward: null });
    expect(today?.chestsReady).toEqual(['2026-10-18']);
    expect(today?.pendingCheckins).toBe(3);
  });

  it('is null from a server without Today (v1)', () => {
    expect(parseToday({ points: {} })).toBeNull();
    expect(parseToday(null)).toBeNull();
  });

  it('reads an opened chest with its reward', () => {
    const chest = parseChestNews({
      id: 7, day: TUESDAY, status: 'opened', quests_done: 3, quests_total: 3, ready_now: false,
      reward: { key: 'points_15', kind: 'points', amount: 15, avatar_key: null, status: 'pending' },
    });
    expect(chest).toEqual({
      id: 7, day: TUESDAY, status: 'opened', questsDone: 3, questsTotal: 3, readyNow: false,
      reward: { key: 'points_15', kind: 'points', amount: 15, avatarKey: null, status: 'pending' },
    });
  });

  it('reads the quests of a check-in with completed_now', () => {
    const news = parseQuestNewsList([{ ...QUEST_JSON, status: 'pending', progress: 2, completed_now: true }, 'x']);
    expect(news.map((q) => [q.id, q.completedNow, q.status])).toEqual([['q1', true, 'pending']]);
  });
});

describe('parseStreak', () => {
  it('reads the days, the freezes and the bridged weeks (v2)', () => {
    expect(
      parseStreak({
        weeks: 5, this_week: true, freezes: 1, max_freezes: 2, frozen_weeks: ['2026-10-12'], week_start: MONDAY,
        days: [{ date: MONDAY, state: 'approved' }, { date: TUESDAY, state: 'pending' }, { date: 'x', state: 'approved' }],
      }),
    ).toEqual({
      weeks: 5, thisWeek: true, freezes: 1, maxFreezes: 2, frozenWeeks: ['2026-10-12'], weekStart: MONDAY,
      days: [{ date: MONDAY, state: 'approved' }, { date: TUESDAY, state: 'pending' }],
    });
  });

  it('keeps v1 working: weeks and this week only', () => {
    expect(parseStreak({ weeks: 2, this_week: false })).toEqual({
      weeks: 2, thisWeek: false, freezes: 0, maxFreezes: 2, frozenWeeks: [], weekStart: null, days: [],
    });
  });
});

describe('day dots', () => {
  it('knows the weekday of a date', () => {
    expect([MONDAY, TUESDAY, FRIDAY, SUNDAY].map(isoWeekday)).toEqual([1, 2, 5, 7]);
  });

  it('gives Monday to Sunday: filled when approved, a ring while waiting, today circled', () => {
    const dots = dayDots(streak({ days: [{ date: MONDAY, state: 'approved' }, { date: TUESDAY, state: 'pending' }] }), TUESDAY);
    expect(dots.map((d) => d.label)).toEqual(['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo']);
    expect(dots.map((d) => d.state)).toEqual(['approved', 'pending', 'none', 'none', 'none', 'none', 'none']);
    expect(dots.map((d) => d.today)).toEqual([false, true, false, false, false, false, false]);
    expect(dots.filter((d) => d.future).map((d) => d.label)).toEqual(['wo', 'do', 'vr', 'za', 'zo']);
  });

  it('finds the Monday itself without week_start (older server)', () => {
    expect(dayDots(streak({ weekStart: null }), SUNDAY)[0].date).toBe(MONDAY);
  });
});

describe('streak in danger', () => {
  it('is in danger from Friday when nothing counts this week yet', () => {
    expect(streakDanger(streak(), THURSDAY)).toBeNull();
    expect(streakDanger(streak(), FRIDAY)).toEqual({ daysLeft: 3 });
    expect(streakDanger(streak(), SATURDAY)).toEqual({ daysLeft: 2 });
    expect(streakDanger(streak(), SUNDAY)).toEqual({ daysLeft: 1 });
  });

  it('is never in danger with this week counted or without a streak', () => {
    expect(streakDanger(streak({ thisWeek: true }), SATURDAY)).toBeNull();
    expect(streakDanger(streak({ weeks: 0 }), SATURDAY)).toBeNull();
  });

  it('says what the week needs', () => {
    expect(streakStatusLine(streak({ thisWeek: true }), FRIDAY)).toEqual({ text: 'Deze week telt al', tone: 'good' });
    expect(streakStatusLine(streak(), SATURDAY)).toEqual({ text: 'Reeks in gevaar · nog 2 dagen', tone: 'danger' });
    expect(streakStatusLine(streak(), SUNDAY).text).toBe('Reeks in gevaar · nog vandaag');
    expect(streakStatusLine(streak(), TUESDAY).tone).toBe('calm');
    expect(streakStatusLine(streak({ weeks: 0 }), SUNDAY).text).toBe('Doe een inworp om een reeks te starten');
  });

  it('names the weeks and the freezes', () => {
    expect([0, 1, 5].map(streakWeeksLabel)).toEqual(['Nog geen reeks', '1 week', '5 weken']);
    expect(freezeLine(streak())).toBe('Geen bevriezers');
    expect(freezeLine(streak({ freezes: 1 }))).toBe('1 van 2 bevriezers');
    expect(freezeLine(streak({ freezes: 0, frozenWeeks: ['2026-10-12'] }))).toBe('Geen bevriezers · vorige week bevroren');
  });
});

describe('quests, challenge and chest', () => {
  it('shows a quest with its bar, reward and state', () => {
    expect(questRow(quest())).toMatchObject({ progressLabel: '1/2', value: 1, max: 2, rewardLabel: '+10', state: 'open' });
    expect(questRow(quest({ status: 'pending', progress: 2 })).state).toBe('pending');
    expect(questRow(quest({ status: 'granted', progress: 2 })).accessibilityLabel).toBe('Doe 2 inworpen, voltooid, +10');
    expect(questRow(quest({ reward: 0, freezes: 1 })).rewardLabel).toBe('Bevriezer');
    expect(questsDone([quest(), quest({ status: 'pending' }), quest({ status: 'granted' })])).toBe(2);
  });

  it('counts the days of the challenge down', () => {
    const weekly = { ...quest({ period: 'week', slot: 'weekly' }), endsOn: SUNDAY };
    expect(weeklyRow(weekly, TUESDAY).daysLeftLabel).toBe('nog 6 dagen');
    expect(weeklyRow(weekly, SUNDAY).daysLeftLabel).toBe('laatste dag');
  });

  it('shows the chest locked, ready and opened', () => {
    const base: Chest = { id: 1, day: TUESDAY, status: 'locked', questsDone: 2, questsTotal: 3, reward: null };
    expect(chestCard(base)).toMatchObject({ state: 'locked', detail: 'Nog 1 quest tot je kist', done: 2, total: 3 });
    expect(chestCard({ ...base, status: 'ready', questsDone: 3 })).toMatchObject({ state: 'ready', title: 'Open je kist' });
    const reward = { key: 'points_15', kind: 'points' as const, amount: 15, avatarKey: null, status: 'pending' as const };
    expect(chestCard({ ...base, status: 'opened', questsDone: 3, reward }).detail).toBe('+15 · wacht op goedkeuring');
    const maan = { key: 'avatar_maan', kind: 'avatar' as const, amount: null, avatarKey: 'maan', status: 'granted' as const };
    expect(chestCard({ ...base, status: 'opened', reward: maan }, () => 'Maan').detail).toBe('Maan');
    expect(chestCard({ ...base, reward: { ...reward, status: 'revoked' } }).detail).toBe('Je +15 komt terug als je quests weer af zijn');
  });

  it('names the day of an older chest', () => {
    expect([TUESDAY, MONDAY, '2026-10-17'].map((d) => dayLabel(d, TUESDAY))).toEqual(['vandaag', 'gisteren', 'zaterdag']);
  });

  it('says what waits for approval', () => {
    expect(pendingLine(3, 64)).toBe('3 inworpen wachten · +64 voorlopig');
    expect(pendingLine(1, 16)).toBe('1 inworp wacht · +16 voorlopig');
    expect(pendingLine(0, 0)).toBeNull();
  });

  it('puts the number of ready chests on the tab', () => {
    const today = parseToday({ today: TUESDAY, chests_ready: [TUESDAY, MONDAY] });
    expect(chestBadge(today)).toBe('2');
    expect(chestBadge(parseToday({ today: TUESDAY, chests_ready: [] }))).toBeNull();
    expect(chestBadge(null)).toBeNull();
  });

  it('shows the chances of the chest from its weights', () => {
    const rewards: ChestRewardDef[] = [
      { key: 'points_5', kind: 'points', amount: 5, avatarKey: null, weight: 30 },
      { key: 'freeze', kind: 'freeze', amount: 1, avatarKey: null, weight: 8 },
      { key: 'avatar_maan', kind: 'avatar', amount: null, avatarKey: 'maan', weight: 1 },
      { key: 'points_10', kind: 'points', amount: 10, avatarKey: null, weight: 61 },
    ];
    expect(chestChances(rewards, (k) => (k === 'maan' ? 'Maan' : null))).toEqual([
      { key: 'points_5', label: '+5 punten', percent: '30 %' },
      { key: 'freeze', label: 'Bevriezer', percent: '8 %' },
      { key: 'avatar_maan', label: 'Avatar Maan', percent: '1 %' },
      { key: 'points_10', label: '+10 punten', percent: '61 %' },
    ]);
  });
});

describe('one-time explanations', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });

  it('shows each explanation once per device', () => {
    expect(tipsToShow(seenTips(), ['streak', 'quests', 'chest'])).toEqual(['streak', 'quests', 'chest']);
    markTipsSeen(['streak', 'quests', 'chest']);
    expect(tipsToShow(seenTips(), ['streak', 'quests', 'chest'])).toEqual([]);
  });

  it('shows a section that appears later the first time it appears', () => {
    markTipsSeen(['streak', 'quests']);
    expect(tipsToShow(seenTips(), ['streak', 'quests'])).toEqual([]);
    expect(tipsToShow(seenTips(), ['streak', 'quests', 'chest'])).toEqual(['chest']);
  });

  it('shows them again after a reset (Dev mode) or when storage fails', () => {
    markTipsSeen(['chest']);
    resetTips();
    expect(seenTips().size).toBe(0);
    store.set('today.tips.seen', 'not json');
    expect(seenTips().size).toBe(0);
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    expect(() => markTipsSeen(['streak'])).not.toThrow();
    expect(seenTips().size).toBe(0);
  });

  it('takes its numbers from the catalog', () => {
    const catalog = {
      config: { checkinBaseChips: 10, streakMultiplier: 1.1, streakMaxSteps: 8, bonusQuestionPoints: 5, discoveryChips: 5, maxFreezes: 2, chestOpenDays: 7 },
      quests: (['easy', 'medium', 'hard'] as const).map((slot, i) => ({
        key: slot, period: 'day' as const, slot, title: slot, target: 1, rewardPoints: [5, 10, 15][i], rewardFreezes: 0,
      })),
    };
    expect(tipText('streak', catalog).body).toContain('×1,1 op je punten, tot ×2,14');
    expect(tipText('quests', catalog).body).toContain('(+5, +10, +15)');
    expect(tipText('quests', null).body).not.toContain('(+');
  });

  it('remembers up to which day a ready chest was announced', () => {
    expect(chestAnnounced(TUESDAY)).toBe(false);
    markChestAnnounced(TUESDAY);
    expect([chestAnnounced(MONDAY), chestAnnounced(TUESDAY), chestAnnounced(FRIDAY)]).toEqual([true, true, false]);
    markChestAnnounced(MONDAY);
    expect(chestAnnounced(TUESDAY)).toBe(true);
  });
});
