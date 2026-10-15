// The points reveal as data: a list of events, each at an absolute time in
// milliseconds from the start. No React, no sound, no clock: pure, so the order,
// the pitches and the Reduce Motion rules are unit tested. The runner (run.ts)
// plays the list, the screen turns the events into sound, haptics and motion.
//
// Sound and haptic events sit exactly on the beat; visual events follow
// AUDIO_LEAD_MS later. The timing comes from tuning.ts, every number shown
// from the score the server sent (score.steps): the timeline lands on its total.
import { countSteps } from '../../lib/reveal';
import { streakStep, type Score } from '../../lib/score';
import type { HapticKind } from '../haptics';
import type { SfxId } from '../sfx/sources';
import * as T from './tuning';

export type { HapticKind, SfxId };

export type Event =
  // Sound and haptics.
  | { atMs: number; type: 'sound'; id: SfxId; volume: number; loop?: boolean }
  | { atMs: number; type: 'soundStop'; id: SfxId }
  | { atMs: number; type: 'haptic'; kind: HapticKind }
  // The big number.
  | { atMs: number; type: 'chipIn' }
  | { atMs: number; type: 'count'; value: number }
  // A discovery: the banner falls in (`sparkles` is 0 with Reduce Motion) and
  // the chips get `add` more; the POINTS chip pops when they land.
  | { atMs: number; type: 'discovery'; add: number; sparkles: number }
  | { atMs: number; type: 'chipPop'; scale: number }
  // A step of a kind the app does not know: its label, and its running total.
  | { atMs: number; type: 'step'; label: string; total: number | null }
  // One streak multiplier lands: the badge, the number, the heat layer.
  | { atMs: number; type: 'mult'; stage: number; multiplier: number; total: number; max: boolean; peakScale: number; heat: number }
  | { atMs: number; type: 'shake'; px: number; ms: number; rotationDeg: number }
  | { atMs: number; type: 'flash'; opacity: number }
  | { atMs: number; type: 'hitStop'; ms: number }
  // The total slams in; `particles` is 0 with Reduce Motion. The number counts
  // from `from` (the last running total shown) to `to` (always the score's
  // total) over `countMs` (ease-out cubic). With base and streak it already
  // climbed with every stage, so both are the total.
  | {
      atMs: number;
      type: 'slam';
      from: number;
      to: number;
      countMs: number;
      scaleFrom: number;
      scalePeak: number;
      spring: { damping: number; stiffness: number };
      particles: number;
    }
  // The first check-in of the week: the streak flame grows (stands still with Reduce Motion).
  | { atMs: number; type: 'flame'; weeks: number; grow: boolean }
  | { atMs: number; type: 'showBonusQuestion' }
  // The +5.
  | { atMs: number; type: 'bonusChip'; durationMs: number; value: number }
  | { atMs: number; type: 'punch'; scale: number }
  | { atMs: number; type: 'ring' }
  | { atMs: number; type: 'badge'; value: number }
  // A celebration (celebrate.tsx): confetti (0 pieces with Reduce Motion), its reward comes in.
  | { atMs: number; type: 'confetti'; pieces: number }
  | { atMs: number; type: 'reward' };

type DistributiveOmit<U, K extends PropertyKey> = U extends unknown ? Omit<U, K> : never;
/** An event without its time. */
type EventBody = DistributiveOmit<Event, 'atMs'>;

/** Collects events: sound and haptics on the beat (`add`), visuals AUDIO_LEAD_MS after it (`visual`). */
function collector() {
  const events: Event[] = [];
  const add = (atMs: number, body: EventBody) => {
    events.push({ atMs, ...body } as Event);
  };
  const visual = (atMs: number, body: EventBody) => add(atMs + T.AUDIO_LEAD_MS, body);
  // Array.sort is stable: events at the same time keep the order they were added in.
  const done = () => events.sort((a, b) => a.atMs - b.atMs);
  return { add, visual, done };
}

export interface RevealTimelineInput {
  /** The steps and running totals from the server. */
  score: Score;
  reduceMotion: boolean;
  /** A bonus question follows the reveal. */
  bonus?: boolean;
}

