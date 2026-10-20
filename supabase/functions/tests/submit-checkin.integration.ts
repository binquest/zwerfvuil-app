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

    // Granted rewards that are not of one check-in: the quests handed out today
    // (their choice depends on the user and the day).
    const questPoints = async (): Promise<number> => {
      const { data: rows, error } = await admin.from("point_transactions").select("amount")
        .eq("user_id", userId).eq("status", "granted").eq("is_test", false).is("checkin_id", null);
      if (error) throw error;
      return rows.reduce((sum, r) => sum + r.amount, 0);
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
      // A new user at a new bin: a discovery (+5 chips), then a one-week
      // streak, so one x1.1 stage on 15 chips.
      assertEquals(body.score, {
        steps: [
          { kind: "base", label: "BASIS", chips: 10, mult: 1, total: 10 },
          { kind: "discovery", label: "NIEUW", chips: 15, mult: 1, total: 15, add: 5 },
          { kind: "streak", label: "REEKS", weeks: 1, per_week: 1.1, stages: [{ mult: 1.1, total: 17 }] },
        ],
        total: 17,
        streak_extended: true,
        parts: { checkin: 11, discovery: 6 },
      });
      assertFalse("points" in body);
      assertEquals(
        [body.game.discovery.bin_id, body.game.discovery.ordinal, body.game.discovery.discovered, body.game.milestone],
        [binA, 1, 1, null],
      );
      assert(body.game.discovery.total_bins >= 1, `total_bins ${body.game.discovery.total_bins}`);
      assert(typeof body.game.as_of === "string", "as_of for mark_seen");
      // Today's three quests and this week's challenge are handed out and count
      // this check-in (every medium quest does); today's chest belongs to them.
      assertEquals(body.game.quests.map((q: { slot: string }) => q.slot), ["easy", "medium", "hard", "weekly"]);
      assert(body.game.quests[1].progress >= 1, `medium quest ${JSON.stringify(body.game.quests[1])}`);
      assertEquals([body.game.chest.status === "opened", body.game.chest.quests_total], [false, 3]);
      assertEquals(body.bonus_question.key, "bin_fullness");
      assertEquals(body.bonus_question.points, 5);
      assertEquals(body.bonus_question.options.map((o: { key: string }) => o.key), ["empty", "half", "full"]);
      checkinId = body.checkin_id;

      const { data: row } = await admin.from("checkins").select("*").eq("id", checkinId).single();
      assertEquals(row.user_id, userId);
      assertEquals(row.status, "pending");
      assertEquals([row.streak_weeks, row.points_earned, row.bonus_points], [1, 17, 0]);
      assertEquals(row.score, body.score);
      assertEquals(await ledgerOf(checkinId), ["checkin:11:pending", "discovery:6:pending"]);

      // The discovery and the badge it earned are moments until the app marks
      // them seen after the reveal (an hour badge may join, by the clock).
      const unseen = await authed.rpc("my_unseen");
      assertEquals(unseen.error, null);
      const moments = unseen.data.moments.map((m: { kind: string; bin_id?: number; key?: string }) => [
        m.kind,
        m.bin_id ?? m.key,
      ]);
      assertEquals(moments[0], ["discovery", binA]);
      assert(moments.some(([kind, key]: [string, string]) => kind === "badge" && key === "first_checkin"));
      assert(body.game.badges.some((b: { key: string; status: string }) => b.key === "first_checkin"));
      const seen = await authed.rpc("mark_seen", { kind: "moments", until: body.game.as_of });
      assertEquals(seen.error, null);
      assertEquals((await authed.rpc("my_unseen")).data.moments_total, 0);
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

    await t.step("game_catalog gives signed-in users the numbers of the config", async () => {
      const { data, error } = await authed.rpc("game_catalog");
      assertEquals(error, null);
      const { checkin_base_chips, streak_multiplier, streak_max_steps, bonus_question_points, discovery_chips } =
        data.config;
      assertEquals(
        [checkin_base_chips, streak_multiplier, streak_max_steps, bonus_question_points, discovery_chips],
        [10, 1.1, 8, 5, 5],
      );
      assertEquals(data.milestones[0], { threshold: 10, points: 50, freezes: 0 });
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
      assertEquals(await ledgerOf(checkinId), ["bonus:5:pending", "checkin:11:pending", "discovery:6:pending"]);
    });

    await t.step("a second check-in at the same bin is refused by the cooldown", async () => {
      const { status, body } = await submit(binA, 5);
      assertEquals(status, 429);
      assertEquals(body.error.code, "cooldown");
      assert(body.error.retry_after_s > 500);
    });

    let secondId = "";
    await t.step("after the cooldown a second check-in at the same bin is no discovery", async () => {
      const earlier = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      const aged = await admin.from("checkins").update({ created_at: earlier }).eq("id", checkinId);
      assertEquals(aged.error, null);
      const { status, body } = await submit(binA, 5);
      assertEquals(status, 201, JSON.stringify(body));
      assertEquals(body.score.steps.map((s: { kind: string }) => s.kind), ["base", "streak"]);
      assertEquals([body.score.total, body.score.streak_extended, body.game.discovery], [11, false, null]);
      secondId = body.checkin_id;
      assertEquals(await ledgerOf(secondId), ["checkin:11:pending"]);
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
        [`${userId}/${checkinId}.jpg`, `${userId}/${secondId}.jpg`, `${userId}/${largeCheckinId}.jpg`].sort(),
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
      assertEquals([real.body.is_test, real.body.score.steps[1].weeks, real.body.score.total], [true, 4, 15]);
      assertEquals(real.body.score.steps.map((s: { kind: string }) => s.kind), ["base", "streak"]);

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
        [`${userId}/${checkinId}.jpg`, `${userId}/${secondId}.jpg`, `${userId}/${largeCheckinId}.jpg`].sort(),
      );
      const { count: testLeft } = await admin.from("checkins").select("id", { count: "exact", head: true })
        .eq("user_id", userId).eq("is_test", true);
      assertEquals(testLeft, 0);
      // Test check-ins made no discoveries.
      const { data: found } = await admin.from("discoveries").select("bin_id").eq("user_id", userId);
      assertEquals(found?.map((d) => d.bin_id).sort(), [binA, binD].sort());
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
      assertEquals(await ledgerOf(checkinId), ["bonus:5:granted", "checkin:11:granted", "discovery:6:granted"]);
      const quests = await questPoints();
      assertEquals(await pointsAndLedger(), [22 + quests, 22 + quests]);

      // The approval celebration: the decision stays unseen until mark_seen('results').
      const unseen = await authed.rpc("my_unseen");
      assertEquals(unseen.error, null);
      const results = unseen.data.results;
      assertEquals(results.approved.map((a: { checkin_id: string }) => a.checkin_id), [checkinId]);
      assertEquals([results.gained, results.points_before, results.points_after], [22 + quests, 0, 22 + quests]);
      assertEquals(
        [results.by_source.bonus, results.by_source.checkin, results.by_source.discovery, results.by_source.quest ?? 0],
        [5, 11, 6, quests],
      );
      assertEquals([results.level_before, results.level_after, results.level_title], [1, 2, "Blikjesbuddy"]);
      assert(results.badges.some((b: { key: string }) => b.key === "first_checkin"), "Eerste inworp granted");
      const marked = await authed.rpc("mark_seen", { kind: "results", until: unseen.data.as_of });
      assertEquals(marked.error, null);
      const seen = (await authed.rpc("my_unseen")).data.results;
      assertEquals([seen.approved_count, seen.level_before, seen.level_after], [0, 2, 2]);

      const noReason = await adminClient.rpc("revoke_checkin", { id: checkinId, reason: " " });
      assertEquals(noReason.error?.code, "22023");
      const byUser = await authed.rpc("revoke_checkin", { id: checkinId, reason: "Dubbel" });
      assertEquals(byUser.error?.code, "42501");

      const revoked = await adminClient.rpc("revoke_checkin", { id: checkinId, reason: "Dubbel of misbruik" });
      assertEquals(revoked.error, null);
      assertEquals([revoked.data.status, revoked.data.review_reason], ["rejected", "Dubbel of misbruik"]);
      assert(revoked.data.revoked_at && revoked.data.reviewed_at, "revoked_at and reviewed_at are set");
      assertEquals(await ledgerOf(checkinId), ["bonus:5:revoked", "checkin:11:revoked", "discovery:6:revoked"]);
      assertEquals(await pointsAndLedger(), [0, 0]);

      // The revocation is a calm result with its reason; the level drops back.
      const afterRevoke = (await authed.rpc("my_unseen")).data.results;
      assertEquals(
        afterRevoke.rejected.map((r: { checkin_id: string; reason: string; revoked: boolean }) => [
          r.checkin_id,
          r.reason,
          r.revoked,
        ]),
        [[checkinId, "Dubbel of misbruik", true]],
      );
      // A quest that still holds over the pending check-in goes back to pending
      // and loses its granted_at, so it is missing from points_before
      // (docs/PRE-BETA.md).
      assert(
        afterRevoke.points_before >= 22 && afterRevoke.points_before <= 22 + quests,
        `points_before ${afterRevoke.points_before}`,
      );
      assertEquals([afterRevoke.points_after, afterRevoke.level_after], [0, 1]);

      // The user sees the outcome and the reason of their own check-in.
      const { data: own } = await authed.from("checkins").select("status, review_reason, revoked_at")
        .eq("id", checkinId).single();
      assertEquals([own?.status, own?.review_reason], ["rejected", "Dubbel of misbruik"]);
      assert(own?.revoked_at, "the user sees that it was revoked");
    });

    await t.step("rejecting moves the discovery to the next check-in, then takes it away", async () => {
      const discoveryOfA = async () => {
        const { data, error } = await authed.rpc("my_collection");
        assertEquals(error, null);
        return data.find((b: { bin_id: number }) => b.bin_id === binA);
      };
      // After the revocation above the second check-in at bin A holds the discovery.
      assertEquals((await discoveryOfA())?.status, "pending");
      assertEquals(await ledgerOf(secondId), ["checkin:11:pending"]);

      const rejected = await adminClient.rpc("review_checkin", { id: secondId, approve: false });
      assertEquals(rejected.error, null);
      assertEquals((await discoveryOfA())?.status ?? null, null);
      const state = await authed.rpc("my_game_state");
      assertEquals(state.error, null);
      assertEquals(state.data.discoveries.discovered, 1); // bin D only
      assertEquals(state.data.discoveries.next_milestone, { threshold: 10, points: 50, previous: 0 });
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
      const quests = await questPoints();
      assertEquals([points, ledger], [granted + quests, granted + quests]);
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
