#!/usr/bin/env node
// Generates the sound effects of the points reveal and the celebrations into
// assets/sfx/ (npm run sfx:generate).
// Everything is synthesised here, from sine partials and filtered noise: our own
// work, no samples. Pure Node, no dependencies.
//
// Every file is a 16-bit 44.1 kHz mono WAV that starts at zero (3 ms fade-in, the
// click 0.4 ms), ends on a short fade, uses exponential decay tails and is peak
// normalised to -6 dBFS. Loudness differences between sounds are set by the
// volumes in src/feedback/reveal/tuning.ts, not here. The pitches are the C major
// pentatonic scale (C D E G A).
//
//   tick_0..4          counting up: soft woodblock at C4 D4 E4 G4 A4
//   transient          a 5 ms click that sharpens every multiplier hit
//   mult_1..8          one bell per streak multiplier, C5 up the pentatonic scale
//   riser              150 ms upward noise sweep: anticipation before the multipliers
//   total_chord        the total: C major chord with a 60 Hz thump
//   whoosh_up          the +5 chip flying to the total
//   bonus_tick_1..5    counting the +5: C6 D6 E6 G6 A6
//   bonus_land         the +5 has landed: bell at C7 and C6
//   neutral_tock       the bonus question was skipped: soft, unpitched
//   heat_loop          1 s seamless low crackle that fades in from stage 5
//   discover_fanfare   a new bin: bells up the C major arpeggio, C5 to C6, with sparkle
//   chip_add           the +5 discovery chips (and a step the app does not know): bright plink at G6
//   flame_whoosh       the streak flame grows: a warm noise sweep over a low E3
//   milestone_fanfare  a milestone: arpeggio C5 E5 G5, then the full C major chord over C4
//   approve_chime      approved (and a badge): two bells up a fourth, G5 then C6, with a shimmer
//   levelup_fanfare    a level-up: a quick pentatonic run C5 to C6, then the C major chord an octave up
//
// Deterministic: the same script writes the same samples (seeded noise).
// generate-sfx.test.mjs checks the committed files against it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAMPLE_RATE = 44100;
export const PEAK_DBFS = -6;
export const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sfx');

const TWO_PI = 2 * Math.PI;

/** Frequency of the note `semitones` above C5 (C5 is three semitones above A4 = 440 Hz). */
export function note(semitones) {
  return 440 * 2 ** ((3 + semitones) / 12);
}

/** Small seeded generator (mulberry32): the noise is the same on every run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buffer(seconds) {
  return new Float64Array(Math.round(seconds * SAMPLE_RATE));
}

/**
 * Adds a decaying tone starting at `at` seconds. `partials` are [ratio, amplitude,
 * decayScale]; every partial decays exponentially with `decay * decayScale`.
 * `drop` bends the pitch down from (1 + drop) * freq over `dropTime`.
 */
function addTone(buf, { at = 0, freq, partials = [[1, 1, 1]], decay, gain = 1, fadeIn = 0.003, drop = 0, dropTime = 0.01 }) {
  const start = Math.round(at * SAMPLE_RATE);
  const phases = partials.map(() => 0);
  const slowest = Math.max(...partials.map((p) => p[2] ?? 1));
  for (let i = start; i < buf.length; i++) {
    const t = (i - start) / SAMPLE_RATE;
    if (t > fadeIn && Math.exp(-t / (decay * slowest)) < 1e-4) break;
    const f = freq * (1 + drop * Math.exp(-t / dropTime));
    let value = 0;
    for (let p = 0; p < partials.length; p++) {
      const [ratio, amplitude, decayScale = 1] = partials[p];
      value += amplitude * Math.exp(-t / (decay * decayScale)) * Math.sin(phases[p]);
      phases[p] += (TWO_PI * f * ratio) / SAMPLE_RATE;
    }
    buf[i] += gain * Math.min(1, t / fadeIn) * value;
  }
}

