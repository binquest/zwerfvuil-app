// End-to-end test of submit-checkin against the local Supabase stack.
// Run with: npm run test:functions:integration   (needs: npm run db:start)
//
// Creates a throwaway user and test bins near Null Island, and removes them
// afterwards. Fake locations are Dev mode: refused for users, a test check-in
// for admins (the local database is marked 'local').
//
// Requests are built with the app's own multipart builder, so this tests the
// exact bytes the app sends. A second throwaway user is the admin who approves
// and revokes; points are read from the ledger (point_transactions). Set CHECKIN_API_URL (e.g. http://<TAILSCALE_IP>:54321)
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
  // The database's own marker (private.app_environment): Dev mode only works
  // on 'local' and 'staging'.
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
  let adminId = "";
  const binIds: number[] = [];

  try {
    const { data: session, error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    const token = session.session!.access_token;
    const authed = createClient(apiUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // Bins: A eligible, B not eligible, C, D and E eligible (all ~200 m apart).
    const { data: bins, error: binError } = await admin.from("bins").insert([
      { source: "user", geom: `SRID=4326;POINT(${BIN_LON} ${BIN_LAT})`, eligible: true },
      { source: "user", geom: `SRID=4326;POINT(${BIN_LON + 0.002} ${BIN_LAT})`, eligible: false },
      { source: "user", geom: `SRID=4326;POINT(${BIN_LON + 0.004} ${BIN_LAT})`, eligible: true },
      { source: "user", geom: `SRID=4326;POINT(${BIN_LON + 0.006} ${BIN_LAT})`, eligible: true },
      { source: "user", geom: `SRID=4326;POINT(${BIN_LON + 0.008} ${BIN_LAT})`, eligible: true },
    ]).select("id");
    if (binError) throw binError;
    binIds.push(...bins.map((b) => b.id));
    const [binA, binB, binC, binD, binE] = binIds;
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

    /** The ledger rows of a check-in as "source:amount:status", sorted. */
    const ledgerOf = async (id: string): Promise<string[]> => {
      const { data, error } = await admin.from("point_transactions").select("source, amount, status")
        .eq("checkin_id", id);
      if (error) throw error;
      return data.map((r) => `${r.source}:${r.amount}:${r.status}`).sort();
    };

    /** The user's profile points and the sum of their granted, real ledger rows. */
    const pointsAndLedger = async (): Promise<[number, number]> => {
      const { data: profile } = await admin.from("profiles").select("points").eq("id", userId).single();
      const { data: rows, error } = await admin.from("point_transactions").select("amount")
        .eq("user_id", userId).eq("status", "granted").eq("is_test", false);
      if (error) throw error;
      return [profile?.points, rows.reduce((sum, r) => sum + r.amount, 0)];
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
      // A new user: this week is a one-week streak, so one x1.1 stage.
      assertEquals(body.points, { base: 10, multiplier: 1.1, streak_weeks: 1, stages: [11], total: 11 });
      assertEquals(body.bonus_question.key, "bin_fullness");
      assertEquals(body.bonus_question.points, 5);
      assertEquals(body.bonus_question.options.map((o: { key: string }) => o.key), ["empty", "half", "full"]);
      checkinId = body.checkin_id;

      const { data: row } = await admin.from("checkins").select("*").eq("id", checkinId).single();
      assertEquals(row.user_id, userId);
      assertEquals(row.status, "pending");
      assertEquals([row.streak_weeks, row.points_earned, row.bonus_points], [1, 11, 0]);
      assertEquals(await ledgerOf(checkinId), ["checkin:11:pending"]);
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

    await t.step("the bonus question can be answered once, for 5 points", async () => {
      const shown = await authed.rpc("mark_bonus_question_shown", { checkin_id: checkinId });
      assertEquals(shown.error, null);
      await new Promise((resolve) => setTimeout(resolve, 1300));
      const answered = await authed.rpc("answer_bonus_question", { checkin_id: checkinId, answer: "half" });
      assertEquals([answered.error, answered.data], [null, 5]);
      const again = await authed.rpc("answer_bonus_question", { checkin_id: checkinId, answer: "full" });
      assertEquals(again.error?.code, "55000");

      const { data: answer } = await admin.from("bonus_answers").select("*").eq("checkin_id", checkinId).single();
      assertEquals([answer.answer_key, answer.is_suspicious], ["half", false]);
      assert(answer.response_ms >= 1300, `response_ms ${answer.response_ms}`);
      const { data: row } = await admin.from("checkins").select("bonus_points").eq("id", checkinId).single();
      assertEquals(row?.bonus_points, 5);
      assertEquals(await ledgerOf(checkinId), ["bonus:5:pending", "checkin:11:pending"]);
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

    await t.step("a fake location from a user who is not an admin is refused by the database", async () => {
      const { status, body } = await submit(binC, 3, { fake_location: "true", accuracy_m: "" });
      assertEquals([status, body.error.code], [403, "fake_location_not_allowed"]);
      const { count } = await admin.from("checkins").select("id", { count: "exact", head: true })
        .eq("user_id", userId).eq("is_fake_location", true);
      assertEquals(count, 0);
    });

    const devMode = dbEnvironment === "local" || dbEnvironment === "staging";
    await t.step(`Dev mode (database: ${dbEnvironment ?? "no marker"}): test check-ins, override, reset`, async () => {
      if (!devMode) return;
      await admin.from("profiles").update({ is_admin: true }).eq("id", userId);

      const fake = await submit(binC, 3, { fake_location: "true", accuracy_m: "" });
      assertEquals(fake.status, 201, JSON.stringify(fake.body));
      assertEquals(fake.body.is_test, true);

      const override = await authed.rpc("set_dev_streak_override", { weeks: 4 });
      assertEquals([override.error, override.data], [null, 4]);
      const real = await submit(binE, 4);
      assertEquals(real.status, 201, JSON.stringify(real.body));
      assertEquals([real.body.is_test, real.body.points.streak_weeks, real.body.points.total], [true, 4, 15]);

      const reset = await authed.rpc("reset_dev_test_data");
      assertEquals(reset.error, null);
      const { deleted_checkins, photo_paths } = reset.data[0];
      assertEquals(deleted_checkins, 2);
      assertEquals(
        [...photo_paths].sort(),
        [`${userId}/${fake.body.checkin_id}.jpg`, `${userId}/${real.body.checkin_id}.jpg`].sort(),
      );

      // The app deletes the photos of the removed test check-ins...
      const removed = await authed.storage.from("checkin-photos").remove(photo_paths);
      assertEquals([removed.error, removed.data?.length], [null, 2]);
      // ...but cannot delete a photo that a real check-in still uses.
      const kept = await authed.storage.from("checkin-photos").remove([`${userId}/${checkinId}.jpg`]);
      assertEquals(kept.data?.length ?? 0, 0);
      assertEquals(
        (await photosInStorage()).sort(),
        [`${userId}/${checkinId}.jpg`, `${userId}/${largeCheckinId}.jpg`].sort(),
      );
      const { count: testLeft } = await admin.from("checkins").select("id", { count: "exact", head: true })
        .eq("user_id", userId).eq("is_test", true);
      assertEquals(testLeft, 0);
      await admin.from("profiles").update({ is_admin: false }).eq("id", userId);
    });

    await t.step("no points before approval, and users cannot call record_checkin", async () => {
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

    // The admin: a second throwaway user.
    const adminEmail = `checkin-it-admin-${crypto.randomUUID()}@example.test`;
    const { data: adminCreated, error: adminError } = await admin.auth.admin.createUser({
      email: adminEmail,
      password,
      email_confirm: true,
    });
    if (adminError) throw adminError;
    adminId = adminCreated.user.id;
    await admin.from("profiles").update({ is_admin: true }).eq("id", adminId);
    const adminClient = createClient(apiUrl, anonKey, { auth: { persistSession: false } });
    const { error: adminSignInError } = await adminClient.auth.signInWithPassword({ email: adminEmail, password });
    if (adminSignInError) throw adminSignInError;

    await t.step("approval grants the points, revoking takes them back (with a reason)", async () => {
      const approved = await adminClient.rpc("review_checkin", { id: checkinId, approve: true });
      assertEquals([approved.error, approved.data?.status], [null, "approved"]);
      assertEquals(await ledgerOf(checkinId), ["bonus:5:granted", "checkin:11:granted"]);
      assertEquals(await pointsAndLedger(), [16, 16]);

      const noReason = await adminClient.rpc("revoke_checkin", { id: checkinId, reason: " " });
      assertEquals(noReason.error?.code, "22023");
      const byUser = await authed.rpc("revoke_checkin", { id: checkinId, reason: "Dubbel" });
      assertEquals(byUser.error?.code, "42501");

      const revoked = await adminClient.rpc("revoke_checkin", { id: checkinId, reason: "Dubbel of misbruik" });
      assertEquals(revoked.error, null);
      assertEquals([revoked.data.status, revoked.data.review_reason], ["rejected", "Dubbel of misbruik"]);
      assert(revoked.data.revoked_at && revoked.data.reviewed_at, "revoked_at and reviewed_at are set");
      assertEquals(await ledgerOf(checkinId), ["bonus:5:revoked", "checkin:11:revoked"]);
      assertEquals(await pointsAndLedger(), [0, 0]);

      // The user sees the outcome and the reason of their own check-in.
      const { data: own } = await authed.from("checkins").select("status, review_reason, revoked_at")
        .eq("id", checkinId).single();
      assertEquals([own?.status, own?.review_reason], ["rejected", "Dubbel of misbruik"]);
      assert(own?.revoked_at, "the user sees that it was revoked");
    });

    await t.step("a review and a check-in of the same user at the same time do not deadlock", async () => {
      // Each round reviews the previous pending check-in while a new one comes
      // in, with the review starting at a different moment of the upload.
      const { data: more, error } = await admin.from("bins").insert(
        [1, 2, 3, 4, 5].map((k) => ({
          source: "user",
          geom: `SRID=4326;POINT(${BIN_LON + 0.002 * (4 + k)} ${BIN_LAT})`,
          eligible: true,
        })),
      ).select("id");
      if (error) throw error;
      binIds.push(...more.map((b) => b.id));

      let pending = largeCheckinId;
      let granted = 0;
      for (const [round, delayMs] of [0, 25, 50, 100, 200].entries()) {
        const review = (async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return await adminClient.rpc("review_checkin", { id: pending, approve: round % 2 === 0 });
        })();
        const [reviewed, submitted] = await Promise.all([review, submit(more[round].id, 4)]);
        assertEquals(reviewed.error, null, `round ${round}: ${JSON.stringify(reviewed.error)}`);
        assertEquals(submitted.status, 201, `round ${round}: ${JSON.stringify(submitted.body)}`);
        if (round % 2 === 0) granted += reviewed.data.points_earned + reviewed.data.bonus_points;
        pending = submitted.body.checkin_id;
      }
      const [points, ledger] = await pointsAndLedger();
      assertEquals([points, ledger], [granted, granted]);
    });
  } finally {
    const photos = await admin.storage.from("checkin-photos").list(userId);
    if (photos.data?.length) {
      await admin.storage.from("checkin-photos").remove(photos.data.map((o) => `${userId}/${o.name}`));
    }
    await admin.auth.admin.deleteUser(userId); // cascades to profile, check-ins and ledger
    if (adminId) await admin.auth.admin.deleteUser(adminId);
    if (binIds.length) await admin.from("bins").delete().in("id", binIds);
  }
});
