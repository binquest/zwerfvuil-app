// A thick rounded progress bar (quests, the next milestone). The fill grows on
// the UI thread; with Reduce Motion it jumps.
import { useEffect } from 'react';
import { useColorScheme, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { progressFraction } from '@/game/progress';
import { gameColors, motionPresets, resolveColor, shapes, type ColorPair } from '@/theme/game';

interface Props {
  value: number;
  max: number;
  /** What VoiceOver says before the numbers, e.g. "Volgende mijlpaal". */
  label: string;
  color?: ColorPair;
  height?: number;
  style?: StyleProp<ViewStyle>;
}

export function ProgressBar({ value, max, label, color = gameColors.progress, height = shapes.barHeight, style }: Props) {
  const scheme = useColorScheme();
  const fraction = progressFraction(value, max);
  const fill = useSharedValue(fraction);

  useEffect(() => {
    fill.set(withTiming(fraction, { duration: motionPresets.fill.duration, reduceMotion: ReduceMotion.System }));
  }, [fill, fraction]);

  const fillStyle = useAnimatedStyle(() => ({ width: `${fill.get() * 100}%` }));
  const shown = Math.min(Math.max(0, value), Math.max(0, max));

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max, now: shown, text: `${shown} van ${max}` }}
      style={[{ height, borderRadius: height / 2, backgroundColor: resolveColor(gameColors.track, scheme), overflow: 'hidden' }, style]}>
      <Animated.View style={[{ height, borderRadius: height / 2, backgroundColor: resolveColor(color, scheme) }, fillStyle]} />
    </View>
  );
}
