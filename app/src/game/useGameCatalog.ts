// Loads game_catalog() once per few minutes and shares it: labels and the Dev
// mode preview read it, the camera uses it to mix the expected reveal ahead.
import { useEffect, useState } from 'react';

import { supabase } from '../lib/supabase';
import { parseCatalog, type GameCatalog } from './catalog';

/** A catalog this old is fetched again (a change in Studio shows up without a restart). */
const MAX_AGE_MS = 5 * 60_000;

let cached: { catalog: GameCatalog; at: number } | null = null;
let loading: Promise<GameCatalog | null> | null = null;

/** The catalog of the last few minutes, or null before the first load. */
export function cachedGameCatalog(): GameCatalog | null {
  return cached?.catalog ?? null;
}

/** Fetches the catalog unless it is fresh; null when it cannot be loaded (offline). Never throws. */
export function loadGameCatalog(): Promise<GameCatalog | null> {
  if (cached && performance.now() - cached.at < MAX_AGE_MS) return Promise.resolve(cached.catalog);
  loading ??= (async () => {
    try {
      const { data, error } = await supabase.rpc('game_catalog');
      const catalog = error ? null : parseCatalog(data);
      if (catalog) cached = { catalog, at: performance.now() };
      return catalog ?? cached?.catalog ?? null;
    } catch {
      return cached?.catalog ?? null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** The catalog for a screen: the cached one at once, refreshed when stale. */
export function useGameCatalog(): GameCatalog | null {
  const [catalog, setCatalog] = useState(cachedGameCatalog);
  useEffect(() => {
    let active = true;
    loadGameCatalog().then((loaded) => {
      if (active && loaded) setCatalog(loaded);
    });
    return () => {
      active = false;
    };
  }, []);
  return catalog;
}
