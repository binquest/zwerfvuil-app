import { describe, expect, it } from '@jest/globals';

import { adminErrorMessage, authErrorMessage, isNetworkError, reportErrorMessage } from '../errors';

describe('error messages', () => {
  it('recognises network failures', () => {
    expect(isNetworkError(new TypeError('Network request failed'))).toBe(true);
    expect(isNetworkError({ message: 'permission denied' })).toBe(false);
    expect(reportErrorMessage(new TypeError('Network request failed'))).toContain('Geen verbinding');
  });

  it('explains the daily report limit from the database trigger', () => {
    expect(reportErrorMessage({ code: 'P0001', message: 'bin_report_daily_limit' })).toBe(
      'Je kunt maximaal 10 vuilbakken per dag melden. Probeer het morgen opnieuw.',
    );
    expect(reportErrorMessage({ code: '42501', message: 'new row violates row-level security policy' })).toBe(
      'Je melding kon niet bewaard worden. Probeer het opnieuw.',
    );
  });

  it('maps OTP errors', () => {
    expect(authErrorMessage({ code: 'otp_expired' })).toContain('ongeldig of verlopen');
    expect(authErrorMessage({ code: 'over_email_send_rate_limit' })).toContain('Te veel pogingen');
    expect(authErrorMessage({ code: 'something_else' })).toBe('Aanmelden lukte niet. Probeer het opnieuw.');
  });

  it('maps moderation errors from the review RPCs', () => {
    expect(adminErrorMessage({ code: '55000' })).toBe('Dit werd intussen al beoordeeld.');
    expect(adminErrorMessage({ code: '42501' })).toBe('Alleen admins kunnen dit doen.');
    expect(adminErrorMessage({ code: 'P0002' })).toBe('Dit item bestaat niet meer.');
  });
});
