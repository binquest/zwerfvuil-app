import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EVENT_NAMES } from '../events';

/** The names in the table under "## Events" in docs/ANALYTICS.md. */
function documentedNames(): string[] {
  const doc = readFileSync(join(__dirname, '../../../../docs/ANALYTICS.md'), 'utf8').replace(/\r\n/g, '\n');
  const start = doc.indexOf('\n## Events\n');
  expect(start).toBeGreaterThan(-1);
  const end = doc.indexOf('\n## ', start + 1);
  const section = doc.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((m) => m[1]);
}

describe('event names', () => {
  it('are the events documented in docs/ANALYTICS.md, in the same order', () => {
    expect(EVENT_NAMES).toEqual(documentedNames());
  });

  it('fit the whitelist of the server (public.event_names)', () => {
    for (const name of EVENT_NAMES) expect(name).toMatch(/^[a-z][a-z0-9_]{1,47}$/);
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
  });
});