/** Adds a burst of noise, run through a one-pole lowpass (and an optional highpass). */
function addNoise(buf, { at = 0, length, gain = 1, decay, fadeIn = 0.003, rng, lowpass = 1, highpass = 0 }) {
  const start = Math.round(at * SAMPLE_RATE);
  const end = Math.min(buf.length, start + Math.round(length * SAMPLE_RATE));
  let low = 0;
  let slow = 0;
  for (let i = start; i < end; i++) {
    const t = (i - start) / SAMPLE_RATE;
    low += lowpass * ((rng() * 2 - 1) - low);
    slow += highpass * (low - slow);
    const value = highpass > 0 ? low - slow : low;
    buf[i] += gain * Math.min(1, t / fadeIn) * Math.exp(-t / decay) * value;
  }
}

/**
 * Band-passed noise whose centre frequency sweeps exponentially from `from` to
 * `to` Hz (a Chamberlin state-variable filter). `envelope` maps progress 0..1 to
 * the amplitude. The output is flattened for the rising bandwidth.
 */
function sweptNoise(seconds, { from, to, q, envelope, rng }) {
  const buf = buffer(seconds);
  let low = 0;
  let band = 0;
  for (let i = 0; i < buf.length; i++) {
    const t = i / SAMPLE_RATE;
    const progress = i / buf.length;
    const centre = from * (to / from) ** progress;
    const f = 2 * Math.sin((Math.PI * centre) / SAMPLE_RATE);
    low += f * band;
    const high = rng() * 2 - 1 - low - q * band;
    band += f * high;
    buf[i] = (band / Math.sqrt(centre / from)) * envelope(progress) * Math.min(1, t / 0.003);
  }
  return buf;
}

/** A raised-cosine fade over the last `seconds`, so every file ends at zero. */
function fadeOut(buf, seconds) {
  const n = Math.min(buf.length, Math.round(seconds * SAMPLE_RATE));
  for (let k = 0; k < n; k++) buf[buf.length - 1 - k] *= 0.5 * (1 - Math.cos((Math.PI * k) / n));
}

const BELL = [[1, 1, 1], [2, 0.4, 0.6], [3.01, 0.18, 0.4], [4.2, 0.1, 0.25]];

const TICK_SEMITONES = [-12, -10, -8, -5, -3]; // C4 D4 E4 G4 A4
const MULT_SEMITONES = [0, 2, 4, 7, 9, 12, 14, 16]; // C5 D5 E5 G5 A5 C6 D6 E6
const BONUS_TICK_SEMITONES = [12, 14, 16, 19, 21]; // C6 D6 E6 G6 A6

function tick(k) {
  const buf = buffer(0.055);
  // Woodblock: the fundamental plus two inharmonic partials, over a tiny click.
  addTone(buf, {
    freq: note(TICK_SEMITONES[k]),
    partials: [[1, 1, 1], [2.76, 0.45, 0.5], [5.4, 0.15, 0.3]],
    decay: 0.013,
    gain: 0.8,
    drop: 0.05,
    dropTime: 0.008,
  });
  addNoise(buf, { length: 0.0015, gain: 0.12, decay: 0.0006, rng: mulberry32(100 + k), lowpass: 0.5 });
  fadeOut(buf, 0.006);
  return buf;
}

function transient() {
  const buf = buffer(0.005);
  addNoise(buf, { length: 0.005, decay: 0.0012, fadeIn: 0.0004, rng: mulberry32(7), lowpass: 0.9, highpass: 0.1 });
  fadeOut(buf, 0.001);
  return buf;
}

