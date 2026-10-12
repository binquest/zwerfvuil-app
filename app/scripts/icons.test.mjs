// Tests for scripts/icons.mjs: node --test scripts/icons.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import pngjs from 'pngjs';

import { coverCrop, generate, innerParts } from './icons.mjs';

const { PNG } = pngjs;
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon-source.png');

test('aspect fill crops only the top and bottom of a tall image on a wide screen', () => {
  const c = coverCrop(1320, 2933, 375, 667);
  assert.ok(Math.abs(c.x0) < 1e-9);
  assert.ok(Math.abs(c.x1 - 1320) < 1e-9);
  assert.ok(c.y0 > 0);
  assert.ok(Math.abs(c.y0 - (2933 - c.y1)) < 1e-9);
});

test('inner parts are the figure parts that touch no edge', () => {
  const w = 100;
  const mask = new Float32Array(w * w);
  const fill = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * w + x] = 1;
  };
  fill(40, 60, 100, 100); // runs off the bottom and right edge
  fill(20, 20, 50, 40); // fully inside
  assert.deepEqual(innerParts(mask, w, w), { x0: 20, y0: 20, x1: 50, y1: 40 });
});

test('generate writes every asset in its expected size and format', () => {
  const dir = mkdtempSync(join(tmpdir(), 'icons-test-'));
  try {
    const report = generate(SOURCE, { assets: dir });
    assert.equal(report.background, '#2FC177');
    assert.match(report.extension, /^the figure is continued/);
    const expected = {
      'icon.png': [1024, 1024, false],
      'android-icon-foreground.png': [1024, 1024, true],
      'android-icon-background.png': [1024, 1024, false],
      'android-icon-monochrome.png': [1024, 1024, true],
      'splash-ios.png': [1320, 2933, false],
      'splash-icon.png': [1024, 1024, true],
      'favicon.png': [48, 48, false],
    };
    for (const [name, [width, height, alpha]] of Object.entries(expected)) {
      const png = PNG.sync.read(readFileSync(join(dir, name)));
      assert.deepEqual([png.width, png.height, png.alpha], [width, height, alpha], name);
    }
    // The splash shows the background at the top and the bin at the bottom right.
    const splash = PNG.sync.read(readFileSync(join(dir, 'splash-ios.png')));
    const at = (x, y) => [...splash.data.subarray((y * splash.width + x) * 4, (y * splash.width + x) * 4 + 3)];
    assert.deepEqual(at(10, 10), [0x2f, 0xc1, 0x77]);
    assert.deepEqual(at(splash.width - 10, splash.height - 10), [0xfe, 0xfe, 0xfe]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
