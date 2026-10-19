import { describe, expect, it } from '@jest/globals';

import {
  binDiscoveryLabel,
  collectionFilter,
  counterLabel,
  discoveryLine,
  milestoneTitle,
  nextMilestoneLabel,
  parseCheckinGame,
  parseCollection,
  parseGameState,
  parseUnseen,
  summarizeMoments,
  type CollectionEntry,
  type MissedMoment,
} from '../discoveries';

describe('parseCheckinGame', () => {
  it('reads the discovery, the milestone and the server time', () => {
    expect(
      parseCheckinGame({
        discovery: { bin_id: 58, ordinal: 12, discovered: 12, total_bins: 120, status: 'pending' },
        milestone: { threshold: 10, points: 50, status: 'pending' },
        as_of: '2026-10-15T18:00:00+00:00',
        later: true,
      }),
    ).toEqual({
      discovery: { binId: 58, ordinal: 12, discovered: 12, totalBins: 120, status: 'pending' },
      milestone: { threshold: 10, points: 50, status: 'pending' },
      asOf: '2026-10-15T18:00:00+00:00',
    });
  });

  it('keeps what it can read: no discovery, no milestone', () => {
    expect(parseCheckinGame({ discovery: null, milestone: null, as_of: 'x' })).toEqual({ discovery: null, milestone: null, asOf: 'x' });
    expect(parseCheckinGame({ discovery: { bin_id: '58' }, milestone: { threshold: 10, points: 50, status: 'revoked' } })).toEqual({
      discovery: null,
      milestone: null,
      asOf: null,
    });
  });

  it('is null without a game (a test check-in, or the game logic failed)', () => {
    for (const value of [null, undefined, 'game', [], 3]) expect(parseCheckinGame(value)).toBeNull();
  });
});

describe('parseGameState', () => {
  const answer = {
    points: { granted: 135, pending: 65 },
    streak: { weeks: 3, this_week: true },
    discoveries: {
      discovered: 10,
      confirmed: 9,
      total_bins: 120,
      next_milestone: { threshold: 20, points: 50, previous: 10 },
    },
    unseen_moments: 2,
    as_of: '2026-10-15T18:00:00+00:00',
  };

  it('reads my_game_state()', () => {
    expect(parseGameState(answer)).toEqual({
      points: { granted: 135, pending: 65 },
      streak: { weeks: 3, thisWeek: true },
      discovered: 10,
      confirmed: 9,
      totalBins: 120,
      nextMilestone: { threshold: 20, points: 50, previous: 10 },
      unseenMoments: 2,
    });
  });

  it('has no next milestone when all are reached', () => {
    expect(parseGameState({ ...answer, discoveries: { ...answer.discoveries, next_milestone: null } })?.nextMilestone).toBeNull();
  });

  it('refuses an answer without the numbers it needs', () => {
    expect(parseGameState(null)).toBeNull();
    expect(parseGameState({ ...answer, points: { granted: '1', pending: 0 } })).toBeNull();
    expect(parseGameState({ ...answer, discoveries: { discovered: 1 } })).toBeNull();
  });
});

describe('parseCollection', () => {
  it('reads the rows of my_collection() and leaves out malformed ones', () => {
    expect(
      parseCollection([
        { bin_id: 1, status: 'confirmed', discovered_at: '2026-10-12T10:00:00+00:00', checkins: 3 },
        { bin_id: 2, status: null, discovered_at: null, checkins: 0 },
        { bin_id: 3, status: 'pending', discovered_at: '2026-10-15T10:00:00+00:00', checkins: 1 },
        { bin_id: '4', status: null },
        null,
      ]),
    ).toEqual([
      { binId: 1, status: 'confirmed', discoveredAt: '2026-10-12T10:00:00+00:00', checkins: 3 },
      { binId: 2, status: null, discoveredAt: null, checkins: 0 },
      { binId: 3, status: 'pending', discoveredAt: '2026-10-15T10:00:00+00:00', checkins: 1 },
    ]);
    expect(parseCollection(null)).toEqual([]);
  });
});

