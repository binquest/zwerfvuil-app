// The sound files of the reveal and the celebrations (scripts/generate-sfx.mjs
// writes them into assets/sfx/). Most of them are only mixed into the soundtrack of a reveal
// (soundtrack.ts); the few played on their own get voices (engine.ts).

export const SFX_SOURCES = {
  tick_0: require('../../../assets/sfx/tick_0.wav'),
  tick_1: require('../../../assets/sfx/tick_1.wav'),
  tick_2: require('../../../assets/sfx/tick_2.wav'),
  tick_3: require('../../../assets/sfx/tick_3.wav'),
  tick_4: require('../../../assets/sfx/tick_4.wav'),
  transient: require('../../../assets/sfx/transient.wav'),
  mult_1: require('../../../assets/sfx/mult_1.wav'),
  mult_2: require('../../../assets/sfx/mult_2.wav'),
  mult_3: require('../../../assets/sfx/mult_3.wav'),
  mult_4: require('../../../assets/sfx/mult_4.wav'),
  mult_5: require('../../../assets/sfx/mult_5.wav'),
  mult_6: require('../../../assets/sfx/mult_6.wav'),
  mult_7: require('../../../assets/sfx/mult_7.wav'),
  mult_8: require('../../../assets/sfx/mult_8.wav'),
  riser: require('../../../assets/sfx/riser.wav'),
  total_chord: require('../../../assets/sfx/total_chord.wav'),
  whoosh_up: require('../../../assets/sfx/whoosh_up.wav'),
  bonus_tick_1: require('../../../assets/sfx/bonus_tick_1.wav'),
  bonus_tick_2: require('../../../assets/sfx/bonus_tick_2.wav'),
  bonus_tick_3: require('../../../assets/sfx/bonus_tick_3.wav'),
  bonus_tick_4: require('../../../assets/sfx/bonus_tick_4.wav'),
  bonus_tick_5: require('../../../assets/sfx/bonus_tick_5.wav'),
  bonus_land: require('../../../assets/sfx/bonus_land.wav'),
  neutral_tock: require('../../../assets/sfx/neutral_tock.wav'),
  heat_loop: require('../../../assets/sfx/heat_loop.wav'),
  discover_fanfare: require('../../../assets/sfx/discover_fanfare.wav'),
  chip_add: require('../../../assets/sfx/chip_add.wav'),
  flame_whoosh: require('../../../assets/sfx/flame_whoosh.wav'),
  milestone_fanfare: require('../../../assets/sfx/milestone_fanfare.wav'),
  approve_chime: require('../../../assets/sfx/approve_chime.wav'),
  levelup_fanfare: require('../../../assets/sfx/levelup_fanfare.wav'),
} as const;

export type SfxId = keyof typeof SFX_SOURCES;

export const SFX_IDS = Object.keys(SFX_SOURCES) as SfxId[];

/**
 * The sounds played on their own, outside a soundtrack, and their voices: the
 * chord when a reveal is skipped (twice in a row is possible) and the tock of
 * a skipped bonus question.
 */
export const ONE_SHOT_VOICES: Partial<Record<SfxId, number>> = {
  total_chord: 2,
  neutral_tock: 1,
};
