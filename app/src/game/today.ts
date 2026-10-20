// Today (docs/GAMIFICATION.md, phase 6): the quests, the weekly challenge,
// the daily chest and the streak with its day dots and freezes, as the server
// sends them (my_game_state v2, `game` of a check-in, moments of my_unseen),
// and the view-models of the Today screen and the chest. Pure parsers and
// labels, unit tested; numbers come from the server and the catalog.
import type { ChestRewardDef, GameCatalog, QuestTemplate } from './catalog';

export type QuestStatus = 'open' | 'pending' | 'granted';
export type QuestSlot = 'easy' | 'medium' | 'hard' | 'weekly';

export interface Quest {
  id: string;
  period: 'day' | 'week';
  slot: QuestSlot;
  templateKey: string;
  title: string;
  /** Over facts that were not rejected (capped at the target). */
  progress: number;
  /** Over approved facts. */
  progressCertain: number;
  target: number;
  /** Points when completed (frozen when handed out). */
  reward: number;
  /** Streak freezes when completed. */
  freezes: number;
  status: QuestStatus;
  completedAt: string | null;
}

/** A quest in `game` of a check-in: completedNow when this check-in completed it. */
export interface QuestNews extends Quest {
  completedNow: boolean;
}

/** The weekly challenge, with its last day (Sunday). */
export interface WeeklyQuest extends Quest {
  endsOn: string;
}

export type ChestStatus = 'locked' | 'ready' | 'opened';
export type RewardKind = 'points' | 'freeze' | 'avatar';
export type RewardStatus = 'pending' | 'granted' | 'revoked';

export interface ChestReward {
  key: string;
  kind: RewardKind;
  /** Points or freezes; null for an avatar. */
  amount: number | null;
  avatarKey: string | null;
  status: RewardStatus;
}

export interface Chest {
  id: number;
  /** The local day (YYYY-MM-DD). */
  day: string;
  status: ChestStatus;
  questsDone: number;
  questsTotal: number;
  /** The draw, once opened (kept when the chest is locked again). */
  reward: ChestReward | null;
}

/** The chest in `game` of a check-in: readyNow when this check-in made it ready. */
export interface ChestNews extends Chest {
  readyNow: boolean;
}

export type DayState = 'approved' | 'pending' | 'none';

/** The streak of my_game_state v2 (weeks and thisWeek as in v1). */
export interface StreakState {
  weeks: number;
  thisWeek: boolean;
  /** Freezes in hand (earned, not used, not lost). */
  freezes: number;
  maxFreezes: number;
  /** The Mondays bridged by a freeze in the live streak. */
  frozenWeeks: string[];
  /** The Monday of this week; null from an older server. */
  weekStart: string | null;
  /** Monday to Sunday of this week. */
  days: { date: string; state: DayState }[];
}

/** The Today part of my_game_state v2. */
export interface TodayState {
  /** The local date of the server (YYYY-MM-DD). */
  date: string;
  /** Today's quests: easy, medium, hard. */
  quests: Quest[];
  weekly: WeeklyQuest | null;
  chest: Chest | null;
  /** Days with a chest ready to open, newest first (today included). */
  chestsReady: string[];
  /** Real check-ins waiting for approval. */
  pendingCheckins: number;
}

export type FreezeSource = 'milestone' | 'quest' | 'chest';

/** A freeze earned by a check-in or missed since the last visit. */
export interface FreezeNews {
  source: FreezeSource;
  status: 'pending' | 'available';
}

type Json = Record<string, unknown>;

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const SLOTS: readonly QuestSlot[] = ['easy', 'medium', 'hard', 'weekly'];

function questStatus(value: unknown): QuestStatus | null {
  return value === 'open' || value === 'pending' || value === 'granted' ? value : null;
}

