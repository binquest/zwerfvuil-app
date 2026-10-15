#!/usr/bin/env node
// Generates every app icon and the splash image from one square source image
// with a flat background colour and a white figure (assets/icon-source.png):
//
//   node scripts/icons.mjs [source.png] [--preview <dir>]
//
// The design is the composition of the source: the figure may run off the
// canvas (the bin is cut off in the corner). Nothing is re-centred.
//
// - Background and figure colours are sampled from the source (the most
//   frequent colour in the outer border, and among the light pixels).
// - The figure becomes an alpha mask by "un-compositing": per pixel, how far
//   its colour lies from the background towards the figure colour, so
//   anti-aliased edges keep their partial alpha and background noise goes.
// - For Android, where the launcher may move the icon layer (parallax), the
//   figure is extended beyond the source canvas: where it leaves the canvas at
//   the bottom, its left and right outlines are fitted as straight lines and
//   continued. If they are not straight (max residual > 0.75 px), there is no
//   extension and the script says so.
// - Everything is rendered on a clean, flat background with area-averaged
//   (box) downscaling.
// - iOS splash: the composition over the full screen. iOS scales the image to
//   fill the screen and crops what sticks out (aspect fill), so the image is
//   taller than any iPhone and only its top and bottom get cropped. The source
//   canvas spans the full width, with its bottom edge on the bottom of the
//   widest screen (iPhone SE); below it the extended figure, which taller
//   screens show. The figure parts that lie fully inside the source (the lid
//   and handle) must stay visible on every iPhone screen; otherwise the script
//   fails.
//
// Outputs in assets/ (all referenced from app.json):
//   icon.png                     1024x1024 RGB, no alpha: the source composition (iOS, fallback)
//   android-icon-foreground.png  1024x1024 RGBA: the figure; the source canvas fills the
//                                central 72 of 108 dp, so the visible icon looks like icon.png
//   android-icon-background.png  1024x1024 RGB: flat background colour
//   android-icon-monochrome.png  1024x1024 RGBA: the same figure in one colour (themed icons)
//   splash-ios.png               1320x2933 RGB: the full-screen iOS splash
//   splash-icon.png              1024x1024 RGBA: the full icon as a rounded square (Android
//                                splash: Android 12+ only shows a centred icon)
//   favicon.png                  48x48 RGB: the full icon
// It prints the colours for app.json (adaptive icon and splash screens).
//
// --preview <dir> writes previews (iOS, Android masks and parallax, themed
// icon, splash screens) to that directory; keep it outside the repo.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pngjs from 'pngjs';

const { PNG } = pngjs;
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(APP_DIR, 'assets');
const SIZE = 1024;
// Android adaptive icon: a 108dp layer of which the launcher shows the
// central 72dp through its mask.
const LAYER_DP = 108;
const VIEW_DP = 72;
// Rounded-square corner radius of the splash icon (as iOS draws app icons).
const CORNER = 0.2237;
// Alpha below/above these values is background noise / solid figure.
const ALPHA_LOW = 0.1;
const ALPHA_HIGH = 0.9;
// Largest deviation (px) of an outline from its fitted line to extend it.
const MAX_RESIDUAL = 0.75;
// iOS splash: as wide as the widest iPhone at 3x, and with an aspect ratio
// (width / height) below that of every iPhone.
const SPLASH_W = 1320;
const SPLASH_ASPECT = 0.45;
// iPhone screens (points), from the widest to the tallest aspect ratio.
const IPHONE_SCREENS = {
  'iPhone SE': [375, 667],
  'iPhone 8 Plus': [414, 736],
  'iPhone 13 mini': [375, 812],
  'iPhone 16': [393, 852],
  'iPhone 16 Pro': [402, 874],
  'iPhone 16 Plus': [430, 932],
  'iPhone 16 Pro Max': [440, 956],
};
// Closest the lid and handle may come to a screen edge (points).
const SPLASH_MIN_MARGIN_PT = 16;
// Android splash background: the background colour at this brightness, so the
// rounded-square icon stands out.
const SPLASH_DARK = 0.3;
// Android splash icon size (imageWidth in app.json). Android 12+ masks the
// splash icon to a circle of 192dp; the rounded square must fit inside it.
const ANDROID_SPLASH_DP = 150;
const ANDROID_SPLASH_CIRCLE_DP = 192;
// Figure parts smaller than this share of the canvas are noise.
const MIN_PART = 0.001;

