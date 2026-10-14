// Dev mode diagnostics: measures the UI thread. Every 100 ms it runs a one-frame
// native-driver animation on an invisible view and reports the round trip (JS
// starts it, the UI thread runs it at its next frames, the end comes back). A
// blocked UI thread shows up as a longer round trip.
import { useEffect, useState } from 'react';
import { Animated } from 'react-native';

const INTERVAL_MS = 100;

export function FrameProbe({ active, onSample }: { active: boolean; onSample: (ms: number) => void }) {
  const [value] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!active) return;
    let inFlight = false;
    let stopped = false;
    const timer = setInterval(() => {
      // Never interrupt a running probe: a stall would then go unmeasured.
      if (inFlight) return;
      inFlight = true;
      const started = performance.now();
      value.setValue(0);
      Animated.timing(value, { toValue: 1, duration: 16, useNativeDriver: true }).start(({ finished }) => {
        inFlight = false;
        if (finished && !stopped) onSample(performance.now() - started);
      });
    }, INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      value.stopAnimation();
    };
  }, [active, onSample, value]);

  return (
    <Animated.View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, width: 1, height: 1, opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0, 0.01] }) }}
    />
  );
}
