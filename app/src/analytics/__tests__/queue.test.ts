import { describe, expect, it } from '@jest/globals';

import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  createEventQueue,
  MAX_AGE_MS,
  MAX_BUFFERED,
  MAX_QUEUED,
  sameClient,
  type EventStore,
  type Transport,
} from '../queue';
import { sendEvents, type LogEventsRpc, type QueuedEvent } from '../wire';

const T0 = Date.parse('2026-10-15T10:00:00Z');

let seq = 0;
function event(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    userId: 'u1',
    sessionId: 's1',
    name: 'screen_view',
    props: { screen: 'map' },
    clientTs: new Date(T0).toISOString(),
    isTest: false,
    appVersion: '0.1.0',
    updateId: 'up1',
    ...overrides,
  };
}

/** The SQLite store, in memory: rows in insertion order. */
function memoryStore() {
  let rows: QueuedEvent[] = [];
  let failAdd = false;
  const store: EventStore = {
    async add(events) {
      if (failAdd) throw new Error('disk full');
      for (const e of events) if (!rows.some((r) => r.id === e.id)) rows.push(e);
    },
    async oldest(userId, limit) {
      return rows.filter((r) => r.userId === userId).slice(0, limit);
    },
    async remove(ids) {
      rows = rows.filter((r) => !ids.includes(r.id));
    },
    async count() {
      return rows.length;
    },
    async removeOldest(n) {
      rows = rows.slice(n);
    },
    async removeBefore(clientTs) {
      rows = rows.filter((r) => r.clientTs >= clientTs);
    },
  };
  return {
    store,
    rows: () => rows,
    failAdd: (fail: boolean) => {
      failAdd = fail;
    },
  };
}

function setup(statuses: number[] = []) {
  const memory = memoryStore();
  const clock = { now: T0 };
  const sent: QueuedEvent[][] = [];
  const logs: string[] = [];
  const transport: Transport = async (events) => {
    sent.push(events);
    const status = statuses.length > 0 ? statuses.shift()! : 200;
    return { status, result: status === 200 ? { accepted: events.length, dropped: 0, rate_limited: 0 } : null };
  };
  const queue = createEventQueue({ store: memory.store, transport, now: () => clock.now, log: (m) => logs.push(m) });
  return { queue, memory, clock, sent, logs };
}