/** One quest as quest_json sends it, or null. */
export function parseQuest(value: unknown): Quest | null {
  if (!isObject(value)) return null;
  const status = questStatus(value.status);
  const slot = SLOTS.find((s) => s === value.slot);
  if (typeof value.id !== 'string' || typeof value.title !== 'string' || !status || !slot) return null;
  if (!isNumber(value.progress) || !isNumber(value.target) || value.target < 1) return null;
  return {
    id: value.id,
    period: value.period === 'week' ? 'week' : 'day',
    slot,
    templateKey: typeof value.template_key === 'string' ? value.template_key : '',
    title: value.title,
    progress: Math.min(value.progress, value.target),
    progressCertain: isNumber(value.progress_certain) ? Math.min(value.progress_certain, value.target) : 0,
    target: value.target,
    reward: isNumber(value.reward) ? value.reward : 0,
    freezes: isNumber(value.freezes) ? value.freezes : 0,
    status,
    completedAt: typeof value.completed_at === 'string' ? value.completed_at : null,
  };
}

function parseQuests(value: unknown): Quest[] {
  return Array.isArray(value) ? value.flatMap((q) => parseQuest(q) ?? []) : [];
}

/** `game.quests` of a check-in. */
export function parseQuestNewsList(value: unknown): QuestNews[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((q): QuestNews[] => {
    const quest = parseQuest(q);
    return quest ? [{ ...quest, completedNow: isObject(q) && q.completed_now === true }] : [];
  });
}

/** The reward of a chest (chest_json, open_daily_chest), or null. */
export function parseChestReward(value: unknown): ChestReward | null {
  if (!isObject(value) || typeof value.key !== 'string') return null;
  const kind = value.kind === 'points' || value.kind === 'freeze' || value.kind === 'avatar' ? value.kind : null;
  const status = value.status === 'pending' || value.status === 'granted' || value.status === 'revoked' ? value.status : null;
  if (!kind || !status) return null;
  return {
    key: value.key,
    kind,
    amount: isNumber(value.amount) ? value.amount : null,
    avatarKey: typeof value.avatar_key === 'string' ? value.avatar_key : null,
    status,
  };
}

/** One chest as chest_json sends it, or null. */
export function parseChest(value: unknown): Chest | null {
  if (!isObject(value) || !isNumber(value.id) || !isDate(value.day)) return null;
  const status = value.status === 'locked' || value.status === 'ready' || value.status === 'opened' ? value.status : null;
  if (!status) return null;
  return {
    id: value.id,
    day: value.day,
    status,
    questsDone: isNumber(value.quests_done) ? value.quests_done : 0,
    questsTotal: isNumber(value.quests_total) ? value.quests_total : 0,
    reward: parseChestReward(value.reward),
  };
}

/** `game.chest` of a check-in, or null. */
export function parseChestNews(value: unknown): ChestNews | null {
  const chest = parseChest(value);
  return chest ? { ...chest, readyNow: isObject(value) && value.ready_now === true } : null;
}

/** `game.freezes` of a check-in. */
export function parseFreezeNewsList(value: unknown): FreezeNews[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((f): FreezeNews[] => {
    if (!isObject(f)) return [];
    const source = f.source === 'milestone' || f.source === 'quest' || f.source === 'chest' ? f.source : null;
    const status = f.status === 'pending' || f.status === 'available' ? f.status : null;
    return source && status ? [{ source, status }] : [];
  });
}

/** The streak of my_game_state (v1 gives weeks and thisWeek only). */
export function parseStreak(value: unknown): StreakState {
  const streak = isObject(value) ? value : {};
  const days = Array.isArray(streak.days)
    ? streak.days.flatMap((d): StreakState['days'] => {
        if (!isObject(d) || !isDate(d.date)) return [];
        const state = d.state === 'approved' || d.state === 'pending' ? d.state : 'none';
        return [{ date: d.date, state }];
      })
    : [];
  return {
    weeks: isNumber(streak.weeks) ? streak.weeks : 0,
    thisWeek: streak.this_week === true,
    freezes: isNumber(streak.freezes) ? Math.max(0, streak.freezes) : 0,
    maxFreezes: isNumber(streak.max_freezes) ? streak.max_freezes : 2,
    frozenWeeks: Array.isArray(streak.frozen_weeks) ? streak.frozen_weeks.filter(isDate) : [],
    weekStart: isDate(streak.week_start) ? streak.week_start : null,
    days,
  };
}

