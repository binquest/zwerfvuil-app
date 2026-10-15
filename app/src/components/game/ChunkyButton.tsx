// The game's big button: a thick rounded face on a darker "lip" that sinks
// into it when pressed, with a light haptic. For game screens (celebrations,
// the chest); forms keep their native buttons.
import { Pressable, Text, useColorScheme, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { fireHaptic } from '@/feedback/haptics';
import { type } from '@/theme';
import { gameColors, motionPresets, resolveColor, shapes } from '@/theme/game';

interface Props {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function ChunkyButton({ title, onPress, variant = 'primary', disabled = false, style }: Props) {
  const scheme = useColorScheme();
  const pressed = useSharedValue(0);
  const primary = variant === 'primary';
  const face = resolveColor(primary ? gameColors.primary : gameColors.secondary, scheme);
  const lip = resolveColor(primary ? gameColors.primaryLip : gameColors.secondaryLip, scheme);
  const ink = resolveColor(primary ? gameColors.onPrimary : gameColors.onSecondary, scheme);

  const press = (down: boolean) => {
    pressed.set(withTiming(down ? 1 : 0, { duration: motionPresets.press.duration, reduceMotion: ReduceMotion.System }));
  };
  const faceStyle = useAnimatedStyle(() => ({ transform: [{ translateY: pressed.get() * shapes.chunkyLip }] }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPressIn={() => press(true)}
      onPressOut={() => press(false)}
      onPress={() => {
        fireHaptic('light');
        onPress();
      }}
      style={[{ opacity: disabled ? 0.5 : 1 }, style]}>
      <View style={{ borderRadius: shapes.chunkyRadius, borderCurve: 'continuous', backgroundColor: lip, paddingBottom: shapes.chunkyLip }}>
        <Animated.View
          style={[
            {
              borderRadius: shapes.chunkyRadius,
              borderCurve: 'continuous',
              backgroundColor: face,
              paddingVertical: 14,
              paddingHorizontal: 20,
              alignItems: 'center',
            },
            faceStyle,
          ]}>
          <Text style={[type.headline, { color: ink, fontWeight: '800' }]} maxFontSizeMultiplier={1.6}>
            {title}
          </Text>
        </Animated.View>
      </View>
    </Pressable>
  );
}
