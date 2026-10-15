// Every number that shapes the points reveal, in one place. Change a value here
// and the timeline (timeline.ts), the tests and the screen follow; nothing else
// holds a timing, a size or a volume. All times are in milliseconds.
//
// Not here: the pitches of the sounds (scripts/generate-sfx.mjs) and the pool
// sizes of the sound engine (src/feedback/sfx/sources.ts).

/** Visuals run this long after their sound, so the eye does not beat the ear to it. */
export const AUDIO_LEAD_MS = 20;

/** Before the first tick: the POINTS chip pops in. */
export const LEAD_IN_MS = 250;

// Counting up to the base points.
export const BASE_TICKS = 10;
/** The gap between ticks eases from the first to the second value. */
export const TICK_INTERVAL_START_MS = 90;
export const TICK_INTERVAL_END_MS = 55;
/** Each tick's volume varies by up to this fraction, so the run does not sound mechanical. */
export const TICK_JITTER = 0.015;
/** There are five tick pitches (C D E G A); two ticks share a pitch. */
export const TICK_PITCHES = 5;

// The streak multipliers.
/**
 * The stage where the reveal is at its peak: the MULT colour ramp ends here,
 * there are this many mult_N sounds, and this stage shakes longest. Later
 * stages (a longer maximum in game_config) stay at the peak.
 */
export const TOP_STAGE = 8;
export const ANTICIPATION_MS = 150;
/** Stage n takes max(MIN, FIRST * DECAY^(n-1)) before stage n + 1 lands. */
export const STAGE_INTERVAL_FIRST_MS = 420;
export const STAGE_INTERVAL_DECAY = 0.85;
export const STAGE_INTERVAL_MIN_MS = 200;
export const REDUCED_MOTION_STAGE_INTERVAL_MS = 250;

/** Stage n: scale = base + step * n, and so on. */
export const STAGE_PEAK_SCALE = { base: 1.12, step: 0.04 };
export const STAGE_SHAKE_PX = { base: 1.5, step: 1 };
export const STAGE_SHAKE_MS = { base: 150, step: 10 };
/** The last stage shakes a little longer than the pattern says. */
export const LAST_STAGE_SHAKE_MS = 240;
export const STAGE_ROTATION_DEG = { base: 0.5, step: 0.25 };
export const STAGE_FLASH = { base: 0.08, step: 0.03 };

/** Haptic strength per stage: light up to LIGHT_UP_TO, medium up to MEDIUM_UP_TO, heavy up to HEAVY_UP_TO, then heavy + rigid. */
export const HAPTIC_LIGHT_UP_TO = 2;
export const HAPTIC_MEDIUM_UP_TO = 4;
export const HAPTIC_HEAVY_UP_TO = 6;
export const HAPTIC_RIGID_DELAY_MS = 45;

/** The heat layer (glow and low crackle) builds from the stage after this one: (n - FROM) / 4. */
export const HEAT_FROM_STAGE = 4;
export const HEAT_LOOP_VOLUME = 0.15;

// The total.
export const HIT_STOP_MS = 90;
export const SLAM_SCALE_FROM = 0.6;
export const SLAM_SCALE_PEAK = 1.5;
export const SLAM_SPRING = { damping: 9, stiffness: 220 };
export const SLAM_COUNT_MS = 300;
export const SLAM_FLASH = 0.3;
export const SLAM_PARTICLES_MIN = 12;
export const SLAM_PARTICLES_MAX = 20;
export const SLAM_SUCCESS_DELAY_MS = 60;
/** After the slam, before the bonus question comes in. */
export const SETTLE_MS = 400;

// The discovery (a new bin): after the base the banner falls in with its
// fanfare, then the chips get their +5, then the streak.
export const DISCOVERY_LEAD_MS = 120;
export const DISCOVERY_ADD_MS = 260;
export const DISCOVERY_HOLD_MS = 420;
export const DISCOVERY_SPARKLES = 10;
export const CHIP_POP_SCALE = 1.25;

// A step the app does not know yet: its label and running total, with the
// chip sound (a new kind of bonus needs no app update).
export const STEP_LEAD_MS = 120;
export const STEP_HOLD_MS = 380;

// The streak flame (the first check-in of the week), after the slam and
// before the bonus question.
export const FLAME_DELAY_MS = 450;
export const FLAME_HOLD_MS = 650;

// The +5 of the bonus question.
export const BONUS_CHIP_ARC_MS = 320;
export const BONUS_HIT_STOP_MS = 80;
export const BONUS_PUNCH_SCALE = 1.35;
export const BONUS_SHAKE_PX = 6;
export const BONUS_SHAKE_MS = 200;
export const BONUS_FLASH = 0.25;
export const BONUS_TICK_MS = 60;
export const BONUS_TICKS = 5;

/** Reduce Motion: nothing moves more than this. */
export const REDUCED_MOTION_MAX_SCALE = 1.05;

/**
 * Volume per sound, 0..1. Every file is normalised to the same peak, so this is
 * the mix. Dull on the phone's speaker? Raise `transient` and `mult`.
 */
export const VOLUME = {
  tick: 0.55,
  transient: 0.45,
  mult: 0.85,
  riser: 0.6,
  total: 0.95,
  whoosh: 0.7,
  bonusTick: 0.7,
  bonusLand: 0.9,
  tock: 0.6,
  fanfare: 0.8,
  chipAdd: 0.75,
  flame: 0.7,
  milestone: 0.9,
};
