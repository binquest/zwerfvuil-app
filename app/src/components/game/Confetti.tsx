// Confetti for a celebration: pieces fall from above the screen with a
// sideways drift and a spin, all on one shared value (the UI thread does the
// work). The caller leaves it out with Reduce Motion (pieces = 0).
import { useEffect } from 'react';
import { useWindowDimensions } from 'react-native';
import Animated, { Easing, ReduceMotion, type SharedValue, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { confettiPiece } from '@/feedback/reveal/motion';
import { playColors } from '@/theme';

const DURATION_MS = 2400;
// A milestone is new: gold, with the PUNTEN blue, the MULT scale and white.
const COLORS = [playColors.gold, playColors.chips, playColors.multRamp[0], playColors.multRamp[2], '#FFFFFF'];

function Piece({ index, progress }: { index: number; progress: SharedValue<number> }) {
  const { width, height } = useWindowDimensions();
  const style = useAnimatedStyle(() => {
    const p = confettiPiece(index, progress.get(), width, height);
    return { opacity: p.opacity, transform: [{ translateX: p.x }, { translateY: p.y }, { rotateZ: `${p.rotation}deg` }] };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          top: 0,
          left: 0,
          width: index % 3 === 0 ? 8 : 10,
          height: index % 3 === 0 ? 14 : 6,
          borderRadius: 2,
          backgroundColor: COLORS[index % COLORS.length],
        },
        style,
      ]}
    />
  );
}

/** `pieces` pieces fall once each time `burst` changes to a new value above 0. */
export function Confetti({ pieces, burst }: { pieces: number; burst: number }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    if (burst <= 0 || pieces <= 0) return;
    progress.set(0);
    progress.set(withTiming(1, { duration: DURATION_MS, easing: Easing.linear, reduceMotion: ReduceMotion.System }));
  }, [burst, pieces, progress]);
  if (pieces <= 0) return null;
  return (
    <>
      {Array.from({ length: pieces }, (_, i) => (
        <Piece key={i} index={i} progress={progress} />
      ))}
    </>
  );
}
