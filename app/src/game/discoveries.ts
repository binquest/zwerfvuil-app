// Discoveries, milestones and the collection as the server sends them
// (docs/GAMIFICATION.md, 2.6 and 2.7): `game` in the answer of a check-in,
// my_game_state(), my_collection() and my_unseen(). Pure parsers and labels,
// unit tested; fetching is in src/lib/api.ts, the state in GameProvider.
import { parseResults, type UnseenResults } from './approval';
import { parseBadgeNews, parseBadgeNewsList, type BadgeNews } from './badges';
import { parseLevelState, type LevelState } from './levels';
import {
  parseChestNews,
  parseFreezeNewsList,
  parseQuestNewsList,
  parseStreak,
  parseToday,
  type ChestNews,
  type FreezeNews,
  type FreezeSource,
  type QuestNews,
  type QuestSlot,
  type StreakState,
  type TodayState,
} from './today';

/** pending until an admin approves a check-in at that bin. */
export type DiscoveryStatus = 'pending' | 'confirmed';
/** pending until enough discoveries are confirmed. */
export type MilestoneStatus = 'pending' | 'granted';

export interface DiscoveryNews {
  binId: number;
  /** The how-manieth discovery this is (12 in "12/120"). */
  ordinal: number;
  discovered: number;
  totalBins: number;
  status: DiscoveryStatus;
}

export interface MilestoneNews {
  threshold: number;
  points: number;
  status: MilestoneStatus;
}

/** What a check-in made new (`game` in the answer of submit-checkin). */
export interface CheckinGame {
  discovery: DiscoveryNews | null;
  milestone: MilestoneNews | null;
  /** Badges this check-in earned (phase 5). */
  badges: BadgeNews[];
  /** Today's quests and this week's challenge, with completedNow (phase 6). */
  quests: QuestNews[];
  /** Today's chest, with readyNow (phase 6). */
  chest: ChestNews | null;
  /** Freezes this check-in earned (phase 6). */
  freezes: FreezeNews[];
  /** Server time: mark_seen('moments', asOf) after the celebrations. */
  asOf: string | null;
}

export interface NextMilestone {
  threshold: number;
  points: number;
  /** The threshold before it (0 at the start): the bar runs from there. */
  previous: number;
}

/** The numbers of the profile (real check-ins and bonus answers that were not rejected). */
export interface ProfileStats {
  checkins: number;
  bonusAnswers: number;
  /** In weeks. */
  longestStreak: number;
}

/** my_game_state(): v1, with the level and the statistics since phase 4, and Today since phase 6 (v2). */
export interface GameState {
  points: { granted: number; pending: number };
  /** Null when the server sent none. */
  level: LevelState | null;
  /** Day dots and freezes since v2. */
  streak: StreakState;
  discovered: number;
  confirmed: number;
  totalBins: number;
  nextMilestone: NextMilestone | null;
  stats: ProfileStats | null;
  unseenMoments: number;
  /** Quests, challenge, chest (v2); null from an older server. */
  today: TodayState | null;
}

/** One bin of my_collection(); status null = not discovered. */
export interface CollectionEntry {
  binId: number;
  status: DiscoveryStatus | null;
  discoveredAt: string | null;
  /** The user's check-ins there that count (not rejected, not test). */
  checkins: number;
}

export type MissedMoment =
  | { kind: 'discovery'; at: string; binId: number; ordinal: number; status: DiscoveryStatus }
  | { kind: 'milestone'; at: string; threshold: number; points: number; status: MilestoneStatus }
  | { kind: 'badge'; at: string; badge: BadgeNews }
  | { kind: 'quest'; at: string; quest: MissedQuest }
  | { kind: 'chest'; at: string; day: string }
  | { kind: 'freeze'; at: string; source: FreezeSource; status: 'pending' | 'available' };

/** A completed quest as a moment. */
export interface MissedQuest {
  id: string;
  period: 'day' | 'week';
  slot: QuestSlot;
  templateKey: string;
  title: string;
  reward: number;
  freezes: number;
  status: 'pending' | 'granted';
}

/** my_unseen(): the moments missed since the last visit (oldest first) and the decisions. */
export interface Unseen {
  moments: MissedMoment[];
  /** All unseen moments (moments holds the newest 20). */
  total: number;
  /** What was decided since the last visit (phase 5); null from an older server. */
  results: UnseenResults | null;
  asOf: string;
}

type Json = Record<string, unknown>;

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function discoveryStatus(value: unknown): DiscoveryStatus | null {
  return value === 'pending' || value === 'confirmed' ? value : null;
}

function milestoneStatus(value: unknown): MilestoneStatus | null {
  return value === 'pending' || value === 'granted' ? value : null;
}

