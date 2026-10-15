// Prototype (phase 2): a progress ring from SwiftUI's circular Gauge, for the
// level ring on the profile. A Gauge has a fixed natural size, so it is scaled
// to `size` with scaleEffect inside a frame of that size. To check on the
// phone (Dev mode, Componenten): sharp at every size, the right thickness,
// and the value animating smoothly.
import { Host } from '@expo/ui';
import { Gauge, Text } from '@expo/ui/swift-ui';
import { accessibilityLabel, accessibilityValue, frame, gaugeStyle, scaleEffect, tint } from '@expo/ui/swift-ui/modifiers';
import { useColorScheme } from 'react-native';

import { progressFraction } from '@/game/progress';
import { gameColors, resolveColor, type ColorPair } from '@/theme/game';

/** The diameter of a circular gauge in SwiftUI before scaling, in points (to confirm on the phone). */
const GAUGE_SIZE = 58;

interface Props {
  value: number;
  max: number;
  size: number;
  label: string;
  /** Shown in the middle, e.g. the level. */
  center?: string;
  color?: ColorPair;
}

export function ProgressRing({ value, max, size, label, center, color = gameColors.progress }: Props) {
  const scheme = useColorScheme();
  return (
    <Host style={{ width: size, height: size }}>
      <Gauge
        value={progressFraction(value, max)}
        currentValueLabel={center ? <Text>{center}</Text> : undefined}
        modifiers={[
          gaugeStyle('circularCapacity'),
          tint(resolveColor(color, scheme)),
          scaleEffect(size / GAUGE_SIZE),
          frame({ width: size, height: size }),
          accessibilityLabel(label),
          accessibilityValue(`${Math.min(Math.max(0, value), max)} van ${max}`),
        ]}
      />
    </Host>
  );
}