function mult(n) {
  const freq = note(MULT_SEMITONES[n - 1]);
  const buf = buffer(0.34);
  addTone(buf, { freq, partials: BELL, decay: 0.11, gain: 0.8 });
  // Short shimmer: two detuned partials two octaves up.
  for (const detune of [1.004, 0.996]) {
    addTone(buf, { freq: freq * 4 * detune, decay: 0.1, gain: 0.07, fadeIn: 0.01 });
  }
  // The two highest hits get a quiet octave-down body.
  if (n >= 7) addTone(buf, { freq: freq / 2, partials: [[1, 1, 1], [2, 0.2, 0.5]], decay: 0.12, gain: 0.3 });
  fadeOut(buf, 0.01);
  return buf;
}

function riser() {
  const buf = sweptNoise(0.15, {
    from: 500,
    to: 6000,
    q: 0.35,
    envelope: (p) => 0.3 + 0.7 * p * p,
    rng: mulberry32(11),
  });
  fadeOut(buf, 0.003);
  return buf;
}

function totalChord() {
  const buf = buffer(1.15);
  // C5 E5 G5 and a soft C6, each as a slightly detuned pair for width.
  [[0, 1], [4, 0.8], [7, 0.8], [12, 0.5]].forEach(([semitones, gain]) => {
    for (const detune of [1.0015, 0.9985]) {
      addTone(buf, { freq: note(semitones) * detune, partials: [[1, 1, 1], [2, 0.3, 0.6], [3, 0.12, 0.4]], decay: 0.4, gain: gain * 0.5 });
    }
  });
  addTone(buf, { freq: 60, decay: 0.14, gain: 1, drop: 0.5, dropTime: 0.03 });
  fadeOut(buf, 0.03);
  return buf;
}

function whooshUp() {
  const buf = sweptNoise(0.3, {
    from: 300,
    to: 5000,
    q: 0.6,
    // Rises to 75 % of the sound, then falls away.
    envelope: (p) => (p < 0.75 ? 0.2 + 0.8 * (p / 0.75) ** 1.5 : (1 - (p - 0.75) / 0.25) ** 1.5),
    rng: mulberry32(13),
  });
  fadeOut(buf, 0.003);
  return buf;
}

function bonusTick(j) {
  const buf = buffer(0.1);
  addTone(buf, { freq: note(BONUS_TICK_SEMITONES[j - 1]), partials: [[1, 1, 1], [2, 0.35, 0.5], [3, 0.1, 0.3]], decay: 0.03, gain: 0.8 });
  fadeOut(buf, 0.01);
  return buf;
}

function bonusLand() {
  const buf = buffer(0.7);
  addTone(buf, { freq: note(24), partials: [[1, 1, 1], [2.76, 0.2, 0.4]], decay: 0.2, gain: 0.7 });
  addTone(buf, { freq: note(12), partials: [[1, 1, 1], [2, 0.3, 0.6], [3, 0.12, 0.4]], decay: 0.22, gain: 0.9 });
  fadeOut(buf, 0.02);
  return buf;
}

function neutralTock() {
  const buf = buffer(0.07);
  // A dull thud: a bent low sine over lowpassed noise. No clear pitch.
  addTone(buf, { freq: 180, decay: 0.02, gain: 0.8, drop: 0.45, dropTime: 0.012 });
  addNoise(buf, { length: 0.03, gain: 0.3, decay: 0.008, rng: mulberry32(17), lowpass: 0.2 });
  fadeOut(buf, 0.006);
  return buf;
}

function discoverFanfare() {
  const buf = buffer(1.0);
  // Four bells, 70 ms apart, each a little louder; a high sparkle on the last.
  [0, 4, 7, 12].forEach((semitones, k) => {
    addTone(buf, { at: k * 0.07, freq: note(semitones), partials: BELL, decay: 0.16, gain: 0.55 + 0.1 * k });
  });
  for (const detune of [1.003, 0.997]) {
    addTone(buf, { at: 0.21, freq: note(36) * detune, decay: 0.12, gain: 0.08, fadeIn: 0.01 });
  }
  fadeOut(buf, 0.03);
  return buf;
}

