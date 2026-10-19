// An avatar (docs/AVATARS.md): the drawing on a circle in its colour, or until
// the drawing is there the placeholder of the catalog (its SF Symbol on that
// circle). `locked` draws a silhouette: a neutral circle with the figure in
// one flat colour (expo-image tintColor, so the drawing must have a
// transparent background). An unknown key gets a neutral placeholder, no key
// the standard avatar. Thumbnails up to 64 pt (game/avatars.ts).
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { memo } from 'react';
import { useColorScheme, View, type StyleProp, type ViewStyle } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

import { AVATAR_IMAGES } from '@/game/avatarImages';
import { resolveAvatar } from '@/game/avatars';
import { useGameCatalog } from '@/game/useGameCatalog';
import { resolveColor, type ColorPair } from '@/theme/game';

const SILHOUETTE: { circle: ColorPair; figure: ColorPair } = {
  circle: { light: '#E5E5EA', dark: '#2C2C2E' },
  figure: { light: '#AEAEB2', dark: '#636366' },
};

interface Props {
  /** null or undefined: the standard avatar. */
  avatarKey: string | null | undefined;
  size: number;
  locked?: boolean;
  /** Inside a button that has its own label: not a separate element for VoiceOver. */
  decorative?: boolean;
  style?: StyleProp<ViewStyle>;
}

export const Avatar = memo(function Avatar({ avatarKey, size, locked = false, decorative = false, style }: Props) {
  const catalog = useGameCatalog();
  const scheme = useColorScheme();
  const avatar = resolveAvatar(avatarKey, catalog?.avatars ?? [], AVATAR_IMAGES, size);
  const figure = locked ? resolveColor(SILHOUETTE.figure, scheme) : undefined;
  return (
    <View
      accessible={!decorative}
      accessibilityRole={decorative ? undefined : 'image'}
      accessibilityLabel={decorative ? undefined : locked ? `${avatar.name}, vergrendeld` : avatar.name}
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: locked ? resolveColor(SILHOUETTE.circle, scheme) : avatar.color,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        },
        style,
      ]}>
      {avatar.image !== null ? (
        <Image
          // A new view when the silhouette changes: a tint does not always clear on iOS.
          key={locked ? 'silhouette' : 'drawing'}
          source={avatar.image}
          style={{ width: size, height: size }}
          contentFit="contain"
          tintColor={figure}
          transition={0}
          accessible={false}
        />
      ) : (
        <SymbolView name={avatar.symbol as SFSymbol} size={Math.round(size * 0.5)} tintColor={figure ?? 'white'} />
      )}
    </View>
  );
});
