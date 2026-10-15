import { describe, expect, it } from '@jest/globals';

import { streakStep } from '../../../lib/score';
import { reveal, scoreFor } from '../__fixtures__/scores';
import { applyRevealEvent, endState, INITIAL_REVEAL_STATE, multiplierLabel, type RevealState } from '../state';
import type { Event } from '../timeline';

const play = (events: readonly Event[], from: RevealState = INITIAL_REVEAL_STATE) => events.reduce(applyRevealEvent, from);

/** The batches the runner plays: all events of the same time together. */
function batchEnds(events: readonly Event[]): number[] {
  return events.flatMap((event, i) => (i === events.length - 1 || events[i + 1].atMs !== event.atMs ? [i + 1] : []));
}

const CASES = [10, 250].flatMap((base) =>
  Array.from({ length: 11 }, (_, weeks) => weeks).flatMap((weeks) =>
    [false, true].flatMap((reduceMotion) => [false, true].map((bonus) => ({ base, weeks, reduceMotion, bonus }))),
  ),
);

describe('endState: skipping lands where playing out lands', () => {
  it('ends on the score: its total, every stage, the maximum when the streak is longer', () => {
    for (const { base, weeks, reduceMotion, bonus } of CASES) {
      const score = scoreFor(weeks, base);
      const stages = streakStep(score)!.stages;
      const end = endState(reveal(weeks, { base, reduceMotion, bonus }));
      expect([weeks, end]).toEqual([
        weeks,
        { value: score.total, stage: stages.length, multiplier: stages.at(-1)?.mult ?? 1, max: weeks > stages.length, landed: true },
      ]);
    }
  });

  it('is the same after a skip at any moment as after playing it out', () => {
    for (const { base, weeks, reduceMotion, bonus } of CASES) {
      const events = reveal(weeks, { base, reduceMotion, bonus });
      const playedOut = play(events);
      expect(endState(events)).toEqual(playedOut);
      for (const cut of [0, ...batchEnds(events)]) {
        const shownSoFar = play(events.slice(0, cut));
        // The screen shows endState on a skip, whatever it showed before.
        expect(endState(events)).toEqual(playedOut);
        // And playing on from there reaches that same state.
        expect(endState(events.slice(cut), shownSoFar)).toEqual(playedOut);
      }
    }
  });

  it('only changes on the number, a stage and the slam', () => {
    const events = reveal(9);
    const changing = events.filter((event) => applyRevealEvent(INITIAL_REVEAL_STATE, event) !== INITIAL_REVEAL_STATE).map((e) => e.type);
    expect(new Set(changing)).toEqual(new Set(['count', 'mult', 'slam']));
    // MAX appears on the last stage and stays.
    const states = events.reduce<RevealState[]>((all, event) => [...all, applyRevealEvent(all.at(-1) ?? INITIAL_REVEAL_STATE, event)], []);
    expect(states.findIndex((s) => s.max)).toBe(events.findIndex((e) => e.type === 'mult' && e.stage === 8));
  });
});

describe('multiplierLabel', () => {
  it('shows the MULT badge with two decimals, from ×1,00', () => {
    expect([1, 1.1, 1.21, 1.33, 2.14].map(multiplierLabel)).toEqual(['×1,00', '×1,10', '×1,21', '×1,33', '×2,14']);
  });
});
