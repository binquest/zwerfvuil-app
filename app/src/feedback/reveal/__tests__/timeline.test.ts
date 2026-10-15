import { describe, expect, it } from '@jest/globals';

import { parseScore, type Score } from '../../../lib/score';
import { previewScore } from '../../../game/catalog';
import { DEFAULT_CONFIG, reveal, scoreFor, SERVER_DISCOVERY_SCORE } from '../__fixtures__/scores';
import {
  buildBonusTimeline,
  buildRevealTimeline,
  heatOf,
  stageHaptics,
  stageIntervalMs,
  timelineEndMs,
  type Event,
} from '../timeline';
import * as T from '../tuning';

type Of<K extends Event['type']> = Extract<Event, { type: K }>;
const only = <K extends Event['type']>(events: Event[], type: K) => events.filter((e): e is Of<K> => e.type === type);
const sounds = (events: Event[]) => only(events, 'sound').map((e) => e.id);
/** The sounds and haptics at `ms`, in order. */
const audibleAt = (events: Event[], ms: number) =>
  events.filter((e) => e.atMs === ms && (e.type === 'sound' || e.type === 'haptic')).map((e) => (e.type === 'sound' ? e.id : e.type === 'haptic' ? e.kind : ''));
/** The steps the server sends for a streak of 3 weeks (11_scoring), as JSON. */
const SERVER_STEPS_3 = [
  { kind: 'base', label: 'BASIS', chips: 10, mult: 1, total: 10 },
  { kind: 'streak', label: 'REEKS', weeks: 3, per_week: 1.1, stages: [{ mult: 1.1, total: 11 }, { mult: 1.21, total: 12 }, { mult: 1.331, total: 13 }] },
];
const VISUAL: Event['type'][] = ['shake', 'flash', 'hitStop', 'bonusChip', 'ring'];
const AUDIO_OR_HAPTIC: Event['type'][] = ['sound', 'soundStop', 'haptic'];

function stripVisual(events: Event[]) {
  return events.filter((e) => AUDIO_OR_HAPTIC.includes(e.type)).map(({ type, ...rest }) => ({ type, ...rest }));
}

