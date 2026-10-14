// Haptics, iOS-first (elsewhere they quietly do nothing). Never awaited: a haptic
// that fails must not slow the reveal down or stop it.
import * as Haptics from 'expo-haptics';

export type HapticKind = 'selection' | 'light' | 'medium' | 'heavy' | 'rigid' | 'success';

const IMPACT = {
  light: Haptics.ImpactFeedbackStyle.Light,
  medium: Haptics.ImpactFeedbackStyle.Medium,
  heavy: Haptics.ImpactFeedbackStyle.Heavy,
  rigid: Haptics.ImpactFeedbackStyle.Rigid,
} as const;

// Dev mode diagnostics: how long each haptic takes to come back from the main thread.
let probe: ((ms: number) => void) | null = null;

export function setHapticProbe(listener: ((ms: number) => void) | null): void {
  probe = listener;
}

function swallow(promise: Promise<void>): void {
  const listener = probe;
  if (!listener) {
    promise.catch(() => {});
    return;
  }
  const started = performance.now();
  promise.then(
    () => listener(performance.now() - started),
    () => {},
  );
}

/** Fires one haptic and returns at once. */
export function fireHaptic(kind: HapticKind): void {
  if (process.env.EXPO_OS !== 'ios') return;
  try {
    if (kind === 'selection') swallow(Haptics.selectionAsync());
    else if (kind === 'success') swallow(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
    else swallow(Haptics.impactAsync(IMPACT[kind]));
  } catch {
    // Haptics are a bonus; the reveal works without them.
  }
}

/** For the places outside the reveal (the camera). */
export const haptic = {
  success(): void {
    fireHaptic('success');
  },
  warning(): void {
    if (process.env.EXPO_OS !== 'ios') return;
    try {
      swallow(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
    } catch {
      // See fireHaptic.
    }
  },
};
