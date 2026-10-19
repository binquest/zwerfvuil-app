import { describe, expect, it } from '@jest/globals';

import { badgeCountLabel, badgeStatusLine, parseBadgeNews, parseBadgeNewsList, parseMyBadges, type Badge } from '../badges';

const date = (iso: string) => iso.slice(0, 10);

/** Rows of my_badges() as the server sends them (supabase/tests/database/14_badges.test.sql). */
const ROWS = [
  { key: 'curious', name: 'Nieuwsgierig', description: 'Beantwoord 25 bonusvragen.', symbol: 'questionmark.bubble.fill', rarity: 'rare', secret: false, sort: 7, status: 'locked', earned_at: null, progress: 12, target: 25 },
  { key: 'first_checkin', name: 'Eerste inworp', description: 'Doe je eerste inworp.', symbol: 'hand.thumbsup.fill', rarity: 'common', secret: false, sort: 1, status: 'granted', earned_at: '2026-10-12T08:00:00Z', progress: 1, target: 1 },
  { key: 'night_owl', name: 'Geheime badge', description: 'Een verrassing: blijf spelen.', symbol: 'questionmark', rarity: 'rare', secret: true, sort: 10, status: 'locked', earned_at: null, progress: null, target: null },
  { key: 'early_bird', name: 'Vroege vogel', description: 'Doe een inworp tussen 5 en 8 uur.', symbol: 'sunrise.fill', rarity: 'mythic', secret: false, sort: 9, status: 'pending', earned_at: '2026-10-19T05:30:00Z', progress: 1, target: 1 },
  { key: 'broken' },
];

describe('parseMyBadges', () => {
  const badges = parseMyBadges(ROWS);

  it('reads every usable row in catalog order', () => {
    expect(badges.map((b) => [b.key, b.status, b.progress, b.target])).toEqual([
      ['first_checkin', 'granted', 1, 1],
      ['curious', 'locked', 12, 25],
      ['early_bird', 'pending', 1, 1],
      ['night_owl', 'locked', null, null],
    ]);
  });

  it('keeps the server text of a secret badge, and an unknown rarity is common', () => {
    expect(badges.find((b) => b.key === 'night_owl')).toMatchObject({ name: 'Geheime badge', symbol: 'questionmark', secret: true });
    expect(badges.find((b) => b.key === 'early_bird')?.rarity).toBe('common');
  });

  it('is empty for anything else', () => {
    expect(parseMyBadges(null)).toEqual([]);
    expect(parseMyBadges({ rows: ROWS })).toEqual([]);
  });

  it('counts the earned badges', () => {
    expect(badgeCountLabel(badges)).toBe('2 van 4');
  });
});

describe('badgeStatusLine', () => {
  const badge = (fields: Partial<Badge>): Badge => ({
    key: 'k',
    name: 'N',
    description: 'D',
    symbol: 'star',
    rarity: 'common',
    secret: false,
    sort: 1,
    status: 'locked',
    earnedAt: null,
    progress: 0,
    target: 1,
    ...fields,
  });

  it('earned on a date, waiting, or how far along', () => {
    expect(badgeStatusLine(badge({ status: 'granted', earnedAt: '2026-10-12T08:00:00Z' }), date)).toBe('Verdiend op 2026-10-12');
    expect(badgeStatusLine(badge({ status: 'pending' }), date)).toBe('Verdiend · wacht op goedkeuring');
    expect(badgeStatusLine(badge({ progress: 12, target: 25 }), date)).toBe('Nog 13 te gaan · 12/25');
  });

  it('nothing to count for a single step or a hidden badge', () => {
    expect(badgeStatusLine(badge({ progress: 0, target: 1 }), date)).toBeNull();
    expect(badgeStatusLine(badge({ progress: null, target: null }), date)).toBeNull();
  });
});

describe('parseBadgeNews', () => {
  it('a badge with a status pending or granted', () => {
    const news = { key: 'mapmaker', name: 'Kaartmaker', description: 'Meld een ontbrekende vuilbak.', symbol: 'mappin.and.ellipse', rarity: 'rare', status: 'pending' };
    expect(parseBadgeNews(news)).toEqual(news);
    expect(parseBadgeNews({ ...news, status: 'revoked' })).toBeNull();
    expect(parseBadgeNews({ ...news, name: '' })).toBeNull();
    expect(parseBadgeNewsList([news, { key: 'x' }, 'y'])).toEqual([news]);
    expect(parseBadgeNewsList(undefined)).toEqual([]);
  });
});
