// "Wacht op goedkeuring": the small tag next to a reward that only counts once
// an admin approves the check-in behind it.
import { SymbolView } from 'expo-symbols';
import { Text, useColorScheme, View, type StyleProp, type ViewStyle } from 'react-native';

import { type } from '@/theme';
import { gameColors, resolveColor, shapes } from '@/theme/game';

export function PendingTag({ text = 'wacht op goedkeuring', style }: { text?: string; style?: StyleProp<ViewStyle> }) {
  const scheme = useColorScheme();
  const ink = resolveColor(gameColors.pending, scheme);
  return (
    <View
      accessible
      accessibilityLabel={text}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'flex-start',
          gap: 4,
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: shapes.pillRadius,
          backgroundColor: resolveColor(gameColors.pendingFill, scheme),
        },
        style,
      ]}>
      <SymbolView name="clock" size={12} tintColor={ink} />
      <Text style={[type.caption, { color: ink, fontWeight: '600' }]}>{text}</Text>
    </View>
  );
}
