import * as Location from 'expo-location';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { LatLon, Position } from '@/lib/geo';

export type PermissionState = 'unknown' | 'granted' | 'denied';

export interface CurrentPosition extends Position {
  /** Android reports mock locations; iOS never does. */
  mocked: boolean;
  timestamp: number;
}

interface LocationState {
  permission: PermissionState;
  requestPermission: () => Promise<void>;
  /** The position used for check-ins: the device's, or the dev fake location. */
  position: CurrentPosition | null;
  /** A position no older than `maxAgeMs`, fetching a new fix when needed. */
  freshPosition: (maxAgeMs?: number) => Promise<CurrentPosition | null>;
  /** Dev only (hidden toggle): pick the location on the map instead of GPS. */
  fakeMode: boolean;
  setFakeMode: (on: boolean) => void;
  setFakeLocation: (point: LatLon) => void;
}

const LocationContext = createContext<LocationState | null>(null);

function fromDevice(location: Location.LocationObject): CurrentPosition {
  return {
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    accuracy: location.coords.accuracy,
    mocked: location.mocked === true,
    fake: false,
    timestamp: location.timestamp,
  };
}

export function LocationProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [permission, setPermission] = useState<PermissionState>('unknown');
  const [device, setDevice] = useState<CurrentPosition | null>(null);
  const [fakeMode, setFakeModeState] = useState(false);
  const [fakeLocation, setFakeLocationState] = useState<(LatLon & { timestamp: number }) | null>(null);

  const requestPermission = useCallback(async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    setPermission(status === 'granted' ? 'granted' : 'denied');
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    Location.requestForegroundPermissionsAsync().then(({ status }) => {
      if (active) setPermission(status === 'granted' ? 'granted' : 'denied');
    });
    return () => {
      active = false;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || permission !== 'granted') return;
    let subscription: Location.LocationSubscription | null = null;
    let cancelled = false;
    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 2, timeInterval: 2000 },
      (location) => setDevice(fromDevice(location)),
    ).then((sub) => {
      if (cancelled) sub.remove();
      else subscription = sub;
    });
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [enabled, permission]);

  const setFakeMode = useCallback((on: boolean) => {
    if (!__DEV__) return;
    setFakeModeState(on);
    if (!on) setFakeLocationState(null);
  }, []);

  const setFakeLocation = useCallback((point: LatLon) => {
    setFakeLocationState({ latitude: point.latitude, longitude: point.longitude, timestamp: Date.now() });
  }, []);

  const position = useMemo<CurrentPosition | null>(() => {
    if (fakeMode) {
      return fakeLocation ? { ...fakeLocation, accuracy: 0, mocked: false, fake: true } : null;
    }
    return device;
  }, [fakeMode, fakeLocation, device]);

  const freshPosition = useCallback(
    async (maxAgeMs = 15_000) => {
      if (fakeMode) return position;
      if (device && Date.now() - device.timestamp <= maxAgeMs) return device;
      if (permission !== 'granted') return null;
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.BestForNavigation });
      const next = fromDevice(location);
      setDevice(next);
      return next;
    },
    [fakeMode, position, device, permission],
  );

  const value = useMemo(
    () => ({ permission, requestPermission, position, freshPosition, fakeMode, setFakeMode, setFakeLocation }),
    [permission, requestPermission, position, freshPosition, fakeMode, setFakeMode, setFakeLocation],
  );
  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}

export function useLocation(): LocationState {
  const context = useContext(LocationContext);
  if (!context) throw new Error('useLocation must be used inside LocationProvider');
  return context;
}