describe('the event queue', () => {
  it('moves the buffer into the store, then sends batches of 100', async () => {
    const { queue, memory, sent } = setup();
    for (let i = 0; i < 250; i++) queue.add(event());
    expect(queue.state.buffered).toBe(250);
    await queue.persist();
    expect(queue.state.buffered).toBe(0);
    expect(memory.rows()).toHaveLength(250);

    await queue.flush('u1');
    expect(sent.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(memory.rows()).toHaveLength(0);
  });

  it('only sends the events of the current user', async () => {
    const { queue, memory, sent } = setup();
    queue.add(event({ userId: 'u1' }));
    queue.add(event({ userId: 'u2' }));
    queue.add(event({ userId: 'u1' }));
    await queue.flush('u1');
    expect(sent).toHaveLength(1);
    expect(sent[0].map((e) => e.userId)).toEqual(['u1', 'u1']);
    expect(memory.rows().map((e) => e.userId)).toEqual(['u2']);

    await queue.flush(null);
    expect(sent).toHaveLength(1);
    expect(memory.rows()).toHaveLength(1);
  });

  it('sends one app version and update per batch', async () => {
    const { queue, sent } = setup();
    queue.add(event({ updateId: 'old' }));
    queue.add(event({ updateId: 'old' }));
    queue.add(event({ updateId: 'new' }));
    await queue.flush('u1');
    expect(sent.map((b) => b.map((e) => e.updateId))).toEqual([['old', 'old'], ['new']]);
  });

  it('retries network errors, 5xx and 401 with a growing pause', async () => {
    const { queue, memory, clock, sent } = setup([0, 503, 401, 0, 0, 0, 0, 0, 0, 0, 0]);
    queue.add(event());

    const pauses: number[] = [];
    for (let attempt = 0; attempt < 9; attempt++) {
      await queue.flush('u1');
      pauses.push(queue.state.retryAt - clock.now);
      // Too early: nothing is sent.
      await queue.flush('u1');
      clock.now = queue.state.retryAt;
    }
    expect(sent).toHaveLength(9);
    // 30 s, 1 min, 2 min, ... up to 30 min.
    expect(pauses).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60].map((m) => m * BACKOFF_BASE_MS));
    expect(Math.max(...pauses)).toBe(BACKOFF_MAX_MS);
    expect(memory.rows()).toHaveLength(1);
  });

  it('a success after failures sends again at once', async () => {
    const { queue, memory, clock, sent } = setup([500, 200, 200]);
    queue.add(event());
    await queue.flush('u1');
    clock.now = queue.state.retryAt;
    await queue.flush('u1');
    expect(memory.rows()).toHaveLength(0);
    expect(queue.state.failures).toBe(0);

    queue.add(event());
    await queue.flush('u1');
    expect(sent).toHaveLength(3);
    expect(memory.rows()).toHaveLength(0);
  });

  it('drops a batch the server will never accept (400)', async () => {
    const { queue, memory, logs } = setup([400]);
    queue.add(event());
    queue.add(event());
    await queue.flush('u1');
    expect(memory.rows()).toHaveLength(0);
    expect(queue.state.failures).toBe(0);
    expect(logs).toContain('log_events refused a batch');
  });

  it('keeps at most 5,000 events, and none older than 30 days', async () => {
    const { queue, memory } = setup();
    queue.add(event({ id: 'too-old', clientTs: new Date(T0 - MAX_AGE_MS - 1).toISOString() }));
    queue.add(event({ id: 'just-in-time', clientTs: new Date(T0 - MAX_AGE_MS + 1000).toISOString() }));
    await queue.persist();
    expect(memory.rows().map((e) => e.id)).toEqual(['just-in-time']);

    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < MAX_BUFFERED; i++) queue.add(event());
      await queue.persist();
    }
    expect(memory.rows()).toHaveLength(MAX_QUEUED);
    expect(memory.rows()[0].id).not.toBe('just-in-time');
    expect(memory.rows().at(-1)!.id).toBe(`e${seq}`);
  });

  it('keeps at most MAX_BUFFERED events in memory, the newest', () => {
    const { queue } = setup();
    for (let i = 0; i < MAX_BUFFERED + 10; i++) queue.add(event());
    expect(queue.state.buffered).toBe(MAX_BUFFERED);
  });

  it('neither persists nor sends while held', async () => {
    const { queue, memory, sent } = setup();
    const release = queue.hold();
    const release2 = queue.hold();
    queue.add(event());
    await queue.flush('u1');
    expect(memory.rows()).toHaveLength(0);
    expect(sent).toHaveLength(0);

    release();
    release(); // twice is harmless
    await queue.flush('u1');
    expect(sent).toHaveLength(0);
    release2();
    await queue.flush('u1');
    expect(sent).toHaveLength(1);
    expect(queue.state.holds).toBe(0);
  });

  it('never throws: a failing store keeps the events for the next try', async () => {
    const { queue, memory, logs } = setup();
    memory.failAdd(true);
    queue.add(event());
    await expect(queue.flush('u1')).resolves.toBeUndefined();
    expect(queue.state.buffered).toBe(1);
    expect(logs).toContain('analytics task failed');

    memory.failAdd(false);
    queue.add(event());
    await queue.persist();
    expect(memory.rows()).toHaveLength(2);
  });

  it('never throws: a failing transport is logged', async () => {
    const memory = memoryStore();
    const logs: string[] = [];
    const queue = createEventQueue({
      store: memory.store,
      transport: async () => {
        throw new Error('boom');
      },
      now: () => T0,
      log: (m) => logs.push(m),
    });
    queue.add(event());
    await expect(queue.flush('u1')).resolves.toBeUndefined();
    expect(logs).toEqual(['analytics task failed']);
    expect(memory.rows()).toHaveLength(1);
  });
});

describe('sameClient', () => {
  it('takes the leading run with one app version and update', () => {
    const a = event({ appVersion: '1', updateId: 'x' });
    const b = event({ appVersion: '1', updateId: 'x' });
    const c = event({ appVersion: '2', updateId: 'x' });
    expect(sameClient([a, b, c])).toEqual([a, b]);
    expect(sameClient([c, a])).toEqual([c]);
    expect(sameClient([])).toEqual([]);
  });
});

describe('sendEvents', () => {
  it('sends the wire format with the client of the batch', async () => {
    const calls: unknown[] = [];
    const rpc: LogEventsRpc = async (fn, args) => {
      calls.push({ fn, args });
      return { data: { accepted: 1, dropped: 0, rate_limited: 0 }, error: null, status: 200 };
    };
    const e = event({ id: 'id1', isTest: true, props: { bin_id: 5 } });
    const answer = await sendEvents(rpc, [e], 'ios');
    expect(answer).toEqual({ status: 200, result: { accepted: 1, dropped: 0, rate_limited: 0 } });
    expect(calls).toEqual([
      {
        fn: 'log_events',
        args: {
          events: [{ id: 'id1', session_id: 's1', name: 'screen_view', props: { bin_id: 5 }, client_ts: e.clientTs, is_test: true }],
          client: { app_version: '0.1.0', update_id: 'up1', platform: 'ios' },
        },
      },
    ]);
  });

  it('passes the status of an error, and 0 when the call throws', async () => {
    const failing: LogEventsRpc = async () => ({ data: null, error: { message: 'JWT expired' }, status: 401 });
    expect(await sendEvents(failing, [event()], 'ios')).toEqual({ status: 401, result: null });
    const throwing: LogEventsRpc = () => Promise.reject(new Error('offline'));
    expect(await sendEvents(throwing, [event()], 'ios')).toEqual({ status: 0, result: null });
  });
});
