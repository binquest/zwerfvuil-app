// Dev mode state for admins on local or staging. The server decides whether
// it is available (dev_mode_status) and enforces every rule; this only drives
// the UI.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { fetchDevModeStatus, resetDevTestData, setDevStreakOverride, type DevModeStatus } from '@/lib/api';
import { useLocation } from '@/providers/LocationProvider';

interface DevModeState {
  status: DevModeStatus | null;
  /** True when the server allows Dev mode for this account. */
  available: boolean;
  refresh: () => Promise<void>;
  setStreakOverride: (weeks: number | null) => Promise<void>;
  /** Clears my test data and switches the test location off; returns the removed check-ins. */
  reset: () => Promise<number>;
  /** Leaderboard: include test points (only while Dev mode is available). */
  showTestData: boolean;
  setShowTestData: (on: boolean) => void;
}

const DevModeContext = createContext<DevModeState | null>(null);

export function DevModeProvider({ isAdmin, children }: { isAdmin: boolean; children: ReactNode }) {
  const [status, setStatus] = useState<DevModeStatus | null>(null);
  const [showTestData, setShowTestData] = useState(false);
  const { setFakeMode } = useLocation();

  const apply = useCallback(
    (next: DevModeStatus | null) => {
      setStatus(next);
      // Without Dev mode the test location is off (the server refuses it anyway).
      if (!next?.allowed) setFakeMode(false);
    },
    [setFakeMode],
  );

  const refresh = useCallback(async () => {
    if (!isAdmin) {
      apply(null);
      return;
    }
    try {
      apply(await fetchDevModeStatus());
    } catch {
      apply(null);
    }
  }, [isAdmin, apply]);

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    fetchDevModeStatus()
      .then((next) => active && apply(next))
      .catch(() => active && apply(null));
    return () => {
      active = false;
    };
  }, [isAdmin, apply]);

  // Only an admin's own status counts; after losing admin rights it is gone.
  const available = isAdmin && !!status?.allowed;

  const setStreakOverride = useCallback(
    async (weeks: number | null) => {
      await setDevStreakOverride(weeks);
      await refresh();
    },
    [refresh],
  );

  const reset = useCallback(async () => {
    const removed = await resetDevTestData();
    setFakeMode(false);
    await refresh();
    return removed;
  }, [refresh, setFakeMode]);

  const value = useMemo(
    () => ({ status, available, refresh, setStreakOverride, reset, showTestData: available && showTestData, setShowTestData }),
    [status, available, refresh, setStreakOverride, reset, showTestData],
  );
  return <DevModeContext.Provider value={value}>{children}</DevModeContext.Provider>;
}

export function useDevMode(): DevModeState {
  const context = useContext(DevModeContext);
  if (!context) throw new Error('useDevMode must be used inside DevModeProvider');
  return context;
}
