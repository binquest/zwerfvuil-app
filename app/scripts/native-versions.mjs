#!/usr/bin/env node
// The native code of the "Zwerfvuil Dev" IPA is fixed per runtime version
// (DEV_RUNTIME_VERSION in app.config.ts). An EAS Update must not ship
// JavaScript built against other native package versions, so update:dev
// compares the installed native packages with native-versions.json and
// refuses on any difference.
//
//   node scripts/native-versions.mjs           check (exit 1 on a difference)
//   node scripts/native-versions.mjs --record  record the installed versions;
//                                              only for the commit of a new IPA,
//                                              after bumping DEV_RUNTIME_VERSION
//
// A package counts as native when it has a podspec (in its root, ios/ or
// apple/) or an expo-module.config.json for Apple platforms. Nested copies
// (node_modules/a/node_modules/b) are listed under their path.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RECORD_FILE = 'native-versions.json';

/** DEV_RUNTIME_VERSION from the text of app.config.ts. */
export function runtimeVersion(configText) {
  const match = /const DEV_RUNTIME_VERSION = '([^']+)'/.exec(configText);
  if (!match) throw new Error('DEV_RUNTIME_VERSION not found in app.config.ts');
  return match[1];
}

function hasPodspec(dir) {
  return ['', 'ios', 'apple'].some((sub) => {
    const path = join(dir, sub);
    return existsSync(path) && readdirSync(path).some((name) => name.endsWith('.podspec'));
  });
}

function isExpoAppleModule(dir) {
  const path = join(dir, 'expo-module.config.json');
  if (!existsSync(path)) return false;
  const platforms = JSON.parse(readFileSync(path, 'utf8')).platforms;
  return !Array.isArray(platforms) || platforms.some((p) => p === 'apple' || p === 'ios');
}

function packageDirs(nodeModules) {
  if (!existsSync(nodeModules)) return [];
  const dirs = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(join(nodeModules, entry.name))) dirs.push(`${entry.name}/${scoped}`);
    } else {
      dirs.push(entry.name);
    }
  }
  return dirs;
}

/** { "<name or nested path>": "<version>" } of the native packages under nodeModules, sorted. */
export function scanNativePackages(nodeModules, prefix = '', depth = 0) {
  const found = {};
  for (const name of packageDirs(nodeModules)) {
    const dir = join(nodeModules, name);
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    if (hasPodspec(dir) || isExpoAppleModule(dir)) {
      found[prefix + name] = JSON.parse(readFileSync(manifest, 'utf8')).version;
    }
    if (depth < 2) Object.assign(found, scanNativePackages(join(dir, 'node_modules'), `${prefix}${name}/node_modules/`, depth + 1));
  }
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Differences between the recorded and the installed state; empty when an update is safe. */
export function compareNative(recorded, runtime, installed) {
  if (!recorded) return [`${RECORD_FILE} is missing`];
  if (recorded.runtimeVersion !== runtime) {
    return [`${RECORD_FILE} is for runtime ${recorded.runtimeVersion}, app.config.ts says ${runtime}`];
  }
  const problems = [];
  const names = new Set([...Object.keys(recorded.packages ?? {}), ...Object.keys(installed)]);
  for (const name of [...names].sort()) {
    const was = recorded.packages?.[name];
    const now = installed[name];
    if (was === now) continue;
    if (!was) problems.push(`${name} ${now} is new`);
    else if (!now) problems.push(`${name} ${was} is gone`);
    else problems.push(`${name} ${was} -> ${now}`);
  }
  return problems;
}

/** The problems for the app in appDir (used by update-dev.mjs). */
export function checkApp(appDir = APP_DIR) {
  const runtime = runtimeVersion(readFileSync(join(appDir, 'app.config.ts'), 'utf8'));
  const recordPath = join(appDir, RECORD_FILE);
  const recorded = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;
  return compareNative(recorded, runtime, scanNativePackages(join(appDir, 'node_modules')));
}

function main() {
  if (process.argv.includes('--record')) {
    const runtime = runtimeVersion(readFileSync(join(APP_DIR, 'app.config.ts'), 'utf8'));
    const packages = scanNativePackages(join(APP_DIR, 'node_modules'));
    const record = {
      '//': 'Native package versions in the Zwerfvuil Dev IPA of this runtime. Written by scripts/native-versions.mjs --record.',
      runtimeVersion: runtime,
      packages,
    };
    writeFileSync(join(APP_DIR, RECORD_FILE), JSON.stringify(record, null, 2) + '\n');
    console.error(`recorded ${Object.keys(packages).length} native packages for runtime ${runtime}`);
    return;
  }
  const problems = checkApp();
  if (problems.length) {
    console.error('native packages differ from the IPA of this runtime:');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.error('native packages match the IPA of this runtime');
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main();
