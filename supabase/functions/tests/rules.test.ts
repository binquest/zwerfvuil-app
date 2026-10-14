import { assert, assertEquals, assertFalse, assertStringIncludes, assertThrows } from "@std/assert";
import {
  assertFakeLocationConfig,
  fakeLocationPossible,
  type Fields,
  MAX_PHOTO_BYTES,
  type RejectCode,
  validateCheckinFields,
  validatePhotoSize,
} from "../submit-checkin/rules.ts";
import { messageFor } from "../submit-checkin/messages.ts";

const VALID: Fields = { bin_id: "42", lat: "51.0523", lon: "3.7169", accuracy_m: "8.5", is_mocked: "false" };
const production = { allowFakeLocation: false };
const dev = { allowFakeLocation: true };

function code(fields: Fields, options = dev): RejectCode | "ok" {
  const result = validateCheckinFields(fields, options);
  return result.ok ? "ok" : result.code;
}

Deno.test("a valid check-in is parsed", () => {
  assertEquals(validateCheckinFields(VALID, production), {
    ok: true,
    value: { binId: 42, lat: 51.0523, lon: 3.7169, accuracyM: 8.5, isMocked: false, fakeLocation: false },
  });
});

Deno.test("is_mocked may be omitted (iOS does not report it)", () => {
  assertEquals(code({ ...VALID, is_mocked: undefined }), "ok");
});

Deno.test("malformed fields are invalid requests", () => {
  const bad: Fields[] = [
    { ...VALID, bin_id: undefined },
    { ...VALID, bin_id: "0" },
    { ...VALID, bin_id: "-1" },
    { ...VALID, bin_id: "1.5" },
    { ...VALID, bin_id: "abc" },
    { ...VALID, bin_id: "99999999999999999" },
    { ...VALID, lat: undefined },
    { ...VALID, lat: "abc" },
    { ...VALID, lat: "91" },
    { ...VALID, lon: "-180.1" },
    { ...VALID, lon: "Infinity" },
    { ...VALID, is_mocked: "yes" },
    { ...VALID, fake_location: "maybe" },
  ];
  for (const fields of bad) assertEquals(code(fields), "invalid_request", JSON.stringify(fields));
});

Deno.test("mocked locations are refused", () => {
  assertEquals(code({ ...VALID, is_mocked: "true" }), "mocked_location");
  assertEquals(code({ ...VALID, is_mocked: "1", accuracy_m: "500" }), "mocked_location");
});

Deno.test("accuracy must be given and at most 30 m", () => {
  assertEquals(code({ ...VALID, accuracy_m: undefined }), "invalid_request");
  assertEquals(code({ ...VALID, accuracy_m: "-1" }), "invalid_request");
  assertEquals(code({ ...VALID, accuracy_m: "0" }), "ok");
  assertEquals(code({ ...VALID, accuracy_m: "30" }), "ok");
  assertEquals(validateCheckinFields({ ...VALID, accuracy_m: "30.1" }, production), {
    ok: false,
    code: "low_accuracy",
    details: { accuracy_m: 30.1, max_accuracy_m: 30 },
  });
});

Deno.test("in production a fake location is refused before the database", () => {
  assertEquals(code({ ...VALID, fake_location: "true" }, production), "fake_location_not_allowed");
  assertEquals(code(VALID, production), "ok");
});

Deno.test("elsewhere a fake location skips the mock and accuracy checks (the database decides who)", () => {
  const result = validateCheckinFields(
    { ...VALID, fake_location: "true", is_mocked: "true", accuracy_m: undefined },
    dev,
  );
  assertEquals(result, {
    ok: true,
    value: { binId: 42, lat: 51.0523, lon: 3.7169, accuracyM: 0, isMocked: true, fakeLocation: true },
  });
  assertEquals(code({ ...VALID, fake_location: "true", accuracy_m: "500" }, dev), "ok");
});

Deno.test("real locations always follow the normal rules", () => {
  assertEquals(code({ ...VALID, is_mocked: "true" }, dev), "mocked_location");
  assertEquals(code({ ...VALID, accuracy_m: "31" }, dev), "low_accuracy");
});

Deno.test("photo size: required and at most 5 MB", () => {
  assertEquals(validatePhotoSize(0), { ok: false, code: "photo_required" });
  assertEquals(validatePhotoSize(undefined), { ok: false, code: "photo_required" });
  assertEquals(validatePhotoSize(MAX_PHOTO_BYTES), { ok: true, value: MAX_PHOTO_BYTES });
  assertEquals(validatePhotoSize(MAX_PHOTO_BYTES + 1), {
    ok: false,
    code: "photo_too_large",
    details: { max_bytes: MAX_PHOTO_BYTES },
  });
});

Deno.test("fake locations are possible everywhere except APP_ENV=production", () => {
  const env = (values: Record<string, string>) => (name: string) => values[name];
  assert(fakeLocationPossible(env({})), "local (unset)");
  assert(fakeLocationPossible(env({ APP_ENV: "local" })));
  assert(fakeLocationPossible(env({ APP_ENV: "staging" })));
  assertFalse(fakeLocationPossible(env({ APP_ENV: "production" })));
});

Deno.test("outside a local environment, the retired ALLOW_FAKE_LOCATION stops the function from starting", () => {
  const env = (values: Record<string, string>) => (name: string) => values[name];
  for (const value of ["true", "false", ""]) {
    assertThrows(
      () => assertFakeLocationConfig(env({ APP_ENV: "staging", ALLOW_FAKE_LOCATION: value })),
      Error,
      "APP_ENV=staging",
    );
  }
  assertFakeLocationConfig(env({ APP_ENV: "staging" }));
  assertFakeLocationConfig(env({ ALLOW_FAKE_LOCATION: "true" }));
  assertFakeLocationConfig(env({ APP_ENV: "local", ALLOW_FAKE_LOCATION: "true" }));
});

Deno.test("every code has a Dutch message with its details", () => {
  assertStringIncludes(messageFor("too_far", { distance_m: 31.6 }), "32 m");
  assertStringIncludes(messageFor("low_accuracy", { accuracy_m: 45, max_accuracy_m: 30 }), "±45 m");
  assertStringIncludes(messageFor("cooldown", { retry_after_s: 590 }), "10 min");
  assertStringIncludes(messageFor("cooldown", { retry_after_s: 20 }), "1 min");
  assertStringIncludes(messageFor("daily_limit"), "20 inworpen");
});
