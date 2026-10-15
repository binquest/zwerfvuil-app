// Interpreting submit-checkin responses and failures (pure, unit tested).

import { type BonusQuestion, parseBonusQuestion } from './points';
import { parseScore, type Score } from './score';

/**
 * - rejected: the server refused the check-in (too far, cooldown, …)
 * - auth: the session is missing or expired
 * - network: the request could not be sent or no answer arrived
 * - timeout: no answer within the time limit
 * - server: the server answered with a 5xx error
 * - unexpected: an answer the app does not understand
 * - photo: the photo could not be read on the phone
 */
export type FailureKind = 'rejected' | 'auth' | 'network' | 'timeout' | 'server' | 'unexpected' | 'photo';

export type CheckinOutcome =
  | {
      ok: true;
      checkinId: string;
      distanceM: number | null;
      message: string;
      /** The steps of the reveal; null when the server sent none (the app then skips the reveal). */
      score: Score | null;
      question: BonusQuestion | null;
      /** Dev mode: a test check-in. */
      isTest: boolean;
    }
  | { ok: false; kind: FailureKind; code: string; message: string };

export const CHECKIN_TIMEOUT_MS = 60_000;

export const FAILURE_TITLE: Record<FailureKind, string> = {
  rejected: 'Inworp geweigerd',
  auth: 'Opnieuw aanmelden',
  network: 'Geen verbinding',
  timeout: 'Versturen duurde te lang',
  server: 'Serverfout',
  unexpected: 'Onverwacht antwoord',
  photo: 'Foto niet leesbaar',
};

function withDetail(message: string, devDetail?: string): string {
  return devDetail ? `${message}\n\n(dev: ${devDetail})` : message;
}

/** A failure that happened on the phone, before or while sending. */
export function localFailure(kind: 'network' | 'timeout' | 'photo', devDetail?: string): CheckinOutcome {
  const message = {
    network: 'Kan de server niet bereiken. Controleer je internetverbinding en of Tailscale aan staat.',
    timeout: `Er kwam binnen ${CHECKIN_TIMEOUT_MS / 1000} seconden geen antwoord. Probeer het opnieuw, liefst met beter bereik.`,
    photo: 'De foto kon niet gelezen worden. Neem een nieuwe foto.',
  }[kind];
  return { ok: false, kind, code: kind, message: withDetail(message, devDetail) };
}

function parseJson(text: string | null): Record<string, any> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** Turns the HTTP status and raw body of submit-checkin into an outcome with a Dutch message. */
export function parseCheckinResponse(status: number, bodyText: string | null, devDetail?: string): CheckinOutcome {
  const data = parseJson(bodyText);

  if (status === 201 && typeof data?.checkin_id === 'string') {
    return {
      ok: true,
      checkinId: data.checkin_id,
      distanceM: typeof data.distance_m === 'number' ? data.distance_m : null,
      message: typeof data.message === 'string' ? data.message : 'Bedankt! Je inworp wacht op goedkeuring.',
      score: parseScore(data.score),
      question: parseBonusQuestion(data.bonus_question),
      isTest: data.is_test === true,
    };
  }

  if (status >= 500) {
    return {
      ok: false,
      kind: 'server',
      code: typeof data?.error?.code === 'string' ? data.error.code : `http_${status}`,
      message: withDetail(`De server gaf een fout (${status}). Probeer het later opnieuw.`, devDetail),
    };
  }

  const error = data?.error;
  if (status >= 400 && error && typeof error.code === 'string' && typeof error.message === 'string') {
    return { ok: false, kind: error.code === 'unauthorized' ? 'auth' : 'rejected', code: error.code, message: error.message };
  }

  if (status === 401) {
    // The API gateway rejects an expired token before the function runs.
    return { ok: false, kind: 'auth', code: 'http_401', message: 'Je sessie is verlopen. Meld je opnieuw aan.' };
  }

  return {
    ok: false,
    kind: 'unexpected',
    code: `http_${status}`,
    message: withDetail(`Onverwacht antwoord van de server (status ${status}). Probeer het opnieuw.`, devDetail),
  };
}