// ---------------------------------------------------------------------------
// colours

export const toHex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

function mode(colors) {
  const counts = new Map();
  for (const c of colors) {
    const key = (c[0] << 16) | (c[1] << 8) | c[2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) [best, bestCount] = [key, count];
  }
  return [(best >> 16) & 255, (best >> 8) & 255, best & 255];
}

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Background: the most frequent colour in a border strip; figure: the most frequent light colour. */
export function sampleColors({ width, height, data }) {
  const strip = Math.max(4, Math.round(width * 0.03));
  const border = [];
  const light = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const c = [data[i], data[i + 1], data[i + 2]];
      if (x < strip || y < strip || x >= width - strip || y >= height - strip) border.push(c);
      if (luminance(c) > 235) light.push(c);
    }
  }
  const bg = mode(border.filter((c) => luminance(c) <= 235));
  const fg = light.length ? mode(light) : [255, 255, 255];
  return { bg, fg };
}

// ---------------------------------------------------------------------------
// mask

/** Alpha (0..1) per pixel: position of the colour between background and figure. */
export function extractMask({ width, height, data }, bg, fg) {
  const dir = fg.map((v, c) => v - bg[c]);
  const len2 = dir.reduce((s, v) => s + v * v, 0);
  if (len2 < 100) throw new Error('figure and background colours are too close to separate');
  const mask = new Float32Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    let t = 0;
    for (let c = 0; c < 3; c++) t += (data[i + c] - bg[c]) * dir[c];
    const a = (t / len2 - ALPHA_LOW) / (ALPHA_HIGH - ALPHA_LOW);
    mask[p] = a <= 0 ? 0 : a >= 1 ? 1 : a;
  }
  return mask;
}

/** The widest opaque run in a row, with sub-pixel outline positions. */
function rowOutline(mask, w, y) {
  let best = null;
  let start = -1;
  for (let x = 0; x <= w; x++) {
    const on = x < w && mask[y * w + x] > 0;
    if (on && start < 0) start = x;
    if (!on && start >= 0) {
      if (!best || x - start > best[1] - best[0]) best = [start, x];
      start = -1;
    }
  }
  if (!best) return null;
  // Partially covered pixels move the outline by their uncovered fraction.
  let left = best[0];
  for (let x = best[0]; x < best[1] && mask[y * w + x] < 1; x++) left += 1 - mask[y * w + x];
  let right = best[1];
  for (let x = best[1] - 1; x >= best[0] && mask[y * w + x] < 1; x--) right -= 1 - mask[y * w + x];
  return { left, right, touchesLeft: best[0] === 0, touchesRight: best[1] === w };
}

function fitLine(points) {
  const n = points.length;
  let sy = 0, sx = 0, syy = 0, syx = 0;
  for (const [y, x] of points) {
    sy += y;
    sx += x;
    syy += y * y;
    syx += y * x;
  }
  const a = (n * syx - sy * sx) / (n * syy - sy * sy);
  const b = (sx - a * sy) / n;
  let residual = 0;
  for (const [y, x] of points) residual = Math.max(residual, Math.abs(x - (a * y + b)));
  return { a, b, residual, rows: [points[0][0], points[n - 1][0]] };
}

/**
 * Where the figure leaves the canvas at the bottom: straight-line fits of its
 * left and right outline over the lowest part of the figure (`span` rows),
 * using only rows where that outline lies inside the canvas.
 */
