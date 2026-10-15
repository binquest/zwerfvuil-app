// Tests for scripts/generate-sfx.mjs: valid WAV files, no leading silence, a peak
// of -6 dBFS, the pentatonic pitches, a seamless loop, and the committed files in
// assets/sfx/ match the generator.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { allSfx, note, OUT_DIR, PEAK_DBFS, SAMPLE_RATE } from './generate-sfx.mjs';

const files = allSfx();

const EXPECTED = [
  ...[0, 1, 2, 3, 4].map((k) => `tick_${k}`),
  'transient',
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `mult_${n}`),
  'riser',
  'total_chord',
  'whoosh_up',
  ...[1, 2, 3, 4, 5].map((j) => `bonus_tick_${j}`),
  'bonus_land',
  'neutral_tock',
  'heat_loop',
].map((name) => `${name}.wav`);

function parse(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.toString('ascii', 12, 16), 'fmt ');
  assert.equal(bytes.toString('ascii', 36, 40), 'data');
  const samples = new Int16Array((bytes.length - 44) / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(44 + i * 2);
  return {
    format: bytes.readUInt16LE(20),
    channels: bytes.readUInt16LE(22),
    sampleRate: bytes.readUInt32LE(24),
    byteRate: bytes.readUInt32LE(28),
    blockAlign: bytes.readUInt16LE(32),
    bits: bytes.readUInt16LE(34),
    dataBytes: bytes.readUInt32LE(40),
    riffBytes: bytes.readUInt32LE(4),
    samples,
  };
}

const peakOf = (samples) => samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
const ms = (samples) => (samples.length / SAMPLE_RATE) * 1000;

/** Signal power at `freq` (Goertzel), to tell which pitch a sound has. */
function power(samples, freq) {
  const w = (2 * Math.PI * freq) / SAMPLE_RATE;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (const v of samples) {
    const s0 = v + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

test('there is a file for every sound of the reveal, and nothing else', () => {
  assert.deepEqual(Object.keys(files).sort(), [...EXPECTED].sort());
});

test('every file is a valid 16-bit 44.1 kHz mono PCM WAV', () => {
  for (const [name, bytes] of Object.entries(files)) {
    const wav = parse(bytes);
    assert.equal(wav.format, 1, `${name}: PCM`);
    assert.equal(wav.channels, 1, `${name}: mono`);
    assert.equal(wav.sampleRate, 44100, name);
    assert.equal(wav.bits, 16, name);
    assert.equal(wav.byteRate, 88200, name);
    assert.equal(wav.blockAlign, 2, name);
    assert.equal(wav.dataBytes, bytes.length - 44, `${name}: data size`);
    assert.equal(wav.riffBytes, bytes.length - 8, `${name}: RIFF size`);
  }
});

test('the peak is -6 dBFS, never above', () => {
  for (const [name, bytes] of Object.entries(files)) {
    const dbfs = 20 * Math.log10(peakOf(parse(bytes).samples) / 32768);
    assert.ok(dbfs <= PEAK_DBFS, `${name}: ${dbfs.toFixed(3)} dBFS`);
    assert.ok(dbfs > PEAK_DBFS - 0.01, `${name}: ${dbfs.toFixed(3)} dBFS is too quiet`);
  }
});

test('no leading silence: the first sample is zero and the sound is there within 10 ms', () => {
  for (const [name, bytes] of Object.entries(files)) {
    const { samples } = parse(bytes);
    const peak = peakOf(samples);
    assert.ok(Math.abs(samples[0]) <= peak * 0.002, `${name}: first sample ${samples[0]}`);
    const early = peakOf(samples.subarray(0, Math.round(0.01 * SAMPLE_RATE)));
    assert.ok(early >= peak * 0.1, `${name}: only ${((early / peak) * 100).toFixed(1)} % of the peak in the first 10 ms`);
  }
});

test('every sound but the loop ends at zero, so nothing clicks at the end', () => {
  for (const [name, bytes] of Object.entries(files)) {
    if (name === 'heat_loop.wav') continue;
    const { samples } = parse(bytes);
    assert.ok(Math.abs(samples.at(-1)) <= peakOf(samples) * 0.002, `${name}: last sample ${samples.at(-1)}`);
  }
});

test('the lengths fit the role of each sound', () => {
  const length = (name) => ms(parse(files[`${name}.wav`]).samples);
  for (let k = 0; k < 5; k++) assert.ok(length(`tick_${k}`) >= 40 && length(`tick_${k}`) <= 70, `tick_${k}`);
  assert.ok(length('transient') <= 6);
  for (let n = 1; n <= 8; n++) assert.ok(length(`mult_${n}`) <= 350, `mult_${n}`);
  assert.ok(Math.abs(length('riser') - 150) < 1);
  assert.ok(length('total_chord') <= 1200);
  assert.ok(Math.abs(length('whoosh_up') - 300) < 1);
  assert.equal(parse(files['heat_loop.wav']).samples.length, SAMPLE_RATE, 'the loop is exactly one second');
});

test('the ticks and multipliers sit on the C major pentatonic scale, each higher than the last', () => {
  const peaksAt = (name, semitones) => {
    const { samples } = parse(files[`${name}.wav`]);
    const freq = note(semitones);
    return { here: power(samples, freq), below: power(samples, freq * 2 ** (-1 / 12)), above: power(samples, freq * 2 ** (1 / 12)) };
  };
  const cases = [
    ...[-12, -10, -8, -5, -3].map((s, k) => [`tick_${k}`, s]),
    ...[0, 2, 4, 7, 9, 12, 14, 16].map((s, n) => [`mult_${n + 1}`, s]),
    ...[12, 14, 16, 19, 21].map((s, j) => [`bonus_tick_${j + 1}`, s]),
  ];
  for (const [name, semitones] of cases) {
    const { here, below, above } = peaksAt(name, semitones);
    assert.ok(here > below && here > above, `${name} is not centred on ${note(semitones).toFixed(1)} Hz`);
  }
  // C D E G A: the major second, major third, perfect fifth and major sixth of the root.
  assert.deepEqual([0, 2, 4, 7, 9].map((s) => s % 12), [0, 2, 4, 7, 9]);
});

test('the loop runs on seamlessly: the end continues into the start', () => {
  const { samples } = parse(files['heat_loop.wav']);
  let total = 0;
  for (let i = 1; i < samples.length; i++) total += Math.abs(samples[i] - samples[i - 1]);
  const typical = total / (samples.length - 1);
  const seam = Math.abs(samples[0] - samples.at(-1));
  assert.ok(seam <= typical * 4, `seam step ${seam} against a typical step of ${typical.toFixed(1)}`);
});

test('the generator is deterministic', () => {
  const again = allSfx();
  for (const [name, bytes] of Object.entries(files)) assert.ok(bytes.equals(again[name]), `${name} differs between runs`);
});

test('the committed files match the generator (run npm run sfx:generate)', () => {
  for (const [name, bytes] of Object.entries(files)) {
    const committed = parse(readFileSync(join(OUT_DIR, name))).samples;
    const generated = parse(bytes).samples;
    assert.equal(committed.length, generated.length, `${name} is stale`);
    // Sine and exponential are not guaranteed bit-identical on every platform:
    // one LSB of difference is fine, a different sound is not.
    let off = 0;
    for (let i = 0; i < generated.length; i++) if (Math.abs(committed[i] - generated[i]) > 2) off++;
    assert.ok(off <= generated.length * 0.001, `${name} is stale (${off} samples differ)`);
  }
});
