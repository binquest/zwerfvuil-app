#!/usr/bin/env node
// Runs a command with the staging configuration of the app:
//   node scripts/staging.mjs npx --yes expo export --platform ios
//
// - Reads app/staging.env.local (gitignored; see staging.env.example): the
//   staging API URL (https://binquest-staging.<tailnet>.ts.net) and its
//   publishable key.
// - Sets EXPO_PUBLIC_APP_ENV=staging and EXPO_NO_DOTENV=1, so Expo loads no
//   .env file at all: the local development values in .env.local can never end
//   up in a staging build.
// - Prints no values.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(APP_DIR, 'staging.env.local');
const REQUIRED = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];

export function parseEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

/** Returns a list of problems with the staging values (empty when fine). */
export function validate(values) {
  const problems = [];
  for (const name of REQUIRED) {
    if (!values[name] || values[name].includes('<')) problems.push(`${name} is missing or a placeholder`);
  }
  const url = values.EXPO_PUBLIC_SUPABASE_URL ?? '';
  if (url && !/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\/?$/.test(url)) {
    problems.push('EXPO_PUBLIC_SUPABASE_URL must be https://<name>.<tailnet>.ts.net');
  }
  const key = values.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
  if (key && !key.startsWith('sb_publishable_')) {
    problems.push('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be a publishable key (sb_publishable_...)');
  }
  return problems;
}

export function stagingEnv(values) {
  const env = { EXPO_NO_DOTENV: '1', EXPO_PUBLIC_APP_ENV: 'staging' };
  for (const name of REQUIRED) env[name] = values[name];
  return env;
}

function main() {
  const command = process.argv.slice(2);
  if (command.length === 0) {
    console.error('usage: node scripts/staging.mjs <command> [args...]');
    process.exit(2);
  }
  let text;
  try {
    text = readFileSync(FILE, 'utf8');
  } catch {
    console.error(`${FILE} not found; copy staging.env.example to staging.env.local and fill it in`);
    process.exit(1);
  }
  const values = parseEnv(text);
  const problems = validate(values);
  if (problems.length) {
    console.error(`staging.env.local: ${problems.join('; ')}`);
    process.exit(1);
  }
  console.error('staging profile: EXPO_PUBLIC_APP_ENV=staging, .env files disabled, values from staging.env.local');
  const result = spawnSync(command[0], command.slice(1), {
    cwd: APP_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...stagingEnv(values) },
  });
  process.exit(result.status ?? 1);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main();
