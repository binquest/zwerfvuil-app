#!/usr/bin/env node
// Turns the avatar drawings into what the app bundles (docs/AVATARS.md):
//
//   node scripts/avatars.mjs           checks every assets/avatars/<key>.png, writes its
//                                      thumbnail assets/avatars/thumbs/<key>.png and the
//                                      require map src/game/avatarImages.ts
//   node scripts/avatars.mjs --check   only checks that thumbnails and map are up to date
//
// A drawing is a PNG of exactly 512 x 512 with a transparent background (the
// four corner pixels fully transparent), at most 200 KB, named after the key
// of its avatar: lower case, digits and _ (like public.avatars.key). The
// thumbnail (192 x 192, sharp up to 64 pt at @3x) is an area average in
// premultiplied alpha, so edges keep their colour. The map holds a hash of
// every drawing: a changed PNG without a new run fails the check (and the
// test in avatars.test.mjs).
//
// Exits 1 when a drawing breaks a rule (nothing is written then) or, with
// --check, when something is stale.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pngjs from 'pngjs';

const { PNG } = pngjs;
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SIZE = 512;
export const THUMB = 192;
export const MAX_BYTES = 200 * 1024;
export const KEY = /^[a-z][a-z0-9_]{1,31}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const paths = (appDir = APP_DIR) => ({
  drawings: join(appDir, 'assets', 'avatars'),
  thumbs: join(appDir, 'assets', 'avatars', 'thumbs'),
  map: join(appDir, 'src', 'game', 'avatarImages.ts'),
});

// ---------------------------------------------------------------------------
// rules

/** Checks one drawing. Returns the decoded image, or the broken rules. */
export function checkDrawing(fileName, bytes) {
  const errors = [];
  const key = fileName.replace(/\.png$/, '');
  if (!fileName.endsWith('.png') || !KEY.test(key)) {
    errors.push(`${fileName}: the name must be <key>.png with a key of 2 to 32 lower-case letters, digits or _`);
  }
  if (bytes.length > MAX_BYTES) {
    errors.push(`${fileName}: ${Math.round(bytes.length / 1024)} KB, at most ${MAX_BYTES / 1024} KB`);
  }
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    errors.push(`${fileName}: not a PNG file`);
    return { key, errors, png: null };
  }
  let png;
  try {
    png = PNG.sync.read(bytes);
  } catch (e) {
    errors.push(`${fileName}: cannot be read as PNG (${e.message})`);
    return { key, errors, png: null };
  }
  if (png.width !== SIZE || png.height !== SIZE) {
    errors.push(`${fileName}: ${png.width} x ${png.height}, must be ${SIZE} x ${SIZE}`);
  } else {
    const corners = [0, SIZE - 1, SIZE * (SIZE - 1), SIZE * SIZE - 1];
    if (corners.some((p) => png.data[p * 4 + 3] !== 0)) {
      errors.push(`${fileName}: the background must be transparent (the corners are not)`);
    }
  }
  return { key, errors, png: errors.length === 0 ? png : null };
}

// ---------------------------------------------------------------------------
// thumbnail: exact box filter (area average) in premultiplied alpha

function boxWeights(outLen, srcLen) {
  const scale = outLen / srcLen;
  const weights = [];
  for (let i = 0; i < outLen; i++) {
    const a = i / scale;
    const b = (i + 1) / scale;
    const list = [];
    for (let j = Math.floor(a); j < Math.min(srcLen, Math.ceil(b)); j++) {
      const overlap = Math.min(b, j + 1) - Math.max(a, j);
      if (overlap > 0) list.push([j, overlap * scale]);
    }
    weights.push(list);
  }
  return weights;
}

/** The RGBA pixels (Uint8Array) of `png` scaled down to size x size. */
export function downscale(png, size = THUMB) {
  const { width: sw, height: sh, data } = png;
  const wx = boxWeights(size, sw);
  const wy = boxWeights(size, sh);
  // premultiplied, rows scaled first
  const rows = new Float64Array(sh * size * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [j, w] of wx[x]) {
        const p = (y * sw + j) * 4;
        const alpha = (data[p + 3] / 255) * w;
        r += data[p] * alpha;
        g += data[p + 1] * alpha;
        b += data[p + 2] * alpha;
        a += alpha;
      }
      const o = (y * size + x) * 4;
      rows[o] = r;
      rows[o + 1] = g;
      rows[o + 2] = b;
      rows[o + 3] = a;
    }
  }
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [j, w] of wy[y]) {
        const p = (j * size + x) * 4;
        r += rows[p] * w;
        g += rows[p + 1] * w;
        b += rows[p + 2] * w;
        a += rows[p + 3] * w;
      }
      const o = (y * size + x) * 4;
      const alpha = Math.min(1, Math.max(0, a));
      out[o + 3] = Math.round(alpha * 255);
      if (out[o + 3] > 0) {
        out[o] = Math.min(255, Math.round(r / a));
        out[o + 1] = Math.min(255, Math.round(g / a));
        out[o + 2] = Math.min(255, Math.round(b / a));
      }
    }
  }
  return out;
}

