// Badges as the server sends them (docs/GAMIFICATION.md, 2.6 and chapter 3):
// my_badges() for the profile, `game.badges` in the answer of a check-in and
// badge moments in my_unseen(). Names, explanations and symbols come from the
// server (a secret badge arrives as "Geheime badge" until it is earned). Pure
// parsers and labels, unit tested.
import type { Rarity } from '../theme/game';

/** locked: not earned (or revoked); pending: earned, waits for an approval; granted: earned. */
export type BadgeStatus = 'locked' | 'pending' | 'granted';

export interface BadgeInfo {
  key: string;
  name: string;
  /** How to earn it: the explanation. */
  description: string;
  /** An SF Symbol. */
  symbol: string;
  rarity: Rarity;
}

/** A badge that was just earned or confirmed (after a check-in, a missed moment, an approval). */
export interface BadgeNews extends BadgeInfo {
  status: 'pending' | 'granted';
}

/** One badge of my_badges(). */
export interface Badge extends BadgeInfo {
  secret: boolean;
  sort: number;
  status: BadgeStatus;
  earnedAt: string | null;
  /** Towards the target; null for a hidden secret badge. */
  progress: number | null;
  target: number | null;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function rarity(value: unknown): Rarity {
  return value === 'rare' || value === 'epic' || value === 'legendary' ? value : 'common';
}

function parseInfo(value: Json): BadgeInfo | null {
  if (!isText(value.key) || !isText(value.name)) return null;
  return {
    key: value.key,
    name: value.name,
    description: typeof value.description === 'string' ? value.description : '',
    symbol: isText(value.symbol) ? value.symbol : 'star.fill',
    rarity: rarity(value.rarity),
  };
}

/** One badge of `game.badges`, a moment or the results; null when unusable. */
export function parseBadgeNews(value: unknown): BadgeNews | null {
  if (!isObject(value)) return null;
  const info = parseInfo(value);
  if (!info || (value.status !== 'pending' && value.status !== 'granted')) return null;
  return { ...info, status: value.status };
}

/** A list of badges (unusable ones left out). */
export function parseBadgeNewsList(value: unknown): BadgeNews[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const badge = parseBadgeNews(item);
    return badge ? [badge] : [];
  });
}

/** The rows of my_badges(), in catalog order; unusable rows are left out. */
export function parseMyBadges(value: unknown): Badge[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((row): Badge[] => {
      if (!isObject(row)) return [];
      const info = parseInfo(row);
      if (!info) return [];
      const status: BadgeStatus = row.status === 'pending' || row.status === 'granted' ? row.status : 'locked';
      return [
        {
          ...info,
          secret: row.secret === true,
          sort: isNumber(row.sort) ? row.sort : 0,
          status,
          earnedAt: typeof row.earned_at === 'string' ? row.earned_at : null,
          progress: isNumber(row.progress) ? row.progress : null,
          target: isNumber(row.target) ? row.target : null,
        },
      ];
    })
    .sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
}

/** "4 van 11 badges". */
export function badgeCountLabel(badges: readonly Badge[]): string {
  const earned = badges.filter((b) => b.status !== 'locked').length;
  return `${earned} van ${badges.length}`;
}

/**
 * The line under the explanation of a badge: when it was earned, that it
 * waits for an approval, or how far along it is ("Nog 13 te gaan · 12/25").
 */
export function badgeStatusLine(badge: Badge, formatDate: (iso: string) => string): string | null {
  if (badge.status === 'pending') return 'Verdiend · wacht op goedkeuring';
  if (badge.status === 'granted') return badge.earnedAt ? `Verdiend op ${formatDate(badge.earnedAt)}` : 'Verdiend';
  if (badge.progress === null || badge.target === null || badge.target <= 1) return null;
  return `Nog ${Math.max(0, badge.target - badge.progress)} te gaan · ${badge.progress}/${badge.target}`;
}
