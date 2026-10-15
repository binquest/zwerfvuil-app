// A game number that rolls from its previous value to the new one (points,
// totals), in the rounded black digits of the game. The roll runs on the UI
// thread (an animated TextInput, so no React render per frame); with Reduce
// Motion it jumps. VoiceOver reads the final value.
import { useEffect } from 'react';
import { TextInput, type StyleProp, type TextStyle } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';

import { motionPresets, NUMBER_MAX_FONT_SCALE, numberStyle } from '@/theme/game';

Animated.addWhitelistedNativeProps({ text: true });
const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

interface Props {
  value: number;
  /** "+12", "12 pt": text around the number. */
  prefix?: string;
  suffix?: string;
  /** How long a roll takes; 0 jumps. */
  durationMs?: number;
  style?: StyleProp<TextStyle>;
}

export function GameNumber({ value, prefix = '', suffix = '', durationMs = motionPresets.roll.duration, style }: Props) {
  const shown = useSharedValue(value);

  useEffect(() => {
    shown.set(withTiming(value, { duration: durationMs, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System }));
  }, [shown, value, durationMs]);

  const animatedProps = useAnimatedProps(() => {
    const text = `${prefix}${Math.round(shown.get())}${suffix}`;
    // `text` updates the native view without a render; `defaultValue` keeps it after one.
    return { text, defaultValue: text } as object;
  });

  const text = `${prefix}${value}${suffix}`;
  return (
    <AnimatedTextInput
      editable={false}
      pointerEvents="none"
      defaultValue={text}
      accessibilityLabel={text}
      maxFontSizeMultiplier={NUMBER_MAX_FONT_SCALE}
      animatedProps={animatedProps}
      style={[numberStyle, { padding: 0 }, style]}
    />
  );
}
