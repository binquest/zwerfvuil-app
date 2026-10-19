// The player's game: my_game_state() (points, streak, the discovery counter and
// the next milestone) and my_collection() (which bins are discovered), shared
// by the map, the bin sheet, the collection and the camera (which mixes the
// expected discovery ahead). Loaded when signed in, again when the app comes
// back to the foreground, and after every check-in (refresh()).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import type { CollectionEntry, GameState } from '@/game/discoveries';
import { fetchMyCollection, fetchMyGameState } from '@/lib/api';
import { genericErrorMessage } from '@/lib/errors';

interface GameContextValue {
  state: GameState | null;
  /** Every bin of the collection, by bin id; null until loaded. */
  collection: ReadonlyMap<number, CollectionEntry> | null;
  loadError: string | null;
  /** Loads both again (one request at a time; a call during one waits for it). The new state, or null. */
  refresh: () => Promise<GameState | null>;
}

const GameContext = createContext<GameContextValue | null>(null);

export function GameProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [state, setState] = useState<GameState | null>(null);
  const [collection, setCollection] = useState<ReadonlyMap<number, CollectionEntry> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const inFlight = useRef<Promise<GameState | null> | null>(null);
  const enabledRef = useRef(enabled);

  const refresh = useCallback(() => {
    if (!enabledRef.current) return Promise.resolve(null);
    inFlight.current ??= (async () => {
      try {
        const [nextState, entries] = await Promise.all([fetchMyGameState(), fetchMyCollection()]);
        if (!enabledRef.current) return null;
        setState(nextState);
        setCollection(new Map(entries.map((entry) => [entry.binId, entry])));
        setLoadError(null);
        return nextState;
      } catch (error) {
        setLoadError(`Je spel laden lukte niet. ${genericErrorMessage(error as Error)}`);
        return null;
      } finally {
        inFlight.current = null;
      }
    })();
    return inFlight.current;
  }, []);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) return;
    refresh();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') refresh();
    });
    return () => {
      subscription.remove();
      // Signed out: nothing of the previous player stays.
      setState(null);
      setCollection(null);
    };
  }, [enabled, refresh]);

  const value = useMemo(() => ({ state, collection, loadError, refresh }), [state, collection, loadError, refresh]);
  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

export function useGame(): GameContextValue {
  const context = useContext(GameContext);
  if (!context) throw new Error('useGame must be used inside GameProvider');
  return context;
}