export function bottomOutlines(mask, w, h, span = Math.round(h * 0.35)) {
  const bottom = rowOutline(mask, w, h - 1);
  if (!bottom) return { ok: false, reason: 'the figure does not leave the canvas at the bottom' };
  for (let x = 0; x < w; x++) {
    if (mask[x] > 0) return { ok: false, reason: 'the figure also touches the top edge' };
  }
  const left = [];
  const right = [];
  for (let y = h - span; y < h; y++) {
    const o = rowOutline(mask, w, y);
    if (!o) continue;
    if (!o.touchesLeft) left.push([y, o.left]);
    if (!o.touchesRight) right.push([y, o.right]);
  }
  if (left.length < 50 || right.length < 50) return { ok: false, reason: 'too few rows to fit the outline' };
  const l = fitLine(left);
  const r = fitLine(right);
  if (l.residual > MAX_RESIDUAL || r.residual > MAX_RESIDUAL) {
    return { ok: false, reason: `the outline is not straight (residuals ${l.residual.toFixed(2)} / ${r.residual.toFixed(2)} px)`, left: l, right: r };
  }
  return { ok: true, left: l, right: r };
}

/**
 * The mask on a canvas enlarged by `margin` px on every side. Inside the
 * source: the source mask. Outside: the figure continued between its fitted
 * outlines (below the canvas, and beside it where the figure leaves it), with
 * 4x4 supersampled anti-aliasing.
 */
export function extendMask(mask, w, h, margin, outlines) {
  const W = w + 2 * margin;
  const ext = new Float32Array(W * W);
  const xl = (y) => outlines.left.a * y + outlines.left.b;
  const xr = (y) => outlines.right.a * y + outlines.right.b;
  const startY = outlines.left.rows[0];
  for (let Y = 0; Y < W; Y++) {
    for (let X = 0; X < W; X++) {
      const x = X - margin;
      const y = Y - margin;
      if (x >= 0 && x < w && y >= 0 && y < h) {
        ext[Y * W + X] = mask[y * w + x];
        continue;
      }
      if (y + 1 < startY || x + 1 < xl(y + 1) - 1 || x > xr(y + 1) + 1) continue;
      let covered = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4;
          const py = y + (sy + 0.5) / 4;
          if (py >= startY && px >= xl(py) && px <= xr(py)) covered++;
        }
      }
      ext[Y * W + X] = covered / 16;
    }
  }
  return { mask: ext, size: W };
}

/**
 * Bounding box (source px, exclusive end) of the figure parts that lie fully
 * inside the canvas: connected parts that touch no edge (for the bin: the lid
 * with its handle). Null if there are none.
 */
export function innerParts(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let box = null;
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || mask[start] <= 0) continue;
    let n = 0;
    let top = 0;
    let edge = false;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    seen[start] = 1;
    stack[top++] = start;
    while (top > 0) {
      const p = stack[--top];
      const x = p % w;
      const y = (p - x) / w;
      n++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && !seen[q] && mask[q] > 0) {
          seen[q] = 1;
          stack[top++] = q;
        }
      }
    }
    if (edge || n < MIN_PART * w * h) continue;
    box = box
      ? { x0: Math.min(box.x0, x0), y0: Math.min(box.y0, y0), x1: Math.max(box.x1, x1), y1: Math.max(box.y1, y1) }
      : { x0, y0, x1, y1 };
  }
  return box;
}

/** The part of a w x h image that aspect fill shows on a sw x sh screen, and the scale it uses. */
export function coverCrop(w, h, sw, sh) {
  const scale = Math.max(sw / w, sh / h);
  const vw = sw / scale;
  const vh = sh / scale;
  return { x0: (w - vw) / 2, y0: (h - vh) / 2, x1: (w + vw) / 2, y1: (h + vh) / 2, scale };
}

// ---------------------------------------------------------------------------
// resampling: exact box filter (area average), separable

