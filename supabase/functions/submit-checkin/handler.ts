// HTTP flow of submit-checkin, with all I/O injected so it can be tested
// without Supabase (supabase/functions/tests/handler.test.ts).
//
// Request: POST multipart/form-data with
//   bin_id, lat, lon, accuracy_m, is_mocked ("true"/"false"),
//   fake_location ("true" only with the dev escape), photo (JPEG file)
// and the user's access token in the Authorization header.

import { InvalidJpegError, stripJpegMetadata } from "../_shared/jpeg.ts";
import { messageFor, SUCCESS_MESSAGE } from "./messages.ts";
import {
  BONUS_POINTS,
  type Details,
  HTTP_STATUS,
  MAX_PHOTO_BYTES,
  type RejectCode,
  STREAK_MULTIPLIER,
  validateCheckinFields,
  validatePhotoSize,
} from "./rules.ts";

export const PHOTO_BUCKET = "checkin-photos";
const FIELD_NAMES = ["bin_id", "lat", "lon", "accuracy_m", "is_mocked", "fake_location"] as const;
const DB_REASONS = new Set<RejectCode>([
  "bin_not_found",
  "bin_inactive",
  "bin_not_eligible",
  "too_far",
  "cooldown",
  "daily_limit",
  "fake_location_not_allowed",
]);

export interface RecordCheckinArgs {
  p_checkin_id: string;
  p_user_id: string;
  p_bin_id: number;
  p_lat: number;
  p_lon: number;
  p_accuracy_m: number;
  p_is_mocked: boolean;
  p_is_fake_location: boolean;
  p_photo_path: string;
}

export interface BonusQuestion {
  key: string;
  prompt: string;
  options: { key: string; label: string }[];
}

export interface RecordCheckinResult {
  ok: boolean;
  reason: string | null;
  checkin_id: string | null;
  distance_m: number | null;
  retry_after_s: number | null;
  /** Only when ok: the streak and the point stages (base first, total last). */
  streak_weeks: number | null;
  point_stages: number[] | null;
  points_total: number | null;
  bonus_question: BonusQuestion | null;
  /** Dev mode (fake location or streak override): kept apart from real data. */
  is_test: boolean | null;
}

export interface CheckinDeps {
  /** False in production: fake locations are refused before the database. */
  allowFakeLocation: boolean;
  /** Returns the user id for a valid access token, otherwise null. */
  authenticate(authorization: string | null): Promise<string | null>;
  uploadPhoto(path: string, jpeg: Uint8Array): Promise<void>;
  deletePhoto(path: string): Promise<void>;
  recordCheckin(args: RecordCheckinArgs): Promise<RecordCheckinResult>;
  newId(): string;
  logError(message: string, error: unknown): void;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

export function reject(code: RejectCode, details: Details = {}): Response {
  return json(HTTP_STATUS[code], { error: { code, message: messageFor(code, details), ...details } });
}

export function createSubmitCheckinHandler(deps: CheckinDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      return await handle(deps, req);
    } catch (error) {
      deps.logError("unexpected error", error);
      return reject("server_error");
    }
  };
}

async function handle(deps: CheckinDeps, req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return reject("method_not_allowed");

  const userId = await deps.authenticate(req.headers.get("Authorization"));
  if (!userId) return reject("unauthorized");

  // Refuse oversized bodies before reading them (photo + a little form overhead).
  const contentLength = Number(req.headers.get("Content-Length") ?? 0);
  if (contentLength > MAX_PHOTO_BYTES + 64 * 1024) return reject("photo_too_large", { max_bytes: MAX_PHOTO_BYTES });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return reject("invalid_request");
  }

  const fields = Object.fromEntries(
    FIELD_NAMES.map((name) => {
      const value = form.get(name);
      return [name, typeof value === "string" ? value : undefined];
    }),
  );
  const checked = validateCheckinFields(fields, { allowFakeLocation: deps.allowFakeLocation });
  if (!checked.ok) return reject(checked.code, checked.details);

  const photo = form.get("photo");
  const size = validatePhotoSize(photo instanceof File ? photo.size : 0);
  if (!size.ok) return reject(size.code, size.details);

  let jpeg: Uint8Array;
  try {
    jpeg = stripJpegMetadata(new Uint8Array(await (photo as File).arrayBuffer()));
  } catch (error) {
    if (error instanceof InvalidJpegError) return reject("invalid_photo");
    throw error;
  }

  const request = checked.value;
  const checkinId = deps.newId();
  const photoPath = `${userId}/${checkinId}.jpg`;

  try {
    await deps.uploadPhoto(photoPath, jpeg);
  } catch (error) {
    deps.logError("photo upload failed", error);
    return reject("server_error");
  }

  let result: RecordCheckinResult;
  try {
    result = await deps.recordCheckin({
      p_checkin_id: checkinId,
      p_user_id: userId,
      p_bin_id: request.binId,
      p_lat: request.lat,
      p_lon: request.lon,
      p_accuracy_m: request.accuracyM,
      p_is_mocked: request.isMocked,
      p_is_fake_location: request.fakeLocation,
      p_photo_path: photoPath,
    });
  } catch (error) {
    deps.logError("record_checkin failed", error);
    await deletePhotoQuietly(deps, photoPath);
    return reject("server_error");
  }

  if (!result.ok) {
    await deletePhotoQuietly(deps, photoPath);
    const reason = result.reason as RejectCode;
    if (!DB_REASONS.has(reason)) {
      deps.logError("unknown record_checkin reason", result.reason);
      return reject("server_error");
    }
    const details: Details = {};
    if (result.distance_m !== null) details.distance_m = Math.round(result.distance_m * 10) / 10;
    if (result.retry_after_s !== null) details.retry_after_s = result.retry_after_s;
    return reject(reason, details);
  }

  // The check-in is stored either way; without points the app shows a plain
  // confirmation instead of the reveal.
  const stages = result.point_stages ?? [];
  const hasPoints = stages.length > 0 && result.points_total !== null && result.streak_weeks !== null;
  if (!hasPoints) deps.logError("record_checkin returned no points", result);

  return json(201, {
    checkin_id: result.checkin_id,
    status: "pending",
    distance_m: result.distance_m === null ? null : Math.round(result.distance_m * 10) / 10,
    message: SUCCESS_MESSAGE,
    // The app animates exactly these numbers: the base, then one stage per
    // streak multiplier. Granted when an admin approves the check-in.
    points: hasPoints
      ? {
        base: stages[0],
        multiplier: STREAK_MULTIPLIER,
        streak_weeks: result.streak_weeks,
        stages: stages.slice(1),
        total: result.points_total,
      }
      : null,
    bonus_question: result.bonus_question ? { ...result.bonus_question, points: BONUS_POINTS } : null,
    is_test: result.is_test === true,
  });
}

async function deletePhotoQuietly(deps: CheckinDeps, path: string): Promise<void> {
  try {
    await deps.deletePhoto(path);
  } catch (error) {
    deps.logError("could not delete photo of a rejected check-in", error);
  }
}
