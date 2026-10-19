import { describe, expect, it } from '@jest/globals';

import { applyRevealEvent, INITIAL_REVEAL_STATE } from '../../feedback/reveal/state';
import { mixKey } from '../../feedback/sfx/mix';
import {
  buildCelebrationTimeline,
  CONFETTI_PIECES,
  MILESTONE_CHORD_MS,
  setPendingCelebration,
  takePendingCelebration,
} from '../celebration';

describe('buildCelebrationTimeline', () => {
  it('a milestone: the fanfare, then on its chord the success haptic and the confetti, then the reward', () => {
    const events = buildCelebrationTimeline({ milestone: true, reduceMotion: false });
    expect(events.map((e) => [e.atMs, e.type === 'sound' ? e.id : e.type === 'haptic' ? e.kind : e.type])).toEqual([
      [0, 'milestone_fanfare'],
      [MILESTONE_CHORD_MS, 'success'],
      [MILESTONE_CHORD_MS, 'confetti'],
      [expect.any(Number), 'reward'],
    ]);
    expect(events.find((e) => e.type === 'confetti')).toMatchObject({ pieces: CONFETTI_PIECES });
  });

  it('with Reduce Motion: the same sound and haptic, no confetti', () => {
    const moving = buildCelebrationTimeline({ milestone: true, reduceMotion: false });
    const still = buildCelebrationTimeline({ milestone: true, reduceMotion: true });
    expect(still.find((e) => e.type === 'confetti')).toMatchObject({ pieces: 0 });
    expect(mixKey(still)).toBe(mixKey(moving));
  });

  it('only discoveries: their fanfare and a medium haptic, never confetti', () => {
    const events = buildCelebrationTimeline({ milestone: false, reduceMotion: false });
    expect(events.filter((e) => e.type === 'sound').map((e) => e.type === 'sound' && e.id)).toEqual(['discover_fanfare']);
    expect(events.some((e) => e.type === 'confetti')).toBe(false);
    expect(events.some((e) => e.type === 'haptic' && e.kind === 'medium')).toBe(true);
  });

  it('changes nothing in the reveal state', () => {
    for (const event of buildCelebrationTimeline({ milestone: true, reduceMotion: false })) {
      expect(applyRevealEvent(INITIAL_REVEAL_STATE, event)).toBe(INITIAL_REVEAL_STATE);
    }
  });
});

describe('the celebration handoff', () => {
  it('is read once', () => {
    setPendingCelebration({ kind: 'missed', moments: [], total: 0, asOf: null, preview: true });
    expect(takePendingCelebration()).toMatchObject({ kind: 'missed', preview: true });
    expect(takePendingCelebration()).toBeNull();
  });
});
