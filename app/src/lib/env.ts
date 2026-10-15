// Public configuration, inlined by Expo at bundle time: from app/.env.local for
// local development, from app/staging.env.local (scripts/staging.mjs) or the EAS
// environment for staging builds.
// Expo only inlines `process.env.EXPO_PUBLIC_*` when accessed with dot notation.

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/** "local" (default, a local Supabase on a PC) or "staging" (the homeserver VM). */
export const APP_ENV = process.env.EXPO_PUBLIC_APP_ENV || 'local';

function problem(name: string, value: string | undefined): string | null {
  if (!value) return `${name} ontbreekt`;
  if (value.includes('<')) return `${name} bevat nog een placeholder`;
  return null;
}

function stagingProblem(): string | null {
  if (APP_ENV !== 'staging' || !url) return null;
  return url.startsWith('https://') ? null : 'EXPO_PUBLIC_SUPABASE_URL moet voor staging met https:// beginnen';
}

/** A Dutch explanation when the configuration is missing or incomplete, otherwise null. */
export const CONFIG_ERROR: string | null =
  [problem('EXPO_PUBLIC_SUPABASE_URL', url), problem('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', key), stagingProblem()]
    .filter(Boolean)
    .join(', ') || null;

// Fallbacks keep createClient from throwing; the app shows CONFIG_ERROR instead.
export const SUPABASE_URL = (CONFIG_ERROR ? 'http://localhost:54321' : url!).replace(/\/+$/, '');
export const SUPABASE_PUBLISHABLE_KEY = CONFIG_ERROR ? 'missing' : key!;