function parseDiscoveryNews(value: unknown): DiscoveryNews | null {
  if (!isObject(value)) return null;
  const status = discoveryStatus(value.status);
  if (!isNumber(value.bin_id) || !isNumber(value.ordinal) || !isNumber(value.discovered) || !isNumber(value.total_bins) || !status) {
    return null;
  }
  return { binId: value.bin_id, ordinal: value.ordinal, discovered: value.discovered, totalBins: value.total_bins, status };
}

function parseMilestoneNews(value: unknown): MilestoneNews | null {
  if (!isObject(value)) return null;
  const status = milestoneStatus(value.status);
  if (!isNumber(value.threshold) || !isNumber(value.points) || !status) return null;
  return { threshold: value.threshold, points: value.points, status };
}

/** `game` of a check-in, or null (a test check-in, or the game logic failed on the server). */
export function parseCheckinGame(value: unknown): CheckinGame | null {
  if (!isObject(value)) return null;
  return {
    discovery: parseDiscoveryNews(value.discovery),
    milestone: parseMilestoneNews(value.milestone),
    badges: parseBadgeNewsList(value.badges),
    quests: parseQuestNewsList(value.quests),
    chest: parseChestNews(value.chest),
    freezes: parseFreezeNewsList(value.freezes),
    asOf: typeof value.as_of === 'string' ? value.as_of : null,
  };
}

/** my_game_state(), or null when it is not what the app expects. */
export function parseGameState(value: unknown): GameState | null {
  if (!isObject(value) || !isObject(value.points) || !isObject(value.discoveries)) return null;
  const { points, discoveries } = value;
  if (!isNumber(points.granted) || !isNumber(points.pending)) return null;
  if (!isNumber(discoveries.discovered) || !isNumber(discoveries.confirmed) || !isNumber(discoveries.total_bins)) return null;
  const next = isObject(discoveries.next_milestone) ? discoveries.next_milestone : null;
  const stats = isObject(value.stats) ? value.stats : null;
  return {
    points: { granted: points.granted, pending: points.pending },
    level: parseLevelState(value.level),
    streak: parseStreak(value.streak),
    discovered: discoveries.discovered,
    confirmed: discoveries.confirmed,
    totalBins: discoveries.total_bins,
    nextMilestone:
      next && isNumber(next.threshold) && isNumber(next.points)
        ? { threshold: next.threshold, points: next.points, previous: isNumber(next.previous) ? next.previous : 0 }
        : null,
    stats:
      stats && isNumber(stats.checkins) && isNumber(stats.bonus_answers) && isNumber(stats.longest_streak)
        ? { checkins: stats.checkins, bonusAnswers: stats.bonus_answers, longestStreak: stats.longest_streak }
        : null,
    unseenMoments: isNumber(value.unseen_moments) ? value.unseen_moments : 0,
    today: parseToday(value),
  };
}

/** The rows of my_collection(); malformed rows are left out. */
export function parseCollection(value: unknown): CollectionEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row): CollectionEntry[] => {
    if (!isObject(row) || !isNumber(row.bin_id)) return [];
    return [
      {
        binId: row.bin_id,
        status: discoveryStatus(row.status),
        discoveredAt: typeof row.discovered_at === 'string' ? row.discovered_at : null,
        checkins: isNumber(row.checkins) ? row.checkins : 0,
      },
    ];
  });
}

/** my_unseen(), or null when it is not what the app expects. */
export function parseUnseen(value: unknown): Unseen | null {
  if (!isObject(value) || !Array.isArray(value.moments) || typeof value.as_of !== 'string') return null;
  const moments = value.moments.flatMap((m): MissedMoment[] => {
    if (!isObject(m) || typeof m.at !== 'string') return [];
    if (m.kind === 'discovery') {
      const status = discoveryStatus(m.status);
      return isNumber(m.bin_id) && isNumber(m.ordinal) && status
        ? [{ kind: 'discovery', at: m.at, binId: m.bin_id, ordinal: m.ordinal, status }]
        : [];
    }
    if (m.kind === 'milestone') {
      const status = milestoneStatus(m.status);
      return isNumber(m.threshold) && isNumber(m.points) && status
        ? [{ kind: 'milestone', at: m.at, threshold: m.threshold, points: m.points, status }]
        : [];
    }
    if (m.kind === 'badge') {
      const badge = parseBadgeNews(m);
      return badge ? [{ kind: 'badge', at: m.at, badge }] : [];
    }
    if (m.kind === 'quest') {
      const slot = (['easy', 'medium', 'hard', 'weekly'] as const).find((x) => x === m.slot);
      const status = m.status === 'pending' || m.status === 'granted' ? m.status : null;
      if (typeof m.id !== 'string' || typeof m.title !== 'string' || !slot || !status) return [];
      const quest: MissedQuest = {
        id: m.id,
        period: m.period === 'week' ? 'week' : 'day',
        slot,
        templateKey: typeof m.template_key === 'string' ? m.template_key : '',
        title: m.title,
        reward: isNumber(m.reward) ? m.reward : 0,
        freezes: isNumber(m.freezes) ? m.freezes : 0,
        status,
      };
      return [{ kind: 'quest', at: m.at, quest }];
    }
    if (m.kind === 'chest') {
      return typeof m.day === 'string' ? [{ kind: 'chest', at: m.at, day: m.day }] : [];
    }
    if (m.kind === 'freeze') {
      const source = m.source === 'milestone' || m.source === 'quest' || m.source === 'chest' ? m.source : null;
      const status = m.status === 'pending' || m.status === 'available' ? m.status : null;
      return source && status ? [{ kind: 'freeze', at: m.at, source, status }] : [];
    }
    return [];
  });
  return {
    moments,
    total: isNumber(value.moments_total) ? value.moments_total : moments.length,
    results: parseResults(value.results),
    asOf: value.as_of,
  };
}