function boxWeights(outLen, srcLen, scale, offset) {
  // Output pixel i covers source interval [(i - offset) / scale, (i + 1 - offset) / scale).
  const weights = [];
  for (let i = 0; i < outLen; i++) {
    const a = (i - offset) / scale;
    const b = (i + 1 - offset) / scale;
    const list = [];
    for (let j = Math.max(0, Math.floor(a)); j < Math.min(srcLen, Math.ceil(b)); j++) {
      const overlap = Math.min(b, j + 1) - Math.max(a, j);
      if (overlap > 0) list.push([j, overlap * scale]);
    }
    weights.push(list);
  }
  return weights;
}

/**
 * Renders a mask (srcW x srcH) into outW x outH, scaled by `scale` and shifted
 * so that source point (sx, sy) lands on output point (ox, oy). Area outside
 * the source counts as transparent.
 */
export function renderMask(mask, srcW, srcH, outW, outH, { scale, sx = 0, sy = 0, ox = 0, oy = 0 }) {
  const wx = boxWeights(outW, srcW, scale, ox - sx * scale);
  const wy = boxWeights(outH, srcH, scale, oy - sy * scale);
  const rows = new Float32Array(srcH * outW);
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < outW; x++) {
      let s = 0;
      for (const [j, wgt] of wx[x]) s += mask[y * srcW + j] * wgt;
      rows[y * outW + x] = s;
    }
  }
  const out = new Float32Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let s = 0;
      for (const [j, wgt] of wy[y]) s += rows[j * outW + x] * wgt;
      out[y * outW + x] = Math.min(1, Math.max(0, s));
    }
  }
  return out;
}

/** Coverage (0..1) of a rounded square with corner radius r, size s, per pixel. */
function roundedSquare(s, r) {
  const out = new Float32Array(s * s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let covered = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const dx = Math.max(0, Math.abs(x + (sx + 0.5) / 4 - s / 2) - (s / 2 - r));
          const dy = Math.max(0, Math.abs(y + (sy + 0.5) / 4 - s / 2) - (s / 2 - r));
          if (dx * dx + dy * dy <= r * r) covered++;
        }
      }
      out[y * s + x] = covered / 16;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// output

function image(width, height, pixel) {
  const png = new PNG({ width, height });
  for (let p = 0; p < width * height; p++) {
    const [r, g, b, a] = pixel(p);
    png.data[p * 4] = r;
    png.data[p * 4 + 1] = g;
    png.data[p * 4 + 2] = b;
    png.data[p * 4 + 3] = a;
  }
  return png;
}

const mix = (fg, bg, a) => [0, 1, 2].map((c) => Math.round(fg[c] * a + bg[c] * (1 - a)));
const flatten = (mask, fg, bg) => (p) => [...mix(fg, bg, mask[p]), 255];
const onTransparent = (mask, color) => (p) => [...color, Math.round(mask[p] * 255)];

function writePng(path, png, { alpha }) {
  // colorType 2 = RGB (no alpha channel at all), 6 = RGBA.
  writeFileSync(path, PNG.sync.write(png, { colorType: alpha ? 6 : 2, inputHasAlpha: true }));
}

