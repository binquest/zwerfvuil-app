// The profile (docs/GAMIFICATION.md, chapter 5), in React Native: the avatar
// in the ring to the next level (tap = the picker), name, level and title;
// the points (rolling) with what waits for approval; the statistics (the
// streak itself is on Today); the
// badges in a grid of 3 (locked = silhouette, tap = how to earn it); the
// collection and the leaderboard; the history. The gear opens the settings
// (name, account, app, sign out).
import { router, Stack, useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

import { Avatar, BadgeGrid, BadgeIcon, GameNumber, PendingTag, ProgressRing } from '@/components/game';
import { badgeCountLabel, badgeStatusLine, type Badge } from '@/game/badges';
import { levelLabel, levelProgress, toNextLabel } from '@/game/levels';
import { fetchMyBadges, fetchMyHistory } from '@/lib/api';
import { genericErrorMessage } from '@/lib/errors';
import { formatDate, formatDateTime, formatWeeks } from '@/lib/format';
import { formatDistance } from '@/lib/geo';
import { buildHistory, formatHistoryPoints, HISTORY_LABEL, type HistoryItem, type HistoryState } from '@/lib/history';
import { useAuth } from '@/providers/AuthProvider';
import { useGame } from '@/providers/GameProvider';
import { colors, numberStyle, radius, spacing, type } from '@/theme';
import { NUMBER_MAX_FONT_SCALE, playType } from '@/theme/game';

const RING = 132;
const AVATAR = 104;

const STATUS_STYLE: Record<HistoryState, { symbol: SFSymbol; color: typeof colors.tint }> = {
  pending: { symbol: 'clock.fill', color: colors.orange },
  granted: { symbol: 'checkmark.circle.fill', color: colors.green },
  rejected: { symbol: 'xmark.circle.fill', color: colors.red },
  revoked: { symbol: 'arrow.uturn.backward.circle.fill', color: colors.red },
};

const card = { backgroundColor: colors.cell, borderRadius: radius.card, borderCurve: 'continuous', padding: spacing.lg } as const;

function SectionTitle({ children }: { children: string }) {
  return (
    <Text style={[playType.label, { color: colors.secondaryLabel, paddingHorizontal: spacing.xs }]} accessibilityRole="header">
      {children}
    </Text>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1, gap: spacing.xs }} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        maxFontSizeMultiplier={NUMBER_MAX_FONT_SCALE}
        style={[{ fontSize: 22, lineHeight: 28, color: colors.label }, numberStyle]}>
        {value}
      </Text>
      <Text numberOfLines={2} style={[type.caption, { color: colors.secondaryLabel }]}>
        {label}
      </Text>
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

/** The explanation of the badge tapped in the grid: what it is, how to earn it, how far along you are. */
function BadgeExplanation({ badge }: { badge: Badge | null }) {
  if (!badge) {
    return <Text style={[type.footnote, { color: colors.secondaryLabel, textAlign: 'center' }]}>Tik op een badge om te zien hoe je hem verdient.</Text>;
  }
  const line = badgeStatusLine(badge, formatDate);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }} accessible accessibilityLiveRegion="polite">
      <BadgeIcon badge={badge} size={48} locked={badge.status === 'locked'} decorative />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.headline, { color: colors.label }]}>{badge.name}</Text>
        <Text style={[type.footnote, { color: colors.label }]}>{badge.description}</Text>
        {badge.status === 'pending' ? <PendingTag style={{ alignSelf: 'flex-start', marginTop: spacing.xs }} /> : null}
        {line && badge.status !== 'pending' ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{line}</Text> : null}
      </View>
    </View>
  );
}

function HistoryRow({ item }: { item: HistoryItem }) {
  const status = STATUS_STYLE[item.state];
  const when = item.distanceM === null ? formatDateTime(item.date) : `${formatDateTime(item.date)} · ${formatDistance(item.distanceM)}`;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm }} accessible>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.body, { color: colors.label }]}>{`${item.title}${item.isTest ? ' · test' : ''}`}</Text>
        <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{when}</Text>
        {item.reason ? <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{item.reason}</Text> : null}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
          <SymbolView name={status.symbol} size={13} tintColor={status.color} />
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{HISTORY_LABEL[item.state]}</Text>
        </View>
        <Text style={[type.footnote, { color: colors.label, fontWeight: '600', fontVariant: ['tabular-nums'] }]}>
          {formatHistoryPoints(item)}
        </Text>
      </View>
    </View>
  );
}