export type CollectionFilter = 'all' | 'discovered' | 'undiscovered';

/** The entries the collection shows for `filter`, by bin number. */
export function collectionFilter(entries: readonly CollectionEntry[], filter: CollectionFilter): CollectionEntry[] {
  return entries
    .filter((entry) => filter === 'all' || (filter === 'discovered') === (entry.status !== null))
    .sort((a, b) => a.binId - b.binId);
}

/** The bin sheet: "12 okt. · 3 inworpen", with "wacht op goedkeuring" while pending; "Nog niet ontdekt" otherwise. */
export function binDiscoveryLabel(entry: CollectionEntry | null | undefined, formatDate: (iso: string) => string): string {
  if (!entry?.status) return 'Nog niet ontdekt';
  const parts = [`${entry.checkins} ${entry.checkins === 1 ? 'inworp' : 'inworpen'}`];
  if (entry.discoveredAt) parts.unshift(formatDate(entry.discoveredAt));
  if (entry.status === 'pending') parts.push('wacht op goedkeuring');
  return parts.join(' · ');
}

/** "#58 · 12/120": the bin's number and the counter. */
export function discoveryLine(news: Pick<DiscoveryNews, 'binId' | 'discovered' | 'totalBins'>): string {
  return `#${news.binId} · ${news.discovered}/${news.totalBins}`;
}

/** "34/120 ontdekt". */
export function counterLabel(discovered: number, totalBins: number): string {
  return `${discovered}/${totalBins} ontdekt`;
}

/** "10 vuilbakken ontdekt" (1: "1 vuilbak ontdekt"). */
export function milestoneTitle(threshold: number): string {
  return `${threshold} ${threshold === 1 ? 'vuilbak' : 'vuilbakken'} ontdekt`;
}

/** "Nog 6 tot 40" for the bar to the next milestone; null when every milestone is reached. */
export function nextMilestoneLabel(discovered: number, next: NextMilestone | null): string | null {
  if (!next) return null;
  const left = next.threshold - discovered;
  return `Nog ${left} tot ${next.threshold} · +${next.points}`;
}

/**
 * What the celebration of missed moments shows: the highest milestone (with
 * confetti) or none, the discoveries, the completed quests (one per quest, the
 * last status), the newest chest that became ready, the freezes and the badges
 * (one per badge, the last status).
 */
export function summarizeMoments(moments: readonly MissedMoment[]): {
  milestone: Extract<MissedMoment, { kind: 'milestone' }> | null;
  discoveries: Extract<MissedMoment, { kind: 'discovery' }>[];
  quests: MissedQuest[];
  chestDay: string | null;
  freezes: number;
  badges: BadgeNews[];
} {
  let milestone: Extract<MissedMoment, { kind: 'milestone' }> | null = null;
  const discoveries: Extract<MissedMoment, { kind: 'discovery' }>[] = [];
  const badges = new Map<string, BadgeNews>();
  const quests = new Map<string, MissedQuest>();
  let chestDay = null as string | null;
  let freezes = 0;
  for (const moment of moments) {
    if (moment.kind === 'discovery') discoveries.push(moment);
    else if (moment.kind === 'badge') badges.set(moment.badge.key, moment.badge);
    else if (moment.kind === 'quest') quests.set(moment.quest.id, moment.quest);
    else if (moment.kind === 'chest') chestDay = chestDay === null || moment.day > chestDay ? moment.day : chestDay;
    else if (moment.kind === 'freeze') freezes += 1;
    else if (!milestone || moment.threshold > milestone.threshold) milestone = moment;
  }
  return { milestone, discoveries, quests: [...quests.values()], chestDay, freezes, badges: [...badges.values()] };
}
