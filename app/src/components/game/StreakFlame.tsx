// The flame of the streak card: lit (heat colour) with a streak, an outline
// without one. It stands still: Today has no looping animation here.
import { SymbolView } from 'expo-symbols';

import { colors } from '@/theme';
import { playColors } from '@/theme/game';

export function StreakFlame({ weeks, size = 40 }: { weeks: number; size?: number }) {
  return weeks > 0 ? (
    <SymbolView name="flame.fill" size={size} tintColor={playColors.heat} />
  ) : (
    <SymbolView name="flame" size={size} tintColor={colors.tertiaryLabel} />
  );
}
