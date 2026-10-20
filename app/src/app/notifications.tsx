// Our own explanation before the system prompt for notifications
// (docs/GAMIFICATION.md, chapter 5 and phase 7), a sheet from the presenter
// after the first successful check-in. "Meldingen aanzetten" shows the system
// prompt and plans right away; "Niet nu" (or swiping the sheet away) leaves
// the switch in Instellingen.
import { SymbolView } from 'expo-symbols';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { track } from '@/analytics';
import { ChunkyButton } from '@/components/game';
import { PROMPT_FOOTER, PROMPT_ROWS, PROMPT_TITLE, takePromptOnClose } from '@/notifications/prompt';
import { requestNotificationPermission, syncNotifications } from '@/notifications/scheduler';
import { useGame } from '@/providers/GameProvider';
import { colors, spacing, type } from '@/theme';
import { playColors } from '@/theme/game';

const ROW_COLORS = { 'flame.fill': playColors.heat, checklist: playColors.chips, 'shippingbox.fill': playColors.gold } as const;

export default function NotificationsPromptScreen() {
  const { state } = useGame();
  const answered = useRef(false);
  const [asking, setAsking] = useState(false);

  // Closed in any way: the presenter may show the next moment. Swiped away = not now.
  useEffect(
    () => () => {
      if (!answered.current) track('notification_permission', { status: 'declined', prompt: 'pre', from: 'moment' });
      takePromptOnClose()?.();
    },
    [],
  );

  const turnOn = async () => {
    if (asking) return;
    answered.current = true;
    setAsking(true);
    track('notification_permission', { status: 'accepted', prompt: 'pre', from: 'moment' });
    if ((await requestNotificationPermission('moment')) === 'granted' && state) await syncNotifications(state);
    router.back();
  };

  const notNow = () => {
    answered.current = true;
    track('notification_permission', { status: 'declined', prompt: 'pre', from: 'moment' });
    router.back();
  };

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.xl }}>
      <View style={{ alignItems: 'center', gap: spacing.md }}>
        <SymbolView name="bell.badge.fill" size={56} tintColor={colors.tint} />
        <Text style={[type.title2, { color: colors.label, textAlign: 'center' }]} accessibilityRole="header">
          {PROMPT_TITLE}
        </Text>
      </View>

      <View style={{ gap: spacing.lg }}>
        {PROMPT_ROWS.map((row) => (
          <View key={row.symbol} style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' }}>
            <View style={{ width: 32, alignItems: 'center', paddingTop: 2 }}>
              <SymbolView name={row.symbol} size={24} tintColor={ROW_COLORS[row.symbol]} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[type.headline, { color: colors.label }]}>{row.title}</Text>
              <Text style={[type.subheadline, { color: colors.secondaryLabel }]}>{row.body}</Text>
            </View>
          </View>
        ))}
      </View>

      <Text style={[type.footnote, { color: colors.secondaryLabel, textAlign: 'center' }]}>{PROMPT_FOOTER}</Text>

      <View style={{ gap: spacing.md }}>
        <ChunkyButton title={asking ? 'Even geduld…' : 'Meldingen aanzetten'} onPress={turnOn} disabled={asking} />
        <Pressable
          onPress={notNow}
          disabled={asking}
          accessibilityRole="button"
          hitSlop={8}
          style={({ pressed }) => ({ alignSelf: 'center', padding: spacing.sm, opacity: pressed ? 0.6 : 1 })}>
          <Text style={[type.headline, { color: colors.tint }]}>Niet nu</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