function chipAdd() {
  const buf = buffer(0.14);
  addTone(buf, { freq: note(19), partials: [[1, 1, 1], [2, 0.3, 0.5], [3.01, 0.12, 0.3]], decay: 0.035, gain: 0.8, drop: 0.03 });
  addNoise(buf, { length: 0.002, gain: 0.15, decay: 0.0008, rng: mulberry32(19), lowpass: 0.7 });
  fadeOut(buf, 0.01);
  return buf;
}

function flameWhoosh() {
  const buf = sweptNoise(0.45, {
    from: 200,
    to: 2500,
    q: 0.7,
    // Swells to 60 % of the sound, then dies down.
    envelope: (p) => (p < 0.6 ? 0.35 + 0.65 * (p / 0.6) : (1 - (p - 0.6) / 0.4) ** 2),
    rng: mulberry32(23),
  });
  addTone(buf, { at: 0.02, freq: note(-8) / 2, partials: [[1, 1, 1], [2, 0.25, 0.5]], decay: 0.12, gain: 0.25, fadeIn: 0.04 });
  fadeOut(buf, 0.02);
  return buf;
}

function milestoneFanfare() {
  const buf = buffer(1.7);
  // The arpeggio up, then the whole chord with a low C and a thump.
  [0, 4, 7].forEach((semitones, k) => {
    addTone(buf, { at: k * 0.11, freq: note(semitones), partials: BELL, decay: 0.12, gain: 0.6 });
  });
  const chordAt = 0.36;
  [[0, 0.8], [4, 0.7], [7, 0.7], [12, 0.6], [-12, 0.5]].forEach(([semitones, gain]) => {
    for (const detune of [1.002, 0.998]) {
      addTone(buf, {
        at: chordAt,
        freq: note(semitones) * detune,
        partials: [[1, 1, 1], [2, 0.3, 0.6], [3, 0.12, 0.4]],
        decay: 0.42,
        gain: gain * 0.45,
      });
    }
  });
  addTone(buf, { at: chordAt, freq: 60, decay: 0.12, gain: 0.8, drop: 0.5, dropTime: 0.03 });
  for (const detune of [1.004, 0.996]) {
    addTone(buf, { at: chordAt + 0.05, freq: note(24) * detune, decay: 0.25, gain: 0.08, fadeIn: 0.02 });
  }
  fadeOut(buf, 0.04);
  return buf;
}

function approveChime() {
  const buf = buffer(0.8);
  // Two bells up a fourth, the second louder; a soft shimmer at G7 on it.
  addTone(buf, { freq: note(7), partials: BELL, decay: 0.14, gain: 0.7 });
  addTone(buf, { at: 0.09, freq: note(12), partials: BELL, decay: 0.2, gain: 0.85 });
  for (const detune of [1.003, 0.997]) {
    addTone(buf, { at: 0.1, freq: note(31) * detune, decay: 0.1, gain: 0.06, fadeIn: 0.01 });
  }
  fadeOut(buf, 0.03);
  return buf;
}

// The chord of the level-up lands here (src/game/approval.ts, LEVEL_CHORD_MS).
const LEVEL_CHORD_AT = 0.4;

function levelupFanfare() {
  const buf = buffer(1.8);
  // A quick run up the pentatonic scale, then a bright chord with a low C and a thump.
  [0, 2, 4, 7, 9, 12].forEach((semitones, k) => {
    addTone(buf, { at: k * 0.06, freq: note(semitones), partials: BELL, decay: 0.08, gain: 0.45 + 0.05 * k });
  });
  [[12, 0.8], [16, 0.7], [19, 0.7], [24, 0.5], [0, 0.6]].forEach(([semitones, gain]) => {
    for (const detune of [1.002, 0.998]) {
      addTone(buf, {
        at: LEVEL_CHORD_AT,
        freq: note(semitones) * detune,
        partials: [[1, 1, 1], [2, 0.3, 0.6], [3, 0.12, 0.4]],
        decay: 0.45,
        gain: gain * 0.4,
      });
    }
  });
  addTone(buf, { at: LEVEL_CHORD_AT, freq: 60, decay: 0.12, gain: 0.8, drop: 0.5, dropTime: 0.03 });
  fadeOut(buf, 0.04);
  return buf;
}

