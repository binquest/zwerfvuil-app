import { describe, expect, it } from '@jest/globals';

import { applyRevealEvent, INITIAL_REVEAL_STATE } from '../../feedback/reveal/state';
import type { Event } from '../../feedback/reveal/timeline';
import { mixKey } from '../../feedback/sfx/mix';
import {
  APPROVAL_COUNT_MS,
  approvalHeadline,
  approvalParts,
  approvalSummary,
  approvedLine,
  buildApprovalTimeline,
  hasResults,
  LEVEL_CHORD_MS,
  LEVEL_CONFETTI_PIECES,
  levelUpLine,
  parseResults,
  previewResults,
  rejectedLine,
  sourceChips,
  type UnseenResults,
} from '../approval';
import type { Level } from '../levels';

/** The results of my_unseen as the server sends them (supabase/tests/database/15_unseen.test.sql). */
const SERVER = {
  approved: [
    { checkin_id: 'c1', bin_id: 58, decided_at: 't1', points: 15 },
    { checkin_id: 'c2', bin_id: 61, decided_at: 't2', points: 18 },
  ],
  rejected: [{ checkin_id: 'c3', bin_id: 74, decided_at: 't3', reason: 'Foto onduidelijk', revoked: false }],
  approved_count: 2,
  rejected_count: 1,
  gained: 83,
  by_source: { milestone: 50, discovery: 10, checkin: 23 },
  points_before: 100,
  points_after: 183,
  level_before: 3,
  level_after: 4,
  level_title: 'Stoepridder',
  badges: [
    { key: 'explorer_10', name: 'Ontdekker 10', description: 'Ontdek 10 vuilbakken.', symbol: 'map.fill', rarity: 'common', status: 'granted' },
  ],
  avatars: [{ key: 'merel', name: 'Merel' }],
};

const results = parseResults(SERVER)!;

/** [time, what] per event: the sound id, the haptic kind, or the type with its part. */
function shape(events: Event[]): [number, string][] {
  return events.map((e) => [
    e.atMs,
    e.type === 'sound' ? e.id : e.type === 'haptic' ? e.kind : e.type === 'part' ? `part ${e.index}` : e.type,
  ]);
}

describe('parseResults', () => {
  it('reads the decisions, the points per source in a fixed order, the totals and the level', () => {
    expect(results).toMatchObject({
      approved: [
        { checkinId: 'c1', binId: 58, points: 15 },
        { checkinId: 'c2', binId: 61, points: 18 },
      ],
      rejected: [{ checkinId: 'c3', binId: 74, reason: 'Foto onduidelijk', revoked: false }],
      approvedCount: 2,
      rejectedCount: 1,
      gained: 83,
      bySource: [
        { source: 'checkin', points: 23 },
        { source: 'discovery', points: 10 },
        { source: 'milestone', points: 50 },
      ],
      pointsBefore: 100,
      pointsAfter: 183,
      levelBefore: 3,
      levelAfter: 4,
      levelTitle: 'Stoepridder',
      avatars: [{ key: 'merel', name: 'Merel' }],
    });
    expect(results.badges.map((b) => [b.key, b.status])).toEqual([['explorer_10', 'granted']]);
  });

  it('is null from an older server, and keeps what it can read', () => {
    expect(parseResults(undefined)).toBeNull();
    expect(parseResults({ approved: 'x', rejected: [] })).toBeNull();
    const odd = parseResults({ approved: [{ checkin_id: 1 }], rejected: [{ checkin_id: 'r', bin_id: 2, reason: '  ' }], by_source: { checkin: 'x', quest: 10 } });
    expect(odd).toMatchObject({ approved: [], approvedCount: 0, rejected: [{ reason: null, revoked: false }], rejectedCount: 1, bySource: [{ source: 'quest', points: 10 }] });
    expect(odd).toMatchObject({ levelBefore: 1, levelAfter: 1, levelTitle: null, badges: [], avatars: [] });
  });
});

