// The approval celebration (docs/GAMIFICATION.md, chapter 5): what was
// decided since the last visit (`results` of my_unseen), shown when the app
// opens. "Goedgekeurd! +16", the total rolling from old to new, the points per
// source, confirmed badges and unlocked avatars, a level-up with its new title;
// rejected check-ins calmly in their own block with the reason. A level-up
// without a decision (a correction) is shown on its own. Pure: the parser, the
// parts of the screen, their timeline and the Dev mode preview are unit tested.
import type { Event } from '../feedback/reveal/timeline';
import { VOLUME } from '../feedback/reveal/tuning';
import { parseBadgeNewsList, type BadgeNews } from './badges';
import type { Level } from './levels';

export interface ApprovedCheckin {
  checkinId: string;
  binId: number;
  points: number;
}

export interface RejectedCheckin {
  checkinId: string;
  binId: number;
  reason: string | null;
  /** Approved first, revoked later. */
  revoked: boolean;
}

export interface UnseenResults {
  /** The newest 50 of each, oldest first. */
  approved: ApprovedCheckin[];
  rejected: RejectedCheckin[];
  approvedCount: number;
  rejectedCount: number;
  /** Points granted since the last visit, in all. */
  gained: number;
  /** Per source (checkin, discovery, bonus, milestone, …), in the order of SOURCE_LABELS. */
  bySource: { source: string; points: number }[];
  pointsBefore: number;
  pointsAfter: number;
  levelBefore: number;
  levelAfter: number;
  /** The title of levelAfter. */
  levelTitle: string | null;
  /** Granted since the last visit. */
  badges: BadgeNews[];
  avatars: { key: string; name: string }[];
}

