// A one-time explanation above a section of Today (streak, quests, chest): it
// appears the first time the section does on this device and goes with "Oké".
import { SymbolView } from 'expo-symbols';
import { Pressable, Text, View } from 'react-native';

import { colors, radius, spacing, type } from '@/theme';

export function FirstTimeTip({ title, body, onDismiss }: { title: string; body: string; onDismiss: () => void }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: spacing.md,
        padding: spacing.lg,
        borderRadius: radius.card,
        borderCurve: 'continuous',
        backgroundColor: colors.cell,
        borderWidth: 1,
        borderColor: colors.separator,
      }}
      accessibilityRole="summary">
      <SymbolView name="lightbulb.fill" size={22} tintColor={colors.yellow} />
      <View style={{ flex: 1, gap: spacing.xs }}>
        <Text style={[type.headline, { color: colors.label }]}>{title}</Text>
        <Text style={[type.footnote, { color: colors.label }]}>{body}</Text>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          hitSlop={8}
          style={({ pressed }) => ({ alignSelf: 'flex-end', marginTop: spacing.xs, opacity: pressed ? 0.6 : 1 })}>
          <Text style={[type.headline, { color: colors.tint }]}>Oké</Text>
        </Pressable>
      </View>
    </View>
  );
}
