import { assert, assertEquals, assertFalse, assertStringIncludes, assertThrows } from "@std/assert";
import {
  assertFakeLocationConfig,
  fakeLocationAllowed,
  type Fields,
  isLocalSupabaseUrl,
  MAX_PHOTO_BYTES,
  type RejectCode,
  validateCheckinFields,
  validatePhotoSize,
} from "../submit-checkin/rules.ts";
import { messageFor } from "../submit-checkin/messages.ts";

const VALID: Fields = { bin_id: "42", lat: "51.0523", lon: "3.7169", accuracy_m: "8.5", is_mocked: "false" };
const strict = { allowFakeLocation: false };
const dev = { allowFakeLocation: true };

function code(fields: Fields, options = strict): RejectCode | "ok" {
  const result = validateCheckinFields(fields, options);
  return result.ok ? "ok" : result.code;
}

Deno.test("a valid check-in is parsed", () => {
  assertEquals(validateCheckinFields(VALID, strict), {
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
  assertEquals(validateCheckinFields({ ...VALID, accuracy_m: "30.1" }, strict), {
    ok: false,
    code: "low_accuracy",
    details: { accuracy_m: 30.1, max_accuracy_m: 30 },
  });
});

Deno.test("a fake location is refused unless the dev escape is on", () => {
  assertEquals(code({ ...VALID, fake_location: "true" }, strict), "fake_location_not_allowed");
});

Deno.test("with the dev escape on, a fake location skips the mock and accuracy checks", () => {
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

Deno.test("with the dev escape on, real locations follow the normal rules", () => {
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

Deno.test("only local Supabase URLs count as local", () => {
  for (const url of ["http://kong:8000", "http://127.0.0.1:54321", "http://localhost:54321", "http://api.localhost"]) {
    assert(isLocalSupabaseUrl(url), url);
  }
  for (
    const url of ["https://abcd.supabase.co", "http://kong.example.com", "http://example.com/?kong", "nope", undefined]
  ) {
    assertFalse(isLocalSupabaseUrl(url), String(url));
  }
});

Deno.test("ALLOW_FAKE_LOCATION is only honoured when exactly 'true' on a local stack", () => {
  const env = (values: Record<string, string>) => (name: string) => values[name];
  assert(fakeLocationAllowed(env({ ALLOW_FAKE_LOCATION: "true", SUPABASE_URL: "http://kong:8000" })));
  assertFalse(fakeLocationAllowed(env({ SUPABASE_URL: "http://kong:8000" })), "off by default");
  assertFalse(fakeLocationAllowed(env({ ALLOW_FAKE_LOCATION: "TRUE", SUPABASE_URL: "http://kong:8000" })));
  assertFalse(fakeLocationAllowed(env({ ALLOW_FAKE_LOCATION: "1", SUPABASE_URL: "http://kong:8000" })));
  assertFalse(fakeLocationAllowed(env({ ALLOW_FAKE_LOCATION: "true", SUPABASE_URL: "https://abcd.supabase.co" })));
});

Deno.test("APP_ENV other than local switches the dev escape off, even with a local-looking URL", () => {
  const env = (values: Record<string, string>) => (name: string) => values[name];
  const local = { ALLOW_FAKE_LOCATION: "true", SUPABASE_URL: "http://kong:8000" };
  assert(fakeLocationAllowed(env({ ...local, APP_ENV: "local" })));
  for (const appEnv of ["staging", "production", "", "LOCAL"]) {
    assertFalse(fakeLocationAllowed(env({ ...local, APP_ENV: appEnv })), appEnv);
  }
  // The staging VM: gateway alias api-gw, and kong exists there as an alias too.
  assertFalse(fakeLocationAllowed(env({ ...local, APP_ENV: "staging", SUPABASE_URL: "http://api-gw:8000" })));
});

Deno.test("outside a local environment, any ALLOW_FAKE_LOCATION stops the function from starting", () => {
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