/** How a source of points is called in the chips ("+33 inworpen"). */
const SOURCE_LABELS: Record<string, string> = {
  checkin: 'inworpen',
  discovery: 'ontdekking',
  bounty: 'premie',
  bonus: 'bonusvraag',
  milestone: 'mijlpaal',
  quest: 'quest',
  weekly: 'weekuitdaging',
  chest: 'kist',
  adjustment: 'correctie',
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function count(value: unknown): number {
  return isNumber(value) ? value : 0;
}

/** `results` of my_unseen(), or null when it is not what the app expects (an older server). */
export function parseResults(value: unknown): UnseenResults | null {
  if (!isObject(value) || !Array.isArray(value.approved) || !Array.isArray(value.rejected)) return null;
  const approved = value.approved.flatMap((a): ApprovedCheckin[] =>
    isObject(a) && typeof a.checkin_id === 'string' && isNumber(a.bin_id)
      ? [{ checkinId: a.checkin_id, binId: a.bin_id, points: count(a.points) }]
      : [],
  );
  const rejected = value.rejected.flatMap((r): RejectedCheckin[] =>
    isObject(r) && typeof r.checkin_id === 'string' && isNumber(r.bin_id)
      ? [{ checkinId: r.checkin_id, binId: r.bin_id, reason: typeof r.reason === 'string' && r.reason.trim() ? r.reason : null, revoked: r.revoked === true }]
      : [],
  );
  const order = Object.keys(SOURCE_LABELS);
  const bySource = Object.entries(isObject(value.by_source) ? value.by_source : {})
    .flatMap(([source, points]) => (isNumber(points) && points !== 0 ? [{ source, points }] : []))
    .sort((a, b) => (order.indexOf(a.source) + 1 || order.length + 1) - (order.indexOf(b.source) + 1 || order.length + 1));
  const avatars = Array.isArray(value.avatars)
    ? value.avatars.flatMap((a) => (isObject(a) && typeof a.key === 'string' && typeof a.name === 'string' ? [{ key: a.key, name: a.name }] : []))
    : [];
  const levelBefore = isNumber(value.level_before) ? value.level_before : 1;
  return {
    approved,
    rejected,
    approvedCount: Math.max(count(value.approved_count), approved.length),
    rejectedCount: Math.max(count(value.rejected_count), rejected.length),
    gained: count(value.gained),
    bySource,
    pointsBefore: count(value.points_before),
    pointsAfter: count(value.points_after),
    levelBefore,
    levelAfter: isNumber(value.level_after) ? value.level_after : levelBefore,
    levelTitle: typeof value.level_title === 'string' ? value.level_title : null,
    badges: parseBadgeNewsList(value.badges),
    avatars,
  };
}

export function isLevelUp(results: UnseenResults): boolean {
  return results.levelAfter > results.levelBefore;
}

/** Whether the results are worth a celebration: a decision, a level-up, a confirmed badge or a new avatar. */
export function hasResults(results: UnseenResults | null): results is UnseenResults {
  if (!results) return false;
  return (
    results.approvedCount + results.rejectedCount > 0 || isLevelUp(results) || results.badges.length > 0 || results.avatars.length > 0
  );
}

/** "+33 inworpen" per source. */
export function sourceChips(results: UnseenResults): string[] {
  return results.bySource.map(({ source, points }) => `${points > 0 ? '+' : ''}${points} ${SOURCE_LABELS[source] ?? source}`);
}

/**
 * The headline: "Goedgekeurd! +16" when something was approved, "Beoordeeld"
 * with only rejections, null when a level-up is the headline (no decision),
 * else "Bevestigd!" (a badge or avatar confirmed without a check-in, e.g. a report).
 */
export function approvalHeadline(results: UnseenResults): string | null {
  if (results.approvedCount > 0) return results.gained > 0 ? `Goedgekeurd! +${results.gained}` : 'Goedgekeurd!';
  if (results.rejectedCount > 0) return 'Beoordeeld';
  if (isLevelUp(results)) return null;
  return 'Bevestigd!';
}

/** "3 inworpen goedgekeurd" (1: "1 inworp goedgekeurd"); null without approvals. */
export function approvedLine(results: UnseenResults): string | null {
  const n = results.approvedCount;
  return n > 0 ? `${n} ${n === 1 ? 'inworp' : 'inworpen'} goedgekeurd` : null;
}

/** "#58 · Foto onduidelijk", "#61 · Herroepen · Dubbel": a rejected check-in. */
export function rejectedLine(rejected: RejectedCheckin): string {
  return [`#${rejected.binId}`, rejected.revoked ? 'Herroepen' : null, rejected.reason].filter(Boolean).join(' · ');
}

/** "Level 8 · Leiewachter". */
export function levelUpLine(results: UnseenResults): string {
  return results.levelTitle ? `Level ${results.levelAfter} · ${results.levelTitle}` : `Level ${results.levelAfter}`;
}

/** What VoiceOver says at once instead of the animation. */
export function approvalSummary(results: UnseenResults): string {
  const parts: string[] = [];
  const headline = approvalHeadline(results);
  if (results.approvedCount > 0) parts.push(`${approvedLine(results)}: ${results.gained} punten erbij, totaal ${results.pointsAfter}.`);
  else if (headline) parts.push(`${headline}.`);
  if (isLevelUp(results)) parts.push(`${levelUpLine(results)}.`);
  for (const badge of results.badges) parts.push(`Badge ${badge.name}.`);
  for (const avatar of results.avatars) parts.push(`${avatar.name} ontgrendeld.`);
  if (results.rejectedCount > 0) {
    const n = results.rejectedCount;
    parts.push(`${n} ${n === 1 ? 'inworp' : 'inworpen'} afgewezen${results.rejected.length > 0 ? ': ' + results.rejected.map(rejectedLine).join(', ') : ''}.`);
  }
  return parts.join(' ');
}

/** The blocks of the screen, top to bottom; each comes in on its own `part` event. */
export type ApprovalPart = 'headline' | 'total' | 'sources' | 'level' | 'badges' | 'avatars' | 'rejected';

export function approvalParts(results: UnseenResults): ApprovalPart[] {
  const parts: ApprovalPart[] = [];
  if (approvalHeadline(results) !== null) parts.push('headline');
  if (results.approvedCount > 0) parts.push('total');
  if (results.approvedCount > 0 && results.bySource.length > 0) parts.push('sources');
  if (isLevelUp(results)) parts.push('level');
  if (results.badges.length > 0) parts.push('badges');
  if (results.avatars.length > 0) parts.push('avatars');
  if (results.rejectedCount > 0) parts.push('rejected');
  return parts;
}

/** Between two blocks. */
export const APPROVAL_PART_MS = 260;
/** The total rolls from old to new over this long. */
export const APPROVAL_COUNT_MS = 700;
/** The chord of levelup_fanfare lands here (scripts/generate-sfx.mjs, LEVEL_CHORD_AT). */
export const LEVEL_CHORD_MS = 400;
export const LEVEL_CONFETTI_PIECES = 40;

/**
 * The timeline: the chime and a success haptic when something was approved
 * (a soft tock and a light haptic with only rejections), then every block in
 * turn. The total starts rolling when its block comes in (celebrate.tsx). A
 * level-up plays its fanfare and comes in on its chord, with confetti (none
 * with Reduce Motion). The rejections come last, without a sound.
 */
export function buildApprovalTimeline({ results, reduceMotion }: { results: UnseenResults; reduceMotion: boolean }): Event[] {
  const parts = approvalParts(results);
  const events: Event[] = [];
  const cheer = results.approvedCount > 0 || results.badges.length > 0 || results.avatars.length > 0;
  if (parts[0] !== 'level') {
    events.push(
      cheer
        ? { atMs: 0, type: 'sound', id: 'approve_chime', volume: VOLUME.approve }
        : { atMs: 0, type: 'sound', id: 'neutral_tock', volume: VOLUME.tock },
      { atMs: 0, type: 'haptic', kind: cheer ? 'success' : 'light' },
    );
  }
  let at = 0;
  parts.forEach((part, index) => {
    if (part === 'level') {
      events.push({ atMs: at, type: 'sound', id: 'levelup_fanfare', volume: VOLUME.levelUp });
      at += LEVEL_CHORD_MS;
      events.push(
        { atMs: at, type: 'haptic', kind: 'success' },
        { atMs: at, type: 'confetti', pieces: reduceMotion ? 0 : LEVEL_CONFETTI_PIECES },
      );
    }
    events.push({ atMs: at, type: 'part', index });
    at += part === 'total' ? APPROVAL_COUNT_MS : APPROVAL_PART_MS;
  });
  return events;
}

/** What the Dev mode preview asks for. */
export interface ApprovalPreviewOptions {
  approved: number;
  rejected: number;
  levelUp: boolean;
  badge: boolean;
}

/**
 * Made-up results for the Dev mode preview: `approved` check-ins of 16 points
 * (11 check-in, 5 discovery) on top of 120 points, `rejected` ones with the
 * reasons of Beheer (the second revoked), a level-up to the level of the new
 * total (or the next one) with its title, the badge Vroege vogel and its merel.
 */
export function previewResults(options: ApprovalPreviewOptions, levels: readonly Level[]): UnseenResults {
  const pointsBefore = 120;
  const gained = 16 * options.approved;
  const pointsAfter = pointsBefore + gained;
  const levelOf = (points: number) => levels.filter((l) => l.minPoints <= points).reduce((top, l) => Math.max(top, l.level), 1);
  const before = levelOf(pointsBefore);
  const after = options.levelUp ? Math.max(levelOf(pointsAfter), before + 1) : before;
  const reasons = ['Foto onduidelijk', 'Dubbel of misbruik'];
  return {
    approved: Array.from({ length: options.approved }, (_, i) => ({ checkinId: `preview-a${i}`, binId: 58 + i, points: 16 })),
    rejected: Array.from({ length: options.rejected }, (_, i) => ({
      checkinId: `preview-r${i}`,
      binId: 74 + i,
      reason: reasons[i % reasons.length],
      revoked: i === 1,
    })),
    approvedCount: options.approved,
    rejectedCount: options.rejected,
    gained,
    bySource: options.approved > 0 ? [{ source: 'checkin', points: 11 * options.approved }, { source: 'discovery', points: 5 * options.approved }] : [],
    pointsBefore,
    pointsAfter,
    levelBefore: before,
    levelAfter: after,
    levelTitle: levels.find((l) => l.level === after)?.title ?? null,
    badges: options.badge
      ? [{ key: 'early_bird', name: 'Vroege vogel', description: "Doe een inworp tussen 5 en 8 uur 's ochtends.", symbol: 'sunrise.fill', rarity: 'rare', status: 'granted' }]
      : [],
    avatars: options.badge ? [{ key: 'merel', name: 'Merel' }] : [],
  };
}