describe('parseUnseen', () => {
  it('reads the moments, oldest first, and the server time', () => {
    expect(
      parseUnseen({
        moments: [
          { kind: 'discovery', at: 'a', bin_id: 58, ordinal: 9, status: 'pending' },
          { kind: 'milestone', at: 'b', threshold: 10, points: 50, status: 'granted' },
          { kind: 'chest', at: 'c' },
        ],
        moments_total: 2,
        as_of: 'now',
      }),
    ).toEqual({
      moments: [
        { kind: 'discovery', at: 'a', binId: 58, ordinal: 9, status: 'pending' },
        { kind: 'milestone', at: 'b', threshold: 10, points: 50, status: 'granted' },
      ],
      total: 2,
      asOf: 'now',
    });
  });

  it('is null without moments or a server time', () => {
    expect(parseUnseen({ moments: [] })).toBeNull();
    expect(parseUnseen(null)).toBeNull();
  });
});

describe('labels', () => {
  it('shows the bin and the counter', () => {
    expect(discoveryLine({ binId: 58, discovered: 12, totalBins: 120 })).toBe('#58 · 12/120');
    expect(counterLabel(34, 120)).toBe('34/120 ontdekt');
    expect(milestoneTitle(10)).toBe('10 vuilbakken ontdekt');
    expect(milestoneTitle(1)).toBe('1 vuilbak ontdekt');
  });

  it('counts down to the next milestone', () => {
    expect(nextMilestoneLabel(34, { threshold: 40, points: 50, previous: 30 })).toBe('Nog 6 tot 40 · +50');
    expect(nextMilestoneLabel(150, null)).toBeNull();
  });

  it('describes a bin in its sheet', () => {
    const date = (iso: string) => iso.slice(0, 10);
    const entry: CollectionEntry = { binId: 1, status: 'confirmed', discoveredAt: '2026-10-12T10:00:00Z', checkins: 3 };
    expect(binDiscoveryLabel(entry, date)).toBe('2026-10-12 · 3 inworpen');
    expect(binDiscoveryLabel({ ...entry, status: 'pending', checkins: 1 }, date)).toBe('2026-10-12 · 1 inworp · wacht op goedkeuring');
    expect(binDiscoveryLabel({ ...entry, status: null }, date)).toBe('Nog niet ontdekt');
    expect(binDiscoveryLabel(undefined, date)).toBe('Nog niet ontdekt');
  });
});

describe('collectionFilter', () => {
  const entries: CollectionEntry[] = [
    { binId: 3, status: null, discoveredAt: null, checkins: 0 },
    { binId: 1, status: 'confirmed', discoveredAt: 'x', checkins: 2 },
    { binId: 2, status: 'pending', discoveredAt: 'y', checkins: 1 },
  ];

  it('filters by discovered or not, sorted by bin number', () => {
    expect(collectionFilter(entries, 'all').map((e) => e.binId)).toEqual([1, 2, 3]);
    expect(collectionFilter(entries, 'discovered').map((e) => e.binId)).toEqual([1, 2]);
    expect(collectionFilter(entries, 'undiscovered').map((e) => e.binId)).toEqual([3]);
  });
});

describe('summarizeMoments', () => {
  it('keeps the highest milestone and every discovery', () => {
    const moments: MissedMoment[] = [
      { kind: 'discovery', at: 'a', binId: 5, ordinal: 9, status: 'pending' },
      { kind: 'milestone', at: 'b', threshold: 10, points: 50, status: 'pending' },
      { kind: 'discovery', at: 'c', binId: 6, ordinal: 20, status: 'pending' },
      { kind: 'milestone', at: 'd', threshold: 20, points: 50, status: 'pending' },
    ];
    const { milestone, discoveries } = summarizeMoments(moments);
    expect(milestone?.threshold).toBe(20);
    expect(discoveries.map((d) => d.binId)).toEqual([5, 6]);
  });

  it('has no milestone when there is none', () => {
    expect(summarizeMoments([]).milestone).toBeNull();
  });
});
