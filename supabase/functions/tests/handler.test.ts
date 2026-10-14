import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import {
  type CheckinDeps,
  createSubmitCheckinHandler,
  type RecordCheckinArgs,
  type RecordCheckinResult,
} from "../submit-checkin/handler.ts";

const USER = "11111111-1111-1111-1111-111111111111";
const CHECKIN = "99999999-9999-9999-9999-999999999999";

const segment = (
  marker: number,
  payload: number[],
) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const JPEG_WITH_EXIF = new Uint8Array([
  0xff,
  0xd8,
  ...segment(0xe1, [...ascii("Exif\0\0"), ...ascii("GPS secret")]),
  ...segment(0xdb, [0, ...Array(64).fill(1)]),
  ...segment(0xda, [1, 1, 0, 0, 63, 0]),
  0x12,
  0x34,
  0xff,
  0xd9,
]);

const QUESTION = {
  key: "bin_fullness",
  prompt: "Hoe vol zat de vuilbak?",
  options: [{ key: "empty", label: "Bijna leeg" }, { key: "half", label: "Half vol" }, {
    key: "full",
    label: "Vol of overvol",
  }],
};

const OK_RESULT: RecordCheckinResult = {
  ok: true,
  reason: null,
  checkin_id: CHECKIN,
  distance_m: 12.345,
  retry_after_s: null,
  streak_weeks: 2,
  point_stages: [10, 11, 12],
  points_total: 12,
  bonus_question: QUESTION,
  is_test: false,
};

const NO_POINTS = { streak_weeks: null, point_stages: null, points_total: null, bonus_question: null, is_test: null };

function fakeDeps(overrides: Partial<CheckinDeps> = {}) {
  const calls = {
    uploads: [] as { path: string; jpeg: Uint8Array }[],
    deletes: [] as string[],
    records: [] as RecordCheckinArgs[],
    errors: [] as string[],
  };
  const deps: CheckinDeps = {
    allowFakeLocation: false,
    authenticate: (auth) => Promise.resolve(auth === "Bearer good-token" ? USER : null),
    uploadPhoto: (path, jpeg) => {
      calls.uploads.push({ path, jpeg });
      return Promise.resolve();
    },
    deletePhoto: (path) => {
      calls.deletes.push(path);
      return Promise.resolve();
    },
    recordCheckin: (args) => {
      calls.records.push(args);
      return Promise.resolve(OK_RESULT);
    },
    newId: () => CHECKIN,
    logError: (message) => {
      calls.errors.push(message);
    },
    ...overrides,
  };
  return { handler: createSubmitCheckinHandler(deps), calls };
}

function request(
  fields: Record<string, string> = {},
  { photo = JPEG_WITH_EXIF as Uint8Array<ArrayBuffer> | null, token = "good-token", method = "POST" } = {},
): Request {
  const form = new FormData();
  const all = { bin_id: "7", lat: "51.05", lon: "3.71", accuracy_m: "8", is_mocked: "false", ...fields };
  for (const [key, value] of Object.entries(all)) form.append(key, value);
  if (photo) form.append("photo", new File([photo], "photo.jpg", { type: "image/jpeg" }));
  return new Request("http://localhost/submit-checkin", {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: method === "POST" ? form : undefined,
  });
}

async function body(response: Response) {
  return await response.json();
}

Deno.test("accepts a valid check-in, uploads the stripped photo and records it", async () => {
  const { handler, calls } = fakeDeps();
  const response = await handler(request());
  assertEquals(response.status, 201);
  assertEquals(await body(response), {
    checkin_id: CHECKIN,
    status: "pending",
    distance_m: 12.3,
    message: "Bedankt! Je inworp wacht op goedkeuring.",
    points: { base: 10, multiplier: 1.1, streak_weeks: 2, stages: [11, 12], total: 12 },
    bonus_question: { ...QUESTION, points: 5 },
    is_test: false,
  });
  assertEquals(calls.uploads.length, 1);
  assertEquals(calls.uploads[0].path, `${USER}/${CHECKIN}.jpg`);
  assertFalse(new TextDecoder("latin1").decode(calls.uploads[0].jpeg).includes("secret"), "EXIF must be stripped");
  assertEquals(calls.records, [{
    p_checkin_id: CHECKIN,
    p_user_id: USER,
    p_bin_id: 7,
    p_lat: 51.05,
    p_lon: 3.71,
    p_accuracy_m: 8,
    p_is_mocked: false,
    p_is_fake_location: false,
    p_photo_path: `${USER}/${CHECKIN}.jpg`,
  }]);
  assertEquals(calls.deletes, []);
});

