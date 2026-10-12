#!/usr/bin/env node
// Puts the staging configuration into the GitHub environment "staging" for
// the unsigned iOS build (.github/workflows/ios-staging.yml):
//   node scripts/github-secrets.mjs [owner/repo]
//
// Values come from app/staging.env.local and go to `gh secret set` on stdin,
// never as a command-line argument, and are never printed. Creates the
// environment (without protection rules) when it does not exist yet.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEnv, validate } from './staging.mjs';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENVIRONMENT = 'staging';
const NAMES = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];

function gh(args, input) {
  const result = spawnSync('gh', args, {
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: (result.stderr ?? '').trim() };
}

function main() {
  const repo = process.argv[2] ?? 'binquest/zwerfvuil-app';
  const values = parseEnv(readFileSync(join(APP_DIR, 'staging.env.local'), 'utf8'));
  const problems = validate(values);
  if (problems.length) {
    console.error(`staging.env.local: ${problems.join('; ')}`);
    process.exit(1);
  }

  if (gh(['api', `repos/${repo}/environments/${ENVIRONMENT}`]).status !== 0) {
    const created = gh(['api', '-X', 'PUT', `repos/${repo}/environments/${ENVIRONMENT}`]);
    if (created.status !== 0) {
      console.error(`creating environment ${ENVIRONMENT} failed: ${created.stderr}`);
      process.exit(1);
    }
    console.log(`created environment "${ENVIRONMENT}" in ${repo}`);
  }

  for (const name of NAMES) {
    const result = gh(['secret', 'set', name, '--env', ENVIRONMENT, '--repo', repo], values[name]);
    if (result.status !== 0) {
      console.error(`setting ${name} failed: ${result.stderr}`);
      process.exit(1);
    }
    console.log(`set ${name} (environment ${ENVIRONMENT})`);
  }
  const list = gh(['secret', 'list', '--env', ENVIRONMENT, '--repo', repo]);
  console.log(list.stdout.trim());
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main();
