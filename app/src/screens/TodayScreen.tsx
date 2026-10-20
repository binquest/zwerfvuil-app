// Today (docs/GAMIFICATION.md, chapter 5): 1) the streak card: flame, weeks
// and multiplier, the seven day dots, "Deze week telt al" or "Reeks in gevaar"
// (from Friday), the freezes; 2) today's three quests; 3) the daily chest:
// locked (2/3) → shining "Open je kist" → opened (+15 · wacht); older chests
// that are still ready; 4) the weekly challenge; 5) what waits for approval;
// 6) leaderboard and collection. The first time each of streak, quests and
// chest appears on this device, a short explanation stands above it.
import { router, useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import type { SFSymbol } from 'sf-symbols-typescript';

import { track } from '@/analytics';
import { ChunkyButton, DayDots, FirstTimeTip, PendingTag, ProgressBar, QuestRow, StreakFlame } from '@/components/game';
import { POINTS_BLUE } from '@/components/game/QuestRow';
import { streakMultiplierLabel } from '@/game/catalog';
import {
  chestCard,
  dayDots,
  dayLabel,
  freezeLine,
  pendingLine,
  questRow,
  questsDone,
  streakStatusLine,
  streakWeeksLabel,
  tipText,
  tipsToShow,
  weeklyRow,
  type Chest,
  type TipKind,
} from '@/game/today';
import { markTipsSeen, seenTips } from '@/game/todayMemory';
import { useGameCatalog } from '@/game/useGameCatalog';
import { genericErrorMessage } from '@/lib/errors';
import { useReduceMotion } from '@/lib/useAccessibility';
import { useGame } from '@/providers/GameProvider';
import { colors, radius, spacing, type } from '@/theme';
import { playColors, playType } from '@/theme/game';

const card = { backgroundColor: colors.cell, borderRadius: radius.card, borderCurve: 'continuous', padding: spacing.lg } as const;

function SectionTitle({ children, right }: { children: string; right?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: spacing.xs }}>
      <Text style={[playType.label, { color: colors.secondaryLabel, flex: 1 }]} accessibilityRole="header">
        {children}
      </Text>
      {right ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{right}</Text> : null}
    </View>
  );
}

function LinkRow({ title, symbol, color, onPress }: { title: string; symbol: SFSymbol; color: typeof colors.tint; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md, opacity: pressed ? 0.6 : 1 })}>
      <SymbolView name={symbol} size={20} tintColor={color} />
      <Text style={[type.body, { color: colors.label, flex: 1 }]}>{title}</Text>
      <SymbolView name="chevron.right" size={13} tintColor={colors.tertiaryLabel} />
    </Pressable>
  );
}

function openChest(day: string) {
  router.push({ pathname: '/chest', params: { day } });
}

/** The chest card; a ready chest shines (a slow pulse, paused off screen and with Reduce Motion). */
function ChestCard({ chest, focused, avatarName }: { chest: Chest; focused: boolean; avatarName: (key: string) => string | null }) {
  const model = chestCard(chest, avatarName);
  const reduceMotion = useReduceMotion();
  const pulse = useSharedValue(0);
  const shine = model.state === 'ready' && focused && reduceMotion === false;

  useEffect(() => {
    if (shine) {
      pulse.set(withRepeat(withTiming(1, { duration: 900 }), -1, true));
    } else {
      cancelAnimation(pulse);
      pulse.set(0);
    }
    return () => cancelAnimation(pulse);
  }, [pulse, shine]);

  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 + pulse.get() * 0.08 }] }));
  const ready = model.state === 'ready';

  return (
    <View style={[card, { gap: spacing.md }, ready && { borderWidth: 2, borderColor: playColors.gold }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <Animated.View style={iconStyle}>
          <SymbolView
            name={model.state === 'opened' ? 'shippingbox' : 'shippingbox.fill'}
            size={40}
            tintColor={ready ? playColors.gold : model.state === 'opened' ? playColors.chips : colors.tertiaryLabel}
          />
        </Animated.View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[type.headline, { color: colors.label }]}>{model.title}</Text>
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{model.detail}</Text>
        </View>
        {model.state === 'locked' ? (
          <Text style={[type.footnote, { color: colors.secondaryLabel, fontVariant: ['tabular-nums'] }]}>{`${model.done}/${model.total}`}</Text>
        ) : null}
      </View>
      {model.state === 'locked' ? <ProgressBar value={model.done} max={Math.max(1, model.total)} label="Quests voor je kist" color={POINTS_BLUE} height={8} /> : null}
      {ready ? <ChunkyButton title="Open je kist" onPress={() => openChest(chest.day)} /> : null}
      {model.state === 'opened' && chest.reward?.status === 'pending' ? <PendingTag style={{ alignSelf: 'flex-start' }} /> : null}
    </View>
  );
}

