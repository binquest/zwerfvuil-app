import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { fetchProfile, type Profile } from '@/lib/api';
import { supabase } from '@/lib/supabase';

interface AuthState {
  session: Session | null;
  /** True until the stored session has been read. */
  loading: boolean;
  profile: Profile | null;
  /** True once the first profile request for this session finished (even if it failed or timed out). */
  profileLoaded: boolean;
  refreshProfile: () => Promise<void>;
  /** What a write returned (onboarding, name, avatar), without another request. */
  updateProfile: (patch: Partial<Profile>) => void;
  signOut: () => Promise<void>;
}

/**
 * The first profile request counts as failed after this long: the app opens
 * (never a splash forever, e.g. without Tailscale), and a late answer still
 * lands.
 */
const PROFILE_TIMEOUT_MS = 5000;

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // The profile is stored with its user id, so a stale profile never leaks to another session.
  const [loaded, setLoaded] = useState<{ userId: string; profile: Profile | null } | null>(null);
  const userId = session?.user.id ?? null;
  const current = loaded && loaded.userId === userId ? loaded : null;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!userId) return;
    try {
      setLoaded({ userId, profile: await fetchProfile(userId) });
    } catch {
      // Keep the last known profile; screens show their own errors.
    }
  }, [userId]);

  const updateProfile = useCallback(
    (patch: Partial<Profile>) => {
      if (!userId) return;
      setLoaded((prev) => (prev?.userId === userId && prev.profile ? { userId, profile: { ...prev.profile, ...patch } } : prev));
    },
    [userId],
  );

  useEffect(() => {
    if (!userId) return;
    let active = true;
    const failed = () => active && setLoaded((prev) => (prev?.userId === userId ? prev : { userId, profile: null }));
    const timer = setTimeout(failed, PROFILE_TIMEOUT_MS);
    fetchProfile(userId)
      .then((next) => active && setLoaded({ userId, profile: next }))
      .catch(failed)
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [userId]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = useMemo(
    () => ({
      session,
      loading,
      profile: current?.profile ?? null,
      profileLoaded: current !== null,
      refreshProfile,
      updateProfile,
      signOut,
    }),
    [session, loading, current, refreshProfile, updateProfile, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
