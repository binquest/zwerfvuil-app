// What the app sends to log_events (docs/ANALYTICS.md). No imports, so the
// Deno integration test sends the exact same payload.

export type Scalar = string | number | boolean | null;

/** An event in the queue on the phone. */
export interface QueuedEvent {
  /** Made on the phone: a batch sent twice is stored once. */
  id: string;
  userId: string;
  sessionId: string;
  name: string;
  props: Record<string, Scalar>;
  /** ISO 8601, from the phone's clock. */
  clientTs: string;
  /** Dev mode previews only; the server ignores it for other users. */
  isTest: boolean;
  appVersion: string | null;
  updateId: string | null;
}

export interface WireEvent {
  id: string;
  session_id: string;
  name: string;
  props: Record<string, Scalar>;
  client_ts: string;
  is_test: boolean;
}

export interface WireClient {
  app_version: string | null;
  update_id: string | null;
  platform: string;
}

/** The answer of log_events. */
export interface LogResult {
  accepted: number;
  dropped: number;
  rate_limited: number;
}

/** supabase.rpc, narrowed to what is needed here. */
export type LogEventsRpc = (
  fn: 'log_events',
  args: { events: WireEvent[]; client: WireClient },
) => PromiseLike<{ data: unknown; error: unknown; status: number }>;

export function toWire(event: QueuedEvent): WireEvent {
  return {
    id: event.id,
    session_id: event.sessionId,
    name: event.name,
    props: event.props,
    client_ts: event.clientTs,
    is_test: event.isTest,
  };
}

/**
 * Sends one batch: events of one user with the same app version and update.
 * Returns the HTTP status (0 when no answer arrived) and the answer. Never
 * throws.
 */
export async function sendEvents(
  rpc: LogEventsRpc,
  events: QueuedEvent[],
  platform: string,
): Promise<{ status: number; result: LogResult | null }> {
  const first = events[0];
  const client: WireClient = {
    app_version: first?.appVersion ?? null,
    update_id: first?.updateId ?? null,
    platform,
  };
  try {
    const { data, error, status } = await rpc('log_events', { events: events.map(toWire), client });
    // supabase-js answers status 0 with an error when the request failed.
    return { status, result: error ? null : (data as LogResult) };
  } catch {
    return { status: 0, result: null };
  }
}
