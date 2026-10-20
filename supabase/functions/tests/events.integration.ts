// End-to-end test of the event log against the local Supabase stack: the
// app's own payload (app/src/analytics/wire.ts) for every event the app can
// track (app/src/analytics/events.ts) goes through log_events and lands in
// app_events. Also: the whitelist in the database equals the app's names.
// Run with: npm run test:functions:integration   (needs: npm run db:start)

import { assertEquals } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import { EVENT_NAMES, type EventName, type EventProps } from "../../../app/src/analytics/events.ts";
import { type LogEventsRpc, type QueuedEvent, sendEvents } from "../../../app/src/analytics/wire.ts";

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

// One example per event, with the props the app sends (typed: a change in
// events.ts that the server would refuse shows up here).
const EXAMPLES: { [N in EventName]: EventProps[N] } = {
  app_open: { kind: "cold" },
  session_start: {},
  session_end: { duration_s: 312 },
  app_background: { foreground_s: 95 },
  screen_view: { screen: "bin/[id]" },
  map_bin_tap: { bin_id: 58, discovered: true },
  checkin_flow_start: { bin_id: 58, distance_bucket: "10_25" },
  camera_opened: { mode: "checkin" },
  photo_taken: { mode: "checkin", retake: false },
  checkin_submitted: { bin_id: 58, upload_kb: 214 },
  checkin_result: { ok: false, reason: "too_far", duration_ms: 1840 },
  reveal_shown: { total: 22, discovery: true, streak_weeks: 4, preview: false },
  reveal_skipped: { step: "streak_2" },
  bonus_question_answered: { question_key: "bin_fullness", answered: true, response_ms: 2300 },
  discovery_shown: { ordinal: 12, status: "pending", source: "reveal" },
  milestone_shown: { threshold: 10, status: "pending", source: "missed" },
  avatar_changed: { avatar_key: "vos", from: "onboarding" },
  onboarding_step: { step: "name" },
  onboarding_completed: {},
  collection_viewed: { discovered: 12, total: 120 },
  leaderboard_viewed: { period: "week" },
  report_flow_start: {},
  report_submitted: { ok: true },
  approval_shown: { approved: 2, rejected: 1, points: 33 },
  level_up_shown: { level: 4, previous: 3 },
  badge_shown: { badge_key: "early_bird", status: "granted", source: "approval" },
  quest_viewed: { open: 2, done: 1 },
  quest_completed: { template_key: "two_checkins", period: "day", source: "reveal" },
  chest_opened: { reward_kind: "points", amount: 10, days_ago: 0 },
  tip_shown: { tip: "quests" },
  notification_permission: { status: "granted", prompt: "system", from: "moment" },
  notification_scheduled: { type: "streak", in_hours: 52 },
  notification_opened: { type: "quest" },
};

Deno.test("event log end to end", async (t) => {
  const { apiUrl, anonKey, serviceRoleKey } = await localStack();
  const admin = createClient(apiUrl, serviceRoleKey, { auth: { persistSession: false } });
  const anon = createClient(apiUrl, anonKey, { auth: { persistSession: false } });

  const email = `events-it-${crypto.randomUUID()}@example.test`;
  const password = crypto.randomUUID() + crypto.randomUUID();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError) throw createError;
  const userId = created.user.id;

  const countByName = async () => {
    const { data, error } = await admin.from("app_events").select("name").eq("user_id", userId);
    if (error) throw error;
    const counts: Record<string, number> = {};
    for (const row of data) counts[row.name] = (counts[row.name] ?? 0) + 1;
    return counts;
  };

  try {
    const client = createClient(apiUrl, anonKey, { auth: { persistSession: false } });
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    const rpc: LogEventsRpc = (fn, args) => client.rpc(fn, args);

    const sessionId = crypto.randomUUID();
    const queued = (name: string, props: QueuedEvent["props"]): QueuedEvent => ({
      id: crypto.randomUUID(),
      userId,
      sessionId,
      name,
      props,
      clientTs: new Date().toISOString(),
      isTest: false,
      appVersion: "0.1.0",
      updateId: "fb4c523e-9c9a-4666-8b76-1ab4a5ab5963",
    });
    const batch = EVENT_NAMES.map((name) => queued(name, EXAMPLES[name]));

    await t.step("the whitelist in the database equals the app's event names", async () => {
      const { data, error } = await admin.from("event_names").select("name").eq("active", true);
      if (error) throw error;
      assertEquals(data.map((r) => r.name).sort(), [...EVENT_NAMES].sort());
    });

    await t.step("every event the app tracks is accepted, with the client fields", async () => {
      const { status, result } = await sendEvents(rpc, batch, "ios");
      assertEquals(status, 200);
      assertEquals(result, { accepted: EVENT_NAMES.length, dropped: 0, rate_limited: 0 });
      assertEquals(await countByName(), Object.fromEntries(EVENT_NAMES.map((name) => [name, 1])));

      const { data } = await admin.from("app_events").select(
        "session_id, props, app_version, update_id, platform, is_test",
      )
        .eq("id", batch[0].id).single();
      assertEquals(data, {
        session_id: sessionId,
        props: { kind: "cold" },
        app_version: "0.1.0",
        update_id: "fb4c523e-9c9a-4666-8b76-1ab4a5ab5963",
        platform: "ios",
        is_test: false,
      });
    });

    await t.step("a batch sent again (after a lost answer) is stored once", async () => {
      const { status, result } = await sendEvents(rpc, batch, "ios");
      assertEquals([status, result?.accepted], [200, EVENT_NAMES.length]);
      assertEquals(Object.values(await countByName()).every((n) => n === 1), true);
    });

    await t.step("a location in props and an unknown name are dropped, the rest kept", async () => {
      const { result } = await sendEvents(rpc, [
        queued("map_bin_tap", { bin_id: 58, lat: 51.05 }),
        queued("made_up", {}),
        queued("screen_view", { screen: "leaderboard" }),
      ], "ios");
      assertEquals(result, { accepted: 1, dropped: 2, rate_limited: 0 });
      assertEquals((await countByName()).screen_view, 2);
    });

    await t.step("a batch over 100 events is a 400: the app drops it instead of retrying", async () => {
      const big = Array.from({ length: 101 }, () => queued("app_open", { kind: "warm" }));
      const { status } = await sendEvents(rpc, big, "ios");
      assertEquals(status, 400);
    });

    await t.step("users read no events; without a session the call is a 401 (the app retries later)", async () => {
      const { data } = await client.from("app_events").select("id");
      assertEquals(data, []);
      const { status } = await sendEvents(
        (fn, args) => anon.rpc(fn, args),
        [queued("app_open", { kind: "cold" })],
        "ios",
      );
      assertEquals(status, 401);
    });

    await t.step("deleting the account deletes its events", async () => {
      await admin.auth.admin.deleteUser(userId);
      const { count } = await admin.from("app_events").select("id", { count: "exact", head: true }).eq(
        "user_id",
        userId,
      );
      assertEquals(count, 0);
    });
  } finally {
    await admin.auth.admin.deleteUser(userId); // harmless when the last step already did
  }
});
