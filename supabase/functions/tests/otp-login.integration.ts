// End-to-end test of the email OTP login used by the app, against the local
// stack: the mail must contain a 6-digit code (no magic link) that signs in.
// Run with: npm run test:functions:integration   (needs: npm run db:start)

import { assert, assertEquals, assertFalse, assertMatch } from "@std/assert";
import { createClient } from "@supabase/supabase-js";

async function localStack(): Promise<{ apiUrl: string; anonKey: string; serviceRoleKey: string; mailpitUrl: string }> {
  const { stdout, success } = await new Deno.Command("node", {
    args: ["node_modules/supabase/dist/supabase.js", "status", "-o", "json"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const text = new TextDecoder().decode(stdout);
  if (!success || !text.includes("{")) throw new Error("Supabase is not running (npm run db:start)");
  const status = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return {
    apiUrl: status.API_URL,
    anonKey: status.ANON_KEY,
    serviceRoleKey: status.SERVICE_ROLE_KEY,
    mailpitUrl: status.MAILPIT_URL,
  };
}

interface Mail {
  id: string;
  subject: string;
  text: string;
  html: string;
}

async function waitForMail(mailpitUrl: string, to: string, notIds: Set<string>): Promise<Mail> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const search = await fetch(`${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages } = await search.json();
    const fresh = (messages ?? []).find((m: { ID: string }) => !notIds.has(m.ID));
    if (fresh) {
      const message = await (await fetch(`${mailpitUrl}/api/v1/message/${fresh.ID}`)).json();
      return { id: fresh.ID, subject: message.Subject, text: message.Text ?? "", html: message.HTML ?? "" };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no mail for ${to} in Mailpit`);
}

function codeFrom(mail: Mail): string {
  const match = (mail.text + " " + mail.html).match(/\b(\d{6})\b/);
  if (!match) throw new Error(`no 6-digit code in mail: ${mail.text}`);
  return match[1];
}

Deno.test("email OTP login with a 6-digit code", async (t) => {
  const { apiUrl, anonKey, serviceRoleKey, mailpitUrl } = await localStack();
  const admin = createClient(apiUrl, serviceRoleKey, { auth: { persistSession: false } });
  const client = createClient(apiUrl, anonKey, { auth: { persistSession: false } });
  const email = `otp-it-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const seen = new Set<string>();
  let userId: string | null = null;

  try {
    await t.step("a new user gets a mail with a code and no magic link", async () => {
      const { error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      assertEquals(error, null);
      const mail = await waitForMail(mailpitUrl, email, seen);
      seen.add(mail.id);
      assertEquals(mail.subject, "Je inlogcode voor Zwerfvuil Gent");
      assertMatch(mail.text + mail.html, /Je inlogcode/);
      assertFalse(/href=|\/verify\?|token=/i.test(mail.html), "the mail must not contain a sign-in link");

      const { data, error: verifyError } = await client.auth.verifyOtp({ email, token: codeFrom(mail), type: "email" });
      assertEquals(verifyError, null);
      assert(data.session?.access_token);
      userId = data.user!.id;
    });

    await t.step("the new user has a profile", async () => {
      const { data } = await admin.from("profiles").select("display_name, points, is_admin").eq("id", userId!).single();
      assertEquals(data, { display_name: email.split("@")[0], points: 0, is_admin: false });
    });

    await t.step("an existing user signs in again with a new code", async () => {
      await client.auth.signOut();
      // Auth allows one mail per user per second locally (auth.email.max_frequency).
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const { error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      assertEquals(error, null);
      const mail = await waitForMail(mailpitUrl, email, seen);
      seen.add(mail.id);
      assertEquals(mail.subject, "Je inlogcode voor Zwerfvuil Gent");

      const wrong = await client.auth.verifyOtp({ email, token: "000000", type: "email" });
      assert(wrong.error, "a wrong code must fail");

      const { data, error: verifyError } = await client.auth.verifyOtp({ email, token: codeFrom(mail), type: "email" });
      assertEquals(verifyError, null);
      assertEquals(data.user?.id, userId);
    });
  } finally {
    if (userId) await admin.auth.admin.deleteUser(userId);
    if (seen.size) {
      await fetch(`${mailpitUrl}/api/v1/messages`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ IDs: [...seen] }),
      });
    }
  }
});
