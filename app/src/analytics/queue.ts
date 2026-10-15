// The event queue: a memory buffer, then batches into a store on the phone
// (SQLite in the app, memory in the tests), then batches to the server. Pure
// logic with injected I/O, unit tested in __tests__/queue.test.ts.
//
// - Every event keeps the user it was tracked for; only the events of the
//   current user are sent (switching accounts on staging).
// - A 2xx answer removes the batch. Only a failed request (status 0), a 5xx
//   or a 401 is retried, after a growing pause; any other answer can never
//   succeed, so that batch is removed.
// - At most MAX_QUEUED events and MAX_AGE_MS old in the store.
// - Nothing is persisted or sent while held (a reveal or celebration plays).
// - Never throws: analytics must never break or block the app.

import type { LogResult, QueuedEvent } from './wire';

export const BATCH_SIZE = 100;
export const MAX_QUEUED = 5000;
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Events kept in memory while the store is unreachable or sending is held. */
export const MAX_BUFFERED = 1000;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 30 * 60_000;
/** Batches per flush, so one flush never runs for long. */
export const MAX_BATCHES_PER_FLUSH = 10;

export interface EventStore {
  add(events: QueuedEvent[]): Promise<void>;
  /** The oldest events of one user, in the order they were added. */
  oldest(userId: string, limit: number): Promise<QueuedEvent[]>;
  remove(ids: string[]): Promise<void>;
  count(): Promise<number>;
  /** Removes the n oldest events, of any user. */
  removeOldest(n: number): Promise<void>;
  /** Removes the events tracked before this time (ISO 8601). */
  removeBefore(clientTs: string): Promise<void>;
}

export type Transport = (events: QueuedEvent[]) => Promise<{ status: number; result: LogResult | null }>;

export interface QueueDeps {
  store: EventStore;
  transport: Transport;
  now: () => number;
  log: (message: string, detail?: unknown) => void;
}

export interface EventQueue {
  add(event: QueuedEvent): void;
  /** Moves the memory buffer into the store. */
  persist(): Promise<void>;
  /** Persists, then sends the queued events of this user. */
  flush(userId: string | null): Promise<void>;
  /** Holds persisting and sending until the returned function is called. */
  hold(): () => void;
  /** For tests and diagnostics. */
  readonly state: { buffered: number; failures: number; retryAt: number; holds: number };
}

export const isRetryable = (status: number) => status === 0 || status === 401 || status >= 500;

/** The leading events that share one app version and update: one batch has one client. */
export function sameClient(events: QueuedEvent[]): QueuedEvent[] {
  const first = events[0];
  if (!first) return [];
  const end = events.findIndex((e) => e.appVersion !== first.appVersion || e.updateId !== first.updateId);
  return end === -1 ? events : events.slice(0, end);
}

export function createEventQueue({ store, transport, now, log }: QueueDeps): EventQueue {
  let buffer: QueuedEvent[] = [];
  let failures = 0;
  let retryAt = 0;
  let holds = 0;
  // One persist or flush at a time, in order; the chain never rejects.
  let chain: Promise<void> = Promise.resolve();

  const serial = (task: () => Promise<void>): Promise<void> => {
    chain = chain.then(task).catch((error: unknown) => {
      log('analytics task failed', error);
    });
    return chain;
  };

  async function persistNow(): Promise<void> {
    if (holds > 0 || buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    try {
      await store.add(batch);
    } catch (error) {
      // Keep them for the next try, newest first when the buffer is full.
      buffer = batch.concat(buffer).slice(-MAX_BUFFERED);
      throw error;
    }
    await store.removeBefore(new Date(now() - MAX_AGE_MS).toISOString());
    const queued = await store.count();
    if (queued > MAX_QUEUED) await store.removeOldest(queued - MAX_QUEUED);
  }

  async function flushNow(userId: string | null): Promise<void> {
    await persistNow();
    if (!userId || holds > 0 || now() < retryAt) return;
    for (let i = 0; i < MAX_BATCHES_PER_FLUSH && holds === 0; i++) {
      const batch = sameClient(await store.oldest(userId, BATCH_SIZE));
      if (batch.length === 0) return;
      const { status, result } = await transport(batch);
      const ids = batch.map((e) => e.id);
      if (status >= 200 && status < 300) {
        failures = 0;
        retryAt = 0;
        if (result && (result.dropped > 0 || result.rate_limited > 0)) log('log_events refused events', result);
        await store.remove(ids);
      } else if (isRetryable(status)) {
        failures += 1;
        retryAt = now() + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
        return;
      } else {
        log('log_events refused a batch', { status, events: batch.length });
        await store.remove(ids);
      }
    }
  }

  return {
    add(event) {
      try {
        buffer.push(event);
        if (buffer.length > MAX_BUFFERED) buffer.splice(0, buffer.length - MAX_BUFFERED);
      } catch (error) {
        log('analytics add failed', error);
      }
    },
    persist: () => serial(persistNow),
    flush: (userId) => serial(() => flushNow(userId)),
    hold() {
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
      };
    },
    get state() {
      return { buffered: buffer.length, failures, retryAt, holds };
    },
  };
}
