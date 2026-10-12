import { describe, expect, it } from '@jest/globals';

import { parseCheckinResponse } from '../checkin';

describe('parseCheckinResponse', () => {
  it('reads a successful check-in', () => {
    expect(
      parseCheckinResponse(201, {
        checkin_id: 'abc',
        status: 'pending',
        distance_m: 12.3,
        message: 'Bedankt! Je inworp wacht op goedkeuring.',
      }),
    ).toEqual({ ok: true, checkinId: 'abc', distanceM: 12.3, message: 'Bedankt! Je inworp wacht op goedkeuring.' });
  });

  it('shows the server message and code of a refusal', () => {
    const body = { error: { code: 'too_far', message: 'Je bent te ver van de vuilbak (32 m, max. 25 m).', distance_m: 31.7 } };
    expect(parseCheckinResponse(422, body)).toEqual({
      ok: false,
      code: 'too_far',
      message: 'Je bent te ver van de vuilbak (32 m, max. 25 m).',
    });
  });

  it('falls back to a Dutch message when the body is not from the function', () => {
    // e.g. the API gateway rejecting an expired token
    expect(parseCheckinResponse(401, { msg: 'Invalid JWT' })).toEqual({
      ok: false,
      code: 'http_401',
      message: 'Je sessie is verlopen. Meld je opnieuw aan.',
    });
    expect(parseCheckinResponse(502, null).message).toBe('Er ging iets mis bij het versturen. Probeer het opnieuw.');
  });

  it('does not treat a 201 without a check-in id as success', () => {
    expect(parseCheckinResponse(201, {}).ok).toBe(false);
  });
});
