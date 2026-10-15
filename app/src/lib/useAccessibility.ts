// The accessibility settings the game follows, one hook each for every screen:
// Reduce Motion (no shaking, flying or confetti) and VoiceOver (a reveal starts
// on its end state and says what happened). null until the system answered.
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

function useSetting(read: () => Promise<boolean>, event: 'reduceMotionChanged' | 'screenReaderChanged'): boolean | null {
  const [value, setValue] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    read().then(
      (on) => active && setValue(on),
      () => active && setValue(false),
    );
    const subscription = AccessibilityInfo.addEventListener(event, setValue);
    return () => {
      active = false;
      subscription.remove();
    };
  }, [read, event]);
  return value;
}

export function useReduceMotion(): boolean | null {
  return useSetting(AccessibilityInfo.isReduceMotionEnabled, 'reduceMotionChanged');
}

export function useScreenReader(): boolean | null {
  return useSetting(AccessibilityInfo.isScreenReaderEnabled, 'screenReaderChanged');
}