export interface BonusTimelineInput {
  /** The question was answered and the points were granted. Skipped, or no points: not awarded. */
  awarded: boolean;
  fromTotal: number;
  points?: number;
  reduceMotion?: boolean;
}

/** How long stage `stage` (1-based) lasts before the next one lands. Each is shorter, down to a floor. */
export function stageIntervalMs(stage: number, reduceMotion = false): number {
  if (reduceMotion) return T.REDUCED_MOTION_STAGE_INTERVAL_MS;
  return Math.max(T.STAGE_INTERVAL_MIN_MS, Math.round(T.STAGE_INTERVAL_FIRST_MS * T.STAGE_INTERVAL_DECAY ** (stage - 1)));
}

/** The haptic of stage `stage`: stronger as the streak grows; the last two end on a rigid tap. */
export function stageHaptics(stage: number): { kind: HapticKind; delayMs: number }[] {
  if (stage <= T.HAPTIC_LIGHT_UP_TO) return [{ kind: 'light', delayMs: 0 }];
  if (stage <= T.HAPTIC_MEDIUM_UP_TO) return [{ kind: 'medium', delayMs: 0 }];
  if (stage <= T.HAPTIC_HEAVY_UP_TO) return [{ kind: 'heavy', delayMs: 0 }];
  return [
    { kind: 'heavy', delayMs: 0 },
    { kind: 'rigid', delayMs: T.HAPTIC_RIGID_DELAY_MS },
  ];
}

/** 0..1 for stage `stage`: the heat layer starts after stage HEAT_FROM_STAGE. */
export function heatOf(stage: number): number {
  return Math.max(0, (stage - T.HEAT_FROM_STAGE) / T.HEAT_FROM_STAGE);
}

