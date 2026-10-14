// The sound files of the reveal (scripts/generate-sfx.mjs writes them into
// assets/sfx/) and how many voices each one gets.
//
// A voice is a player of its own: a sound that is still ringing when it is
// triggered again needs a second one. Every sound plays at most a few times in
// a row and the files are short, so the pools are small; the whole set is about
// three dozen players, primed once (see engine.ts).

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
} as const;

export type SfxId = keyof typeof SFX_SOURCES;

export const SFX_IDS = Object.keys(SFX_SOURCES) as SfxId[];

/**
 * Voices per sound. Ticks come every 55-90 ms and a file lasts about that long,
 * and two in a row share a pitch: two voices. The multipliers play once per
 * reveal, 200 ms or more apart: one voice each.
 */
export const SFX_VOICES: Record<SfxId, number> = {
  tick_0: 2,
  tick_1: 2,
  tick_2: 2,
  tick_3: 2,
  tick_4: 2,
  transient: 3,
  mult_1: 1,
  mult_2: 1,
  mult_3: 1,
  mult_4: 1,
  mult_5: 1,
  mult_6: 1,
  mult_7: 1,
  mult_8: 1,
  riser: 1,
  total_chord: 2,
  whoosh_up: 2,
  bonus_tick_1: 1,
  bonus_tick_2: 1,
  bonus_tick_3: 1,
  bonus_tick_4: 1,
  bonus_tick_5: 1,
  bonus_land: 2,
  neutral_tock: 1,
  heat_loop: 1,
};