Deno.test("answers CORS preflight and refuses other methods", async () => {
  const { handler } = fakeDeps();
  assertEquals((await handler(new Request("http://localhost", { method: "OPTIONS" }))).status, 204);
  assertEquals((await handler(request({}, { method: "GET" }))).status, 405);
});

Deno.test("refuses requests without a valid user token before doing anything", async () => {
  const { handler, calls } = fakeDeps();
  for (const token of ["", "bad-token"]) {
    const response = await handler(request({}, { token }));
    assertEquals(response.status, 401);
    assertEquals((await body(response)).error.code, "unauthorized");
  }
  assertEquals(calls.uploads.length + calls.records.length, 0);
});

Deno.test("validation failures never upload or record anything", async () => {
  const cases: [Record<string, string>, Uint8Array<ArrayBuffer> | null, number, string][] = [
    [{ bin_id: "x" }, JPEG_WITH_EXIF, 400, "invalid_request"],
    [{ is_mocked: "true" }, JPEG_WITH_EXIF, 422, "mocked_location"],
    [{ accuracy_m: "31" }, JPEG_WITH_EXIF, 422, "low_accuracy"],
    [{ fake_location: "true" }, JPEG_WITH_EXIF, 403, "fake_location_not_allowed"],
    [{}, null, 400, "photo_required"],
    [{}, new TextEncoder().encode("GIF89a not a jpeg"), 415, "invalid_photo"],
  ];
  for (const [fields, photo, status, code] of cases) {
    const { handler, calls } = fakeDeps();
    const response = await handler(request(fields, { photo }));
    assertEquals(response.status, status, code);
    const json = await body(response);
    assertEquals(json.error.code, code);
    assert(json.error.message.length > 0);
    assertEquals(calls.uploads.length + calls.records.length, 0, code);
  }
});

Deno.test("refuses oversized bodies from Content-Length", async () => {
  const { handler, calls } = fakeDeps();
  const req = new Request("http://localhost", {
    method: "POST",
    headers: { Authorization: "Bearer good-token", "Content-Length": String(6 * 1024 * 1024) },
    body: "x",
  });
  assertEquals((await handler(req)).status, 413);
  assertEquals(calls.uploads.length, 0);
});

Deno.test("database rejections are reported with details and the photo is deleted", async () => {
  const cases: [RecordCheckinResult, number, string, Record<string, number>, string][] = [
    [
      { ...OK_RESULT, ...NO_POINTS, ok: false, reason: "too_far", checkin_id: null, distance_m: 31.66 },
      422,
      "too_far",
      {
        distance_m: 31.7,
      },
      "32 m",
    ],
    [
      { ...OK_RESULT, ...NO_POINTS, ok: false, reason: "cooldown", checkin_id: null, retry_after_s: 300 },
      429,
      "cooldown",
      {
        distance_m: 12.3,
        retry_after_s: 300,
      },
      "5 min",
    ],
    [
      { ...OK_RESULT, ...NO_POINTS, ok: false, reason: "bin_not_eligible", checkin_id: null, distance_m: null },
      422,
      "bin_not_eligible",
      {},
      "geen punten",
    ],
    [
      { ...OK_RESULT, ...NO_POINTS, ok: false, reason: "daily_limit", checkin_id: null, retry_after_s: 3600 },
      429,
      "daily_limit",
      {
        distance_m: 12.3,
        retry_after_s: 3600,
      },
      "20 inworpen",
    ],
    [
      {
        ...OK_RESULT,
        ...NO_POINTS,
        ok: false,
        reason: "fake_location_not_allowed",
        checkin_id: null,
        distance_m: null,
      },
      403,
      "fake_location_not_allowed",
      {},
      "Dev-modus",
    ],
  ];
  for (const [result, status, code, details, text] of cases) {
    const { handler, calls } = fakeDeps({ recordCheckin: () => Promise.resolve(result) });
    const response = await handler(request());
    assertEquals(response.status, status, code);
    const { error } = await body(response);
    const { message, ...rest } = error;
    assertEquals(rest, { code, ...details });
    assertStringIncludes(message, text);
    assertEquals(calls.deletes, [`${USER}/${CHECKIN}.jpg`], code);
  }
});