/** The Today part of my_game_state v2, or null from an older server. */
export function parseToday(value: unknown): TodayState | null {
  if (!isObject(value) || !isDate(value.today)) return null;
  const weekly = parseQuest(value.weekly);
  const endsOn = isObject(value.weekly) && isDate(value.weekly.ends_on) ? value.weekly.ends_on : null;
  return {
    date: value.today,
    quests: parseQuests(value.quests).filter((q) => q.period === 'day'),
    weekly: weekly && endsOn ? { ...weekly, endsOn } : null,
    chest: parseChest(value.chest),
    chestsReady: Array.isArray(value.chests_ready) ? value.chests_ready.filter(isDate) : [],
    pendingCheckins: isNumber(value.pending_checkins) ? value.pending_checkins : 0,
  };
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** 1 (Monday) to 7 (Sunday) for a local date YYYY-MM-DD. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The date `days` after `date` (YYYY-MM-DD). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

export const WEEKDAY_SHORT = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'] as const;
const WEEKDAY_LONG = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'] as const;

/** "vandaag", "gisteren" or the weekday ("dinsdag") of a chest. */
export function dayLabel(day: string, today: string): string {
  const ago = daysBetween(day, today);
  if (ago === 0) return 'vandaag';
  if (ago === 1) return 'gisteren';
  return WEEKDAY_LONG[isoWeekday(day) - 1];
}

// ---------------------------------------------------------------------------
// The streak card
// ---------------------------------------------------------------------------

export interface DayDot {
  date: string;
  /** "ma" … "zo". */
  label: string;
  /** Filled = approved, ring = waiting, empty = none. */
  state: DayState;
  today: boolean;
  future: boolean;
}

/** The seven dots Monday to Sunday of this week; today circled. */
export function dayDots(streak: StreakState, today: string): DayDot[] {
  const monday = streak.weekStart ?? addDays(today, 1 - isoWeekday(today));
  return WEEKDAY_SHORT.map((label, i) => {
    const date = addDays(monday, i);
    const state = streak.days.find((d) => d.date === date)?.state ?? 'none';
    return { date, label, state, today: date === today, future: date > today };
  });
}

/** In danger from Friday: a streak to lose, nothing this week yet. Null when not. */
export function streakDanger(streak: StreakState, today: string): { daysLeft: number } | null {
  const weekday = isoWeekday(today);
  if (streak.weeks < 1 || streak.thisWeek || weekday < 5) return null;
  return { daysLeft: 8 - weekday };
}

export type Tone = 'calm' | 'good' | 'danger';

/** The line under the dots: "Deze week telt al", "Reeks in gevaar · nog 2 dagen", … */
export function streakStatusLine(streak: StreakState, today: string): { text: string; tone: Tone } {
  if (streak.thisWeek) return { text: 'Deze week telt al', tone: 'good' };
  const danger = streakDanger(streak, today);
  if (danger) {
    const left = danger.daysLeft === 1 ? 'nog vandaag' : `nog ${danger.daysLeft} dagen`;
    return { text: `Reeks in gevaar · ${left}`, tone: 'danger' };
  }
  if (streak.weeks < 1) return { text: 'Doe een inworp om een reeks te starten', tone: 'calm' };
  return { text: 'Doe deze week een inworp om je reeks te houden', tone: 'calm' };
}

/** "5 weken", "1 week", "Nog geen reeks". */
export function streakWeeksLabel(weeks: number): string {
  if (weeks < 1) return 'Nog geen reeks';
  return weeks === 1 ? '1 week' : `${weeks} weken`;
}

/** "1 van 2 bevriezers" and, when last week was bridged, "vorige week bevroren". */
export function freezeLine(streak: StreakState): string {
  const held =
    streak.freezes === 0 ? 'Geen bevriezers' : `${streak.freezes} van ${streak.maxFreezes} ${streak.maxFreezes === 1 ? 'bevriezer' : 'bevriezers'}`;
  const lastWeek = streak.weekStart ? addDays(streak.weekStart, -7) : null;
  return lastWeek && streak.frozenWeeks.includes(lastWeek) ? `${held} · vorige week bevroren` : held;
}

// ---------------------------------------------------------------------------
// Quests, the challenge, the chest
// ---------------------------------------------------------------------------

/** "+10", "+10 · bevriezer", "Bevriezer". */
export function questRewardLabel(quest: Pick<Quest, 'reward' | 'freezes'>): string {
  const parts = [];
  if (quest.reward > 0) parts.push(`+${quest.reward}`);
  if (quest.freezes > 0) parts.push(quest.freezes === 1 ? 'bevriezer' : `${quest.freezes} bevriezers`);
  const label = parts.join(' · ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export interface QuestRowModel {
  id: string;
  title: string;
  /** "1/2". */
  progressLabel: string;
  value: number;
  max: number;
  rewardLabel: string;
  /** open; done but waiting for approval (clock); done for good. */
  state: 'open' | 'pending' | 'done';
  accessibilityLabel: string;
}

export function questRow(quest: Quest): QuestRowModel {
  const state = quest.status === 'granted' ? 'done' : quest.status === 'pending' ? 'pending' : 'open';
  const reward = questRewardLabel(quest);
  const stateText = state === 'done' ? 'voltooid' : state === 'pending' ? 'voltooid, wacht op goedkeuring' : `${quest.progress} van ${quest.target}`;
  return {
    id: quest.id,
    title: quest.title,
    progressLabel: `${quest.progress}/${quest.target}`,
    value: quest.progress,
    max: quest.target,
    rewardLabel: reward,
    state,
    accessibilityLabel: `${quest.title}, ${stateText}, ${reward}`,
  };
}

/** Done quests (pending or granted) of a list. */
export function questsDone(quests: readonly Quest[]): number {
  return quests.filter((q) => q.status !== 'open').length;
}

/** The weekly challenge: its row, and "nog 3 dagen" / "laatste dag". */
export function weeklyRow(weekly: WeeklyQuest, today: string): QuestRowModel & { daysLeftLabel: string } {
  const left = daysBetween(today, weekly.endsOn) + 1;
  return { ...questRow(weekly), daysLeftLabel: left <= 1 ? 'laatste dag' : `nog ${left} dagen` };
}

/** "Maan", "+15", "Bevriezer" (the reward itself). */
export function rewardTitle(reward: Pick<ChestReward, 'kind' | 'amount' | 'avatarKey'>, avatarName?: (key: string) => string | null): string {
  if (reward.kind === 'points') return `+${reward.amount ?? 0}`;
  if (reward.kind === 'freeze') return (reward.amount ?? 1) === 1 ? 'Bevriezer' : `${reward.amount} bevriezers`;
  return (reward.avatarKey && avatarName?.(reward.avatarKey)) || 'Nieuwe avatar';
}

export interface ChestCardModel {
  state: ChestStatus;
  title: string;
  detail: string;
  /** For the bar of a locked chest. */
  done: number;
  total: number;
}

/** The chest card on Today: locked (2/3) → "Open je kist" → opened (+15 · wacht). */
export function chestCard(chest: Chest, avatarName?: (key: string) => string | null): ChestCardModel {
  const base = { done: chest.questsDone, total: chest.questsTotal };
  if (chest.status === 'ready') return { ...base, state: 'ready', title: 'Open je kist', detail: 'Je 3 quests zijn af' };
  if (chest.status === 'opened' && chest.reward) {
    const waiting = chest.reward.status === 'pending' ? ' · wacht op goedkeuring' : '';
    return { ...base, state: 'opened', title: 'Kist geopend', detail: `${rewardTitle(chest.reward, avatarName)}${waiting}` };
  }
  const left = Math.max(0, chest.questsTotal - chest.questsDone);
  const detail = chest.reward
    ? `Je ${rewardTitle(chest.reward, avatarName)} komt terug als je quests weer af zijn`
    : left === 1
      ? 'Nog 1 quest tot je kist'
      : `Nog ${left} quests tot je kist`;
  return { ...base, state: 'locked', title: 'Dagkist', detail };
}

/** "3 inworpen wachten · +64 voorlopig"; null when nothing waits. */
export function pendingLine(pendingCheckins: number, pendingPoints: number): string | null {
  if (pendingCheckins < 1 && pendingPoints < 1) return null;
  const checkins = pendingCheckins === 1 ? '1 inworp wacht' : `${pendingCheckins} inworpen wachten`;
  if (pendingCheckins < 1) return `+${pendingPoints} voorlopig`;
  return pendingPoints > 0 ? `${checkins} · +${pendingPoints} voorlopig` : checkins;
}

/** The badge of the Today tab: the number of ready chests, or null. */
export function chestBadge(today: TodayState | null): string | null {
  const n = today?.chestsReady.length ?? 0;
  return n > 0 ? String(n) : null;
}

/** The chances of the chest ("Kansen"): label and whole percent, by weight. */
export function chestChances(
  rewards: readonly ChestRewardDef[],
  avatarName?: (key: string) => string | null,
): { key: string; label: string; percent: string }[] {
  const total = rewards.reduce((sum, r) => sum + r.weight, 0);
  if (total <= 0) return [];
  return rewards.map((r) => {
    const share = (r.weight / total) * 100;
    const label =
      r.kind === 'avatar' ? `Avatar ${rewardTitle({ kind: 'avatar', amount: null, avatarKey: r.avatarKey }, avatarName)}` : rewardTitle(r);
    return { key: r.key, label: r.kind === 'points' ? `${label} punten` : label, percent: share < 1 ? '< 1 %' : `${Math.round(share)} %` };
  });
}

// ---------------------------------------------------------------------------
// One-time explanations
// ---------------------------------------------------------------------------

export type TipKind = 'streak' | 'quests' | 'chest';

/** The explanations to show now: the visible sections whose tip was never shown on this device. */
export function tipsToShow(seen: ReadonlySet<TipKind>, visible: readonly TipKind[]): TipKind[] {
  return visible.filter((tip) => !seen.has(tip));
}

function slotPoints(quests: readonly QuestTemplate[], slot: QuestTemplate['slot']): number | null {
  const points = quests.filter((q) => q.slot === slot).map((q) => q.rewardPoints);
  return points.length ? Math.min(...points) : null;
}

/** The explanation of a section, with the numbers of the catalog. */
export function tipText(tip: TipKind, catalog: Pick<GameCatalog, 'config' | 'quests'> | null): { title: string; body: string } {
  if (tip === 'streak') {
    const step = catalog ? String(catalog.config.streakMultiplier).replace('.', ',') : '1,1';
    const max = catalog ? (catalog.config.streakMultiplier ** catalog.config.streakMaxSteps).toFixed(2).replace('.', ',') : null;
    const freezes = catalog?.config.maxFreezes ?? 2;
    return {
      title: 'Je reeks',
      body:
        `Doe elke week minstens één inworp. Elke week erbij geeft ×${step} op je punten` +
        `${max ? `, tot ×${max}` : ''}. Een bevriezer redt een gemiste week; je kunt er ${freezes} bewaren.`,
    };
  }
  if (tip === 'quests') {
    const quests = catalog?.quests ?? [];
    const pts = (['easy', 'medium', 'hard'] as const).map((s) => slotPoints(quests, s));
    const rewards = pts.every((p) => p !== null) ? ` (+${pts.join(', +')})` : '';
    return {
      title: 'Dagquests',
      body: `Elke dag 3 nieuwe quests${rewards}. Ze lopen meteen op met je inworpen; de punten tellen na goedkeuring.`,
    };
  }
  return {
    title: 'Je dagkist',
    body: 'Zijn je 3 quests van vandaag af, dan gaat je dagkist open: punten, een bevriezer of zelfs een avatar. De kansen staan bij de kist.',
  };
}
