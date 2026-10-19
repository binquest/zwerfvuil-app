// The bins of the test region, shared by the map and the bin sheet.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { fetchBins, setBinEligibility, type Bin } from '@/lib/api';
import { genericErrorMessage } from '@/lib/errors';

interface BinsState {
  bins: Bin[];
  loadError: string | null;
  reload: () => Promise<void>;
  /** The bin whose sheet is open, highlighted on the map. */
  selectedId: number | null;
  setSelectedId: (id: number | null) => void;
  /** Admins: exclude (false) or re-admit (true); reloads the bins. */
  setEligibility: (id: number, eligible: boolean) => Promise<void>;
  /** A request to show a bin on the map (from the collection); the map moves there and selects it. */
  focus: { id: number; seq: number } | null;
  showOnMap: (id: number) => void;
}

const BinsContext = createContext<BinsState | null>(null);

export function BinsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [bins, setBins] = useState<Bin[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ id: number; seq: number } | null>(null);

  const reload = useCallback(async () => {
    try {
      setBins(await fetchBins());
      setLoadError(null);
    } catch (error) {
      setLoadError(`Vuilbakken laden lukte niet. ${genericErrorMessage(error as Error)}`);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    fetchBins()
      .then((next) => {
        if (!active) return;
        setBins(next);
        setLoadError(null);
      })
      .catch((error) => active && setLoadError(`Vuilbakken laden lukte niet. ${genericErrorMessage(error as Error)}`));
    return () => {
      active = false;
    };
  }, [enabled]);

  const setEligibility = useCallback(
    async (id: number, eligible: boolean) => {
      await setBinEligibility(id, eligible);
      await reload();
    },
    [reload],
  );

  const showOnMap = useCallback((id: number) => {
    setSelectedId(id);
    setFocus((previous) => ({ id, seq: (previous?.seq ?? 0) + 1 }));
  }, []);

  const value = useMemo(
    () => ({ bins, loadError, reload, selectedId, setSelectedId, setEligibility, focus, showOnMap }),
    [bins, loadError, reload, selectedId, setEligibility, focus, showOnMap],
  );
  return <BinsContext.Provider value={value}>{children}</BinsContext.Provider>;
}

export function useBins(): BinsState {
  const context = useContext(BinsContext);
  if (!context) throw new Error('useBins must be used inside BinsProvider');
  return context;
}
