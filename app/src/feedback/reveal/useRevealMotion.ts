// The motion of the reveal on Reanimated: every visual event writes shared
// values (in the same JS tick as its haptic), and the animated styles run on the
// UI thread. Nothing here starts a sound: the soundtrack owns all audio.
//
// Every animation uses ReduceMotion.System, so Reanimated also jumps to the end
// when the system setting is on; the timeline already leaves out shake, flash,
// particles and the flying chip then (timeline.ts).
import { useCallback, useMemo } from 'react';
import {
  cancelAnimation,
  Easing,
  interpolateColor,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { MAX_STAGES } from '../../lib/points';
import { bonusArc, particle, shakeOffset } from './motion';
import type { Event } from './timeline';

const REDUCE = ReduceMotion.System;
const timing = (toValue: number, duration: number, easing = Easing.out(Easing.quad)) =>
  withTiming(toValue, { duration, easing, reduceMotion: REDUCE });
const spring = (toValue: number, damping: number, stiffness: number) => withSpring(toValue, { damping, stiffness, reduceMotion: REDUCE });
/** Jump to a value, then animate on (Reanimated has no "set and go" in one call). */
const jump = (toValue: number) => withTiming(toValue, { duration: 0, reduceMotion: REDUCE });

/** The MULT badge ramps orange → red → magenta over the stages. */
export const MULT_COLORS = ['#FF9F0A', '#FF3B30', '#FF2D95'];
/** Where the flying +5 starts (below the number, at the question) and lands (its badge), relative to the number's centre. */
export const BONUS_FROM = { x: 0, y: 320 };
export const BONUS_TO = { x: 100, y: -62 };
export const MAX_PARTICLES = 20;

export function useRevealMotion() {
  const shakeT = useSharedValue(1);
  const shakePx = useSharedValue(0);
  const shakeDeg = useSharedValue(0);
  const flash = useSharedValue(0);
  const chips = useSharedValue(0);
  const multPop = useSharedValue(1);
  const multRamp = useSharedValue(0);
  const heat = useSharedValue(0);
  const totalScale = useSharedValue(1);
  const burst = useSharedValue(0);
  const burstCount = useSharedValue(0);
  const arc = useSharedValue(-1);
  const ring = useSharedValue(0);
  const badge = useSharedValue(0);
  const sheet = useSharedValue(0);

  // Shared values never change identity, so neither do these functions.
  /** Writes the shared values of one visual event. Returns false for events that are not about motion. */
  const apply = useCallback((event: Event): boolean => {
    switch (event.type) {
      case 'chipIn':
        chips.set(spring(1, 12, 260));
        return true;
      case 'mult':
        multPop.set(withSequence(timing(1.22, 70), spring(1, 10, 300)));
        multRamp.set(timing(event.stage / MAX_STAGES, 160));
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
        return true;
      case 'punch':
        totalScale.set(withSequence(timing(event.scale, 70), spring(1, 10, 260)));
        return true;
      case 'bonusChip':
        arc.set(withSequence(jump(0), timing(1, event.durationMs, Easing.inOut(Easing.quad))));
        return true;
      case 'ring':
        ring.set(withSequence(jump(0), timing(1, 450, Easing.out(Easing.cubic))));
        return true;
      case 'badge':
        badge.set(spring(1, 12, 260));
        return true;
      case 'showBonusQuestion':
        sheet.set(spring(1, 18, 160));
        return true;
      default:
        return false;
    }
  }, [arc, badge, burst, burstCount, chips, flash, heat, multPop, multRamp, ring, shakeDeg, shakePx, shakeT, sheet, totalScale]);

  /** A skip: stop everything and stand still on the end state. */
  const settle = useCallback(
    (stages: number) => {
      for (const value of [shakeT, flash, chips, multPop, multRamp, heat, totalScale, burst, arc, ring]) cancelAnimation(value);
      shakeT.set(1);
      flash.set(0);
      chips.set(1);
      multPop.set(1);
      multRamp.set(stages / MAX_STAGES);
      heat.set(0);
      totalScale.set(1);
      burst.set(0);
      arc.set(-1);
      ring.set(0);
    },
    [arc, burst, chips, flash, heat, multPop, multRamp, ring, shakeT, totalScale],
  );

  const showSheet = useCallback(() => {
    sheet.set(spring(1, 18, 160));
  }, [sheet]);

  const shakeStyle = useAnimatedStyle(() => {
    const { x, y, rotation } = shakeOffset(shakeT.get(), shakePx.get(), shakeDeg.get());
    return { transform: [{ translateX: x }, { translateY: y }, { rotateZ: `${rotation}deg` }] };
  });
  const flashStyle = useAnimatedStyle(() => ({ opacity: flash.get() }));
  const chipStyle = useAnimatedStyle(() => ({ opacity: chips.get(), transform: [{ scale: 0.6 + 0.4 * chips.get() }] }));
  const multStyle = useAnimatedStyle(() => ({
    opacity: chips.get(),
    backgroundColor: interpolateColor(multRamp.get(), [0, 0.5, 1], MULT_COLORS),
    transform: [{ scale: (0.6 + 0.4 * chips.get()) * multPop.get() }],
  }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: heat.get() * 0.8, transform: [{ scale: 1 + heat.get() * 0.35 }] }));
  const totalStyle = useAnimatedStyle(() => ({ transform: [{ scale: totalScale.get() }] }));
  const arcStyle = useAnimatedStyle(() => {
    const t = arc.get();
    const { x, y } = bonusArc(t, BONUS_FROM, BONUS_TO, 140);
    return { opacity: t >= 0 && t < 1 ? 1 : 0, transform: [{ translateX: x }, { translateY: y }, { scale: 0.8 + 0.4 * Math.sin(Math.max(0, t) * Math.PI) }] };
  });
  const ringStyle = useAnimatedStyle(() => {
    const r = ring.get();
    return { opacity: r > 0 && r < 1 ? 0.85 * (1 - r) : 0, transform: [{ scale: 0.6 + 1.8 * r }] };
  });
  const badgeStyle = useAnimatedStyle(() => ({ opacity: badge.get(), transform: [{ scale: 0.4 + 0.6 * badge.get() }] }));
  const sheetStyle = useAnimatedStyle(() => ({ opacity: sheet.get(), transform: [{ translateY: (1 - sheet.get()) * 80 }] }));

  return useMemo(
    () => ({
      apply,
      settle,
      showSheet,
      burst,
      burstCount,
      styles: { shakeStyle, flashStyle, chipStyle, multStyle, glowStyle, totalStyle, arcStyle, ringStyle, badgeStyle, sheetStyle },
    }),
    [apply, settle, showSheet, burst, burstCount, shakeStyle, flashStyle, chipStyle, multStyle, glowStyle, totalStyle, arcStyle, ringStyle, badgeStyle, sheetStyle],
  );
}

/** The animated style of particle `index`, driven by the burst of the slam. */
export function useParticleStyle(index: number, burst: SharedValue<number>, burstCount: SharedValue<number>) {
  return useAnimatedStyle(() => {
    const p = particle(index, burstCount.get(), burst.get());
    return { opacity: p.opacity, transform: [{ translateX: p.x }, { translateY: p.y }, { scale: p.scale }] };
  });
}