/** A repeatable stand-in for random in [-1, 1]. */
function jitter(index: number): number {
  const x = Math.sin((index + 1) * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * The reveal of `score`, step by step in the server's order: the base counted
 * up, the discovery (banner, +5 chips), one hit per streak stage, a step of an
 * unknown kind with its label and the chip sound; then the total slams in, and
 * on the first check-in of the week the streak flame grows.
 */
export function buildRevealTimeline(input: RevealTimelineInput): Event[] {
  const { score } = input;
  const reduce = input.reduceMotion;
  const { add, visual, done } = collector();

  visual(0, { type: 'chipIn' });

  // `cursor` is when the next step starts, `shown` the running total on screen.
  let cursor = T.LEAD_IN_MS;
  let shown = 0;
  let stageCount = 0;
  for (const step of score.steps) {
    switch (step.kind) {
      case 'base': {
        // Counting up to the base points.
        const base = Math.max(0, Math.round(step.total));
        const values = base > 0 ? countSteps(0, base, T.BASE_TICKS) : [];
        let at = cursor;
        values.forEach((value, i) => {
          if (i > 0) {
            const progress = values.length > 2 ? (i - 1) / (values.length - 2) : 0;
            const eased = progress * progress * (3 - 2 * progress);
            at += Math.round(T.TICK_INTERVAL_START_MS + (T.TICK_INTERVAL_END_MS - T.TICK_INTERVAL_START_MS) * eased);
          }
          const id = `tick_${Math.floor(i / 2) % T.TICK_PITCHES}` as SfxId;
          add(at, { type: 'sound', id, volume: T.VOLUME.tick * (1 + T.TICK_JITTER * jitter(i)) });
          if (i % 2 === 0) add(at, { type: 'haptic', kind: 'selection' });
          visual(at, { type: 'count', value });
        });
        shown = base;
        cursor = at + T.TICK_INTERVAL_END_MS;
        break;
      }
      case 'discovery': {
        // The banner with its fanfare, then the chips get their +5.
        const bannerAt = cursor + T.DISCOVERY_LEAD_MS;
        add(bannerAt, { type: 'sound', id: 'discover_fanfare', volume: T.VOLUME.fanfare });
        add(bannerAt, { type: 'haptic', kind: 'medium' });
        visual(bannerAt, { type: 'discovery', add: step.add, sparkles: reduce ? 0 : T.DISCOVERY_SPARKLES });
        const addAt = bannerAt + T.DISCOVERY_ADD_MS;
        add(addAt, { type: 'sound', id: 'chip_add', volume: T.VOLUME.chipAdd });
        add(addAt, { type: 'haptic', kind: 'selection' });
        visual(addAt, { type: 'count', value: step.total });
        visual(addAt, { type: 'chipPop', scale: reduce ? T.REDUCED_MOTION_MAX_SCALE : T.CHIP_POP_SCALE });
        shown = step.total;
        cursor = addAt + T.DISCOVERY_HOLD_MS;
        break;
      }
      case 'streak': {
        // Anticipation, then one hit per streak week.
        add(cursor, { type: 'sound', id: 'riser', volume: T.VOLUME.riser });
        let at = cursor + T.ANTICIPATION_MS;
        const { weeks, stages } = step;
        stageCount = stages.length;
        for (let stage = 1; stage <= stageCount; stage++) {
          const { mult, total } = stages[stage - 1];
          // Sound, haptics and motion grow up to the top stage and stay there.
          const level = Math.min(stage, T.TOP_STAGE);
          add(at, { type: 'sound', id: `mult_${level}` as SfxId, volume: T.VOLUME.mult });
          add(at, { type: 'sound', id: 'transient', volume: T.VOLUME.transient });
          for (const { kind, delayMs } of stageHaptics(level)) add(at + delayMs, { type: 'haptic', kind });
          // The low crackle is audio: it stays with Reduce Motion, the glow does not.
          if (heatOf(level) > 0) add(at, { type: 'sound', id: 'heat_loop', volume: T.HEAT_LOOP_VOLUME * heatOf(level), loop: true });
          visual(at, {
            type: 'mult',
            stage,
            multiplier: mult,
            total,
            max: weeks > stageCount && stage === stageCount,
            peakScale: Math.min(reduce ? T.REDUCED_MOTION_MAX_SCALE : Infinity, T.STAGE_PEAK_SCALE.base + T.STAGE_PEAK_SCALE.step * level),
            heat: reduce ? 0 : heatOf(level),
          });
          if (!reduce) {
            const sign = stage % 2 === 1 ? 1 : -1;
            visual(at, {
              type: 'shake',
              px: T.STAGE_SHAKE_PX.base + T.STAGE_SHAKE_PX.step * level,
              ms: level === T.TOP_STAGE ? T.LAST_STAGE_SHAKE_MS : T.STAGE_SHAKE_MS.base + T.STAGE_SHAKE_MS.step * level,
              rotationDeg: sign * (T.STAGE_ROTATION_DEG.base + T.STAGE_ROTATION_DEG.step * level),
            });
            visual(at, { type: 'flash', opacity: T.STAGE_FLASH.base + T.STAGE_FLASH.step * level });
          }
          shown = total;
          at += stageIntervalMs(stage, reduce);
        }
        cursor = at;
        break;
      }
      case 'other': {
        // A kind the app does not know yet: its label and total, the chip sound.
        const stepAt = cursor + T.STEP_LEAD_MS;
        add(stepAt, { type: 'sound', id: 'chip_add', volume: T.VOLUME.chipAdd });
        add(stepAt, { type: 'haptic', kind: 'medium' });
        visual(stepAt, { type: 'step', label: step.label, total: step.total });
        if (step.total !== null) shown = step.total;
        cursor = stepAt + T.STEP_HOLD_MS;
        break;
      }
    }
  }
  let at = cursor;

  // Hit-stop, then the total slams in.
  if (!reduce) {
    visual(at, { type: 'hitStop', ms: T.HIT_STOP_MS });
    at += T.HIT_STOP_MS;
  }
  if (heatOf(Math.min(stageCount, T.TOP_STAGE)) > 0) add(at, { type: 'soundStop', id: 'heat_loop' });
  add(at, { type: 'sound', id: 'total_chord', volume: T.VOLUME.total });
  add(at, { type: 'haptic', kind: 'heavy' });
  add(at + T.SLAM_SUCCESS_DELAY_MS, { type: 'haptic', kind: 'success' });
  visual(at, {
    type: 'slam',
    from: shown,
    to: score.total,
    countMs: T.SLAM_COUNT_MS,
    scaleFrom: reduce ? 1 : T.SLAM_SCALE_FROM,
    scalePeak: reduce ? T.REDUCED_MOTION_MAX_SCALE : T.SLAM_SCALE_PEAK,
    spring: T.SLAM_SPRING,
    particles: reduce ? 0 : Math.min(T.SLAM_PARTICLES_MAX, T.SLAM_PARTICLES_MIN + stageCount),
  });
  if (!reduce) visual(at, { type: 'flash', opacity: T.SLAM_FLASH });

  // The first check-in of the week: the streak flame, then the bonus question.
  let settleAt = at + T.SETTLE_MS;
  if (score.streakExtended) {
    const flameAt = at + T.FLAME_DELAY_MS;
    add(flameAt, { type: 'sound', id: 'flame_whoosh', volume: T.VOLUME.flame });
    add(flameAt, { type: 'haptic', kind: 'light' });
    visual(flameAt, { type: 'flame', weeks: streakStep(score)?.weeks ?? 0, grow: !reduce });
    settleAt = flameAt + T.FLAME_HOLD_MS;
  }
  if (input.bonus) visual(settleAt, { type: 'showBonusQuestion' });

  return done();
}

/** The +5 of the bonus question: awarded counts up with a flourish, not awarded is one quiet tock. */
export function buildBonusTimeline(input: BonusTimelineInput): Event[] {
  const points = input.points ?? 5;
  const reduce = input.reduceMotion ?? false;
  const { add, visual, done } = collector();
  if (!input.awarded || points <= 0) {
    // Never celebrate a non-gain: no flash, no success haptic, no count.
    add(0, { type: 'sound', id: 'neutral_tock', volume: T.VOLUME.tock });
    return done();
  }

  add(0, { type: 'sound', id: 'whoosh_up', volume: T.VOLUME.whoosh });
  if (!reduce) visual(0, { type: 'bonusChip', durationMs: T.BONUS_CHIP_ARC_MS, value: points });
  let at = T.BONUS_CHIP_ARC_MS;
  if (!reduce) {
    visual(at, { type: 'hitStop', ms: T.BONUS_HIT_STOP_MS });
    at += T.BONUS_HIT_STOP_MS;
  }

  visual(at, { type: 'punch', scale: reduce ? T.REDUCED_MOTION_MAX_SCALE : T.BONUS_PUNCH_SCALE });
  if (!reduce) {
    visual(at, { type: 'shake', px: T.BONUS_SHAKE_PX, ms: T.BONUS_SHAKE_MS, rotationDeg: 0 });
    visual(at, { type: 'flash', opacity: T.BONUS_FLASH });
    visual(at, { type: 'ring' });
  }

  // Count total+1 .. total+points, one rising tick each.
  const values = countSteps(input.fromTotal, input.fromTotal + points, T.BONUS_TICKS);
  values.forEach((value, i) => {
    const tickAt = at + i * T.BONUS_TICK_MS;
    add(tickAt, { type: 'sound', id: `bonus_tick_${i + 1}` as SfxId, volume: T.VOLUME.bonusTick });
    add(tickAt, { type: 'haptic', kind: 'selection' });
    visual(tickAt, { type: 'count', value });
  });

  const landAt = at + values.length * T.BONUS_TICK_MS;
  add(landAt, { type: 'sound', id: 'bonus_land', volume: T.VOLUME.bonusLand });
  add(landAt, { type: 'haptic', kind: 'success' });
  visual(landAt, { type: 'badge', value: points });

  return done();
}

/** When the last event happens. */
export function timelineEndMs(events: readonly Event[]): number {
  return events.reduce((end, event) => Math.max(end, event.atMs), 0);
}

