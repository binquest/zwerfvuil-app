import { describe, expect, it } from '@jest/globals';

import { buildHistory, checkinState, formatHistoryPoints, pendingPoints, type HistoryCheckin, type LedgerEntry } from '../history';

function checkin(overrides: Partial<HistoryCheckin>): HistoryCheckin {
  return {
    id: 'c1',
    created_at: '2026-10-15T10:00:00+00:00',
    status: 'pending',
    review_reason: null,
    revoked_at: null,
    distance_m: 6,
    bin_id: 58,
    is_test: false,
    points: [],
    ...overrides,
  };
}

describe('checkinState', () => {
  it('maps review statuses, and tells a revocation from a rejection', () => {
    expect(checkinState({ status: 'pending', revoked_at: null })).toBe('pending');
    expect(checkinState({ status: 'approved', revoked_at: null })).toBe('granted');
    expect(checkinState({ status: 'rejected', revoked_at: null })).toBe('rejected');
    expect(checkinState({ status: 'rejected', revoked_at: '2026-10-15T12:00:00+00:00' })).toBe('revoked');
  });
});

describe('buildHistory', () => {
  it('sums the rows of a check-in that match its state', () => {
    const [pending] = buildHistory(
      [
        checkin({
          points: [
            { source: 'checkin', amount: 11, status: 'pending' },
            { source: 'bonus', amount: 5, status: 'pending' },
          ],
        }),
      ],
      [],
    );
    expect(pending).toMatchObject({ title: 'Vuilbak #58', state: 'pending', points: 16, distanceM: 6 });

    const [granted] = buildHistory(
      [
        checkin({
          status: 'approved',
          points: [
            { source: 'checkin', amount: 11, status: 'granted' },
            { source: 'bonus', amount: 5, status: 'granted' },
          ],
        }),
      ],
      [],
    );
    expect(granted.points).toBe(16);

    const [revoked] = buildHistory(
      [
        checkin({
          status: 'rejected',
          revoked_at: '2026-10-15T12:00:00+00:00',
          review_reason: 'Dubbel of misbruik',
          points: [{ source: 'checkin', amount: 11, status: 'revoked' }],
        }),
      ],
      [],
    );
    expect(revoked).toMatchObject({ state: 'revoked', points: 11, reason: 'Dubbel of misbruik' });
  });

  it('shows rows without a check-in with their reason, newest first', () => {
    const entry: LedgerEntry = {
      id: 7,
      source: 'adjustment',
      amount: -30,
      status: 'granted',
      earned_at: '2026-10-15T11:00:00.5+00:00',
      is_test: false,
      details: { reason: 'Correctie' },
    };
    const items = buildHistory(
      [checkin({ id: 'old', created_at: '2026-10-14T10:00:00+00:00' }), checkin({ id: 'new', created_at: '2026-10-15T12:00:00+00:00' })],
      [entry],
    );
    expect(items.map((i) => i.key)).toEqual(['checkin:new', 'entry:7', 'checkin:old']);
    expect(items[1]).toMatchObject({ title: 'Correctie', reason: 'Correctie', points: -30, state: 'granted', distanceM: null });
  });

  it('copes with a check-in without rows and keeps at most `limit` items', () => {
    const many = Array.from({ length: 60 }, (_, i) => checkin({ id: String(i), points: undefined as never }));
    const items = buildHistory(many, [], 50);
    expect(items).toHaveLength(50);
    expect(items[0].points).toBe(0);
  });
});

describe('pendingPoints and formatHistoryPoints', () => {
  it('counts only real pending points', () => {
    const items = buildHistory(
      [
        checkin({ id: 'a', points: [{ source: 'checkin', amount: 11, status: 'pending' }] }),
        checkin({ id: 'b', is_test: true, points: [{ source: 'checkin', amount: 13, status: 'pending' }] }),
        checkin({ id: 'c', status: 'approved', points: [{ source: 'checkin', amount: 12, status: 'granted' }] }),
      ],
      [],
    );
    expect(pendingPoints(items)).toBe(11);
  });

  it('formats signed points, and 0 for what was taken back', () => {
    expect(formatHistoryPoints({ state: 'pending', points: 16 })).toBe('+16');
    expect(formatHistoryPoints({ state: 'granted', points: -30 })).toBe('−30');
    expect(formatHistoryPoints({ state: 'rejected', points: 11 })).toBe('0');
    expect(formatHistoryPoints({ state: 'revoked', points: 11 })).toBe('0');
  });
});
