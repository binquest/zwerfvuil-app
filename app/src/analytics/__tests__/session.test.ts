import { describe, expect, it } from '@jest/globals';

import { createSessionTracker, SESSION_GAP_MS, type SessionState } from '../session';

const T0 = Date.parse('2026-10-15T10:00:00Z');
const MIN = 60_000;

function setup(saved: SessionState | null = null) {
  const clock = { now: T0 };
  let ids = 0;
  let stored = saved;
  const events: { name: string; props: unknown; sessionId: string; userId: string }[] = [];
  const tracker = createSessionTracker({
    now: () => clock.now,
    uuid: () => `s${++ids}`,
    load: () => stored,
    save: (session) => {
      stored = session;
    },
    emit: (name, props, session) => events.push({ name, props, sessionId: session.sessionId, userId: session.userId }),
  });
  const names = () => events.map((e) => e.name);
  return { tracker, clock, events, names, stored: () => stored };
}

describe('sessions', () => {
  it('a cold start opens a session and the app', () => {
    const { tracker, events, stored } = setup();
    tracker.coldStart('u1');
    expect(events).toEqual([
      { name: 'session_start', props: {}, sessionId: 's1', userId: 'u1' },
      { name: 'app_open', props: { kind: 'cold' }, sessionId: 's1', userId: 'u1' },
    ]);
    expect(stored()).toEqual({ sessionId: 's1', userId: 'u1', startedAt: T0, lastActiveAt: T0 });
  });

  it('the next start ends the session of the previous run, for its own user', () => {
    const previous = { sessionId: 'old', userId: 'u0', startedAt: T0 - 60 * MIN, lastActiveAt: T0 - 50 * MIN };
    const { tracker, events } = setup(previous);
    tracker.coldStart('u1');
    expect(events[0]).toEqual({ name: 'session_end', props: { duration_s: 600 }, sessionId: 'old', userId: 'u0' });
    expect(events.slice(1).map((e) => e.name)).toEqual(['session_start', 'app_open']);
  });

  it('without a user nothing is opened, but the previous session still ends', () => {
    const previous = { sessionId: 'old', userId: 'u0', startedAt: T0 - 2 * MIN, lastActiveAt: T0 - MIN };
    const { tracker, names, stored } = setup(previous);
    tracker.coldStart(null);
    expect(names()).toEqual(['session_end']);
    expect(tracker.current).toBeNull();
    expect(stored()).toBeNull();
  });

  it('back from the background within 30 minutes: the same session, a warm open', () => {
    const { tracker, clock, events } = setup();
    tracker.coldStart('u1');
    clock.now += 2 * MIN;
    tracker.background();
    clock.now += SESSION_GAP_MS;
    tracker.foreground();
    expect(events.slice(2)).toEqual([
      { name: 'app_background', props: { foreground_s: 120 }, sessionId: 's1', userId: 'u1' },
      { name: 'app_open', props: { kind: 'warm' }, sessionId: 's1', userId: 'u1' },
    ]);
  });

  it('back after more than 30 minutes: the old session ends where the app went away', () => {
    const { tracker, clock, events } = setup();
    tracker.coldStart('u1');
    clock.now += 5 * MIN;
    tracker.background();
    clock.now += SESSION_GAP_MS + 1;
    tracker.foreground();
    expect(events.slice(3)).toEqual([
      { name: 'session_end', props: { duration_s: 300 }, sessionId: 's1', userId: 'u1' },
      { name: 'session_start', props: {}, sessionId: 's2', userId: 'u1' },
      { name: 'app_open', props: { kind: 'warm' }, sessionId: 's2', userId: 'u1' },
    ]);
  });

  it("'active' without a background (Control Center, a permission prompt) is no warm start", () => {
    const { tracker, names } = setup();
    tracker.coldStart('u1');
    tracker.foreground();
    tracker.background();
    tracker.background();
    expect(names()).toEqual(['session_start', 'app_open', 'app_background']);
  });

  it('sign-in, other account and sign-out start and end sessions', () => {
    const { tracker, clock, events } = setup();
    tracker.coldStart(null);
    tracker.userChanged('u1');
    clock.now += MIN;
    tracker.userChanged('u1');
    tracker.userChanged('u2');
    clock.now += MIN;
    tracker.userChanged(null);
    expect(events.map((e) => [e.name, e.userId, e.sessionId])).toEqual([
      ['session_start', 'u1', 's1'],
      ['session_end', 'u1', 's1'],
      ['session_start', 'u2', 's2'],
      ['session_end', 'u2', 's2'],
    ]);
    expect(events[1].props).toEqual({ duration_s: 60 });
    expect(tracker.current).toBeNull();
  });

  it('touch keeps the end of the session up to date, also across a restart', () => {
    const { tracker, clock, stored } = setup();
    tracker.coldStart('u1');
    clock.now += 7 * MIN;
    tracker.touch();
    expect(stored()?.lastActiveAt).toBe(T0 + 7 * MIN);

    const next = setup(stored());
    next.tracker.coldStart('u1');
    expect(next.events[0]).toMatchObject({ name: 'session_end', props: { duration_s: 420 } });
  });

  it('nothing is tracked in the background without a session', () => {
    const { tracker, names } = setup();
    tracker.coldStart(null);
    tracker.background();
    tracker.foreground();
    tracker.touch();
    expect(names()).toEqual([]);
  });
});
