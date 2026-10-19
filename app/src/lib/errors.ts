// Dutch messages for Supabase errors shown in the app (pure, unit tested).

type ErrorLike = { code?: string; message?: string; status?: number } | null | undefined;

const NETWORK = /network request failed|failed to fetch|fetch failed|timeout|aborted/i;

export function isNetworkError(error: ErrorLike): boolean {
  return !!error?.message && NETWORK.test(error.message);
}

export function authErrorMessage(error: ErrorLike): string {
  if (isNetworkError(error)) return 'Geen verbinding met de server. Controleer je internet.';
  switch (error?.code) {
    case 'otp_expired':
      return 'Deze code is ongeldig of verlopen. Vraag een nieuwe code aan.';
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
      return 'Te veel pogingen. Wacht even en probeer het opnieuw.';
    case 'email_address_invalid':
    case 'validation_failed':
      return 'Dit e-mailadres is ongeldig.';
    case 'signup_disabled':
      return 'Nieuwe accounts zijn momenteel uitgeschakeld.';
  }
  return 'Aanmelden lukte niet. Probeer het opnieuw.';
}

export function reportErrorMessage(error: ErrorLike): string {
  if (isNetworkError(error)) return 'Geen verbinding met de server. Controleer je internet.';
  if (error?.message?.includes('bin_report_daily_limit')) {
    return 'Je kunt maximaal 10 vuilbakken per dag melden. Probeer het morgen opnieuw.';
  }
  return 'Je melding kon niet bewaard worden. Probeer het opnieuw.';
}

export function adminErrorMessage(error: ErrorLike): string {
  if (isNetworkError(error)) return 'Geen verbinding met de server. Controleer je internet.';
  switch (error?.code) {
    case '55000':
      return 'Dit werd intussen al beoordeeld.';
    case '42501':
      return 'Alleen admins kunnen dit doen.';
    case 'P0002':
      return 'Dit item bestaat niet meer.';
    case '22023':
      return 'Geef een reden van 1 tot 200 tekens.';
  }
  return 'Dat lukte niet. Probeer het opnieuw.';
}

/** complete_onboarding, set_my_name and set_my_avatar. */
export function identityErrorMessage(error: ErrorLike): string {
  if (isNetworkError(error)) return 'Geen verbinding met de server. Controleer je internet.';
  switch (error?.code) {
    case '22023':
      return 'Deze naam kan niet. Gebruik 2 tot 24 tekens.';
    case '42501':
      return 'Deze avatar is nog vergrendeld.';
    case 'P0002':
      return 'Deze avatar bestaat niet meer. Kies een andere.';
  }
  return 'Bewaren lukte niet. Probeer het opnieuw.';
}

export function genericErrorMessage(error: ErrorLike): string {
  if (isNetworkError(error)) return 'Geen verbinding met de server. Controleer je internet.';
  return 'Er ging iets mis. Probeer het opnieuw.';
}
