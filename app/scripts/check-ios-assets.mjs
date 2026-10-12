#!/usr/bin/env node
// Checks the iOS project that `expo prebuild` generated against app.json and
// assets/: the app icon must be assets/icon.png, and the launch screen must be
// the expo-splash-screen configuration (for us: the full-screen image).
//
//   node scripts/check-ios-assets.mjs [ios-dir]      (default: ios)
//
// Runs in .github/workflows/ios-staging.yml after the prebuild. Exits 1 on any
// difference, e.g. when an Expo update drops enableFullScreenImage_legacy and
// the launch screen silently becomes a small centred image.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pngjs from 'pngjs';

const { PNG } = pngjs;
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
// Largest mean difference per colour channel (0-255) between an asset and its copy.
const MAX_MEAN_DIFF = 2;

const failures = [];
const fail = (message) => failures.push(message);
const ok = (message) => console.log(`ok: ${message}`);

function readPng(path) {
  return PNG.sync.read(readFileSync(path));
}

/** Mean absolute RGB difference, or null if the sizes differ. */
function meanDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) return null;
  let sum = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    for (let c = 0; c < 3; c++) sum += Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c]);
  }
  return sum / (a.width * a.height * 3);
}

function expectSameImage(label, path, expectedPath) {
  if (!existsSync(path)) return fail(`${label}: ${path} is missing`);
  const got = readPng(path);
  const want = readPng(expectedPath);
  const diff = meanDiff(got, want);
  if (diff === null) return fail(`${label}: ${got.width}x${got.height}, expected ${want.width}x${want.height} (${expectedPath})`);
  if (diff > MAX_MEAN_DIFF) return fail(`${label}: differs from ${expectedPath} (mean difference ${diff.toFixed(2)})`);
  ok(`${label}: ${got.width}x${got.height}, matches ${expectedPath} (mean difference ${diff.toFixed(2)})`);
}

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function main() {
  const iosDir = resolve(process.argv[2] ?? join(APP_DIR, 'ios'));
  const expo = JSON.parse(readFileSync(join(APP_DIR, 'app.json'), 'utf8')).expo;
  const project = readdirSync(iosDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(iosDir, d.name))
    .find((dir) => existsSync(join(dir, 'Images.xcassets')));
  if (!project) throw new Error(`no Images.xcassets in ${iosDir}; run expo prebuild first`);
  const xcassets = join(project, 'Images.xcassets');

  // App icon: the 1024 image of the AppIcon set is assets/icon.png.
  const iconSet = join(xcassets, 'AppIcon.appiconset');
  const iconContents = JSON.parse(readFileSync(join(iconSet, 'Contents.json'), 'utf8'));
  const icon1024 = iconContents.images.find((i) => i.size === '1024x1024' && i.filename);
  if (!icon1024) fail('AppIcon: no 1024x1024 image in Contents.json');
  else expectSameImage('AppIcon', join(iconSet, icon1024.filename), join(APP_DIR, expo.icon));

  // Launch screen: resolved like expo-splash-screen does (ios over top level).
  const plugin = expo.plugins.find((p) => (Array.isArray(p) ? p[0] : p) === 'expo-splash-screen');
  if (!plugin || !Array.isArray(plugin)) throw new Error('app.json has no configured expo-splash-screen plugin');
  const splash = { ...plugin[1], ...plugin[1].ios };
  const fullScreen = splash.enableFullScreenImage_legacy === true;
  const imageName = fullScreen ? 'SplashScreenLegacy' : 'SplashScreenLogo';
  const contentMode = splash.resizeMode === 'cover' ? 'scaleAspectFill' : 'scaleAspectFit';

  const plist = readFileSync(join(project, 'Info.plist'), 'utf8');
  if (!/<key>UILaunchStoryboardName<\/key>\s*<string>SplashScreen<\/string>/.test(plist)) {
    fail('Info.plist: UILaunchStoryboardName is not SplashScreen');
  } else ok('Info.plist: UILaunchStoryboardName is SplashScreen');

  const storyboard = readFileSync(join(project, 'SplashScreen.storyboard'), 'utf8');
  const imageView = storyboard.match(/<imageView [^>]*id="EXPO-SplashScreen"[^>]*>/)?.[0] ?? '';
  if (!imageView.includes(`image="${imageName}"`) || !imageView.includes(`contentMode="${contentMode}"`)) {
    fail(`SplashScreen.storyboard: expected image ${imageName} with contentMode ${contentMode}, found: ${imageView || 'no image view'}`);
  } else ok(`SplashScreen.storyboard: image ${imageName}, contentMode ${contentMode}`);
  const edges = fullScreen ? ['top', 'bottom', 'leading', 'trailing'] : ['centerX', 'centerY'];
  const missing = edges.filter((edge) => !new RegExp(
    `<constraint firstItem="EXPO-SplashScreen" firstAttribute="${edge}" secondItem="EXPO-ContainerView" secondAttribute="${edge}"`,
  ).test(storyboard));
  if (missing.length) fail(`SplashScreen.storyboard: no ${missing.join(', ')} constraint(s) on the container`);
  else ok(`SplashScreen.storyboard: image pinned to the container (${edges.join(', ')})`);

  const color = storyboard.match(/<namedColor name="SplashScreenBackground">\s*<color ([^>]*)\/>/)?.[1] ?? '';
  const channel = (name) => Math.round(parseFloat(color.match(new RegExp(`${name}="([^"]+)"`))?.[1] ?? 'NaN') * 255);
  const got = [channel('red'), channel('green'), channel('blue')];
  const want = hexToRgb(splash.backgroundColor);
  if (got.some((v, i) => !(Math.abs(v - want[i]) <= 1))) {
    fail(`SplashScreen.storyboard: background ${got.join(',')}, expected ${want.join(',')} (${splash.backgroundColor})`);
  } else ok(`SplashScreen.storyboard: background ${splash.backgroundColor}`);

  // Full screen: every scale is the image itself; centred: imageWidth points.
  const imageSet = join(xcassets, `${imageName}.imageset`);
  for (const [suffix, scale] of [['', 1], ['@2x', 2], ['@3x', 3]]) {
    const path = join(imageSet, `image${suffix}.png`);
    if (fullScreen) {
      expectSameImage(`${imageName} ${scale}x`, path, join(APP_DIR, splash.image));
    } else if (!existsSync(path)) {
      fail(`${imageName} ${scale}x: ${path} is missing`);
    } else {
      const { width } = readPng(path);
      const want = (splash.imageWidth ?? 100) * scale;
      if (width !== want) fail(`${imageName} ${scale}x: ${width} px wide, expected ${want}`);
      else ok(`${imageName} ${scale}x: ${width} px wide`);
    }
  }

  if (failures.length) {
    for (const message of failures) console.log(`::error::${message}`);
    process.exit(1);
  }
  console.log('The generated iOS project has our app icon and launch screen.');
}

main();
