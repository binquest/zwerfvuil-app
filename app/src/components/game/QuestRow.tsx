// One quest on Today: a status mark (open, waiting with a clock, done), the
// title, a bar and the reward in PUNTEN blue (it adds up).
import { SymbolView } from 'expo-symbols';
import { memo } from 'react';
import { Text, View } from 'react-native';

import type { QuestRowModel } from '@/game/today';
import { colors, spacing, type } from '@/theme';
import { gameColors, playColors, type ColorPair } from '@/theme/game';

import { ProgressBar } from './ProgressBar';

/** PUNTEN blue in both schemes: what adds up. */
export const POINTS_BLUE: ColorPair = { light: playColors.chips, dark: playColors.chips };

export const QuestRow = memo(function QuestRow({ model, detail }: { model: QuestRowModel; detail?: string }) {
  const mark =
    model.state === 'done' ? (
      <SymbolView name="checkmark.circle.fill" size={22} tintColor={playColors.chips} />
    ) : model.state === 'pending' ? (
      <SymbolView name="clock.fill" size={22} tintColor={gameColors.pending.dark} />
    ) : (
      <SymbolView name="circle" size={22} tintColor={colors.tertiaryLabel} />
    );
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm }}
      accessible
      accessibilityLabel={detail ? `${model.accessibilityLabel}, ${detail}` : model.accessibilityLabel}>
      {mark}
      <View style={{ flex: 1, gap: spacing.xs }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm }}>
          <Text style={[type.body, { color: colors.label, flex: 1 }]} numberOfLines={2}>
            {model.title}
          </Text>
          <Text style={[type.footnote, { color: colors.secondaryLabel, fontVariant: ['tabular-nums'] }]}>{model.progressLabel}</Text>
        </View>
        <ProgressBar value={model.value} max={model.max} label={model.title} color={POINTS_BLUE} height={8} />
        {detail ? <Text style={[type.caption, { color: colors.secondaryLabel }]}>{detail}</Text> : null}
      </View>
      <Text style={[type.headline, { color: playColors.chips, fontVariant: ['tabular-nums'] }]}>{model.rewardLabel}</Text>
    </View>
  );
});