describe('buildRevealTimeline', () => {
  it('counts the base in 10 ticks, then shows every stage total: 11, 12, 13, 15, 16, 18, 19, 21', () => {
    const events = reveal(8);
    const counts = only(events, 'count').map((e) => e.value);
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(only(events, 'mult').map((e) => e.total)).toEqual([11, 12, 13, 15, 16, 18, 19, 21]);
    expect(only(events, 'slam')[0]).toMatchObject({ from: 21, to: 21 });
  });

  it('shows exactly the running totals of the score, stage by stage', () => {
    for (let weeks = 0; weeks <= 10; weeks++) {
      const score = scoreFor(weeks);
      const stages = score.steps[1].kind === 'streak' ? score.steps[1].stages : [];
      const mults = only(buildRevealTimeline({ score, reduceMotion: false }), 'mult');
      expect(mults.map((e) => [e.total, e.multiplier])).toEqual(stages.map((s) => [s.total, s.mult]));
    }
  });

  it('caps at 8 stages: weeks 9 and 10 show stage 8 with MAX', () => {
    for (const weeks of [9, 10]) {
      const mults = only(reveal(weeks), 'mult');
      expect(mults).toHaveLength(8);
      expect(mults.at(-1)).toMatchObject({ stage: 8, max: true, total: 21 });
      expect(mults.slice(0, -1).every((e) => !e.max)).toBe(true);
    }
    expect(only(reveal(8), 'mult').at(-1)?.max).toBe(false);
  });

  it('shows the multiplier 1.1^n per stage, up to ×2.14', () => {
    const mults = only(reveal(8), 'mult');
    expect(mults.map((e) => Math.round(e.multiplier * 100) / 100)).toEqual([1.1, 1.21, 1.33, 1.46, 1.61, 1.77, 1.95, 2.14]);
  });

  it('plays whatever numbers the server sends, and lands on its total', () => {
    const score: Score = {
      steps: [
        { kind: 'base', label: 'BASIS', chips: 12, mult: 1, total: 12 },
        { kind: 'streak', label: 'REEKS', weeks: 5, perWeek: 1.2, stages: [{ mult: 1.2, total: 14 }, { mult: 1.44, total: 17 }] },
      ],
      total: 17,
      streakExtended: false,
    };
    const events = buildRevealTimeline({ score, reduceMotion: false });
    expect(only(events, 'count').at(-1)?.value).toBe(12);
    expect(only(events, 'mult').map((e) => [e.total, e.multiplier, e.max])).toEqual([
      [14, 1.2, false],
      [17, 1.44, true],
    ]);
    expect(only(events, 'slam')[0]).toMatchObject({ from: 17, to: 17 });
  });

  it('plays a × step it does not know as a pop-up that flies into MULT, then lands on its total', () => {
    const known = buildRevealTimeline({ score: scoreFor(3), reduceMotion: false });
    const score = parseScore({
      steps: [...(SERVER_STEPS_3 as object[]), { kind: 'comet', label: 'KOMEET ×2', chips: 10, mult: 2.662, total: 27 }],
      total: 27,
    })!;
    expect(score.steps.at(-1)).toEqual({ kind: 'other', name: 'comet', label: 'KOMEET ×2', total: 27, chips: 10, mult: 2.662 });
    const events = buildRevealTimeline({ score, reduceMotion: false });
    const [popIn] = only(events, 'popupIn');
    const [popOut] = only(events, 'popupOut');
    expect(popIn).toMatchObject({ popup: 'step0', sparkles: 0 });
    expect(popOut).toMatchObject({ popup: 'step0', to: 'mult', ms: T.POPUP_FLY_MS, fly: true });
    expect(popOut.atMs - popIn.atMs).toBe(T.STEP_SHOW_MS);
    const lastMult = only(events, 'mult').at(-1)!;
    expect(popIn.atMs).toBeGreaterThan(lastMult.atMs);
    // In with the chip sound, landing in MULT with a transient and a heavy tap.
    const beat = popIn.atMs - T.AUDIO_LEAD_MS;
    const land = popOut.atMs - T.AUDIO_LEAD_MS + T.POPUP_FLY_MS;
    expect(audibleAt(events, beat)).toEqual(['chip_add', 'medium']);
    expect(audibleAt(events, land)).toEqual(['transient', 'heavy']);
    expect(only(events, 'bins')).toEqual([{ atMs: land + T.AUDIO_LEAD_MS, type: 'bins', chips: null, multiplier: 2.662, total: 27, discovery: 0 }]);
    expect(only(events, 'binPop')).toEqual([{ atMs: land + T.AUDIO_LEAD_MS, type: 'binPop', bin: 'mult', scale: T.BIN_POP_SCALE }]);
    expect(only(events, 'slam')[0]).toMatchObject({ from: 27, to: 27 });
    // Up to the last streak stage it is the known reveal.
    const upTo = (list: Event[]) => list.filter((e) => e.atMs <= lastMult.atMs);
    expect(upTo(events)).toEqual(upTo(known));
  });

  it('sends a + step into PUNTEN, and a step with only a total into the total', () => {
    const plus = parseScore({
      steps: [...(SERVER_STEPS_3 as object[]), { kind: 'gift', label: 'CADEAU +3', chips: 13, mult: 1.331, total: 17 }],
      total: 17,
    })!;
    const events = buildRevealTimeline({ score: plus, reduceMotion: false });
    expect(only(events, 'popupOut')[0]).toMatchObject({ to: 'chips' });
    expect(only(events, 'bins')[0]).toMatchObject({ chips: 13, multiplier: null, total: 17 });
    expect(only(events, 'binPop')[0]).toMatchObject({ bin: 'chips' });
    const bare = parseScore({ steps: [...(SERVER_STEPS_3 as object[]), { kind: 'comet', label: 'KOMEET' }], total: 13 })!;
    const quiet = buildRevealTimeline({ score: bare, reduceMotion: true });
    expect(only(quiet, 'popupOut')[0]).toMatchObject({ to: 'total', fly: false });
    expect(only(quiet, 'bins')[0]).toMatchObject({ chips: null, multiplier: null, total: 13 });
    expect(only(quiet, 'binPop')).toHaveLength(0);
    expect(only(quiet, 'slam')[0]).toMatchObject({ from: 13, to: 13 });
  });

  it('gives every unknown step its own pop-up, up to three', () => {
    const steps = [1, 2, 3, 4].map((i) => ({ kind: `kind${i}`, label: `STAP ${i}`, total: 13 }));
    const score = parseScore({ steps: [...(SERVER_STEPS_3 as object[]), ...steps], total: 13 })!;
    expect(only(buildRevealTimeline({ score, reduceMotion: false }), 'popupIn').map((e) => e.popup)).toEqual(['step0', 'step1', 'step2', 'step2']);
  });

  it('stays at the top stage when the maximum is longer than eight weeks', () => {
    const events = reveal(12, { config: { ...DEFAULT_CONFIG, streakMaxSteps: 12 } });
    const mults = only(events, 'mult');
    expect(mults.map((e) => e.stage)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(sounds(events).filter((id) => id.startsWith('mult_')).slice(7)).toEqual(Array(5).fill('mult_8'));
    expect(mults.slice(7).every((e) => e.heat === 1 && e.peakScale === mults[7].peakScale)).toBe(true);
    expect(mults.at(-1)?.max).toBe(false);
  });

  it('without a streak: ticks, riser, total; no multipliers', () => {
    const events = reveal(0);
    expect(only(events, 'mult')).toHaveLength(0);
    expect(sounds(events).filter((id) => id.startsWith('mult_'))).toHaveLength(0);
    expect(only(events, 'slam')[0]).toMatchObject({ from: 10, to: 10 });
  });

  it('makes the stage intervals non-increasing and never shorter than 200 ms', () => {
    const expected = [420, 357, 303, 258, 219, 200, 200, 200];
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => stageIntervalMs(n))).toEqual(expected);
    const stageTimes = only(reveal(10), 'mult').map((e) => e.atMs);
    const gaps = stageTimes.slice(1).map((t, i) => t - stageTimes[i]);
    gaps.forEach((gap, i) => {
      expect(gap).toBeGreaterThanOrEqual(200);
      if (i > 0) expect(gap).toBeLessThanOrEqual(gaps[i - 1]);
    });
  });

  it('eases the tick gaps from 90 to 55 ms', () => {
    const ticks = only(reveal(0), 'sound').filter((e) => e.id.startsWith('tick_'));
    const gaps = ticks.slice(1).map((e, i) => e.atMs - ticks[i].atMs);
    expect(gaps[0]).toBe(90);
    expect(gaps.at(-1)).toBe(55);
    gaps.slice(1).forEach((gap, i) => expect(gap).toBeLessThanOrEqual(gaps[i]));
  });

  it('gives the ticks the pentatonic pitches in pairs, with a little volume jitter', () => {
    const ticks = only(reveal(0), 'sound').filter((e) => e.id.startsWith('tick_'));
    expect(ticks.map((e) => e.id)).toEqual(['tick_0', 'tick_0', 'tick_1', 'tick_1', 'tick_2', 'tick_2', 'tick_3', 'tick_3', 'tick_4', 'tick_4']);
    for (const tick of ticks) expect(Math.abs(tick.volume / T.VOLUME.tick - 1)).toBeLessThanOrEqual(T.TICK_JITTER + 1e-9);
    expect(new Set(ticks.map((e) => e.volume)).size).toBeGreaterThan(1);
  });

  it('puts a selection haptic on every second tick', () => {
    const events = reveal(0);
    const tickTimes = only(events, 'sound').filter((e) => e.id.startsWith('tick_')).map((e) => e.atMs);
    const selections = only(events, 'haptic').filter((e) => e.kind === 'selection').map((e) => e.atMs);
    expect(selections).toEqual(tickTimes.filter((_, i) => i % 2 === 0));
  });

  it('plays mult_n plus a transient on stage n, with the haptic getting stronger', () => {
    const events = reveal(8);
    const mults = only(events, 'mult');
    for (const mult of mults) {
      const beat = mult.atMs - T.AUDIO_LEAD_MS;
      const atBeat = events.filter((e) => e.atMs === beat);
      expect(sounds(atBeat)).toEqual(expect.arrayContaining([`mult_${mult.stage}`, 'transient']));
      const haptics = only(events, 'haptic').filter((e) => e.atMs === beat || e.atMs === beat + T.HAPTIC_RIGID_DELAY_MS);
      expect(haptics.map((e) => e.kind)).toEqual(stageHaptics(mult.stage).map((h) => h.kind));
    }
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => stageHaptics(n).map((h) => h.kind).join('+'))).toEqual([
      'light',
      'light',
      'medium',
      'medium',
      'heavy',
      'heavy',
      'heavy+rigid',
      'heavy+rigid',
    ]);
  });

  it('grows scale, shake, rotation and flash with every stage; stage 8 shakes 240 ms', () => {
    const events = reveal(8);
    const mults = only(events, 'mult');
    const shakes = only(events, 'shake');
    const flashes = only(events, 'flash');
    expect(mults.map((e) => Math.round(e.peakScale * 100) / 100)).toEqual([1.16, 1.2, 1.24, 1.28, 1.32, 1.36, 1.4, 1.44]);
    expect(shakes.map((e) => e.px)).toEqual([2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5]);
    expect(shakes.map((e) => e.ms)).toEqual([160, 170, 180, 190, 200, 210, 220, 240]);
    expect(shakes.map((e) => Math.abs(e.rotationDeg))).toEqual([0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5]);
    expect(shakes.map((e) => Math.sign(e.rotationDeg))).toEqual([1, -1, 1, -1, 1, -1, 1, -1]);
    // Eight stage flashes plus the slam.
    expect(flashes.slice(0, 8).map((e) => Math.round(e.opacity * 100) / 100)).toEqual([0.11, 0.14, 0.17, 0.2, 0.23, 0.26, 0.29, 0.32]);
  });

  it('builds the heat layer from stage 5 and stops its loop at the slam', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(heatOf)).toEqual([0, 0, 0, 0, 0.25, 0.5, 0.75, 1]);
    const events = reveal(8);
    const loops = only(events, 'sound').filter((e) => e.id === 'heat_loop');
    expect(loops.map((e) => [e.loop, e.volume])).toEqual([0.25, 0.5, 0.75, 1].map((h) => [true, T.HEAT_LOOP_VOLUME * h]));
    const stop = only(events, 'soundStop')[0];
    const slam = only(events, 'slam')[0];
    expect(stop).toMatchObject({ id: 'heat_loop', atMs: slam.atMs - T.AUDIO_LEAD_MS });
    expect(only(reveal(4), 'soundStop')).toHaveLength(0);
  });

  it('holds a 90 ms hit-stop, then slams the total with a chord, heavy + success haptics and 12-20 particles', () => {
    const events = reveal(3);
    const lastStage = only(events, 'mult').at(-1)!;
    const hitStop = only(events, 'hitStop')[0];
    const slam = only(events, 'slam')[0];
    expect(hitStop.atMs).toBe(lastStage.atMs + stageIntervalMs(3));
    expect(slam.atMs - hitStop.atMs).toBe(T.HIT_STOP_MS);
    const beat = slam.atMs - T.AUDIO_LEAD_MS;
    expect(sounds(events.filter((e) => e.atMs === beat))).toContain('total_chord');
    const haptics = only(events, 'haptic').filter((e) => e.atMs >= beat);
    expect(haptics).toEqual([
      { atMs: beat, type: 'haptic', kind: 'heavy' },
      { atMs: beat + T.SLAM_SUCCESS_DELAY_MS, type: 'haptic', kind: 'success' },
    ]);
    expect(slam).toMatchObject({ scaleFrom: 0.6, scalePeak: 1.5, spring: { damping: 9, stiffness: 220 }, countMs: 300, particles: 15 });
    expect(only(reveal(0), 'slam')[0].particles).toBe(12);
    expect(only(reveal(10), 'slam')[0].particles).toBe(20);
  });

  it('asks the bonus question 400 ms after the slam, only when there is one', () => {
    const withBonus = reveal(2, { bonus: true });
    const slam = only(withBonus, 'slam')[0];
    expect(only(withBonus, 'showBonusQuestion')).toEqual([{ atMs: slam.atMs + T.SETTLE_MS, type: 'showBonusQuestion' }]);
    expect(timelineEndMs(withBonus)).toBe(slam.atMs + T.SETTLE_MS);
    expect(only(reveal(2), 'showBonusQuestion')).toHaveLength(0);
  });

  it('puts visuals AUDIO_LEAD_MS after their sound', () => {
    const events = reveal(1);
    const firstTick = only(events, 'sound').find((e) => e.id === 'tick_0')!;
    expect(only(events, 'count')[0].atMs).toBe(firstTick.atMs + T.AUDIO_LEAD_MS);
  });

  it('keeps the event times in order', () => {
    for (const reduceMotion of [false, true]) {
      for (let weeks = 0; weeks <= 10; weeks++) {
        const times = reveal(weeks, { reduceMotion, bonus: true }).map((e) => e.atMs);
        times.forEach((t, i) => i > 0 && expect(t).toBeGreaterThanOrEqual(times[i - 1]));
        // Every tick, stage and the slam is on a beat of its own.
        const beats = reveal(weeks, { reduceMotion })
          .filter((e) => e.type === 'count' || e.type === 'mult' || e.type === 'slam')
          .map((e) => e.atMs);
        beats.forEach((t, i) => i > 0 && expect(t).toBeGreaterThan(beats[i - 1]));
      }
    }
  });

  it('with Reduce Motion: the same sounds and haptics, flat 250 ms stages, no shake, flash or particles, scale at most 1.05', () => {
    const full = reveal(8);
    const reduced = reveal(8, { reduceMotion: true });
    expect(stripVisual(reduced).map((e) => [e.type, 'id' in e ? e.id : 'kind' in e ? e.kind : ''])).toEqual(
      stripVisual(full).map((e) => [e.type, 'id' in e ? e.id : 'kind' in e ? e.kind : '']),
    );
    expect(reduced.filter((e) => VISUAL.includes(e.type))).toEqual([]);
    const mults = only(reduced, 'mult');
    expect(mults.slice(1).map((e, i) => e.atMs - mults[i].atMs)).toEqual(Array(7).fill(250));
    expect(mults.every((e) => e.peakScale <= 1.05 && e.heat === 0)).toBe(true);
    expect(only(reduced, 'slam')[0]).toMatchObject({ scaleFrom: 1, scalePeak: 1.05, particles: 0 });
  });
});