function encode(pixels, size) {
  const png = new PNG({ width: size, height: size });
  png.data = Buffer.from(pixels);
  return PNG.sync.write(png, { colorType: 6, inputHasAlpha: true });
}

// ---------------------------------------------------------------------------
// map

const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

/** The text of src/game/avatarImages.ts for these drawings ({key, hash}, any order). */
export function renderMap(entries) {
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  const lines = [
    '// Generated by scripts/avatars.mjs from assets/avatars/*.png (docs/AVATARS.md):',
    '// run `npm run avatars` after adding or changing a drawing. Do not edit; a test',
    '// fails when this file is behind the folder.',
    "import type { AvatarImage } from './avatars';",
    '',
  ];
  if (sorted.length === 0) {
    lines.push('export const AVATAR_IMAGES: Readonly<Record<string, AvatarImage>> = {};');
  } else {
    lines.push('export const AVATAR_IMAGES: Readonly<Record<string, AvatarImage>> = {');
    for (const { key, hash } of sorted) {
      lines.push(`  // ${key}.png sha256 ${hash}`);
      lines.push(`  ${key}: {`);
      lines.push(`    full: require('../../assets/avatars/${key}.png'),`);
      lines.push(`    thumb: require('../../assets/avatars/thumbs/${key}.png'),`);
      lines.push('  },');
    }
    lines.push('};');
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// run

function drawingFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name.toLowerCase().endsWith('.png'))
    .map((e) => e.name)
    .sort();
}

const sameText = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

/**
 * Checks the drawings and, with `write`, writes thumbnails and map (and
 * removes thumbnails without a drawing). Returns {keys, errors, stale}:
 * errors break a rule; stale lists what is behind the drawings.
 */
export function build({ appDir = APP_DIR, write = false } = {}) {
  const p = paths(appDir);
  const errors = [];
  const drawings = [];
  for (const name of drawingFiles(p.drawings)) {
    const bytes = readFileSync(join(p.drawings, name));
    const checked = checkDrawing(name, bytes);
    errors.push(...checked.errors);
    if (checked.png) drawings.push({ key: checked.key, hash: hashOf(bytes), png: checked.png });
  }
  const keys = drawings.map((d) => d.key);
  if (errors.length > 0) return { keys, errors, stale: [] };

  const stale = [];
  const map = renderMap(drawings);
  if (!existsSync(p.map) || !sameText(readFileSync(p.map, 'utf8'), map)) stale.push('src/game/avatarImages.ts');
  for (const d of drawings) {
    const thumbPath = join(p.thumbs, `${d.key}.png`);
    const pixels = downscale(d.png);
    let fresh = false;
    if (existsSync(thumbPath)) {
      try {
        const old = PNG.sync.read(readFileSync(thumbPath));
        fresh = old.width === THUMB && old.height === THUMB && old.data.every((v, i) => Math.abs(v - pixels[i]) <= 1);
      } catch {
        fresh = false;
      }
    }
    if (!fresh) {
      stale.push(`assets/avatars/thumbs/${d.key}.png`);
      if (write) {
        mkdirSync(p.thumbs, { recursive: true });
        writeFileSync(thumbPath, encode(pixels, THUMB));
      }
    }
  }
  const orphans = drawingFiles(p.thumbs).filter((name) => !keys.includes(name.replace(/\.png$/, '')));
  for (const name of orphans) {
    stale.push(`assets/avatars/thumbs/${name} (no drawing)`);
    if (write) rmSync(join(p.thumbs, name));
  }
  if (write && stale.includes('src/game/avatarImages.ts')) writeFileSync(p.map, map);
  return { keys, errors, stale };
}

function main() {
  const check = process.argv.includes('--check');
  const { keys, errors, stale } = build({ write: !check });
  if (errors.length > 0) {
    console.error(`avatars: ${errors.length} problem(s), nothing written (docs/AVATARS.md):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`avatars: ${keys.length} drawing(s)${keys.length ? `: ${keys.join(', ')}` : ''}`);
  if (check) {
    if (stale.length > 0) {
      console.error('avatars: out of date, run `npm run avatars`:');
      for (const s of stale) console.error(`  - ${s}`);
      process.exit(1);
    }
    console.log('avatars: up to date');
  } else {
    console.log(stale.length > 0 ? `avatars: wrote ${stale.join(', ')}` : 'avatars: nothing to change');
  }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main();
