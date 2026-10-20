import { describe, expect, it } from '@jest/globals';

import { FAILURE_TITLE, localFailure, parseCheckinResponse } from '../checkin';

const json = (value: unknown) => JSON.stringify(value);

describe('parseCheckinResponse', () => {
  it('reads a successful check-in', () => {
    expect(
      parseCheckinResponse(
        201,
        json({ checkin_id: 'abc', status: 'pending', distance_m: 12.3, message: 'Bedankt! Je inworp wacht op goedkeuring.' }),
      ),
    ).toEqual({
      ok: true,
      checkinId: 'abc',
      distanceM: 12.3,
      message: 'Bedankt! Je inworp wacht op goedkeuring.',
      score: null,
      game: null,
      question: null,
      isTest: false,
    });
  });

  it('reads what the check-in made new', () => {
    const outcome = parseCheckinResponse(
      201,
      json({
        checkin_id: 'abc',
        game: {
          discovery: { bin_id: 58, ordinal: 12, discovered: 12, total_bins: 120, status: 'pending' },
          milestone: { threshold: 10, points: 50, status: 'pending' },
          as_of: '2026-10-15T18:00:00+00:00',
        },
      }),
    );
    expect(outcome.ok && outcome.game).toEqual({
      discovery: { binId: 58, ordinal: 12, discovered: 12, totalBins: 120, status: 'pending' },
      milestone: { threshold: 10, points: 50, status: 'pending' },
      badges: [],
      quests: [],
      chest: null,
      freezes: [],
      asOf: '2026-10-15T18:00:00+00:00',
    });
  });

  it('reads the score, the bonus question and the test flag', () => {
    const body = json({
      checkin_id: 'abc',
      status: 'pending',
      distance_m: 4,
      message: 'Bedankt!',
      score: {
        steps: [
          { kind: 'base', label: 'BASIS', chips: 10, mult: 1, total: 10 },
          { kind: 'streak', label: 'REEKS', weeks: 2, per_week: 1.1, stages: [{ mult: 1.1, total: 11 }, { mult: 1.21, total: 12 }] },
        ],
        total: 12,
      },
      bonus_question: { key: 'find_ease', prompt: 'Hoe makkelijk?', options: [{ key: 'easy', label: 'Meteen' }, { key: 'hard', label: 'Moeilijk' }], points: 5 },
      is_test: true,
    });
    expect(parseCheckinResponse(201, body)).toMatchObject({
      ok: true,
      score: {
        steps: [
          { kind: 'base', chips: 10, total: 10 },
          { kind: 'streak', weeks: 2, perWeek: 1.1, stages: [{ mult: 1.1, total: 11 }, { mult: 1.21, total: 12 }] },
        ],
        total: 12,
      },
      question: { key: 'find_ease', points: 5 },
      isTest: true,
    });
  });

  it('has no score (a plain confirmation) when the server sent the old points object', () => {
    const body = json({ checkin_id: 'abc', points: { base: 10, multiplier: 1.1, streak_weeks: 2, stages: [11, 12], total: 12 } });
    expect(parseCheckinResponse(201, body)).toMatchObject({ ok: true, score: null });
  });

  it('shows the server message of a refusal as "rejected"', () => {
    const body = json({ error: { code: 'too_far', message: 'Je bent te ver van de vuilbak (32 m, max. 25 m).' } });
    expect(parseCheckinResponse(422, body)).toEqual({
      ok: false,
      kind: 'rejected',
      code: 'too_far',
      message: 'Je bent te ver van de vuilbak (32 m, max. 25 m).',
    });
  });

  it('treats a missing or expired session as an auth problem', () => {
    // The API gateway answers before the function runs.
    expect(parseCheckinResponse(401, json({ msg: 'Invalid JWT' }))).toMatchObject({ kind: 'auth', code: 'http_401' });
    const fromFunction = json({ error: { code: 'unauthorized', message: 'Je bent niet aangemeld.' } });
    expect(parseCheckinResponse(401, fromFunction)).toMatchObject({ kind: 'auth', code: 'unauthorized' });
  });

  it('reports 5xx answers as server errors with the status', () => {
    expect(parseCheckinResponse(502, '<html>Bad Gateway</html>')).toEqual({
      ok: false,
      kind: 'server',
      code: 'http_502',
      message: 'De server gaf een fout (502). Probeer het later opnieuw.',
    });
    const fromFunction = json({ error: { code: 'server_error', message: 'Er ging iets mis.' } });
    expect(parseCheckinResponse(500, fromFunction)).toMatchObject({ kind: 'server', code: 'server_error' });
  });

  it('reports answers it cannot interpret as unexpected', () => {
    expect(parseCheckinResponse(201, json({}))).toMatchObject({ kind: 'unexpected', code: 'http_201' });
    expect(parseCheckinResponse(200, 'not json')).toMatchObject({ kind: 'unexpected', code: 'http_200' });
    expect(parseCheckinResponse(404, null).message).toBe('Onverwacht antwoord van de server (status 404). Probeer het opnieuw.');
  });

  it('adds technical details only when given (dev builds)', () => {
    expect(parseCheckinResponse(503, null, 'status 503, 812 ms').message).toContain('(dev: status 503, 812 ms)');
    expect(parseCheckinResponse(503, null).message).not.toContain('dev:');
  });
});

describe('localFailure', () => {
  it('distinguishes network, timeout and photo problems', () => {
    expect(localFailure('network')).toEqual({
      ok: false,
      kind: 'network',
      code: 'network',
      message: 'Kan de server niet bereiken. Controleer je internetverbinding en of Tailscale aan staat.',
    });
    expect(localFailure('timeout').message).toBe(
      'Er kwam binnen 60 seconden geen antwoord. Probeer het opnieuw, liefst met beter bereik.',
    );
    expect(localFailure('photo').message).toBe('De foto kon niet gelezen worden. Neem een nieuwe foto.');
    expect(localFailure('network', 'TypeError: fetch failed').message).toContain('(dev: TypeError: fetch failed)');
  });

  it('has a distinct title per kind, and only refusals say "geweigerd"', () => {
    const titles = Object.values(FAILURE_TITLE);
    expect(new Set(titles).size).toBe(titles.length);
    expect(Object.entries(FAILURE_TITLE).filter(([, title]) => title.includes('geweigerd'))).toEqual([
      ['rejected', 'Inworp geweigerd'],
    ]);
  });
});
