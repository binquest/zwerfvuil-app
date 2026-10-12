// End-to-end test of submit-checkin against the local Supabase stack.
// Run with: npm run test:functions:integration   (needs: npm run db:start)
//
// Creates a throwaway user and test bins near Null Island, and removes them
// afterwards. The expected fake-location behaviour is read from
// supabase/functions/.env, so run it after (re)starting Supabase.
//
// Requests are built with the app's own multipart builder, so this tests the
// exact bytes the app sends. Set CHECKIN_API_URL (e.g. http://<TAILSCALE_IP>:54321)
// to send the check-ins through another address than 127.0.0.1.

import { assert, assertAlmostEquals, assertEquals, assertFalse } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import { buildMultipart } from "../../../app/src/lib/multipart.ts";
import { stripJpegMetadata } from "../_shared/jpeg.ts";

async function localStack(): Promise<{ apiUrl: string; anonKey: string; serviceRoleKey: string }> {
  const { stdout, success } = await new Deno.Command("node", {
    args: ["node_modules/supabase/dist/supabase.js", "status", "-o", "json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const text = new TextDecoder().decode(stdout);
  if (!success || !text.includes("{")) throw new Error("Supabase is not running (npm run db:start)");
  const status = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return { apiUrl: status.API_URL, anonKey: status.ANON_KEY, serviceRoleKey: status.SERVICE_ROLE_KEY };
}

function fakeLocationConfigured(): boolean {
  try {
    const env = Deno.readTextFileSync("supabase/functions/.env");
    return /^ALLOW_FAKE_LOCATION=true\s*$/m.test(env);
  } catch {
    return false;
  }
}

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
  ...segment(0xe1, [...ascii("Exif\0\0"), ...ascii("GPS 51.05 3.71 secret")]),
  ...segment(0xdb, [0, ...Array(64).fill(1)]),
  ...segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
  ...segment(0xda, [1, 1, 0, 0, 63, 0]),
  0x12,
  0x34,
  0xff,
  0xd9,
]);

/** A structurally valid JPEG of roughly `bytes` size (random scan data without 0xFF). */
function largePhoto(bytes: number): Uint8Array<ArrayBuffer> {
  const header = PHOTO.subarray(0, PHOTO.length - 4); // up to and including the scan header
  const scan = new Uint8Array(bytes);
  for (let i = 0; i < scan.length; i += 65536) crypto.getRandomValues(scan.subarray(i, i + 65536));
  for (let i = 0; i < scan.length; i++) if (scan[i] === 0xff) scan[i] = 0xfe;
  const out = new Uint8Array(header.length + scan.length + 2);
  out.set(header);
  out.set(scan, header.length);
  out.set([0xff, 0xd9], header.length + scan.length);
  return out;
}

// Metres per degree of latitude at the equator (WGS84).
const M_PER_DEG_LAT = 110574.3;
const BIN_LAT = 0.01;
const BIN_LON = 0.01;

Deno.test("submit-checkin end to end", async (t) => {
  const { apiUrl, anonKey, serviceRoleKey } = await localStack();
  const checkinUrl = `${Deno.env.get("CHECKIN_API_URL") ?? apiUrl}/functions/v1/submit-checkin`;
  const admin = createClient(apiUrl, serviceRoleKey, { auth: { persistSession: false } });
  const client = createClient(apiUrl, anonKey, { auth: { persistSession: false } });
  const expectFake = fakeLocationConfigured();
  // The database's own marker (private.app_environment): record_checkin only
  // stores fake locations when it says 'local'.
  const { data: dbEnvironment } = await admin.rpc("app_environment");

  const email = `checkin-it-${crypto.randomUUID()}@example.test`;
  const password = crypto.randomUUID() + crypto.randomUUID();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError) throw createError;
  const userId = created.user.id;
  const binIds: number[] = [];

  try {
    const { data: session, error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    const token = session.session!.access_token;

    // Bins: A eligible, B not eligible, C and D eligible (all ~200 m apart).
    const { data: bins, error: binError } = await admin.from("bins").insert([
      { source: "user", geom: `SRID=4326;POINT(${BIN_LON} ${BIN_LAT})`, eligible: true },
      { source: "user", geom: `SRID=4326;POINT(${BIN_LON + 0.002} ${BIN_LAT})`, eligible: false },
      { source: "user", geom: `SRID=4326;POINT(${BIN_LON + 0.004} ${BIN_LAT})`, eligible: true },
      { source: "user", geom: `SRID=4326;POINT(${BIN_LON + 0.006} ${BIN_LAT})`, eligible: true },
    ]).select("id");
    if (binError) throw binError;
    binIds.push(...bins.map((b) => b.id));
    const [binA, binB, binC, binD] = binIds;
    const lonOf = (bin: number) => BIN_LON + 0.002 * binIds.indexOf(bin);

    const submit = async (
      bin: number,
      metersNorth: number,
      extra: Record<string, string> = {},
      { photo = PHOTO as Uint8Array, auth = token } = {},
    ) => {
      const fields = {
        bin_id: String(bin),
        lat: String(BIN_LAT + metersNorth / M_PER_DEG_LAT),
        lon: String(lonOf(bin)),
        accuracy_m: "8",
        is_mocked: "false",
        ...extra,
      };
      const { body, contentType } = buildMultipart(fields, {
        field: "photo",
        filename: "photo.jpg",
        contentType: "image/jpeg",
        bytes: photo,
      });
      const started = performance.now();
      const response = await fetch(checkinUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth}`, apikey: anonKey, "Content-Type": contentType },
        body,
      });
      const json = await response.json();
      return { status: response.status, body: json, uploadBytes: body.byteLength, ms: performance.now() - started };
    };

    const photosInStorage = async (): Promise<string[]> => {
      const { data, error } = await admin.storage.from("checkin-photos").list(userId);
      if (error) throw error;
      return data.map((o) => `${userId}/${o.name}`);
    };

    await t.step("the anon key is not a user", async () => {
      const { status, body } = await submit(binA, 10, {}, { auth: anonKey });
      assertEquals(status, 401);
      assertEquals(body.error.code, "unauthorized");
    });

    let checkinId = "";
    await t.step("a check-in 10 m from an eligible bin is accepted as pending", async () => {
      const { status, body } = await submit(binA, 10);
      assertEquals(status, 201, JSON.stringify(body));
      assertEquals(body.status, "pending");
      assertAlmostEquals(body.distance_m, 10, 0.2);
      checkinId = body.checkin_id;

      const { data: row } = await admin.from("checkins").select("*").eq("id", checkinId).single();
      assertEquals(row.user_id, userId);
      assertEquals(row.status, "pending");
      assertEquals(row.points_awarded, 0);
      assertEquals(row.is_fake_location, false);
      assertEquals(row.photo_path, `${userId}/${checkinId}.jpg`);
    });

    await t.step("the stored photo has no metadata and the user can read it", async () => {
      const { data, error } = await admin.storage.from("checkin-photos").download(`${userId}/${checkinId}.jpg`);
      if (error) throw error;
      const stored = new Uint8Array(await data.arrayBuffer());
      assertEquals(stored, stripJpegMetadata(PHOTO));
      assertFalse(new TextDecoder("latin1").decode(stored).includes("GPS"));

      const own = await client.storage.from("checkin-photos").download(`${userId}/${checkinId}.jpg`);
      assertEquals(own.error, null);
    });

    await t.step("a second check-in at the same bin is refused by the cooldown", async () => {
      const { status, body } = await submit(binA, 5);
      assertEquals(status, 429);
      assertEquals(body.error.code, "cooldown");
      assert(body.error.retry_after_s > 500);
    });

    let largeCheckinId = "";
    await t.step("a realistic 600 KB photo is accepted (upload size and duration logged)", async () => {
      const { status, body, uploadBytes, ms } = await submit(binD, 6, {}, { photo: largePhoto(600 * 1024) });
      console.log(`      via ${checkinUrl}: ${(uploadBytes / 1024).toFixed(0)} KB uploaded, ${ms.toFixed(0)} ms`);
      assertEquals(status, 201, JSON.stringify(body));
      largeCheckinId = body.checkin_id;
      const { data, error } = await admin.storage.from("checkin-photos").download(`${userId}/${body.checkin_id}.jpg`);
      if (error) throw error;
      assert(data.size > 600 * 1024, `stored photo is ${data.size} bytes`);
    });

    await t.step("too far, ineligible bin, mocked, inaccurate and invalid photo are refused", async () => {
      const tooFar = await submit(binC, 40);
      assertEquals([tooFar.status, tooFar.body.error.code], [422, "too_far"]);
      assertAlmostEquals(tooFar.body.error.distance_m, 40, 0.3);

      const ineligible = await submit(binB, 5);
      assertEquals([ineligible.status, ineligible.body.error.code], [422, "bin_not_eligible"]);

      const mocked = await submit(binC, 5, { is_mocked: "true" });
      assertEquals([mocked.status, mocked.body.error.code], [422, "mocked_location"]);

      const inaccurate = await submit(binC, 5, { accuracy_m: "45" });
      assertEquals([inaccurate.status, inaccurate.body.error.code], [422, "low_accuracy"]);

      const notJpeg = await submit(binC, 5, {}, { photo: new TextEncoder().encode("GIF89a") });
      assertEquals([notJpeg.status, notJpeg.body.error.code], [415, "invalid_photo"]);
    });

    await t.step("rejected check-ins leave no photos behind", async () => {
      assertEquals(
        (await photosInStorage()).sort(),
        [`${userId}/${checkinId}.jpg`, `${userId}/${largeCheckinId}.jpg`].sort(),
      );
    });

    const fakeCase = !expectFake
      ? "refused by the function"
      : dbEnvironment === "local"
      ? "accepted (ALLOW_FAKE_LOCATION=true, database marked local)"
      : `refused by the database (marked ${dbEnvironment ?? "nothing"}, not local)`;
    await t.step(`a fake location is ${fakeCase}`, async () => {
      const { status, body } = await submit(binC, 3, { fake_location: "true", accuracy_m: "" });
      if (expectFake && dbEnvironment === "local") {
        assertEquals(status, 201, JSON.stringify(body));
        const { data: row } = await admin.from("checkins").select("is_fake_location").eq("id", body.checkin_id)
          .single();
        assertEquals(row?.is_fake_location, true);
      } else if (expectFake) {
        // The function lets it through; record_checkin raises and nothing is stored.
        assertEquals([status, body.error.code], [500, "server_error"]);
        const { count } = await admin.from("checkins").select("id", { count: "exact", head: true })
          .eq("user_id", userId).eq("is_fake_location", true);
        assertEquals(count, 0);
      } else {
        assertEquals([status, body.error.code], [403, "fake_location_not_allowed"]);
      }
    });

    await t.step("no points before approval, and users cannot call record_checkin", async () => {
      const authed = createClient(apiUrl, anonKey, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      });
      const { data: profile } = await authed.from("profiles").select("points").eq("id", userId).single();
      assertEquals(profile?.points, 0);
      const { error } = await authed.rpc("record_checkin", {
        p_checkin_id: crypto.randomUUID(),
        p_user_id: userId,
        p_bin_id: binC,
        p_lat: BIN_LAT,
        p_lon: lonOf(binC),
        p_accuracy_m: 1,
        p_is_mocked: false,
        p_is_fake_location: false,
        p_photo_path: "x.jpg",
      });
      assertEquals(error?.code, "42501");
    });
  } finally {
    const photos = await admin.storage.from("checkin-photos").list(userId);
    if (photos.data?.length) {
      await admin.storage.from("checkin-photos").remove(photos.data.map((o) => `${userId}/${o.name}`));
    }
    await admin.auth.admin.deleteUser(userId); // cascades to profile and check-ins
    if (binIds.length) await admin.from("bins").delete().in("id", binIds);
  }
});