describe('what the screen says', () => {
  const none = parseResults({ approved: [], rejected: [], level_before: 3, level_after: 3 })!;

  it('the headline: approved with the points, only rejections, a level-up alone, a confirmed badge', () => {
    expect(approvalHeadline(results)).toBe('Goedgekeurd! +83');
    expect(approvedLine(results)).toBe('2 inworpen goedgekeurd');
    expect(approvedLine({ ...results, approvedCount: 1 })).toBe('1 inworp goedgekeurd');
    expect(approvalHeadline({ ...results, approvedCount: 0 })).toBe('Beoordeeld');
    expect(approvalHeadline({ ...none, levelAfter: 4 })).toBeNull();
    expect(approvalHeadline({ ...none, badges: results.badges })).toBe('Bevestigd!');
  });

  it('chips per source, a level line, a rejected line', () => {
    expect(sourceChips(results)).toEqual(['+23 inworpen', '+10 ontdekking', '+50 mijlpaal']);
    expect(levelUpLine(results)).toBe('Level 4 · Stoepridder');
    expect(rejectedLine(results.rejected[0])).toBe('#74 · Foto onduidelijk');
    expect(rejectedLine({ checkinId: 'x', binId: 61, reason: 'Dubbel', revoked: true })).toBe('#61 · Herroepen · Dubbel');
    expect(rejectedLine({ checkinId: 'x', binId: 61, reason: null, revoked: false })).toBe('#61');
  });

  it('one summary for VoiceOver', () => {
    expect(approvalSummary(results)).toBe(
      '2 inworpen goedgekeurd: 83 punten erbij, totaal 183. Level 4 · Stoepridder. Badge Ontdekker 10. Merel ontgrendeld. 1 inworp afgewezen: #74 · Foto onduidelijk.',
    );
  });

  it('is worth showing with a decision, a level-up, a badge or an avatar; not for a level that dropped', () => {
    expect(hasResults(results)).toBe(true);
    expect(hasResults(none)).toBe(false);
    expect(hasResults(null)).toBe(false);
    expect(hasResults({ ...none, levelAfter: 4 })).toBe(true);
    expect(hasResults({ ...none, levelAfter: 2 })).toBe(false);
    expect(hasResults({ ...none, avatars: [{ key: 'bloem', name: 'Bloem' }] })).toBe(true);
  });
});

describe('approvalParts', () => {
  it('top to bottom: headline, total, sources, level, badges, avatars, and the rejections last', () => {
    expect(approvalParts(results)).toEqual(['headline', 'total', 'sources', 'level', 'badges', 'avatars', 'rejected']);
  });

  it('only rejections: the headline and the calm block, no total', () => {
    const rejected: UnseenResults = { ...results, approved: [], approvedCount: 0, gained: 0, bySource: [], levelAfter: 3, badges: [], avatars: [] };
    expect(approvalParts(rejected)).toEqual(['headline', 'rejected']);
  });

  it('a level-up alone: the level is the headline', () => {
    const level = parseResults({ approved: [], rejected: [], level_before: 3, level_after: 4, level_title: 'Stoepridder' })!;
    expect(approvalParts(level)).toEqual(['level']);
  });
});

