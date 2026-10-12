// Interpreting submit-checkin responses (pure, unit tested).

export type CheckinOutcome =
  | { ok: true; checkinId: string; distanceM: number | null; message: string }
  | { ok: false; code: string; message: string };

const FALLBACK: Record<number, string> = {
  401: 'Je sessie is verlopen. Meld je opnieuw aan.',
  413: 'De foto is te groot.',
  429: 'Je hebt te snel na elkaar ingeworpen. Probeer het later opnieuw.',
};

/** Turns the HTTP status and JSON body of submit-checkin into a Dutch outcome. */
export function parseCheckinResponse(status: number, body: unknown): CheckinOutcome {
  const data = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
  if (status === 201 && typeof data.checkin_id === 'string') {
    return {
      ok: true,
      checkinId: data.checkin_id,
      distanceM: typeof data.distance_m === 'number' ? data.distance_m : null,
      message: typeof data.message === 'string' ? data.message : 'Bedankt! Je inworp wacht op goedkeuring.',
    };
  }
  const error = data.error && typeof data.error === 'object' ? data.error : {};
  const code = typeof error.code === 'string' ? error.code : `http_${status}`;
  const message =
    typeof error.message === 'string' && error.message
      ? error.message
      : (FALLBACK[status] ?? 'Er ging iets mis bij het versturen. Probeer het opnieuw.');
  return { ok: false, code, message };
}

export const NETWORK_ERROR_MESSAGE =
  'Geen verbinding met de server. Controleer je internet en of je pc bereikbaar is (Tailscale).';
