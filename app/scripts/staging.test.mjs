// Tests for scripts/staging.mjs and scripts/check-staging-bundle.mjs.
// Run with: npm run test:scripts (node --test)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkBundle, EXPECTED, FORBIDDEN } from './check-staging-bundle.mjs';
import { parseEnv, stagingEnv, validate } from './staging.mjs';

const STAGING = {
  EXPO_PUBLIC_SUPABASE_URL: 'https://binquest-staging.tailnet-example.ts.net',
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_EXAMPLEexampleEXAMPLEexa_00000000',
};

test('parses KEY=VALUE lines with comments and quotes', () => {
  assert.deepEqual(parseEnv('# c\nA=1\r\nB="x y"\nlower=no\n\nC=\'z\''), { A: '1', B: 'x y', C: 'z' });
});

test('accepts only an https ts.net URL and a publishable key', () => {
  assert.deepEqual(validate(STAGING), []);
  assert.equal(validate({}).length, 2);
  assert.equal(validate({ ...STAGING, EXPO_PUBLIC_SUPABASE_URL: 'http://192.0.2.10:54321' }).length, 1);
  assert.ok(validate({ ...STAGING, EXPO_PUBLIC_SUPABASE_URL: 'https://binquest-staging.<tailnet>.ts.net' }).length > 0);
  assert.equal(validate({ ...STAGING, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_x' }).length, 1);
});

test('the staging environment disables .env files and marks the app as staging', () => {
  assert.deepEqual(stagingEnv(STAGING), { EXPO_NO_DOTENV: '1', EXPO_PUBLIC_APP_ENV: 'staging', ...STAGING });
});

test('the bundle check fails on dev-only strings and on the local config', () => {
  const local = { EXPO_PUBLIC_SUPABASE_URL: 'http://192.0.2.10:54321', EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_local' };
  const clean = [...EXPECTED, ...Object.values(STAGING)].join(' ');
  assert.ok(checkBundle(clean, { staging: STAGING, local }).every((r) => r.ok));
  for (const marker of FORBIDDEN) {
    const sample = marker instanceof RegExp ? 'fields.fake_location="true"' : marker;
    assert.ok(checkBundle(clean + sample, { staging: STAGING, local }).some((r) => !r.ok), String(marker));
  }
  // The history query's column name is allowed.
  assert.ok(checkBundle(clean + "select('is_fake_location')", { staging: STAGING, local }).every((r) => r.ok));
  assert.ok(checkBundle(clean + local.EXPO_PUBLIC_SUPABASE_URL, { staging: STAGING, local }).some((r) => !r.ok));
  assert.ok(checkBundle(EXPECTED.join(' '), { staging: STAGING, local }).some((r) => !r.ok), 'staging config missing');
});
