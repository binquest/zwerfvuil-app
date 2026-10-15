// The motion of the reveal on Reanimated: every visual event writes shared
// values (in the same JS tick as its haptic), and the animated styles run on the
// UI thread. Nothing here starts a sound: the soundtrack owns all audio.
//
// Every animation uses ReduceMotion.System, so Reanimated also jumps to the end
// when the system setting is on (ReduceMotion.Always when the Dev mode preview
// forces it); the timeline already leaves out shake, flash, particles, sparkles
// and flights then (timeline.ts). Only opacity fades run with Reduce Motion on
// (the pop-ups and the context line): nothing moves.
//
// Everything the reveal shows is on screen from its first frame (invisible
// until its event): an event only changes shared values, so no native view is
// created while the reveal plays and the UI thread stays free.
import { useCallback, useMemo } from 'react';
import {
  cancelAnimation,
  Easing,
  interpolateColor,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { playColors } from '../../theme/game';
import type { FlightTargets } from './layout';
import { particle, shakeOffset } from './motion';
import type { Event, PopupId, PopupTarget } from './timeline';
import { TOP_STAGE } from './tuning';

/** The animation helpers, all with the same Reduce Motion behaviour. */
function animations(reduceMotion: ReduceMotion) {
  return {
    timing: (toValue: number, duration: number, easing = Easing.out(Easing.quad)) => withTiming(toValue, { duration, easing, reduceMotion }),
    spring: (toValue: number, damping: number, stiffness: number) => withSpring(toValue, { damping, stiffness, reduceMotion }),
    /** Jump to a value, then animate on (Reanimated has no "set and go" in one call). */
    jump: (toValue: number) => withTiming(toValue, { duration: 0, reduceMotion }),
    /** An opacity fade: it also runs with Reduce Motion on, since nothing moves. */
    fade: (toValue: number, duration: number) => withTiming(toValue, { duration, easing: Easing.out(Easing.quad), reduceMotion: ReduceMotion.Never }),
  };
}

/** The MULT badge ramps orange → red → magenta up to the top stage. */
const MULT_COLORS = [...playColors.multRamp];
/** Where the MULT ramp is after `stage` stages, 0..1. */
const rampOf = (stage: number) => Math.min(1, stage / TOP_STAGE);
export const MAX_PARTICLES = 20;

const TARGET_INDEX: Record<PopupTarget, number> = { chips: 0, mult: 1, total: 2, context: 3 };
const NO_TARGETS: FlightTargets = { chips: { x: 0, y: 0 }, mult: { x: 0, y: 0 }, total: { x: 0, y: 0 }, context: { x: 0, y: 0 } };

/** One pop-up: fading in, popping in, flying out (0..1), to which target, flying or only fading. */
export interface PopupValues {
  opacity: SharedValue<number>;
  pop: SharedValue<number>;
  out: SharedValue<number>;
  to: SharedValue<number>;
  fly: SharedValue<number>;
}

function usePopupValues(): PopupValues {
  const opacity = useSharedValue(0);
  const pop = useSharedValue(0);
  const out = useSharedValue(0);
  const to = useSharedValue(0);
  const fly = useSharedValue(0);
  return useMemo(() => ({ opacity, pop, out, to, fly }), [opacity, pop, out, to, fly]);
}

export function useRevealMotion(forceReduceMotion = false) {
  const { timing, spring, jump, fade } = useMemo(
    () => animations(forceReduceMotion ? ReduceMotion.Always : ReduceMotion.System),
    [forceReduceMotion],
  );
  const shakeT = useSharedValue(1);
  const shakePx = useSharedValue(0);
  const shakeDeg = useSharedValue(0);
  const flash = useSharedValue(0);
  const chips = useSharedValue(0);
  const chipPop = useSharedValue(1);
  const multPop = useSharedValue(1);
  const multRamp = useSharedValue(0);
  const heat = useSharedValue(0);
  const totalScale = useSharedValue(1);
  const burst = useSharedValue(0);
  const burstCount = useSharedValue(0);
  const sparkle = useSharedValue(0);
  const sparkleCount = useSharedValue(0);
  const ring = useSharedValue(0);
  const sheet = useSharedValue(0);
  const context = useSharedValue(0);
  const targets = useSharedValue<FlightTargets>(NO_TARGETS);
  // A fixed set of pop-ups (hooks cannot be created per event).
  const discovery = usePopupValues();
  const discoveryAdd = usePopupValues();
  const flame = usePopupValues();
  const bonus = usePopupValues();
  const step0 = usePopupValues();
  const step1 = usePopupValues();
  const step2 = usePopupValues();
  const popups = useMemo<Record<PopupId, PopupValues>>(
    () => ({ discovery, discoveryAdd, flame, bonus, step0, step1, step2 }),
    [discovery, discoveryAdd, flame, bonus, step0, step1, step2],
  );

  const popupIn = useCallback(
    (p: PopupValues) => {
      p.out.set(0);
      p.opacity.set(fade(1, 140));
      p.pop.set(withSequence(jump(0), spring(1, 12, 260)));
    },
    [fade, jump, spring],
  );

  /** Off to `to` over `ms`: flying there and shrinking, or (Reduce Motion) fading where it is. */
  const popupOut = useCallback(
    (p: PopupValues, to: PopupTarget, ms: number, fly: boolean, delayMs = 0) => {
      p.to.set(TARGET_INDEX[to]);
      p.fly.set(fly ? 1 : 0);
      const run = fly ? timing(1, ms, Easing.in(Easing.quad)) : fade(1, ms);
      p.out.set(delayMs > 0 ? withDelay(delayMs, run) : run);
    },
    [fade, timing],
  );

  // Shared values never change identity, so neither do these functions.
  /** Writes the shared values of one visual event. Returns false for events that are not about motion. */
  const apply = useCallback(
    (event: Event): boolean => {
      switch (event.type) {
        case 'chipIn':
          chips.set(spring(1, 12, 260));
          return true;
        case 'mult':
          multPop.set(withSequence(timing(1.22, 70), spring(1, 10, 300)));
          multRamp.set(timing(rampOf(event.stage), 160));
          heat.set(timing(event.heat, 200));
          totalScale.set(withSequence(timing(event.peakScale, 70), spring(1, 11, 280)));
          return true;
        case 'shake':
          shakePx.set(event.px);
          shakeDeg.set(event.rotationDeg);
          shakeT.set(withSequence(jump(0), timing(1, event.ms, Easing.linear)));
          return true;
        case 'flash':
          flash.set(withSequence(jump(event.opacity), timing(0, 240)));
          return true;
        case 'slam':
          totalScale.set(
            withSequence(
              jump(event.scaleFrom),
              timing(event.scalePeak, 110, Easing.out(Easing.cubic)),
              spring(1, event.spring.damping, event.spring.stiffness),
            ),
          );
          heat.set(timing(0, 400));
          burstCount.set(event.particles);
          if (event.particles > 0) burst.set(withSequence(jump(0), timing(1, 650, Easing.out(Easing.cubic))));
          // The context line is there once the total has landed (if a discovery did not bring it in earlier).
          context.set(fade(1, 300));
          return true;
        case 'popupIn':
          popupIn(popups[event.popup]);
          if (event.sparkles > 0) {
            sparkleCount.set(event.sparkles);
            sparkle.set(withSequence(jump(0), timing(1, 700, Easing.out(Easing.cubic))));
          }
          return true;
        case 'popupOut':
          popupOut(popups[event.popup], event.to, event.ms, event.fly);
          // The discovery shrinks into the context line, which appears as it arrives.
          if (event.to === 'context') context.set(withDelay(Math.round(event.ms / 2), fade(1, 240)));
          return true;
        case 'bins':
          // Something multiplied on top of the streak: MULT at its hottest.
          if (event.multiplier !== null) multRamp.set(timing(1, 160));
          return true;
        case 'binPop': {
          const pop = event.bin === 'chips' ? chipPop : multPop;
          pop.set(withSequence(timing(event.scale, 70), spring(1, 10, 300)));
          return true;
        }
        case 'punch':
          totalScale.set(withSequence(timing(event.scale, 70), spring(1, 10, 260)));
          return true;
        case 'bonusChip':
          // "+5 bonusvraag" pops up, then drops into the total.
          popupIn(bonus);
          popupOut(bonus, 'total', Math.max(80, event.durationMs - 120), event.fly, 120);
          return true;
        case 'ring':
          ring.set(withSequence(jump(0), timing(1, 450, Easing.out(Easing.cubic))));
          return true;
        case 'showBonusQuestion':
          sheet.set(spring(1, 18, 160));
          return true;
        default:
          return false;
      }
    },
    [
      bonus, burst, burstCount, chipPop, chips, context, flash, heat, multPop, multRamp, popupIn, popupOut, popups, ring, shakeDeg,
      shakePx, shakeT, sheet, sparkle, sparkleCount, totalScale, timing, spring, jump, fade,
    ],
  );

  /** A skip: stop everything and stand still on the end state (no pop-ups, the context line shown). */
  const settle = useCallback(
    (stages: number, hot = false) => {
      for (const value of [shakeT, flash, chips, chipPop, multPop, multRamp, heat, totalScale, burst, sparkle, ring, context]) {
        cancelAnimation(value);
      }
      shakeT.set(1);
      flash.set(0);
      chips.set(1);
      chipPop.set(1);
      multPop.set(1);
      multRamp.set(hot ? 1 : rampOf(stages));
      heat.set(0);
      totalScale.set(1);
      burst.set(0);
      sparkle.set(0);
      ring.set(0);
      context.set(1);
      for (const p of Object.values(popups)) {
        for (const value of [p.opacity, p.pop, p.out]) cancelAnimation(value);
        p.opacity.set(0);
        p.out.set(0);
      }
    },
    [burst, chipPop, chips, context, flash, heat, multPop, multRamp, popups, ring, shakeT, sparkle, totalScale],
  );

  const showSheet = useCallback(() => {
    sheet.set(spring(1, 18, 160));
  }, [sheet, spring]);

  /** Where the bins, the total and the context line are, seen from the pop-up anchor (measured with onLayout). */
  const setTargets = useCallback((next: FlightTargets) => targets.set(next), [targets]);

  const shakeStyle = useAnimatedStyle(() => {
    const { x, y, rotation } = shakeOffset(shakeT.get(), shakePx.get(), shakeDeg.get());
    return { transform: [{ translateX: x }, { translateY: y }, { rotateZ: `${rotation}deg` }] };
  });
  const flashStyle = useAnimatedStyle(() => ({ opacity: flash.get() }));
  const chipStyle = useAnimatedStyle(() => ({ opacity: chips.get(), transform: [{ scale: (0.6 + 0.4 * chips.get()) * chipPop.get() }] }));
  const multStyle = useAnimatedStyle(() => ({
    opacity: chips.get(),
    backgroundColor: interpolateColor(multRamp.get(), [0, 0.5, 1], MULT_COLORS),
    transform: [{ scale: (0.6 + 0.4 * chips.get()) * multPop.get() }],
  }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: heat.get() * 0.8, transform: [{ scale: 1 + heat.get() * 0.35 }] }));
  const totalStyle = useAnimatedStyle(() => ({ transform: [{ scale: totalScale.get() }] }));
  const ringStyle = useAnimatedStyle(() => {
    const r = ring.get();
    return { opacity: r > 0 && r < 1 ? 0.85 * (1 - r) : 0, transform: [{ scale: 0.6 + 1.8 * r }] };
  });
  const sheetStyle = useAnimatedStyle(() => ({ opacity: sheet.get(), transform: [{ translateY: (1 - sheet.get()) * 80 }] }));
  const contextStyle = useAnimatedStyle(() => ({ opacity: context.get() }));

  return useMemo(
    () => ({
      apply,
      settle,
      showSheet,
      setTargets,
      popups,
      targets,
      burst,
      burstCount,
      sparkle,
      sparkleCount,
      styles: { shakeStyle, flashStyle, chipStyle, multStyle, glowStyle, totalStyle, ringStyle, sheetStyle, contextStyle },
    }),
    [
      apply, settle, showSheet, setTargets, popups, targets, burst, burstCount, sparkle, sparkleCount, shakeStyle, flashStyle,
      chipStyle, multStyle, glowStyle, totalStyle, ringStyle, sheetStyle, contextStyle,
    ],
  );
}

/** The animated style of particle `index`, driven by a burst (the slam's, or the discovery's sparkles). */
export function useParticleStyle(index: number, burst: SharedValue<number>, burstCount: SharedValue<number>) {
  return useAnimatedStyle(() => {
    const p = particle(index, burstCount.get(), burst.get());
    return { opacity: p.opacity, transform: [{ translateX: p.x }, { translateY: p.y }, { scale: p.scale }] };
  });
}

/** The animated style of a pop-up: fades and pops in at the anchor, then flies to its target shrinking (or only fades). */
export function usePopupStyle(p: PopupValues, targets: SharedValue<FlightTargets>) {
  return useAnimatedStyle(() => {
    const out = p.out.get();
    const all = targets.get();
    const index = p.to.get();
    const target = index === 0 ? all.chips : index === 1 ? all.mult : index === 2 ? all.total : all.context;
    const move = p.fly.get() > 0 ? out : 0;
    return {
      opacity: p.opacity.get() * (1 - out),
      transform: [{ translateX: target.x * move }, { translateY: target.y * move }, { scale: (0.7 + 0.3 * p.pop.get()) * (1 - 0.6 * move) }],
    };
  });
}
