#!/usr/bin/env node
// Publishes the current JavaScript to the "Zwerfvuil Dev" app as an EAS Update
// on the channel "dev", with the staging configuration:
//   npm run update:dev -- "Profiel: ranglijst toegevoegd"
//
// 1. Exports the iOS bundle with the staging profile (values from
//    staging.env.local, no .env files) and APP_VARIANT=development, into
//    dist-update/.
// 2. Checks it like the staging bundle: staging config present, no local
//    config, no old dev toggle.
// 3. Uploads exactly that export (`eas update --skip-bundler`).
//
// Needs `npx eas-cli login` once on this PC. Prints no URL or key. The update
// only reaches apps with the same runtime version (app.config.ts).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEnv, stagingEnv, validate } from './staging.mjs';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const EAS_CLI = 'eas-cli@24.14.0';
const OUT = 'dist-update';
const CHANNEL = 'dev';
const WINDOWS = process.platform === 'win32';

const message = process.argv.slice(2).join(' ').trim();
if (!message) {
  console.error('usage: npm run update:dev -- "<what changed>"');
  process.exit(2);
}

let values;
try {
  values = parseEnv(readFileSync(join(APP_DIR, 'staging.env.local'), 'utf8'));
} catch {
  console.error('staging.env.local not found; copy staging.env.example to staging.env.local and fill it in');
  process.exit(1);
}
const problems = validate(values);
if (problems.length) {
  console.error(`staging.env.local: ${problems.join('; ')}`);
  process.exit(1);
}
const env = { ...process.env, ...stagingEnv(values), APP_VARIANT: 'development' };

function run(command, args) {
  console.error(`> ${command} ${args.join(' ')}`);
  // npx is a .cmd file on Windows, which needs a shell.
  const result = spawnSync(command, args, { cwd: APP_DIR, stdio: 'inherit', env, shell: WINDOWS });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.error('dev update: staging profile, APP_VARIANT=development, channel ' + CHANNEL);
run('npx', ['--yes', 'expo', 'export', '--platform', 'ios', '--output-dir', OUT, '--clear']);
run('node', ['scripts/check-staging-bundle.mjs', OUT]);
// The shell joins the arguments on Windows, so quote the message there.
const quoted = WINDOWS ? `"${message.replace(/["%^&|<>]/g, "'")}"` : message;
run('npx', [
  '--yes', EAS_CLI, 'update',
  '--skip-bundler', '--input-dir', OUT,
  '--channel', CHANNEL, '--platform', 'ios',
  // Required with --non-interactive. No EAS variables are set there; the values
  // come from staging.env.local above.
  '--environment', 'preview',
  '--message', quoted, '--non-interactive',
]);