export function generate(sourcePath, { assets = ASSETS, preview } = {}) {
  const src = PNG.sync.read(readFileSync(sourcePath));
  const { width: w, height: h } = src;
  if (w !== h) throw new Error(`the source must be square, got ${w}x${h}`);
  if (w < SIZE) console.warn(`warning: the source is ${w}x${h}; at least ${SIZE}x${SIZE} is recommended`);

  const { bg, fg } = sampleColors(src);
  const mask = extractMask(src, bg, fg);

  // iOS / fallback icon and favicon: the source composition as it is.
  const full = renderMask(mask, w, h, SIZE, SIZE, { scale: SIZE / w });
  const fav = renderMask(full, SIZE, SIZE, 48, 48, { scale: 48 / SIZE });

  // iOS splash: the source canvas spans the full width; its bottom edge lies
  // on the bottom of the widest screen, below it the extended figure.
  const splashH = Math.round(SPLASH_W / SPLASH_ASPECT);
  const splashScale = SPLASH_W / w;
  const screens = Object.entries(IPHONE_SCREENS).map(([name, [sw, sh]]) => ({ name, sw, sh, crop: coverCrop(SPLASH_W, splashH, sw, sh) }));
  const widest = screens.reduce((a, b) => (b.sw / b.sh > a.sw / a.sh ? b : a));
  const outlines = bottomOutlines(mask, w, h);
  const splashBottom = outlines.ok ? Math.floor(widest.crop.y1) : splashH;
  const splashTop = splashBottom - SPLASH_W;

  // Android: the source canvas fills the central 72dp of the 108dp layer.
  // The 18dp around it (in source pixels) gets the extended figure, as do the
  // rows below the canvas on the iOS splash.
  const viewPx = (SIZE * VIEW_DP) / LAYER_DP;
  const layerScale = viewPx / w;
  const marginSrc = Math.max(
    Math.ceil(((LAYER_DP - VIEW_DP) / 2 / VIEW_DP) * w),
    Math.ceil((splashH - splashBottom) / splashScale),
  ) + 2;
  const ext = outlines.ok ? extendMask(mask, w, h, marginSrc, outlines) : { mask, size: w };
  const extOffset = outlines.ok ? marginSrc : 0;
  const layer = renderMask(ext.mask, ext.size, ext.size, SIZE, SIZE, {
    scale: layerScale, sx: extOffset, sy: extOffset, ox: (SIZE - viewPx) / 2, oy: (SIZE - viewPx) / 2,
  });
  const splashMask = renderMask(ext.mask, ext.size, ext.size, SPLASH_W, splashH, {
    scale: splashScale, sx: extOffset, sy: extOffset, ox: 0, oy: splashTop,
  });

  // The lid and handle must be fully visible on every iPhone screen.
  const parts = innerParts(mask, w, h);
  if (!parts) throw new Error('the figure has no part that lies fully inside the source canvas');
  const box = {
    x0: parts.x0 * splashScale, y0: splashTop + parts.y0 * splashScale,
    x1: parts.x1 * splashScale, y1: splashTop + parts.y1 * splashScale,
  };
  const margins = screens.map(({ name, crop }) => ({
    name,
    pt: Math.min(box.x0 - crop.x0, box.y0 - crop.y0, crop.x1 - box.x1, crop.y1 - box.y1) * crop.scale,
  }));
  const closest = margins.reduce((a, b) => (b.pt < a.pt ? b : a));
  if (closest.pt < SPLASH_MIN_MARGIN_PT) {
    throw new Error(`splash: the lid and handle come within ${closest.pt.toFixed(1)} pt of the edge on ${closest.name} (minimum ${SPLASH_MIN_MARGIN_PT} pt)`);
  }

  // Android splash: the full icon as a rounded square, transparent outside.
  // Its farthest point from the centre is on the corner arcs.
  const reach = ANDROID_SPLASH_DP * ((0.5 - CORNER) * Math.SQRT2 + CORNER);
  if (reach > ANDROID_SPLASH_CIRCLE_DP / 2) {
    throw new Error(`android splash: a ${ANDROID_SPLASH_DP}dp icon does not fit the ${ANDROID_SPLASH_CIRCLE_DP}dp circle`);
  }
  const corners = roundedSquare(SIZE, SIZE * CORNER);
  const splashIcon = (p) => [...mix(fg, bg, full[p]), Math.round(corners[p] * 255)];
  const dark = bg.map((v) => Math.round(v * SPLASH_DARK));

  const outputs = [
    ['icon.png', image(SIZE, SIZE, flatten(full, fg, bg)), false],
    ['android-icon-foreground.png', image(SIZE, SIZE, onTransparent(layer, fg)), true],
    ['android-icon-background.png', image(SIZE, SIZE, () => [...bg, 255]), false],
    ['android-icon-monochrome.png', image(SIZE, SIZE, onTransparent(layer, [255, 255, 255])), true],
    ['splash-ios.png', image(SPLASH_W, splashH, flatten(splashMask, fg, bg)), false],
    ['splash-icon.png', image(SIZE, SIZE, splashIcon), true],
    ['favicon.png', image(48, 48, flatten(fav, fg, bg)), false],
  ];
  for (const [name, png, alpha] of outputs) writePng(join(assets, name), png, { alpha });

  const report = {
    source: `${w}x${h}`,
    background: toHex(bg),
    figure: toHex(fg),
    androidSplashBackground: toHex(dark),
    androidSplash: `imageWidth ${ANDROID_SPLASH_DP}; reaches ${reach.toFixed(1)} of ${ANDROID_SPLASH_CIRCLE_DP / 2} dp from the centre`,
    extension: outlines.ok
      ? `the figure is continued beyond the source canvas (outline residuals ${outlines.left.residual.toFixed(2)} / ${outlines.right.residual.toFixed(2)} px)`
      : `none: ${outlines.reason}`,
    iosSplash: `${SPLASH_W}x${splashH}; lid and handle visible on ${screens.length} iPhone screens, closest to the edge: ${closest.pt.toFixed(1)} pt (${closest.name})`,
    files: outputs.map(([name]) => name),
  };
  if (preview) writePreviews(preview, { bg, fg, dark, full, layer, corners, splashMask, splashH, screens });
  return report;
}

