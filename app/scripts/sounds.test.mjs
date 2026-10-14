// Tests for scripts/sounds.mjs: valid WAV files, rising stage pitches, and the
// committed files in assets/sounds/ match the generator.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { allSounds, OUT_DIR, SAMPLE_RATE, STAGES, stageFrequency } from './sounds.mjs';

test('every sound is a 16-bit mono PCM WAV at the sample rate, without clipping', () => {
  for (const [name, bytes] of Object.entries(allSounds())) {
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', name);
    assert.equal(bytes.toString('ascii', 8, 12), 'WAVE', name);
    assert.equal(bytes.readUInt16LE(20), 1, `${name}: PCM`);
    assert.equal(bytes.readUInt16LE(22), 1, `${name}: mono`);
    assert.equal(bytes.readUInt32LE(24), SAMPLE_RATE, name);
    assert.equal(bytes.readUInt16LE(34), 16, name);
    assert.equal(bytes.readUInt32LE(40), bytes.length - 44, `${name}: data size`);
    let peak = 0;
    for (let i = 44; i < bytes.length; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
    assert.ok(peak > 20000 && peak < 32767, `${name}: peak ${peak}`);
    assert.ok(bytes.length < 50_000, `${name}: ${bytes.length} bytes`);
  }
});

test('there is one stage sound per multiplier stage, each higher than the last', () => {
  const names = Object.keys(allSounds()).filter((n) => n.startsWith('stage-'));
  assert.equal(names.length, STAGES);
  for (let k = 2; k <= STAGES; k++) assert.ok(stageFrequency(k) > stageFrequency(k - 1));
  assert.ok(Math.abs(stageFrequency(7) / stageFrequency(1) - 2) < 1e-9, 'six whole tones make an octave');
});

test('the committed sound files match the generator (run npm run sounds)', () => {
  for (const [name, bytes] of Object.entries(allSounds())) {
    assert.ok(readFileSync(join(OUT_DIR, name)).equals(bytes), `${name} is stale`);
  }
});