describe('the discovery step', () => {
  // The server's discovery: 10 + 5 chips, four streak weeks, the first check-in of the week.
  const discovery = () => parseScore(SERVER_DISCOVERY_SCORE)!;
  const play = (reduceMotion = false, bonus = false) => buildRevealTimeline({ score: discovery(), reduceMotion, bonus });

  it('pops up the banner, flies its +5 into PUNTEN and shrinks it into the context line; the streak runs on 15 chips', () => {
    const events = play();
    const pops = only(events, 'popupIn');
    const outs = only(events, 'popupOut');
    expect(pops.map((e) => [e.popup, e.sparkles])).toEqual([
      ['discovery', T.DISCOVERY_SPARKLES],
      ['discoveryAdd', 0],
      ['flame', 0],
    ]);
    expect(outs.map((e) => [e.popup, e.to, e.fly])).toEqual([
      ['discoveryAdd', 'chips', true],
      ['discovery', 'context', true],
      ['flame', 'mult', true],
    ]);
    const [banner, add, flame] = pops;
    expect(add.atMs - banner.atMs).toBe(T.DISCOVERY_ADD_MS);
    const land = add.atMs + T.POPUP_FLY_MS;
    expect(only(events, 'bins')).toEqual([{ atMs: land, type: 'bins', chips: 15, multiplier: null, total: 15, discovery: 5 }]);
    expect(only(events, 'binPop')[0]).toEqual({ atMs: land, type: 'binPop', bin: 'chips', scale: T.BIN_POP_SCALE });
    expect(outs[1].atMs).toBe(land + T.DISCOVERY_SHRINK_DELAY_MS);
    // The base counts to 10; PUNTEN gets 15 from the discovery; the stages build on 15.
    expect(only(events, 'count').at(-1)?.value).toBe(10);
    expect(only(events, 'mult').map((e) => e.total)).toEqual([17, 18, 20, 22]);
    expect(only(events, 'slam')[0]).toMatchObject({ from: 22, to: 22 });
    // After the last tick; the flame follows once the +5 has landed.
    expect(banner.atMs).toBeGreaterThan(only(events, 'count').at(-1)!.atMs);
    expect(flame.atMs).toBe(land + T.DISCOVERY_HOLD_MS + T.FLAME_LEAD_MS);
  });

  it('plays the fanfare with a medium haptic; the +5 lands with the chip sound and a selection tap', () => {
    const events = play();
    const banner = only(events, 'popupIn')[0].atMs - T.AUDIO_LEAD_MS;
    const land = banner + T.DISCOVERY_ADD_MS + T.POPUP_FLY_MS;
    expect(audibleAt(events, banner)).toEqual(['discover_fanfare', 'medium']);
    expect(audibleAt(events, land)).toEqual(['chip_add', 'selection']);
    expect(sounds(events).filter((id) => !id.startsWith('tick_'))).toEqual([
      'discover_fanfare',
      'chip_add',
      'flame_whoosh',
      'riser',
      'mult_1',
      'transient',
      'mult_2',
      'transient',
      'mult_3',
      'transient',
      'mult_4',
      'transient',
      'total_chord',
    ]);
  });

  it('with Reduce Motion: the same sounds and haptics; pop-ups fade instead of flying, no sparkles, shake or flash', () => {
    const moving = play(false);
    const still = play(true);
    const audible = (events: Event[]) => events.filter((e) => e.type === 'sound' || e.type === 'haptic').map((e) => ({ ...e, atMs: 0 }));
    expect(audible(still)).toEqual(audible(moving));
    expect(only(still, 'popupIn').every((e) => e.sparkles === 0)).toBe(true);
    expect(only(still, 'popupOut').every((e) => !e.fly)).toBe(true);
    expect(only(still, 'binPop').every((e) => e.scale <= T.REDUCED_MOTION_MAX_SCALE)).toBe(true);
    expect(only(still, 'shake')).toHaveLength(0);
    expect(only(still, 'flash')).toHaveLength(0);
  });

  it('is what the app expects while uploading (previewScore with a discovery)', () => {
    const expected = buildRevealTimeline({
      score: previewScore(DEFAULT_CONFIG, 4, undefined, { discovery: true, streakExtended: true }),
      reduceMotion: false,
    });
    expect(expected).toEqual(play());
  });

  it('stays under 6 s with eight weeks, the flame and the bonus question', () => {
    const score = previewScore(DEFAULT_CONFIG, 8, undefined, { discovery: true, streakExtended: true });
    const events = buildRevealTimeline({ score, reduceMotion: false, bonus: true });
    expect(timelineEndMs(events)).toBeLessThan(6000);
  });
});

