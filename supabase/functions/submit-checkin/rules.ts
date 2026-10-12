// Request validation for submit-checkin. Pure functions without I/O, unit
// tested in supabase/functions/tests/rules.test.ts.
//
// Rules that need the database (distance <= 25 m, active and eligible bin,
// 10-minute cooldown per bin, 20 check-ins per day) live in the SQL function
// public.record_checkin so they are enforced atomically.

export const MAX_ACCURACY_M = 30;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

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
 * - fake_location=true is only accepted when the dev-only ALLOW_FAKE_LOCATION
 *   escape is on; it then skips the mock and accuracy checks (the location was
 *   picked on the map), but the distance rules in the database still apply.
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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "kong", "host.docker.internal"]);

/** True for the URLs a local Supabase stack uses (kong is the gateway inside Docker). */
export function isLocalSupabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return LOCAL_HOSTS.has(host) || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/**
 * APP_ENV names the deployment ("staging" on the homeserver VM). The local
 * Supabase CLI does not set it, so unset means a developer's local stack.
 */
function isLocalAppEnv(env: (name: string) => string | undefined): boolean {
  const appEnv = env("APP_ENV");
  return appEnv === undefined || appEnv === "local";
}

/**
 * The dev escape is on only when ALLOW_FAKE_LOCATION is exactly "true", APP_ENV
 * is unset or "local", AND the function runs against a local Supabase stack, so
 * it can never be enabled on staging or in a hosted project by accident. The
 * database refuses fake locations as well unless it is marked 'local'.
 */
export function fakeLocationAllowed(env: (name: string) => string | undefined): boolean {
  return env("ALLOW_FAKE_LOCATION") === "true" && isLocalAppEnv(env) && isLocalSupabaseUrl(env("SUPABASE_URL"));
}

/**
 * Throws when ALLOW_FAKE_LOCATION is set at all (any value) outside a local
 * environment, so a misconfigured deployment fails to start instead of
 * running with a setting that must not exist there.
 */
export function assertFakeLocationConfig(env: (name: string) => string | undefined): void {
  if (!isLocalAppEnv(env) && env("ALLOW_FAKE_LOCATION") !== undefined) {
    throw new Error(`ALLOW_FAKE_LOCATION must not be set when APP_ENV=${env("APP_ENV")}`);
  }
}
