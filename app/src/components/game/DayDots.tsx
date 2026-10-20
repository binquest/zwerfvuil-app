// The seven day dots of the streak card, Monday to Sunday: filled when a
// check-in that day is approved, a ring while it waits, today circled. One
// element for VoiceOver ("maandag goedgekeurd, dinsdag wacht, …").
import { memo } from 'react';
import { Text, View } from 'react-native';

import type { DayDot } from '@/game/today';
import { colors, spacing, type } from '@/theme';
import { playColors } from '@/theme/game';

const SIZE = 26;
const DAY_NAMES = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];
const STATE_TEXT = { approved: 'goedgekeurd', pending: 'wacht op goedkeuring', none: 'geen inworp' } as const;

function Dot({ dot }: { dot: DayDot }) {
  const color = playColors.heat;
  return (
    <View style={{ alignItems: 'center', gap: spacing.xs, flex: 1 }}>
      <View
        style={{
          width: SIZE + 8,
          height: SIZE + 8,
          borderRadius: (SIZE + 8) / 2,
          borderWidth: dot.today ? 2 : 0,
          borderColor: colors.label,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <View
          style={{
            width: SIZE,
            height: SIZE,
            borderRadius: SIZE / 2,
            backgroundColor: dot.state === 'approved' ? color : 'transparent',
            borderWidth: dot.state === 'approved' ? 0 : 2.5,
            borderColor: dot.state === 'pending' ? color : colors.separator,
            borderStyle: dot.state === 'pending' ? 'dashed' : 'solid',
            opacity: dot.future ? 0.5 : 1,
          }}
        />
      </View>
      <Text style={[type.caption, { color: dot.today ? colors.label : colors.secondaryLabel, fontWeight: dot.today ? '700' : '400' }]}>
        {dot.label}
      </Text>
    </View>
  );
}

export const DayDots = memo(function DayDots({ dots }: { dots: DayDot[] }) {
  const label = dots
    .filter((d) => !d.future)
    .map((d, i) => `${DAY_NAMES[i]}${d.today ? ' (vandaag)' : ''} ${STATE_TEXT[d.state]}`)
    .join(', ');
  return (
    <View style={{ flexDirection: 'row' }} accessible accessibilityLabel={`Deze week: ${label}`}>
      {dots.map((dot) => (
        <Dot key={dot.date} dot={dot} />
      ))}
    </View>
  );
});
