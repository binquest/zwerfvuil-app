import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { fetchProfile, type Profile } from '@/lib/api';
import { supabase } from '@/lib/supabase';

interface AuthState {
  session: Session | null;
  /** True until the stored session has been read. */
  loading: boolean;
  profile: Profile | null;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // The profile is stored with its user id, so a stale profile never leaks to another session.
  const [loaded, setLoaded] = useState<{ userId: string; profile: Profile } | null>(null);
  const userId = session?.user.id ?? null;
  const profile = loaded && loaded.userId === userId ? loaded.profile : null;

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

  useEffect(() => {
    if (!userId) return;
    let active = true;
    fetchProfile(userId)
      .then((next) => active && setLoaded({ userId, profile: next }))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [userId]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = useMemo(
    () => ({ session, loading, profile, refreshProfile, signOut }),
    [session, loading, profile, refreshProfile, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