// ---------------------------------------------------------------------------
// previews (not used by the app)

function writePreviews(dir, { bg, fg, dark, full, layer, corners, splashMask, splashH, screens }) {
  mkdirSync(dir, { recursive: true });
  const S = SIZE;
  const grey = [236, 236, 236];
  const view = Math.round((S * VIEW_DP) / LAYER_DP);
  const off = Math.floor((S - view) / 2);
  const dp = S / LAYER_DP;
  const masks = {
    circle: (x, y) => Math.hypot(x - view / 2, y - view / 2) <= view / 2,
    squircle: (x, y) => Math.abs((x - view / 2) / (view / 2)) ** 4 + Math.abs((y - view / 2) / (view / 2)) ** 4 <= 1,
  };
  // Launcher view of the adaptive icon; shift (dp) moves the foreground layer
  // like a parallax effect does.
  const launcher = (inside, fgColor, bgColor, shift = 0) => image(view, view, (p) => {
    const x = p % view;
    const y = Math.floor(p / view);
    if (!inside(x + 0.5, y + 0.5)) return [...grey, 255];
    const lx = Math.round(x + off - shift * dp);
    const ly = Math.round(y + off - shift * dp);
    const a = lx >= 0 && lx < S && ly >= 0 && ly < S ? layer[ly * S + lx] : 0;
    return [...mix(fgColor, bgColor, a), 255];
  });
  writePng(join(dir, 'preview-android-circle.png'), launcher(masks.circle, fg, bg), { alpha: false });
  writePng(join(dir, 'preview-android-squircle.png'), launcher(masks.squircle, fg, bg), { alpha: false });
  // Shifted up-left: brings the area below and right of the source canvas into view.
  writePng(join(dir, 'preview-android-parallax-12dp.png'), launcher(masks.squircle, fg, bg, -12), { alpha: false });
  writePng(join(dir, 'preview-android-themed.png'), launcher(masks.circle, [32, 64, 48], [208, 232, 216]), { alpha: false });
  // The whole 108dp foreground layer, with the 72dp view outlined.
  const whole = image(S, S, (p) => {
    const x = p % S;
    const y = Math.floor(p / S);
    const onFrame = (Math.abs(x - off) < 2 || Math.abs(x - off - view) < 2 || Math.abs(y - off) < 2 ||
      Math.abs(y - off - view) < 2) && x >= off - 2 && x <= off + view + 2 && y >= off - 2 && y <= off + view + 2;
    if (onFrame) return [230, 60, 60, 255];
    return [...mix(fg, bg, layer[p]), 255];
  });
  writePng(join(dir, 'preview-android-whole-layer.png'), whole, { alpha: false });
  // iOS: the rounded-square mask on icon.png.
  const ios = image(S, S, (p) => [...mix(mix(fg, bg, full[p]), grey, corners[p]), 255]);
  writePng(join(dir, 'preview-ios.png'), ios, { alpha: false });
  // iOS splash on the widest (iPhone SE) and the tallest screen (Pro Max),
  // side by side at 2 px per point, cropped as aspect fill does.
  const PX = 2;
  const pad = 60;
  const shown = [screens[0], screens[screens.length - 1]].map(({ sw, sh, crop }) => ({
    w: sw * PX,
    h: sh * PX,
    radius: sh / sw > 2 ? 55 * PX : 0,
    mask: renderMask(splashMask, SPLASH_W, splashH, sw * PX, sh * PX, { scale: (sw * PX) / (crop.x1 - crop.x0), sx: crop.x0, sy: crop.y0 }),
  }));
  const cw = shown.reduce((s, d) => s + d.w, 0) + pad * (shown.length + 1);
  const ch = Math.max(...shown.map((d) => d.h)) + 2 * pad;
  const canvas = new Array(cw * ch).fill(grey);
  let left = pad;
  for (const d of shown) {
    const r = d.radius;
    for (let y = 0; y < d.h; y++) {
      for (let x = 0; x < d.w; x++) {
        const dx = Math.max(0, Math.abs(x + 0.5 - d.w / 2) - (d.w / 2 - r));
        const dy = Math.max(0, Math.abs(y + 0.5 - d.h / 2) - (d.h / 2 - r));
        if (r && dx * dx + dy * dy > r * r) continue;
        canvas[(pad + y) * cw + left + x] = mix(fg, bg, d.mask[y * d.w + x]);
      }
    }
    left += d.w + pad;
  }
  writePng(join(dir, 'preview-splash-ios-se-and-pro-max.png'), image(cw, ch, (p) => [...canvas[p], 255]), { alpha: false });

  // Android splash: the rounded-square icon at ANDROID_SPLASH_DP, centred on a
  // 412x915 dp screen (2 px per dp).
  const aw = 412 * PX, ah = 915 * PX, iw = ANDROID_SPLASH_DP * PX;
  const small = renderMask(full, S, S, iw, iw, { scale: iw / S });
  const smallCorners = renderMask(corners, S, S, iw, iw, { scale: iw / S });
  const ix = (aw - iw) / 2, iy = Math.round((ah - iw) / 2);
  const android = image(aw, ah, (p) => {
    const x = p % aw;
    const y = Math.floor(p / aw);
    if (x < ix || x >= ix + iw || y < iy || y >= iy + iw) return [...dark, 255];
    const q = (y - iy) * iw + (x - ix);
    return [...mix(mix(fg, bg, small[q]), dark, smallCorners[q]), 255];
  });
  writePng(join(dir, 'preview-splash-android.png'), android, { alpha: false });
}

function main() {
  const args = process.argv.slice(2);
  const previewAt = args.indexOf('--preview');
  const preview = previewAt >= 0 ? resolve(args[previewAt + 1]) : undefined;
  const positional = args.filter((_, i) => i !== previewAt && i !== previewAt + 1);
  const source = resolve(positional[0] ?? join(ASSETS, 'icon-source.png'));
  const report = generate(source, { preview });
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nIn app.json: ${report.background} as android.adaptiveIcon.backgroundColor and as the iOS splash`);
  console.log(`backgroundColor; ${report.androidSplashBackground} and imageWidth ${ANDROID_SPLASH_DP} for the Android splash.`);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main();