function heatLoop() {
  const n = SAMPLE_RATE;
  const rng = mulberry32(2026);
  const noise = Float64Array.from({ length: n }, () => rng() * 2 - 1);
  // Rumble: a one-pole lowpass run over two laps, keeping the second. That is the
  // steady state of a circular signal, so the end runs on into the start.
  const rumble = new Float64Array(n);
  let state = 0;
  for (let lap = 0; lap < 2; lap++) {
    for (let i = 0; i < n; i++) {
      state += 0.05 * (noise[i] - state);
      if (lap === 1) rumble[i] = state;
    }
  }
  // Crackle: sparse pops with a 3 ms tail, wrapping around the end of the loop.
  const crackle = new Float64Array(n);
  const tail = Math.round(0.003 * SAMPLE_RATE);
  for (let c = 0; c < 16; c++) {
    const position = Math.floor(rng() * n);
    const amplitude = (0.4 + 0.6 * rng()) * (rng() < 0.5 ? -1 : 1);
    for (let k = 0; k < tail * 5; k++) crackle[(position + k) % n] += amplitude * Math.exp(-k / tail);
  }
  const mixed = Float64Array.from({ length: n }, (_, i) => rumble[i] * 2.7 + crackle[i] * 0.6);
  const mean = mixed.reduce((sum, v) => sum + v, 0) / n;
  for (let i = 0; i < n; i++) mixed[i] -= mean;
  // Start the loop on a quiet zero crossing, so the first sample is near zero.
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < n; i++) {
    const score = Math.abs(mixed[i]) + Math.abs(mixed[i] - mixed[(i + n - 1) % n]);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return Float64Array.from({ length: n }, (_, i) => mixed[(best + i) % n]);
}

/** Every sound by file name, as floating point samples. */
export function renderAll() {
  const sounds = {};
  for (let k = 0; k < TICK_SEMITONES.length; k++) sounds[`tick_${k}`] = tick(k);
  sounds.transient = transient();
  for (let n = 1; n <= MULT_SEMITONES.length; n++) sounds[`mult_${n}`] = mult(n);
  sounds.riser = riser();
  sounds.total_chord = totalChord();
  sounds.whoosh_up = whooshUp();
  for (let j = 1; j <= BONUS_TICK_SEMITONES.length; j++) sounds[`bonus_tick_${j}`] = bonusTick(j);
  sounds.bonus_land = bonusLand();
  sounds.neutral_tock = neutralTock();
  sounds.heat_loop = heatLoop();
  sounds.discover_fanfare = discoverFanfare();
  sounds.chip_add = chipAdd();
  sounds.flame_whoosh = flameWhoosh();
  sounds.milestone_fanfare = milestoneFanfare();
  sounds.approve_chime = approveChime();
  sounds.levelup_fanfare = levelupFanfare();
  return sounds;
}

/** 16-bit mono PCM WAV with the peak at PEAK_DBFS (a whole sample below it, never above). */
export function wav(samples) {
  const peak = samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0) || 1;
  const target = Math.floor(10 ** (PEAK_DBFS / 20) * 32768);
  const scale = target / peak;
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(v * scale), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Every sound file by name (with .wav). */
export function allSfx() {
  return Object.fromEntries(Object.entries(renderAll()).map(([name, samples]) => [`${name}.wav`, wav(samples)]));
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, bytes] of Object.entries(allSfx())) {
    writeFileSync(join(OUT_DIR, name), bytes);
    console.log(`${name}: ${bytes.length} bytes`);
  }
}
