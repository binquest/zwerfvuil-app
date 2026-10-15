// Phase 2 proof: the reveal built from the server's score.steps plays exactly
// the events of the reveal before phase 2 (built from base, streak and the
// stage totals), and mixes exactly the same soundtrack: same mix key. The
// golden file holds a fingerprint of every event list and its mix key, for
// 4 bases x 11 streaks x Reduce Motion x bonus question (see __fixtures__).
import { describe, expect, it } from '@jest/globals';

import { parseScore } from '../../../lib/score';
import { mixKey } from '../../sfx/mix';
import { canonical, caseKey, fingerprint, GOLDEN_CASES } from '../__fixtures__/canonical';
import golden from '../__fixtures__/reveal-v1.json';
import { reveal, SERVER_SCORES } from '../__fixtures__/scores';
import { buildRevealTimeline, type Event } from '../timeline';

type Golden = Record<string, { events: string; count: number; mixKey: string }>;
const GOLDEN = golden as Golden;

const describeEvents = (events: Event[]) => ({ events: fingerprint(canonical(events)), count: events.length, mixKey: mixKey(events) });

describe('the reveal from score.steps', () => {
  it('has a golden entry for every case', () => {
    expect(Object.keys(GOLDEN).sort()).toEqual(GOLDEN_CASES.map(caseKey).sort());
  });

  it('plays exactly the events and mixes exactly the sound of before, in every case', () => {
    const different: string[] = [];
    for (const c of GOLDEN_CASES) {
      const now = describeEvents(reveal(c.weeks, { base: c.base, reduceMotion: c.reduceMotion, bonus: c.bonus }));
      const before = GOLDEN[caseKey(c)];
      if (now.events !== before.events || now.count !== before.count || now.mixKey !== before.mixKey) different.push(caseKey(c));
    }
    expect(different).toEqual([]);
  });

  it('does so from the server JSON itself, parsed as the app parses it', () => {
    for (const weeks of [0, 1, 3, 10]) {
      const score = parseScore(SERVER_SCORES[weeks])!;
      for (const reduceMotion of [false, true]) {
        for (const bonus of [false, true]) {
          const now = describeEvents(buildRevealTimeline({ score, reduceMotion, bonus }));
          expect([weeks, now]).toEqual([weeks, GOLDEN[caseKey({ base: 10, weeks, reduceMotion, bonus })]]);
        }
      }
    }
  });
});
