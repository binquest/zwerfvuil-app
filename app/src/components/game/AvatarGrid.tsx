// A grid of avatars to choose from (the onboarding and the avatar picker): a
// tap selects one, the caller decides what happens next. Locked avatars are
// silhouettes with a lock, pending ones carry a clock; the selected one has a
// ring in the tint colour.
import { SymbolView } from 'expo-symbols';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';

import type { AvatarChoice } from '@/game/avatars';
import { colors, spacing, type } from '@/theme';

import { Avatar } from './Avatar';

const COLUMNS = 4;
const MAX_SIZE = 76;
const RING = 3;

interface Props {
  choices: readonly AvatarChoice[];
  selected: string | null;
  onSelect: (choice: AvatarChoice) => void;
  /** Horizontal padding of the screen around the grid. */
  inset?: number;
}

function statusText(choice: AvatarChoice): string {
  if (choice.status === 'locked') return 'vergrendeld';
  if (choice.status === 'pending') return 'wacht op goedkeuring';
  return choice.current ? 'je huidige avatar' : '';
}

export function AvatarGrid({ choices, selected, onSelect, inset = spacing.lg }: Props) {
  const { width } = useWindowDimensions();
  const cell = Math.floor((width - inset * 2 - spacing.md * (COLUMNS - 1)) / COLUMNS);
  const size = Math.min(MAX_SIZE, cell - RING * 4);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }}>
      {choices.map((choice) => {
        const isSelected = choice.key === selected;
        const extra = statusText(choice);
        return (
          <Pressable
            key={choice.key}
            onPress={() => onSelect(choice)}
            accessibilityRole="button"
            accessibilityLabel={extra ? `${choice.name}, ${extra}` : choice.name}
            accessibilityState={{ selected: isSelected }}
            style={({ pressed }) => ({ width: cell, alignItems: 'center', gap: spacing.xs, opacity: pressed ? 0.7 : 1 })}>
            <View
              style={{
                padding: RING,
                borderRadius: (size + RING * 4) / 2,
                borderWidth: RING,
                borderColor: isSelected ? colors.tint : 'transparent',
              }}>
              <Avatar avatarKey={choice.key} size={size} locked={choice.status !== 'unlocked'} decorative />
              {choice.status !== 'unlocked' ? (
                <View
                  style={{
                    position: 'absolute',
                    right: 0,
                    bottom: 0,
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    backgroundColor: colors.cell,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                  <SymbolView
                    name={choice.status === 'pending' ? 'clock.fill' : 'lock.fill'}
                    size={13}
                    tintColor={colors.secondaryLabel}
                  />
                </View>
              ) : null}
            </View>
            <Text
              numberOfLines={1}
              style={[type.caption, { color: choice.status === 'unlocked' ? colors.label : colors.secondaryLabel }]}>
              {choice.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
