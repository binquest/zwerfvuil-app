// Tests for scripts/avatars.mjs: node --test scripts/avatars.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import pngjs from 'pngjs';

import { build, checkDrawing, downscale, MAX_BYTES, paths, renderMap, SIZE, THUMB } from './avatars.mjs';

const { PNG } = pngjs;
const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** An app folder with an empty map, like a fresh checkout. */
function appDir() {
  const dir = mkdtempSync(join(tmpdir(), 'avatars-'));
  temps.push(dir);
  mkdirSync(paths(dir).drawings, { recursive: true });
  mkdirSync(join(dir, 'src', 'game'), { recursive: true });
  return dir;
}

/** A PNG: `pixel(x, y)` gives [r, g, b, a]. */
function png(pixel, { width = SIZE, height = SIZE, colorType = 6 } = {}) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) image.data.set(pixel(x, y), (y * width + x) * 4);
  }
  return PNG.sync.write(image, { colorType, inputHasAlpha: true });
}

/** A red disc of radius 200 in the middle, on transparency. */
const disc = (color = [220, 40, 40]) =>
  png((x, y) => ((x - 255.5) ** 2 + (y - 255.5) ** 2 <= 200 ** 2 ? [...color, 255] : [0, 0, 0, 0]));

test('the committed map and thumbnails match assets/avatars (run npm run avatars)', () => {
  const { errors, stale } = build();
  assert.deepEqual(errors, []);
  assert.deepEqual(stale, []);
});

test('a drawing gets a 192 px thumbnail and an entry in the map', () => {
  const dir = appDir();
  const p = paths(dir);
  writeFileSync(join(p.drawings, 'vos.png'), disc());
  writeFileSync(join(p.drawings, 'README.md'), 'not a drawing');

  const first = build({ appDir: dir, write: true });
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.keys, ['vos']);
  assert.deepEqual(first.stale, ['src/game/avatarImages.ts', 'assets/avatars/thumbs/vos.png']);

  const thumb = PNG.sync.read(readFileSync(join(p.thumbs, 'vos.png')));
  assert.equal(thumb.width, THUMB);
  assert.equal(thumb.height, THUMB);
  const map = readFileSync(p.map, 'utf8');
  assert.match(map, /full: require\('\.\.\/\.\.\/assets\/avatars\/vos\.png'\)/);
  assert.match(map, /thumb: require\('\.\.\/\.\.\/assets\/avatars\/thumbs\/vos\.png'\)/);

  assert.deepEqual(build({ appDir: dir }).stale, [], 'a second run finds nothing to do');
});

test('a changed or removed drawing makes the map stale until the script runs', () => {
  const dir = appDir();
  const p = paths(dir);
  writeFileSync(join(p.drawings, 'vos.png'), disc());
  writeFileSync(join(p.drawings, 'zon.png'), disc([240, 180, 20]));
  build({ appDir: dir, write: true });

  writeFileSync(join(p.drawings, 'vos.png'), disc([40, 40, 220]));
  assert.deepEqual(build({ appDir: dir }).stale, ['src/game/avatarImages.ts', 'assets/avatars/thumbs/vos.png']);

  rmSync(join(p.drawings, 'zon.png'));
  build({ appDir: dir, write: true });
  assert.equal(existsSync(join(p.thumbs, 'zon.png')), false, 'the thumbnail of a removed drawing goes');
  assert.doesNotMatch(readFileSync(p.map, 'utf8'), /zon/);
  assert.deepEqual(build({ appDir: dir }).stale, []);
});

test('no drawings: an empty map', () => {
  assert.equal(
    renderMap([]).split('\n').filter((line) => line.startsWith('export')).join(''),
    'export const AVATAR_IMAGES: Readonly<Record<string, AvatarImage>> = {};',
  );
});

test('the thumbnail averages areas in premultiplied alpha: edges keep their colour', () => {
  // Opaque blue up to x = 257, transparent black after it.
  const image = PNG.sync.read(png((x) => (x < 257 ? [0, 0, 255, 255] : [0, 0, 0, 0])));
  const out = downscale(image);
  const at = (x, y) => Array.from(out.subarray((y * THUMB + x) * 4, (y * THUMB + x) * 4 + 4));
  assert.deepEqual(at(10, 10), [0, 0, 255, 255]);
  assert.deepEqual(at(THUMB - 1, 10), [0, 0, 0, 0]);
  // Column 96 covers source x 256 to 258.67: one blue pixel of 2.67.
  assert.deepEqual(at(96, 10), [0, 0, 255, Math.round((1 / (SIZE / THUMB)) * 255)]);
  for (let x = 0; x < THUMB; x++) {
    const [r, g, b, a] = at(x, 50);
    if (a > 0) assert.deepEqual([r, g, b], [0, 0, 255], `column ${x} turned dark`);
  }
});

test('a drawing that breaks a rule is refused with the reason, and nothing is written', () => {
  const opaque = png(() => [255, 255, 255, 255]);
  const cases = [
    ['Vos.png', disc(), /the name must be <key>\.png/],
    ['mijn-vos.png', disc(), /the name must be <key>\.png/],
    ['vos.png', png(() => [0, 0, 0, 0], { width: 500, height: 500 }), /500 x 500, must be 512 x 512/],
    ['vos.png', opaque, /the background must be transparent/],
    ['vos.png', Buffer.from('not a png'), /not a PNG file/],
  ];
  for (const [name, bytes, reason] of cases) {
    const { errors, png: decoded } = checkDrawing(name, bytes);
    assert.equal(decoded, null, name);
    assert.match(errors.join('\n'), reason, name);
  }

  // Noise does not compress: far above 200 KB.
  let seed = 1;
  const noise = png(() => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return [seed & 255, (seed >> 8) & 255, (seed >> 16) & 255, (seed & 1) * 255];
  });
  assert.ok(noise.length > MAX_BYTES);
  assert.match(checkDrawing('vos.png', noise).errors.join('\n'), /KB, at most 200 KB/);

  const dir = appDir();
  writeFileSync(join(paths(dir).drawings, 'vos.png'), opaque);
  const { errors } = build({ appDir: dir, write: true });
  assert.equal(errors.length, 1);
  assert.equal(existsSync(paths(dir).map), false, 'no map written');
});

test('an opaque RGB PNG (no alpha channel) is refused', () => {
  const rgb = png(() => [10, 200, 10, 255], { colorType: 2 });
  assert.match(checkDrawing('vos.png', rgb).errors.join('\n'), /transparent/);
});
