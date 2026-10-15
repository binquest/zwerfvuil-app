import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ColorValue, StyleProp, ViewProps, ViewStyle } from 'react-native';
import { View } from 'react-native';

import { colors, radius } from '@/theme';

const LIQUID_GLASS = isLiquidGlassAvailable();

interface Props extends ViewProps {
  /** Reacts to touches like a glass control (buttons, tappable cards). */
  interactive?: boolean;
  tint?: ColorValue;
  /** Always the dark look, for panels over the camera or the reveal. */
  dark?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A Liquid Glass surface for controls that float over content (the map, the
 * camera). Before iOS 26 it falls back to a plain rounded card.
 */
export function GlassPanel({ interactive, tint, dark = false, style, children, ...rest }: Props) {
  const shape: ViewStyle = { borderRadius: radius.card, borderCurve: 'continuous' };
  if (!LIQUID_GLASS) {
    return (
      <View
        {...rest}
        style={[
          shape,
          { backgroundColor: tint ?? (dark ? 'rgba(44,44,46,0.92)' : colors.background), boxShadow: '0 2px 10px rgba(0,0,0,0.15)' },
          style,
        ]}>
        {children}
      </View>
    );
  }
  return (
    <GlassView
      {...rest}
      glassEffectStyle="regular"
      isInteractive={interactive}
      tintColor={tint}
      colorScheme={dark ? 'dark' : 'auto'}
      style={[shape, style]}>
      {children}
    </GlassView>
  );
}
