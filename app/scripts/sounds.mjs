#!/usr/bin/env node
// Generates the sounds of the points reveal into assets/sounds/ (npm run sounds).
// All synthesized here from sine and square waves: our own work, no samples.
//
//   tick.wav          counting up, one per point step
//   stage-1..8.wav    one per streak multiplier, each a whole tone higher
//   total.wav         the final total (major arpeggio)
//   bonus.wav         the +5 of the bonus question
//
// Deterministic: the same script always writes the same bytes, and
// sounds.test.mjs checks that the committed files match.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAMPLE_RATE = 22050;
export const STAGES = 8;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sounds');

/** Frequency of streak stage k (1-based): G4, then a whole tone higher per stage. */
export function stageFrequency(k) {
  return 392 * 2 ** ((2 * (k - 1)) / 12);
}

function samples(seconds) {
  return new Float64Array(Math.round(seconds * SAMPLE_RATE));
}

/** Adds a decaying tone with harmonics, starting at `at` seconds. */
function addTone(buffer, { at = 0, freq, partials = [[1, 1]], attack = 0.003, decay, gain = 1, sweep = 0 }) {
  const start = Math.round(at * SAMPLE_RATE);
  let phase = 0;
  for (let i = start; i < buffer.length; i++) {
    const t = (i - start) / SAMPLE_RATE;
    // A short upward sweep at the start gives a punchy attack.
    const f = freq * (1 + sweep * Math.exp(-t / 0.012));
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    const envelope = Math.min(1, t / attack) * Math.exp(-t / decay);
    if (envelope < 1e-4 && t > attack) break;
    let value = 0;
    for (const [multiple, amplitude] of partials) value += amplitude * Math.sin(phase * multiple);
    buffer[i] += gain * envelope * value;
  }
}

/** A tiny click of filtered noise (seeded, so the output is deterministic). */
function addClick(buffer, { at = 0, gain = 0.3, length = 0.006 }) {
  let seed = 12345;
  let previous = 0;
  const start = Math.round(at * SAMPLE_RATE);
  const end = Math.min(buffer.length, start + Math.round(length * SAMPLE_RATE));
  for (let i = start; i < end; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const noise = seed / 2 ** 30 - 1;
    previous = previous * 0.6 + noise * 0.4;
    buffer[i] += gain * previous * (1 - (i - start) / (end - start));
  }
}

const SQUARE = [[1, 1], [3, 1 / 3], [5, 1 / 5], [7, 1 / 7]];
const BELL = [[1, 1], [2, 0.35], [3, 0.12], [4.2, 0.05]];

export function tick() {
  const buffer = samples(0.06);
  addTone(buffer, { freq: 1760, partials: [[1, 1], [2, 0.2]], attack: 0.001, decay: 0.012, gain: 0.5 });
  addClick(buffer, { gain: 0.15, length: 0.003 });
  return buffer;
}

export function stage(k) {
  const buffer = samples(0.32);
  const freq = stageFrequency(k);
  addTone(buffer, { freq, partials: SQUARE, decay: 0.09, gain: 0.45, sweep: 0.35 });
  addTone(buffer, { freq: freq * 2, partials: BELL, decay: 0.06, gain: 0.2 });
  addClick(buffer, { gain: 0.25 });
  return buffer;
}

export function total() {
  const buffer = samples(0.9);
  // C5 E5 G5 C6, 60 ms apart.
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
    addTone(buffer, { at: i * 0.06, freq, partials: BELL, decay: 0.22, gain: 0.32 });
  });
  addTone(buffer, { freq: 130.81, partials: SQUARE, decay: 0.12, gain: 0.25, sweep: 0.2 });
  return buffer;
}

export function bonus() {
  const buffer = samples(0.3);
  addTone(buffer, { freq: 783.99, partials: BELL, decay: 0.06, gain: 0.4 });
  addTone(buffer, { at: 0.07, freq: 1046.5, partials: BELL, decay: 0.12, gain: 0.45 });
  return buffer;
}

/** 16-bit mono PCM WAV, normalised to a peak of 0.9. */
export function wav(buffer) {
  const peak = buffer.reduce((max, v) => Math.max(max, Math.abs(v)), 0) || 1;
  const scale = (0.9 / peak) * 32767;
  const data = Buffer.alloc(buffer.length * 2);
  buffer.forEach((v, i) => data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * scale))), i * 2));
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

/** Every sound file by name. */
export function allSounds() {
  const files = { 'tick.wav': wav(tick()), 'total.wav': wav(total()), 'bonus.wav': wav(bonus()) };
  for (let k = 1; k <= STAGES; k++) files[`stage-${k}.wav`] = wav(stage(k));
  return files;
}

export { OUT_DIR };

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, bytes] of Object.entries(allSounds())) {
    writeFileSync(join(OUT_DIR, name), bytes);
    console.log(`${name}: ${bytes.length} bytes`);
  }
}
