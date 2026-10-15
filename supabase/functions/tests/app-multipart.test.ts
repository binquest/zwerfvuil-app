// The app builds the submit-checkin request body itself (app/src/lib/multipart.ts).
// These tests feed exactly those bytes to the edge function's parser and handler.

import { assert, assertEquals, assertFalse, assertInstanceOf } from "@std/assert";
import { buildMultipart } from "../../../app/src/lib/multipart.ts";
import { createSubmitCheckinHandler, type RecordCheckinArgs } from "../submit-checkin/handler.ts";

const USER = "11111111-1111-1111-1111-111111111111";
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const segment = (marker: number, payload: number[]) => [
  0xff,
  marker,
  (payload.length + 2) >> 8,
  (payload.length + 2) & 0xff,
  ...payload,
];
const PHOTO = new Uint8Array([
  0xff,
  0xd8,
  ...segment(0xe1, [...ascii("Exif\0\0"), ...ascii("GPS secret")]),
  ...segment(0xdb, [0, ...Array(64).fill(1)]),
  ...segment(0xda, [1, 1, 0, 0, 63, 0]),
  0x12,
  0x0d,
  0x0a,
  0x2d,
  0x2d, // CR LF "--" inside the image data must not confuse the parser
  0xff,
  0xd9,
]);

const FIELDS = { bin_id: "7", lat: "51.05", lon: "3.71", accuracy_m: "8", is_mocked: "false" };

function appRequest(fields: Record<string, string> = FIELDS): Request {
  const { body, contentType } = buildMultipart(fields, {
    field: "photo",
    filename: "photo.jpg",
    contentType: "image/jpeg",
    bytes: PHOTO,
  });
  return new Request("http://localhost/submit-checkin", {
    method: "POST",
    headers: { Authorization: "Bearer good-token", "Content-Type": contentType },
    body,
  });
}

Deno.test("the app's multipart body parses into the fields and a JPEG file", async () => {
  const form = await appRequest().formData();
  for (const [name, value] of Object.entries(FIELDS)) assertEquals(form.get(name), value, name);
  const photo = form.get("photo");
  assertInstanceOf(photo, File);
  assertEquals(photo.name, "photo.jpg");
  assertEquals(photo.type, "image/jpeg");
  assertEquals(new Uint8Array(await photo.arrayBuffer()), PHOTO);
});

Deno.test("submit-checkin accepts the app's request", async () => {
  const uploads: Uint8Array[] = [];
  const records: RecordCheckinArgs[] = [];
  const handler = createSubmitCheckinHandler({
    allowFakeLocation: false,
    authenticate: (auth) => Promise.resolve(auth === "Bearer good-token" ? USER : null),
    uploadPhoto: (_path, jpeg) => {
      uploads.push(jpeg);
      return Promise.resolve();
    },
    deletePhoto: () => Promise.resolve(),
    recordCheckin: (args) => {
      records.push(args);
      return Promise.resolve({
        ok: true,
        reason: null,
        checkin_id: "c1",
        distance_m: 8,
        retry_after_s: null,
        streak_weeks: 1,
        point_stages: [10, 11],
        points_total: 11,
        bonus_question: null,
        is_test: false,
      });
    },
    devModeAllowed: () => Promise.resolve(false),
    newId: () => "c1",
    logError: () => {},
  });

  const response = await handler(appRequest());
  assertEquals(response.status, 201, await response.clone().text());
  assertEquals(records[0].p_bin_id, 7);
  assertEquals(records[0].p_accuracy_m, 8);
  assertEquals(uploads.length, 1);
  assertFalse(new TextDecoder("latin1").decode(uploads[0]).includes("secret"), "EXIF must be stripped");
  assert(uploads[0].length < PHOTO.length);
});
