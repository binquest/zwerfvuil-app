// Dutch user-facing messages for every response code, so the app can show the
// server's message directly.

import type { Details, RejectCode } from "./rules.ts";

const round = (n: number | undefined) => (n === undefined ? "?" : String(Math.round(n)));

export function messageFor(code: RejectCode, details: Details = {}): string {
  switch (code) {
    case "method_not_allowed":
      return "Deze actie is niet toegestaan.";
    case "unauthorized":
      return "Je bent niet aangemeld. Meld je opnieuw aan.";
    case "invalid_request":
      return "De aanvraag is ongeldig. Probeer het opnieuw.";
    case "photo_required":
      return "Neem een foto van je inworp.";
    case "photo_too_large":
      return "De foto is te groot (max. 5 MB).";
    case "invalid_photo":
      return "De foto kon niet gelezen worden. Neem een nieuwe foto.";
    case "fake_location_not_allowed":
      return "Een gekozen locatie is niet toegestaan.";
    case "mocked_location":
      return "Je locatie lijkt gesimuleerd. Schakel nep-locaties uit en probeer opnieuw.";
    case "low_accuracy":
      return `Je locatie is niet nauwkeurig genoeg (±${round(details.accuracy_m)} m, max. ${
        round(details.max_accuracy_m)
      } m). Wacht even op een beter gps-signaal.`;
    case "bin_not_found":
      return "Deze vuilbak bestaat niet.";
    case "bin_inactive":
      return "Deze vuilbak is niet meer actief.";
    case "bin_not_eligible":
      return "Bij deze vuilbak kun je geen punten verdienen.";
    case "too_far":
      return `Je bent te ver van de vuilbak (${round(details.distance_m)} m, max. 25 m).`;
    case "cooldown":
      return `Je hebt deze vuilbak net gebruikt. Probeer opnieuw over ${
        Math.max(1, Math.ceil((details.retry_after_s ?? 60) / 60))
      } min.`;
    case "daily_limit":
      return "Je hebt het maximum van 20 inworpen voor vandaag bereikt.";
    case "server_error":
      return "Er ging iets mis. Probeer het later opnieuw.";
  }
}

export const SUCCESS_MESSAGE = "Bedankt! Je inworp wacht op goedkeuring.";
