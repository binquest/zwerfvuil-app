// The event queue on the phone: its own SQLite file, async API. The logic
// (batches, caps, retries) lives in queue.ts; this file only stores rows.

import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import type { EventStore } from './queue';
import type { QueuedEvent } from './wire';

const FILE = 'analytics.db';

const SCHEMA = `
  create table if not exists events (
    seq integer primary key autoincrement,
    id text not null unique,
    user_id text not null,
    client_ts text not null,
    body text not null
  );
  create index if not exists events_user_seq on events (user_id, seq);
`;

export function createSqliteStore(): EventStore {
  let opening: Promise<SQLiteDatabase> | null = null;

  const db = () =>
    (opening ??= openDatabaseAsync(FILE)
      .then(async (database) => {
        await database.execAsync(SCHEMA);
        return database;
      })
      .catch((error: unknown) => {
        opening = null; // try again next time
        throw error;
      }));

  const remove = async (ids: string[]) => {
    if (ids.length === 0) return;
    const database = await db();
    await database.runAsync(`delete from events where id in (${ids.map(() => '?').join(', ')})`, ids);
  };

  return {
    async add(events) {
      const database = await db();
      await database.withTransactionAsync(async () => {
        for (const e of events) {
          await database.runAsync('insert or ignore into events (id, user_id, client_ts, body) values (?, ?, ?, ?)', [
            e.id,
            e.userId,
            e.clientTs,
            JSON.stringify(e),
          ]);
        }
      });
    },

    async oldest(userId, limit) {
      const database = await db();
      const rows = await database.getAllAsync<{ id: string; body: string }>(
        'select id, body from events where user_id = ? order by seq limit ?',
        [userId, limit],
      );
      const events: QueuedEvent[] = [];
      const broken: string[] = [];
      for (const row of rows) {
        try {
          events.push(JSON.parse(row.body) as QueuedEvent);
        } catch {
          broken.push(row.id);
        }
      }
      // A row that cannot be read would block the queue forever.
      if (broken.length > 0) await remove(broken);
      return events;
    },

    remove,

    async count() {
      const database = await db();
      const row = await database.getFirstAsync<{ n: number }>('select count(*) as n from events');
      return row?.n ?? 0;
    },

    async removeOldest(n) {
      const database = await db();
      await database.runAsync('delete from events where seq in (select seq from events order by seq limit ?)', [n]);
    },

    async removeBefore(clientTs) {
      const database = await db();
      await database.runAsync('delete from events where client_ts < ?', [clientTs]);
    },
  };
}
