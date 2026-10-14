import { describe, expect, it } from '@jest/globals';

import { pointStages } from '../../../lib/points';
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
const VISUAL: Event['type'][] = ['shake', 'flash', 'hitStop', 'bonusChip', 'ring'];
const AUDIO_OR_HAPTIC: Event['type'][] = ['sound', 'soundStop', 'haptic'];

function stripVisual(events: Event[]) {
  return events.filter((e) => AUDIO_OR_HAPTIC.includes(e.type)).map(({ type, ...rest }) => ({ type, ...rest }));
}

describe('buildRevealTimeline', () => {
  it('counts the base in 10 ticks, then shows every stage total: 11, 12, 13, 15, 16, 18, 19, 21', () => {
    const events = buildRevealTimeline({ basePoints: 10, streakWeeks: 8, reduceMotion: false });
    const counts = only(events, 'count').map((e) => e.value);
    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(only(events, 'mult').map((e) => e.total)).toEqual([11, 12, 13, 15, 16, 18, 19, 21]);
    expect(only(events, 'slam')[0]).toMatchObject({ from: 21, to: 21 });
  });

  it('matches the server formula for every streak', () => {
    for (let weeks = 0; weeks <= 10; weeks++) {
      const totals = only(buildRevealTimeline({ basePoints: 10, streakWeeks: weeks, reduceMotion: false }), 'mult').map((e) => e.total);
      expect(totals).toEqual(pointStages(10, weeks).stages);
    }
  });

  it('caps at 8 stages: weeks 9 and 10 show stage 8 with MAX', () => {
    for (const weeks of [9, 10]) {
      const mults = only(buildRevealTimeline({ basePoints: 10, streakWeeks: weeks, reduceMotion: false }), 'mult');
      expect(mults).toHaveLength(8);
      expect(mults.at(-1)).toMatchObject({ stage: 8, max: true, total: 21 });
      expect(mults.slice(0, -1).every((e) => !e.max)).toBe(true);
    }
    expect(only(buildRevealTimeline({ basePoints: 10, streakWeeks: 8, reduceMotion: false }), 'mult').at(-1)?.max).toBe(false);
  });

  it('shows the multiplier 1.1^n per stage, up to ×2.14', () => {
    const mults = only(buildRevealTimeline({ basePoints: 10, streakWeeks: 8, reduceMotion: false }), 'mult');
    expect(mults.map((e) => Math.round(e.multiplier * 100) / 100)).toEqual([1.1, 1.21, 1.33, 1.46, 1.61, 1.77, 1.95, 2.14]);
  });

  it('uses the server totals when it has them', () => {
    const events = buildRevealTimeline({ basePoints: 10, streakWeeks: 2, reduceMotion: false, stages: [12, 14] });
    expect(only(events, 'mult').map((e) => e.total)).toEqual([12, 14]);
  });

  it('without a streak: ticks, riser, total; no multipliers', () => {
    const events = buildRevealTimeline({ basePoints: 10, streakWeeks: 0, reduceMotion: false });
    expect(only(events, 'mult')).toHaveLength(0);
    expect(sounds(events).filter((id) => id.startsWith('mult_'))).toHaveLength(0);
    expect(only(events, 'slam')[0]).toMatchObject({ from: 10, to: 10 });
  });

  it('makes the stage intervals non-increasing and never shorter than 200 ms', () => {
    const expected = [420, 357, 303, 258, 219, 200, 200, 200];
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => stageIntervalMs(n))).toEqual(expected);
    const stageTimes = only(buildRevealTimeline({ basePoints: 10, streakWeeks: 10, reduceMotion: false }), 'mult').map((e) => e.atMs);
    const gaps = stageTimes.slice(1).map((t, i) => t - stageTimes[i]);
    gaps.forEach((gap, i) => {
      expect(gap).toBeGreaterThanOrEqual(200);
      if (i > 0) expect(gap).toBeLessThanOrEqual(gaps[i - 1]);
    });
  });

  it('eases the tick gaps from 90 to 55 ms', () => {
    const ticks = only(buildRevealTimeline({ basePoints: 10, streakWeeks: 0, reduceMotion: false }), 'sound').filter((e) => e.id.startsWith('tick_'));
    const gaps = ticks.slice(1).map((e, i) => e.atMs - ticks[i].atMs);
    expect(gaps[0]).toBe(90);
    expect(gaps.at(-1)).toBe(55);
    gaps.slice(1).forEach((gap, i) => expect(gap).toBeLessThanOrEqual(gaps[i]));
  });

  it('gives the ticks the pentatonic pitches in pairs, with a little volume jitter', () => {
    const ticks = only(buildRevealTimeline({ basePoints: 10, streakWeeks: 0, reduceMotion: false }), 'sound').filter((e) => e.id.startsWith('tick_'));
    expect(ticks.map((e) => e.id)).toEqual(['tick_0', 'tick_0', 'tick_1', 'tick_1', 'tick_2', 'tick_2', 'tick_3', 'tick_3', 'tick_4', 'tick_4']);
    for (const tick of ticks) expect(Math.abs(tick.volume / T.VOLUME.tick - 1)).toBeLessThanOrEqual(T.TICK_JITTER + 1e-9);
    expect(new Set(ticks.map((e) => e.volume)).size).toBeGreaterThan(1);
  });

  it('puts a selection haptic on every second tick', () => {
    const events = buildRevealTimeline({ basePoints: 10, streakWeeks: 0, reduceMotion: false });
    const tickTimes = only(events, 'sound').filter((e) => e.id.startsWith('tick_')).map((e) => e.atMs);
    const selections = only(events, 'haptic').filter((e) => e.kind === 'selection').map((e) => e.atMs);
    expect(selections).toEqual(tickTimes.filter((_, i) => i % 2 === 0));
  });

  it('plays mult_n plus a transient on stage n, with the haptic getting stronger', () => {
    const events = buildRevealTimeline({ basePoints: 10, streakWeeks: 8, reduceMotion: false });
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
    const events = buildRevealTimeline({ basePoints: 10, streakWeeks: 8, reduceMotion: false });
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
    const events = buildRevealTimeline({ basePoints: 10, streakWeeks: 8, reduceMotion: false });
    const loops = only(events, 'sound').filter((e) => e.id === 'heat_loop');
    expect(loops.map((e) => [e.loop, e.volume])).toEqual([0.25, 0.5, 0.75, 1].map((h) => [true, T.HEAT_LOOP_VOLUME * h]));
    const stop = only(events, 'soundStop')[0];
    const slam = only(events, 'slam')[0];
    expect(stop).toMatchObject({ id: 'heat_loop', atMs: slam.atMs - T.AUDIO_LEAD_MS });
    expect(only(buildRevealTimeline({ basePoints: 10, streakWeeks: 4, reduceMotion: false }), 'soundStop')).toHaveLength(0);
  });

  it('holds a 90 ms hit-stop, then slams the total with a chord, heavy + success haptics and 12-20 particles', () => {
    const events = buildRevealTimeline({ basePoints: 10, streakWeeks: 3, reduceMotion: false });
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
    expect(only(buildRevealTimeline({ basePoints: 10, streakWeeks: 0, reduceMotion: false }), 'slam')[0].particles).toBe(12);
    expect(only(buildRevealTimeline({ basePoints: 10, streakWeeks: 10, reduceMotion: false }), 'slam')[0].particles).toBe(20);
  });

  it('asks the bonus question 400 ms after the slam, only when there is one', () => {
    const withBonus = buildRevealTimeline({ basePoints: 10, streakWeeks: 2, reduceMotion: false, bonus: true });
    const slam = only(withBonus, 'slam')[0];
    expect(only(withBonus, 'showBonusQuestion')).toEqual([{ atMs: slam.atMs + T.SETTLE_MS, type: 'showBonusQuestion' }]);
    expect(timelineEndMs(withBonus)).toBe(slam.atMs + T.SETTLE_MS);
    expect(only(buildRevealTimeline({ basePoints: 10, streakWeeks: 2, reduceMotion: false }), 'showBonusQuestion')).toHaveLength(0);
  });

  it('puts visuals AUDIO_LEAD_MS after their sound', () => {
    const events = buildRevealTimeline({ basePoints: 10, streakWeeks: 1, reduceMotion: false });
    const firstTick = only(events, 'sound').find((e) => e.id === 'tick_0')!;
    expect(only(events, 'count')[0].atMs).toBe(firstTick.atMs + T.AUDIO_LEAD_MS);
  });

  it('keeps the event times in order', () => {
    for (const reduceMotion of [false, true]) {
      for (let weeks = 0; weeks <= 10; weeks++) {
        const times = buildRevealTimeline({ basePoints: 10, streakWeeks: weeks, reduceMotion, bonus: true }).map((e) => e.atMs);
        times.forEach((t, i) => i > 0 && expect(t).toBeGreaterThanOrEqual(times[i - 1]));
        // Every tick, stage and the slam is on a beat of its own.
        const beats = buildRevealTimeline({ basePoints: 10, streakWeeks: weeks, reduceMotion })
          .filter((e) => e.type === 'count' || e.type === 'mult' || e.type === 'slam')
          .map((e) => e.atMs);
        beats.forEach((t, i) => i > 0 && expect(t).toBeGreaterThan(beats[i - 1]));
      }
    }
  });

  it('with Reduce Motion: the same sounds and haptics, flat 250 ms stages, no shake, flash or particles, scale at most 1.05', () => {
    const full = buildRevealTimeline({ basePoints: 10, streakWeeks: 8, reduceMotion: false });
    const reduced = buildRevealTimeline({ basePoints: 10, streakWeeks: 8, reduceMotion: true });
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

describe('buildBonusTimeline', () => {
  it('awarded: whoosh, chip arc, hit-stop, punch, then five rising ticks to total + 5 and the landing', () => {
    const events = buildBonusTimeline({ awarded: true, fromTotal: 21 });
    const at = T.BONUS_CHIP_ARC_MS + T.BONUS_HIT_STOP_MS;
    expect(sounds(events)).toEqual(['whoosh_up', 'bonus_tick_1', 'bonus_tick_2', 'bonus_tick_3', 'bonus_tick_4', 'bonus_tick_5', 'bonus_land']);
    expect(only(events, 'sound').filter((e) => e.id.startsWith('bonus_tick_')).map((e) => e.atMs)).toEqual([0, 1, 2, 3, 4].map((i) => at + i * 60));
    expect(only(events, 'count').map((e) => e.value)).toEqual([22, 23, 24, 25, 26]);
    expect(only(events, 'bonusChip')[0]).toMatchObject({ durationMs: 320, value: 5 });
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

  it('with Reduce Motion: the same sounds and haptics, no chip arc, shake, flash or ring', () => {
    const full = buildBonusTimeline({ awarded: true, fromTotal: 10 });
    const reduced = buildBonusTimeline({ awarded: true, fromTotal: 10, reduceMotion: true });
    expect(sounds(reduced)).toEqual(sounds(full));
    expect(only(reduced, 'haptic').map((e) => e.kind)).toEqual(only(full, 'haptic').map((e) => e.kind));
    expect(reduced.filter((e) => VISUAL.includes(e.type))).toEqual([]);
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
