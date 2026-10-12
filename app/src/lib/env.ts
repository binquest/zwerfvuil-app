// Public configuration, inlined by Expo from app/.env at bundle time.
// Expo only inlines `process.env.EXPO_PUBLIC_*` when accessed with dot notation.

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

function problem(name: string, value: string | undefined): string | null {
  if (!value) return `${name} ontbreekt`;
  if (value.includes('<')) return `${name} bevat nog een placeholder`;
  return null;
}

/** A Dutch explanation when app/.env is missing or incomplete, otherwise null. */
export const CONFIG_ERROR: string | null =
  [problem('EXPO_PUBLIC_SUPABASE_URL', url), problem('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', key)]
    .filter(Boolean)
    .join(', ') || null;

// Fallbacks keep createClient from throwing; the app shows CONFIG_ERROR instead.
export const SUPABASE_URL = (CONFIG_ERROR ? 'http://localhost:54321' : url!).replace(/\/+$/, '');
export const SUPABASE_PUBLISHABLE_KEY = CONFIG_ERROR ? 'missing' : key!;
