// Request validation for submit-checkin. Pure functions without I/O, unit
// tested in supabase/functions/tests/rules.test.ts.
//
// Rules that need the database (distance <= 25 m, active and eligible bin,
// 10-minute cooldown per bin, 20 check-ins per day, who may send a fake
// location) live in the SQL function public.record_checkin so they are
// enforced atomically.

export const MAX_ACCURACY_M = 30;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

// For the label in the response only: the database computes the points from
// game_config (checkin_point_stages). Goes away with the points object in
// phase 2, when the response carries score.steps with each multiplier.
export const STREAK_MULTIPLIER = 1.1;

export type RejectCode =
  | "method_not_allowed"
  | "unauthorized"
  | "invalid_request"
  | "photo_required"
  | "photo_too_large"
  | "invalid_photo"
  | "fake_location_not_allowed"
  | "mocked_location"
  | "low_accuracy"
  | "bin_not_found"
  | "bin_inactive"
  | "bin_not_eligible"
  | "too_far"
  | "cooldown"
  | "daily_limit"
  | "server_error";

export const HTTP_STATUS: Record<RejectCode, number> = {
  method_not_allowed: 405,
  unauthorized: 401,
  invalid_request: 400,
  photo_required: 400,
  photo_too_large: 413,
  invalid_photo: 415,
  fake_location_not_allowed: 403,
  mocked_location: 422,
  low_accuracy: 422,
  bin_not_found: 404,
  bin_inactive: 409,
  bin_not_eligible: 422,
  too_far: 422,
  cooldown: 429,
  daily_limit: 429,
  server_error: 500,
};

export type Details = Record<string, number>;

export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; code: RejectCode; details?: Details };

export interface CheckinRequest {
  binId: number;
  lat: number;
  lon: number;
  accuracyM: number;
  isMocked: boolean;
  fakeLocation: boolean;
}

export type Fields = Record<string, string | null | undefined>;

function parseBool(value: string | null | undefined): boolean | null {
  if (value === undefined || value === null || value === "") return false;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return null;
}

function parseNumber(value: string | null | undefined): number | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseBinId(value: string | null | undefined): number | null {
  if (!value || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Validates the form fields of a check-in.
 *
 * - is_mocked=true (Android's location.mocked) is refused.
 * - accuracy_m is required and must be <= 30 m.
 * - fake_location=true (Dev mode: a location picked on the map) is refused
 *   outright when allowFakeLocation is false (production). Otherwise it skips
 *   the mock and accuracy checks and the database decides: only admins on a
 *   local or staging database, as a test check-in; the distance rules apply.
 */
export function validateCheckinFields(
  fields: Fields,
  options: { allowFakeLocation: boolean },
): Validation<CheckinRequest> {
  const binId = parseBinId(fields.bin_id);
  const lat = parseNumber(fields.lat);
  const lon = parseNumber(fields.lon);
  const isMocked = parseBool(fields.is_mocked);
  const fakeLocation = parseBool(fields.fake_location);
  if (
    binId === null || lat === null || lon === null || isMocked === null || fakeLocation === null ||
    lat < -90 || lat > 90 || lon < -180 || lon > 180
  ) {
    return { ok: false, code: "invalid_request" };
  }

  if (fakeLocation) {
    if (!options.allowFakeLocation) return { ok: false, code: "fake_location_not_allowed" };
    const accuracy = parseNumber(fields.accuracy_m);
    return {
      ok: true,
      value: { binId, lat, lon, accuracyM: accuracy !== null && accuracy >= 0 ? accuracy : 0, isMocked, fakeLocation },
    };
  }

  if (isMocked) return { ok: false, code: "mocked_location" };

  const accuracyM = parseNumber(fields.accuracy_m);
  if (accuracyM === null || accuracyM < 0) return { ok: false, code: "invalid_request" };
  if (accuracyM > MAX_ACCURACY_M) {
    return { ok: false, code: "low_accuracy", details: { accuracy_m: accuracyM, max_accuracy_m: MAX_ACCURACY_M } };
  }

  return { ok: true, value: { binId, lat, lon, accuracyM, isMocked, fakeLocation } };
}

/** Checks presence and size of the photo; the content is checked by stripJpegMetadata. */
export function validatePhotoSize(size: number | null | undefined): Validation<number> {
  if (!size) return { ok: false, code: "photo_required" };
  if (size > MAX_PHOTO_BYTES) {
    return { ok: false, code: "photo_too_large", details: { max_bytes: MAX_PHOTO_BYTES } };
  }
  return { ok: true, value: size };
}

/**
 * Fake locations exist only for Dev mode; the database decides who may use
 * them (admins on a local or staging database). With APP_ENV=production the
 * function refuses them before asking the database.
 */
export function fakeLocationPossible(env: (name: string) => string | undefined): boolean {
  return env("APP_ENV") !== "production";
}

/**
 * ALLOW_FAKE_LOCATION was the old local-only escape and is retired (Dev mode
 * replaced it). Outside a local environment the function still refuses to
 * start while it is set at all, so a stale configuration is noticed.
 */
export function assertFakeLocationConfig(env: (name: string) => string | undefined): void {
  const appEnv = env("APP_ENV");
  const local = appEnv === undefined || appEnv === "local";
  if (!local && env("ALLOW_FAKE_LOCATION") !== undefined) {
    throw new Error(`ALLOW_FAKE_LOCATION must not be set when APP_ENV=${appEnv}`);
  }
}