describe('the streak flame', () => {
  const extended = (reduceMotion: boolean, bonus = true) =>
    buildRevealTimeline({ score: previewScore(DEFAULT_CONFIG, 5, undefined, { streakExtended: true }), reduceMotion, bonus });

  it('beats at MULT before the streak: whoosh, light haptic and a MULT pop, then it flies into MULT as the riser starts', () => {
    const events = extended(false);
    const [flame] = only(events, 'popupIn');
    expect(flame.popup).toBe('flame');
    const beat = flame.atMs - T.AUDIO_LEAD_MS;
    expect(audibleAt(events, beat)).toEqual(['flame_whoosh', 'light']);
    expect(only(events, 'binPop')[0]).toEqual({ atMs: flame.atMs, type: 'binPop', bin: 'mult', scale: T.BIN_POP_SCALE });
    expect(only(events, 'popupOut')[0]).toMatchObject({ popup: 'flame', to: 'mult', atMs: flame.atMs + T.FLAME_SHOW_MS, fly: true });
    const riser = only(events, 'sound').find((e) => e.id === 'riser')!.atMs;
    expect(riser).toBe(beat + T.FLAME_SHOW_MS + T.FLAME_HOLD_MS);
    expect(only(events, 'mult')[0].atMs).toBeGreaterThan(flame.atMs);
  });

  it('fades with Reduce Motion, with the same sound', () => {
    const events = extended(true);
    expect(only(events, 'popupOut')[0].fly).toBe(false);
    expect(sounds(events)).toContain('flame_whoosh');
  });

  it('asks the bonus question 400 ms after the slam, as without the flame', () => {
    const events = extended(false);
    expect(only(events, 'showBonusQuestion')[0].atMs).toBe(only(events, 'slam')[0].atMs + T.SETTLE_MS);
  });

  it('is not there when the streak was extended before this week', () => {
    expect(only(reveal(5, { bonus: true }), 'popupIn')).toHaveLength(0);
    expect(sounds(reveal(5))).not.toContain('flame_whoosh');
  });
});