export function TodayScreen() {
  const { state, loadError, refresh } = useGame();
  const catalog = useGameCatalog();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  // The explanations already shown when this visit began, and those closed now.
  const [seenAtFocus, setSeenAtFocus] = useState<ReadonlySet<TipKind> | null>(null);
  const [dismissed, setDismissed] = useState<TipKind[]>([]);
  const logged = useRef(new Set<TipKind>());
  const viewedRef = useRef(false);

  const today = state?.today ?? null;
  const streak = state?.streak ?? null;

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      setSeenAtFocus(seenTips());
      viewedRef.current = false;
      refresh().catch((e: Error) => setError(genericErrorMessage(e)));
      return () => setFocused(false);
    }, [refresh]),
  );

  // Once per visit: the quests came into view.
  useEffect(() => {
    if (!focused || !today || viewedRef.current || today.quests.length === 0) return;
    viewedRef.current = true;
    const done = questsDone(today.quests);
    track('quest_viewed', { open: today.quests.length - done, done });
  }, [focused, today]);

  // The explanations of the sections that are there now and were never shown here.
  const visible = useMemo(() => {
    const sections: TipKind[] = [];
    if (streak) sections.push('streak');
    if (today && today.quests.length > 0) sections.push('quests');
    if (today?.chest) sections.push('chest');
    return sections;
  }, [streak, today]);
  const tips = useMemo(
    () => (seenAtFocus ? tipsToShow(seenAtFocus, visible).filter((t) => !dismissed.includes(t)) : []),
    [seenAtFocus, visible, dismissed],
  );
  // Shown once: remembered on this device as soon as it appears.
  useEffect(() => {
    const fresh = tips.filter((t) => !logged.current.has(t));
    if (fresh.length === 0) return;
    for (const tip of fresh) {
      logged.current.add(tip);
      track('tip_shown', { tip });
    }
    markTipsSeen(fresh);
  }, [tips]);

  const dismissTip = (tip: TipKind) => setDismissed((closed) => [...closed, tip]);
  const tip = (kind: TipKind) =>
    tips.includes(kind) ? <FirstTimeTip key={`tip-${kind}`} {...tipText(kind, catalog)} onDismiss={() => dismissTip(kind)} /> : null;

  const avatarName = useCallback((key: string) => catalog?.avatars.find((a) => a.key === key)?.name ?? null, [catalog]);

  const pull = async () => {
    setRefreshing(true);
    try {
      await refresh();
      setError(null);
    } catch (e) {
      setError(genericErrorMessage(e as Error));
    }
    setRefreshing(false);
  };

  const status = streak && today ? streakStatusLine(streak, today.date) : null;
  const olderChests = today ? today.chestsReady.filter((day) => day !== today.date) : [];
  const waiting = state && today ? pendingLine(today.pendingCheckins, state.points.pending) : null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.groupedBackground }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} />}>
      {!state ? (
        <Text style={[type.body, { color: colors.secondaryLabel, textAlign: 'center' }]}>
          {loadError ? 'Vandaag kon niet geladen worden. Trek omlaag om opnieuw te proberen.' : 'Laden…'}
        </Text>
      ) : null}
      {error && state ? <Text style={[type.footnote, { color: colors.red, textAlign: 'center' }]}>{error}</Text> : null}

      {streak ? (
        <View style={{ gap: spacing.sm }}>
          {tip('streak')}
          <View style={[card, { gap: spacing.lg }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <StreakFlame weeks={streak.weeks} />
              <View style={{ flex: 1 }}>
                <Text style={[type.title2, { color: colors.label }]}>{streakWeeksLabel(streak.weeks)}</Text>
                {catalog && streak.weeks > 0 ? (
                  <Text style={[type.subheadline, { color: colors.secondaryLabel }]}>
                    {`Reeks · ${streakMultiplierLabel(catalog.config, streak.weeks)} op je punten`}
                  </Text>
                ) : null}
              </View>
            </View>
            {today ? <DayDots dots={dayDots(streak, today.date)} /> : null}
            {status ? (
              <Text
                style={[
                  type.subheadline,
                  { fontWeight: '600', color: status.tone === 'danger' ? colors.orange : status.tone === 'good' ? colors.label : colors.secondaryLabel },
                ]}>
                {status.text}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <SymbolView name="snowflake" size={16} tintColor={streak.freezes > 0 ? colors.tint : colors.tertiaryLabel} />
              <Text style={[type.footnote, { color: colors.secondaryLabel, flex: 1 }]}>{freezeLine(streak)}</Text>
            </View>
          </View>
        </View>
      ) : null}

      {today && today.quests.length > 0 ? (
        <View style={{ gap: spacing.sm }}>
          {tip('quests')}
          <SectionTitle right={`${questsDone(today.quests)}/${today.quests.length}`}>Quests van vandaag</SectionTitle>
          <View style={[card, { paddingVertical: spacing.sm }]}>
            {today.quests.map((quest) => (
              <QuestRow key={quest.id} model={questRow(quest)} />
            ))}
          </View>
        </View>
      ) : null}

      {today?.chest ? (
        <View style={{ gap: spacing.sm }}>
          {tip('chest')}
          <SectionTitle>Dagkist</SectionTitle>
          <ChestCard chest={today.chest} focused={focused} avatarName={avatarName} />
        </View>
      ) : null}

      {today && olderChests.length > 0 ? (
        <View style={[card, { paddingVertical: spacing.xs }]}>
          {olderChests.map((day) => (
            <LinkRow key={day} title={`Je kist van ${dayLabel(day, today.date)} staat nog klaar`} symbol="shippingbox.fill" color={playColors.gold} onPress={() => openChest(day)} />
          ))}
        </View>
      ) : null}

      {today?.weekly ? (
        <View style={{ gap: spacing.sm }}>
          <SectionTitle right={weeklyRow(today.weekly, today.date).daysLeftLabel}>Weekuitdaging</SectionTitle>
          <View style={[card, { paddingVertical: spacing.sm }]}>
            <QuestRow model={weeklyRow(today.weekly, today.date)} />
          </View>
        </View>
      ) : null}

      {waiting ? (
        <View style={{ alignItems: 'center' }}>
          <PendingTag text={waiting} />
        </View>
      ) : null}

      <View style={[card, { paddingVertical: spacing.xs }]}>
        <LinkRow title="Ranglijst" symbol="trophy.fill" color={colors.yellow} onPress={() => router.push('/(tabs)/(today)/leaderboard')} />
        <View style={{ height: 0.5, backgroundColor: colors.separator, marginLeft: 32 }} />
        <LinkRow title="Collectie" symbol="square.grid.2x2.fill" color={colors.tint} onPress={() => router.push('/(tabs)/(today)/collection')} />
      </View>
    </ScrollView>
  );
}