describe('buildApprovalTimeline', () => {
  it('the chime, then every block in turn; the total has time to roll; the level on the chord of its fanfare', () => {
    const events = buildApprovalTimeline({ results, reduceMotion: false });
    const levelAt = 260 + APPROVAL_COUNT_MS + 260;
    expect(shape(events)).toEqual([
      [0, 'approve_chime'],
      [0, 'success'],
      [0, 'part 0'],
      [260, 'part 1'],
      [260 + APPROVAL_COUNT_MS, 'part 2'],
      [levelAt, 'levelup_fanfare'],
      [levelAt + LEVEL_CHORD_MS, 'success'],
      [levelAt + LEVEL_CHORD_MS, 'confetti'],
      [levelAt + LEVEL_CHORD_MS, 'part 3'],
      [levelAt + LEVEL_CHORD_MS + 260, 'part 4'],
      [levelAt + LEVEL_CHORD_MS + 520, 'part 5'],
      [levelAt + LEVEL_CHORD_MS + 780, 'part 6'],
    ]);
    expect(events.find((e) => e.type === 'confetti')).toMatchObject({ pieces: LEVEL_CONFETTI_PIECES });
  });

  it('stays short: everything in under 4 s', () => {
    expect(Math.max(...buildApprovalTimeline({ results, reduceMotion: false }).map((e) => e.atMs))).toBeLessThan(4000);
  });

  it('with Reduce Motion: no confetti, the same sounds at the same times', () => {
    const moving = buildApprovalTimeline({ results, reduceMotion: false });
    const still = buildApprovalTimeline({ results, reduceMotion: true });
    expect(still.find((e) => e.type === 'confetti')).toMatchObject({ pieces: 0 });
    expect(mixKey(still)).toBe(mixKey(moving));
    expect(shape(still)).toEqual(shape(moving));
  });

  it('only rejections: a soft tock and a light haptic, no confetti, no fanfare', () => {
    const rejected: UnseenResults = { ...results, approved: [], approvedCount: 0, gained: 0, bySource: [], levelAfter: 3, badges: [], avatars: [] };
    const events = buildApprovalTimeline({ results: rejected, reduceMotion: false });
    expect(events.filter((e) => e.type === 'sound').map((e) => e.type === 'sound' && e.id)).toEqual(['neutral_tock']);
    expect(events.filter((e) => e.type === 'haptic').map((e) => e.type === 'haptic' && e.kind)).toEqual(['light']);
    expect(events.some((e) => e.type === 'confetti')).toBe(false);
  });

  it('a level-up alone opens with its fanfare (no chime)', () => {
    const level = parseResults({ approved: [], rejected: [], level_before: 3, level_after: 4 })!;
    expect(shape(buildApprovalTimeline({ results: level, reduceMotion: false }))).toEqual([
      [0, 'levelup_fanfare'],
      [LEVEL_CHORD_MS, 'success'],
      [LEVEL_CHORD_MS, 'confetti'],
      [LEVEL_CHORD_MS, 'part 0'],
    ]);
  });

  it('changes nothing in the reveal state', () => {
    for (const event of buildApprovalTimeline({ results, reduceMotion: false })) {
      expect(applyRevealEvent(INITIAL_REVEAL_STATE, event)).toBe(INITIAL_REVEAL_STATE);
    }
  });
});

describe('previewResults', () => {
  const levels: Level[] = [
    { level: 1, minPoints: 0, title: 'Wegwerp-rookie' },
    { level: 2, minPoints: 10, title: 'Blikjesbuddy' },
    { level: 3, minPoints: 60, title: 'Peukenpikker' },
    { level: 4, minPoints: 175, title: 'Stoepridder' },
  ];

  it('the chosen numbers: 16 points each on top of 120, reasons, a level-up with its title, the badge and its avatar', () => {
    const preview = previewResults({ approved: 3, rejected: 2, levelUp: true, badge: true }, levels);
    expect(preview).toMatchObject({ approvedCount: 3, rejectedCount: 2, gained: 48, pointsBefore: 120, pointsAfter: 168 });
    expect(sourceChips(preview)).toEqual(['+33 inworpen', '+15 ontdekking']);
    expect(preview.rejected.map(rejectedLine)).toEqual(['#74 · Foto onduidelijk', '#75 · Herroepen · Dubbel of misbruik']);
    expect([preview.levelBefore, preview.levelAfter, preview.levelTitle]).toEqual([3, 4, 'Stoepridder']);
    expect([preview.badges.map((b) => b.key), preview.avatars.map((a) => a.key)]).toEqual([['early_bird'], ['merel']]);
  });

  it('without a level-up the level stays; nothing chosen is nothing to show', () => {
    expect(previewResults({ approved: 1, rejected: 0, levelUp: false, badge: false }, levels)).toMatchObject({ levelBefore: 3, levelAfter: 3 });
    expect(hasResults(previewResults({ approved: 0, rejected: 0, levelUp: false, badge: false }, levels))).toBe(false);
  });
});