export function ProfileScreen() {
  const { session, profile, refreshProfile } = useAuth();
  const { state, refresh } = useGame();
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [badges, setBadges] = useState<Badge[] | null>(null);
  const [focusedBadge, setFocusedBadge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const userId = session?.user.id;
  const load = useCallback(async () => {
    if (!userId) return;
    // The badges on their own: a failure there leaves the rest of the profile.
    fetchMyBadges().then(setBadges, () => {});
    try {
      const [mine] = await Promise.all([fetchMyHistory(userId), refresh(), refreshProfile()]);
      setHistory(buildHistory(mine.checkins, mine.entries));
      setError(null);
    } catch (e) {
      setError(genericErrorMessage(e as Error));
    }
  }, [userId, refresh, refreshProfile]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const pull = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const points = state?.points.granted ?? profile?.points ?? 0;
  const pending = state?.points.pending ?? 0;
  const level = state?.level ?? null;
  const progress = level ? levelProgress(level, points) : null;
  const stats = state?.stats ?? null;

  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="gearshape" accessibilityLabel="Instellingen" onPress={() => router.push('/settings')} />
      </Stack.Toolbar>
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.groupedBackground }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} />}>
        <View style={{ alignItems: 'center', gap: spacing.sm }}>
          <Pressable
            onPress={() => router.push('/avatar-picker')}
            accessibilityRole="button"
            accessibilityLabel="Avatar wijzigen"
            style={({ pressed }) => ({ width: RING, height: RING, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.8 : 1 })}>
            {level && progress ? (
              <View style={{ position: 'absolute' }} pointerEvents="none">
                <ProgressRing
                  value={progress.value}
                  max={progress.max}
                  size={RING}
                  label={`${levelLabel(level.level, level.title)}, ${toNextLabel(level, points)}`}
                />
              </View>
            ) : null}
            <Avatar avatarKey={profile?.avatarKey} size={AVATAR} decorative />
            <View
              style={{
                position: 'absolute',
                right: spacing.sm,
                bottom: spacing.sm,
                width: 30,
                height: 30,
                borderRadius: 15,
                backgroundColor: colors.cell,
                alignItems: 'center',
                justifyContent: 'center',
              }}>
              <SymbolView name="pencil" size={14} tintColor={colors.label} />
            </View>
          </Pressable>
          <Text style={[type.title2, { color: colors.label, textAlign: 'center' }]} accessibilityRole="header">
            {profile?.displayName ?? 'Zonder naam'}
          </Text>
          {level ? (
            <View style={{ alignItems: 'center', gap: 2 }}>
              <Text style={[type.headline, { color: colors.label }]}>{levelLabel(level.level, level.title)}</Text>
              <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{toNextLabel(level, points)}</Text>
            </View>
          ) : null}
        </View>

        {error ? <Text style={[type.footnote, { color: colors.red, textAlign: 'center' }]}>{error}</Text> : null}

        <View style={[card, { alignItems: 'center', gap: spacing.xs }]}>
          <Text style={[playType.label, { color: colors.secondaryLabel }]}>Jouw punten</Text>
          <GameNumber
            value={points}
            style={[{ fontSize: 56, lineHeight: 64, color: colors.tint }, numberStyle]}
          />
          {pending > 0 ? <PendingTag text={`+${pending} wacht op goedkeuring`} /> : null}
        </View>

        {state ? (
          <View style={[card, { gap: spacing.lg }]}>
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <Stat label="Ontdekt" value={`${state.discovered}/${state.totalBins}`} />
              <Stat label="Inworpen" value={String(stats?.checkins ?? 0)} />
            </View>
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <Stat label="Bonusvragen" value={String(stats?.bonusAnswers ?? 0)} />
              <Stat label="Langste reeks" value={stats && stats.longestStreak > 0 ? formatWeeks(stats.longestStreak) : '—'} />
            </View>
          </View>
        ) : null}

        {badges && badges.length > 0 ? (
          <View style={{ gap: spacing.sm }}>
            <SectionTitle>{`Badges · ${badgeCountLabel(badges)}`}</SectionTitle>
            <View style={[card, { gap: spacing.lg }]}>
              <BadgeExplanation badge={badges.find((b) => b.key === focusedBadge) ?? null} />
              <BadgeGrid
                badges={badges}
                selected={focusedBadge}
                onSelect={(badge) => setFocusedBadge(badge.key)}
                inset={spacing.lg * 2}
              />
            </View>
          </View>
        ) : null}

        <View style={[card, { paddingVertical: spacing.xs }]}>
          <LinkRow title="Collectie" symbol="square.grid.2x2.fill" color={colors.tint} onPress={() => router.push('/(tabs)/(profile)/collection')} />
          <View style={{ height: 0.5, backgroundColor: colors.separator, marginLeft: 32 }} />
          <LinkRow title="Ranglijst" symbol="trophy.fill" color={colors.yellow} onPress={() => router.push('/(tabs)/(profile)/leaderboard')} />
        </View>

        <View style={{ gap: spacing.sm }}>
          <SectionTitle>Historiek</SectionTitle>
          <View style={[card, { paddingVertical: spacing.sm }]}>
            {history === null ? (
              <Text style={[type.body, { color: colors.secondaryLabel }]}>Laden…</Text>
            ) : history.length === 0 ? (
              <Text style={[type.body, { color: colors.secondaryLabel }]}>
                Nog geen inworpen. Raap zwerfvuil op en gooi het in een vuilbak op de kaart.
              </Text>
            ) : (
              history.map((item) => <HistoryRow key={item.key} item={item} />)
            )}
          </View>
        </View>
      </ScrollView>
    </>
  );
}
