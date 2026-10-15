// Tests for scripts/native-versions.mjs (the native version check of update:dev).
// Run with: npm run test:scripts (node --test)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkApp, compareNative, runtimeVersion, scanNativePackages } from './native-versions.mjs';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function pkg(root, name, version, files = {}) {
  write(join(root, name, 'package.json'), JSON.stringify({ name, version }));
  for (const [file, text] of Object.entries(files)) write(join(root, name, file), text);
}

function fakeNodeModules() {
  const root = mkdtempSync(join(tmpdir(), 'native-versions-'));
  const nm = join(root, 'node_modules');
  pkg(nm, 'react-native-thing', '1.2.3', { 'RNThing.podspec': '' });
  pkg(nm, 'expo-thing', '57.0.1', { 'expo-module.config.json': '{"platforms":["apple","android"]}' });
  pkg(nm, 'expo-android-only', '57.0.1', { 'expo-module.config.json': '{"platforms":["android"]}' });
  pkg(nm, '@scope/ui', '2.0.0', { 'ios/ScopeUI.podspec': '' });
  pkg(nm, 'left-pad', '1.3.0');
  pkg(join(nm, 'expo-thing', 'node_modules'), 'expo-nested', '57.0.9', { 'expo-module.config.json': '{}' });
  return { root, nm };
}

test('finds packages with a podspec or an Apple expo module, also scoped and nested', () => {
  const { root, nm } = fakeNodeModules();
  try {
    assert.deepEqual(scanNativePackages(nm), {
      '@scope/ui': '2.0.0',
      'expo-thing': '57.0.1',
      'expo-thing/node_modules/expo-nested': '57.0.9',
      'react-native-thing': '1.2.3',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reports changed, new and removed packages, and a runtime mismatch', () => {
  const recorded = { runtimeVersion: '1', packages: { a: '1.0.0', b: '2.0.0', c: '3.0.0' } };
  assert.deepEqual(compareNative(recorded, '1', { a: '1.0.0', b: '2.0.0', c: '3.0.0' }), []);
  assert.deepEqual(compareNative(recorded, '1', { a: '1.0.1', c: '3.0.0', d: '4.0.0' }), [
    'a 1.0.0 -> 1.0.1',
    'b 2.0.0 is gone',
    'd 4.0.0 is new',
  ]);
  assert.equal(compareNative(recorded, '2', recorded.packages).length, 1);
  assert.equal(compareNative(null, '1', {}).length, 1);
});

test('reads DEV_RUNTIME_VERSION from app.config.ts', () => {
  assert.equal(runtimeVersion("const DEV_RUNTIME_VERSION = '7';\n"), '7');
  assert.throws(() => runtimeVersion('runtimeVersion: "1"'));
  assert.match(runtimeVersion(readFileSync(join(APP_DIR, 'app.config.ts'), 'utf8')), /^\S+$/);
});

test('this app matches its record (what update:dev checks)', () => {
  assert.deepEqual(checkApp(APP_DIR), []);
});
