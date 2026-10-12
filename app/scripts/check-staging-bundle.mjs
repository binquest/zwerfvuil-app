#!/usr/bin/env node
// Checks an exported staging bundle (npm run check:staging-bundle):
//   node scripts/check-staging-bundle.mjs <export dir>
//
// Fails when the bundle contains anything of the fake-location dev toggle or
// other dev-only code, or the local development config from .env.local, and
// when the staging URL and key are missing. Prints no URL or key.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEnv } from './staging.mjs';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// Strings that only exist in dev-only code (behind a literal __DEV__). ASCII
// variants too, because a minifier may escape characters such as "·".
export const FORBIDDEN = [
  'Nep-locatie aan (dev)', // toggle alert
  'Tik op de kaart om je locatie te kiezen', // toggle alert text
  'DEV · nep-locatie', // badge on the map
  'nep-locatie: tik op de kaart', // same badge, ASCII part
  'Nep-locatie (dev)', // marker title and admin flag
  'nep-locatie (dev)', // profile history
  // Request field sent only in fake mode. Not the column is_fake_location,
  // which the check-in history still selects.
  /(?<!is_)fake_location/,
  'ALLOW_FAKE_LOCATION',
  'Mailpit', // local login hint
];
// Ordinary app texts: prove that the check reads the real bundle.
export const EXPECTED = ['Dichtstbijzijnde vuilbak', 'Opnieuw vragen', 'Stuur een nieuwe code'];

function bundleFiles(dir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      // .js/.hbc from `expo export`, main.jsbundle inside a built .app.
      else if (/\.(js|hbc|jsbundle)$/.test(name)) files.push(path);
    }
  };
  walk(dir);
  return files;
}

/** Returns [{ label, ok, detail }] for the given bundle text and configs. */
export function checkBundle(text, { staging, local }) {
  const results = [];
  for (const marker of EXPECTED) {
    results.push({ label: `app text "${marker}" found (the bundle is read)`, ok: text.includes(marker) });
  }
  for (const marker of FORBIDDEN) {
    const found = marker instanceof RegExp ? marker.test(text) : text.includes(marker);
    results.push({ label: `no ${marker instanceof RegExp ? marker : `"${marker}"`}`, ok: !found });
  }
  for (const [name, label] of [
    ['EXPO_PUBLIC_SUPABASE_URL', 'staging URL'],
    ['EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'staging publishable key'],
  ]) {
    results.push({ label: `${label} is in the bundle`, ok: !!staging[name] && text.includes(staging[name]) });
  }
  for (const [name, label] of [
    ['EXPO_PUBLIC_SUPABASE_URL', 'local development URL (.env.local)'],
    ['EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'local development key (.env.local)'],
  ]) {
    const value = local[name];
    if (value && !value.includes('<') && value !== staging[name]) {
      results.push({ label: `no ${label}`, ok: !text.includes(value) });
    }
  }
  return results;
}

function readEnv(file) {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

function main() {
  const dir = resolve(APP_DIR, process.argv[2] ?? 'dist-staging');
  const files = existsSync(dir) ? bundleFiles(dir) : [];
  if (files.length === 0) {
    console.error(`no .js, .hbc or .jsbundle under ${dir}; export first`);
    process.exit(1);
  }
  const text = files.map((f) => readFileSync(f, 'latin1') + '\n' + readFileSync(f, 'utf8')).join('\n');
  const results = checkBundle(text, {
    staging: readEnv(join(APP_DIR, 'staging.env.local')),
    local: readEnv(join(APP_DIR, '.env.local')),
  });
  console.log(`${files.length} bundle file(s), ${Math.round(text.length / 2 / 1024)} KB`);
  for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.label}`);
  const failed = results.filter((r) => !r.ok).length;
  if (failed) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('staging bundle: no dev toggle, no dev config, staging config present');
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main();
