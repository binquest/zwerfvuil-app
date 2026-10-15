// submit-checkin: validates a check-in server-side, stores the photo without
// metadata in the private checkin-photos bucket and records a pending
// check-in. The response carries the points the check-in earns (base and
// streak stages) and a bonus question; points are only awarded later by an
// admin (review_checkin).
//
// Env: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
// APP_ENV names the deployment (unset locally, "staging" on the staging VM,
// "production" later). Fake locations (Dev mode) are refused here when
// APP_ENV=production and otherwise decided by record_checkin: admins on a local
// or staging database only. ALLOW_FAKE_LOCATION is retired; outside a local
// environment the function refuses to start while it is set.

import { createClient } from "@supabase/supabase-js";
import { createSubmitCheckinHandler, PHOTO_BUCKET, type RecordCheckinResult } from "./handler.ts";
import { assertFakeLocationConfig, fakeLocationPossible } from "./rules.ts";

assertFakeLocationConfig((name) => Deno.env.get(name));

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceRoleKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const allowFakeLocation = fakeLocationPossible((name) => Deno.env.get(name));
if (Deno.env.get("ALLOW_FAKE_LOCATION") !== undefined) {
  console.warn("submit-checkin: ALLOW_FAKE_LOCATION is retired and ignored; remove it (Dev mode replaced it)");
}
console.log(
  `submit-checkin: started (APP_ENV=${Deno.env.get("APP_ENV") ?? "unset"}, fake locations ${
    allowFakeLocation ? "decided by the database (Dev mode)" : "refused"
  })`,
);

const handler = createSubmitCheckinHandler({
  allowFakeLocation,

  async authenticate(authorization) {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return null;
    const { data, error } = await admin.auth.getUser(token);
    return error || !data.user ? null : data.user.id;
  },

  async uploadPhoto(path, jpeg) {
    const { error } = await admin.storage.from(PHOTO_BUCKET).upload(path, jpeg, {
      contentType: "image/jpeg",
      upsert: false,
    });
    if (error) throw error;
  },

  async deletePhoto(path) {
    const { error } = await admin.storage.from(PHOTO_BUCKET).remove([path]);
    if (error) throw error;
  },

  async recordCheckin(args) {
    const { data, error } = await admin.rpc("record_checkin", args);
    if (error) throw error;
    const row = (data as RecordCheckinResult[] | null)?.[0];
    if (!row) throw new Error("record_checkin returned no row");
    return row;
  },

  async devModeAllowed(userId) {
    const { data, error } = await admin.rpc("dev_mode_allowed_for", { p_user_id: userId });
    if (error) throw error;
    return data === true;
  },

  newId: () => crypto.randomUUID(),

  logError(message, error) {
    console.error(`submit-checkin: ${message}`, error);
  },
});

Deno.serve(handler);