describe('buildBonusTimeline', () => {
  it('awarded: whoosh, the pop-up drops in, hit-stop, punch, then five rising ticks to total + 5 and the landing', () => {
    const events = buildBonusTimeline({ awarded: true, fromTotal: 21 });
    const at = T.BONUS_CHIP_ARC_MS + T.BONUS_HIT_STOP_MS;
    expect(sounds(events)).toEqual(['whoosh_up', 'bonus_tick_1', 'bonus_tick_2', 'bonus_tick_3', 'bonus_tick_4', 'bonus_tick_5', 'bonus_land']);
    expect(only(events, 'sound').filter((e) => e.id.startsWith('bonus_tick_')).map((e) => e.atMs)).toEqual([0, 1, 2, 3, 4].map((i) => at + i * 60));
    expect(only(events, 'count').map((e) => e.value)).toEqual([22, 23, 24, 25, 26]);
    expect(only(events, 'bonusChip')[0]).toMatchObject({ atMs: T.AUDIO_LEAD_MS, durationMs: 320, value: 5, fly: true });
    expect(only(events, 'punch')[0]).toMatchObject({ scale: 1.35, atMs: at + T.AUDIO_LEAD_MS });
    expect(only(events, 'shake')[0]).toMatchObject({ px: 6, ms: 200 });
    expect(only(events, 'flash')[0]).toMatchObject({ opacity: 0.25 });
    expect(only(events, 'ring')).toHaveLength(1);
    const haptics = only(events, 'haptic').map((e) => e.kind);
    expect(haptics).toEqual(['selection', 'selection', 'selection', 'selection', 'selection', 'success']);
    const land = only(events, 'sound').find((e) => e.id === 'bonus_land')!;
    expect(land.atMs).toBe(at + 5 * 60);
    expect(only(events, 'badge')).toEqual([{ atMs: land.atMs + T.AUDIO_LEAD_MS, type: 'badge', value: 5 }]);
  });

  it('not awarded: one neutral tock, nothing to celebrate', () => {
    const events = buildBonusTimeline({ awarded: false, fromTotal: 21 });
    expect(events).toEqual([{ atMs: 0, type: 'sound', id: 'neutral_tock', volume: T.VOLUME.tock }]);
    expect(buildBonusTimeline({ awarded: true, points: 0, fromTotal: 21 })).toEqual(events);
  });

  it('with Reduce Motion: the same sounds and haptics; the pop-up fades, no shake, flash or ring', () => {
    const full = buildBonusTimeline({ awarded: true, fromTotal: 10 });
    const reduced = buildBonusTimeline({ awarded: true, fromTotal: 10, reduceMotion: true });
    expect(sounds(reduced)).toEqual(sounds(full));
    expect(only(reduced, 'haptic').map((e) => e.kind)).toEqual(only(full, 'haptic').map((e) => e.kind));
    expect(only(reduced, 'bonusChip')[0]).toMatchObject({ fly: false, value: 5 });
    expect(reduced.filter((e) => VISUAL.includes(e.type) && e.type !== 'bonusChip')).toEqual([]);
    expect(only(reduced, 'punch')[0].scale).toBeLessThanOrEqual(1.05);
    expect(only(reduced, 'count').map((e) => e.value)).toEqual([11, 12, 13, 14, 15]);
  });

  it('keeps the event times in order', () => {
    for (const reduceMotion of [false, true]) {
      const times = buildBonusTimeline({ awarded: true, fromTotal: 10, reduceMotion }).map((e) => e.atMs);
      times.forEach((t, i) => i > 0 && expect(t).toBeGreaterThanOrEqual(times[i - 1]));
    }
  });
});