Deno.test("without a streak the points are just the base, and the bonus question may be absent", async () => {
  const { handler } = fakeDeps({
    recordCheckin: () =>
      Promise.resolve({ ...OK_RESULT, streak_weeks: 0, point_stages: [10], points_total: 10, bonus_question: null }),
  });
  const data = await body(await handler(request()));
  assertEquals(data.points, { base: 10, multiplier: 1.1, streak_weeks: 0, stages: [], total: 10 });
  assertEquals(data.bonus_question, null);
});

Deno.test("a recorded check-in without points is still a success, without the points", async () => {
  const { handler, calls } = fakeDeps({ recordCheckin: () => Promise.resolve({ ...OK_RESULT, ...NO_POINTS }) });
  const response = await handler(request());
  assertEquals(response.status, 201);
  const data = await body(response);
  assertEquals([data.checkin_id, data.points, data.bonus_question], [CHECKIN, null, null]);
  assertEquals(calls.errors, ["record_checkin returned no points"]);
  assertEquals(calls.deletes, []);
});

Deno.test("an unknown database reason is a server error", async () => {
  const { handler, calls } = fakeDeps({
    recordCheckin: () => Promise.resolve({ ...OK_RESULT, ...NO_POINTS, ok: false, reason: "something_new" }),
  });
  assertEquals((await handler(request())).status, 500);
  assertEquals(calls.deletes.length, 1);
  assertEquals(calls.errors, ["unknown record_checkin reason"]);
});

Deno.test("a failing database call deletes the photo and returns a server error", async () => {
  const { handler, calls } = fakeDeps({ recordCheckin: () => Promise.reject(new Error("db down")) });
  const response = await handler(request());
  assertEquals(response.status, 500);
  assertEquals((await body(response)).error.code, "server_error");
  assertEquals(calls.deletes.length, 1);
});

Deno.test("a failing upload does not record a check-in", async () => {
  let recorded = false;
  const { handler } = fakeDeps({
    uploadPhoto: () => Promise.reject(new Error("storage down")),
    recordCheckin: () => {
      recorded = true;
      return Promise.resolve(OK_RESULT);
    },
  });
  assertEquals((await handler(request())).status, 500);
  assertFalse(recorded);
});

Deno.test("unexpected errors become a JSON server error", async () => {
  const { handler, calls } = fakeDeps({ authenticate: () => Promise.reject(new Error("auth down")) });
  const response = await handler(request());
  assertEquals(response.status, 500);
  assertEquals((await body(response)).error.code, "server_error");
  assertEquals(calls.errors, ["unexpected error"]);
});

Deno.test("outside production a fake location goes to the database, which records it as a test", async () => {
  const { handler, calls } = fakeDeps({
    allowFakeLocation: true,
    recordCheckin: (args) => {
      calls.records.push(args);
      return Promise.resolve({ ...OK_RESULT, is_test: true });
    },
  });
  const response = await handler(request({ fake_location: "true", accuracy_m: "" }));
  assertEquals(response.status, 201);
  assertEquals(calls.records[0].p_is_fake_location, true);
  assertEquals((await body(response)).is_test, true);
  assertEquals(calls.records[0].p_accuracy_m, 0);
});
