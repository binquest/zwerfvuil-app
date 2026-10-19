// The badges of the profile in a grid of 3: earned ones in the colour of
// their rarity, those that wait for an approval with a clock, locked ones as
// a silhouette. A tap selects one; the caller shows its explanation.
import { SymbolView } from 'expo-symbols';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';

import type { Badge } from '@/game/badges';
import { colors, spacing, type } from '@/theme';

import { BadgeIcon } from './BadgeIcon';

const COLUMNS = 3;
const MAX_SIZE = 64;
const RING = 3;

interface Props {
  badges: readonly Badge[];
  selected: string | null;
  onSelect: (badge: Badge) => void;
  /** Horizontal space around the grid on each side (screen and card padding). */
  inset?: number;
}

function statusText(badge: Badge): string {
  if (badge.status === 'locked') return 'nog niet verdiend';
  if (badge.status === 'pending') return 'verdiend, wacht op goedkeuring';
  return 'verdiend';
}

export function BadgeGrid({ badges, selected, onSelect, inset = spacing.lg }: Props) {
  const { width } = useWindowDimensions();
  const cell = Math.floor((width - inset * 2 - spacing.md * (COLUMNS - 1)) / COLUMNS);
  const size = Math.min(MAX_SIZE, cell - RING * 4);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }}>
      {badges.map((badge) => {
        const isSelected = badge.key === selected;
        return (
          <Pressable
            key={badge.key}
            onPress={() => onSelect(badge)}
            accessibilityRole="button"
            accessibilityLabel={`${badge.name}, ${statusText(badge)}`}
            accessibilityHint="Toont hoe je deze badge verdient"
            accessibilityState={{ selected: isSelected }}
            style={({ pressed }) => ({ width: cell, alignItems: 'center', gap: spacing.xs, opacity: pressed ? 0.7 : 1 })}>
            <View
              style={{
                padding: RING,
                borderRadius: (size + RING * 4) / 2,
                borderWidth: RING,
                borderColor: isSelected ? colors.tint : 'transparent',
              }}>
              <BadgeIcon badge={badge} size={size} locked={badge.status === 'locked'} decorative />
              {badge.status === 'pending' ? (
                <View
                  style={{
                    position: 'absolute',
                    right: 0,
                    bottom: 0,
                    width: 22,
                    height: 22,
                    borderRadius: 11,
                    backgroundColor: colors.cell,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                  <SymbolView name="clock.fill" size={12} tintColor={colors.secondaryLabel} />
                </View>
              ) : null}
            </View>
            <Text
              numberOfLines={2}
              style={[type.caption, { textAlign: 'center', color: badge.status === 'locked' ? colors.secondaryLabel : colors.label }]}>
              {badge.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
