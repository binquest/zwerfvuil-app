// A badge: its SF Symbol in white on a circle in the colour of its rarity
// (common grey, rare blue, epic purple, legendary gold), like the avatar
// placeholder. Locked = a silhouette: a grey circle with the symbol in a
// lighter grey. On the dark play surface of a celebration, pass scheme 'dark'.
import { SymbolView } from 'expo-symbols';
import { memo } from 'react';
import { useColorScheme, View, type StyleProp, type ViewStyle } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

import type { BadgeInfo } from '@/game/badges';
import { rarityColors, resolveColor, type ColorPair, type Scheme } from '@/theme/game';

const SILHOUETTE: { circle: ColorPair; figure: ColorPair } = {
  circle: { light: '#E5E5EA', dark: '#2C2C2E' },
  figure: { light: '#AEAEB2', dark: '#636366' },
};

interface Props {
  badge: Pick<BadgeInfo, 'name' | 'symbol' | 'rarity'>;
  size: number;
  locked?: boolean;
  /** Overrides the colour scheme (the play surface is always dark). */
  scheme?: Scheme;
  /** Inside an element with its own label: not a separate element for VoiceOver. */
  decorative?: boolean;
  style?: StyleProp<ViewStyle>;
}

export const BadgeIcon = memo(function BadgeIcon({ badge, size, locked = false, scheme, decorative = false, style }: Props) {
  const systemScheme = useColorScheme();
  const colors = scheme ?? systemScheme;
  return (
    <View
      accessible={!decorative}
      accessibilityRole={decorative ? undefined : 'image'}
      accessibilityLabel={decorative ? undefined : locked ? `${badge.name}, nog niet verdiend` : badge.name}
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: resolveColor(locked ? SILHOUETTE.circle : rarityColors[badge.rarity], colors),
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}>
      <SymbolView
        name={badge.symbol as SFSymbol}
        size={Math.round(size * 0.5)}
        tintColor={locked ? resolveColor(SILHOUETTE.figure, colors) : 'white'}
      />
    </View>
  );
});
