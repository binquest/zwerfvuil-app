// The leaderboard (docs/GAMIFICATION.md, chapter 5), in React Native: this
// week or all time; a row is the place (a medal for the top 3), the avatar,
// the name with "Lv 7 · Stoepridder", and the points. The caller's own row is
// always visible: pinned at the bottom while it is out of view. One screen,
// routed from the profile (and from Vandaag in phase 6).
import { Host } from '@expo/ui';
import { Picker, Text as SwiftText } from '@expo/ui/swift-ui';
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useState } from 'react';
import { FlatList, RefreshControl, Switch, Text, View, type ViewToken } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { track } from '@/analytics';
import { Avatar } from '@/components/game';
import { EmptyState } from '@/components/EmptyState';
import { shortLevelLabel } from '@/game/levels';
import { fetchLeaderboard, type LeaderboardPeriod, type LeaderboardRow } from '@/lib/api';
import { genericErrorMessage } from '@/lib/errors';
import { useDevMode } from '@/providers/DevModeProvider';
import { colors, numberStyle, radius, spacing, type } from '@/theme';

const MEDALS = [colors.yellow, colors.gray, colors.orange];
const PERIODS: { value: LeaderboardPeriod; label: string }[] = [
  { value: 'week', label: 'Deze week' },
  { value: 'all', label: 'Altijd' },
];
const ROW_HEIGHT = 64;
// The own row counts as visible when it is fully on screen (one object for the list's whole life).
const VIEWABILITY = { itemVisiblePercentThreshold: 100 };

function Row({ row, pinned = false }: { row: LeaderboardRow; pinned?: boolean }) {
  const medal = row.place <= 3 ? MEDALS[row.place - 1] : null;
  return (
    <View
      accessible
      accessibilityLabel={`Plaats ${row.place}, ${row.display_name}${row.is_me ? ' (jij)' : ''}, level ${row.level} ${row.title}, ${row.points} punten`}
      style={{
        height: ROW_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.md,
        backgroundColor: colors.cell,
        borderRadius: radius.control,
        borderCurve: 'continuous',
        borderWidth: row.is_me ? 2 : 0,
        borderColor: colors.tint,
        ...(pinned ? { shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } } : null),
      }}>
      <View style={{ width: 28, alignItems: 'center' }}>
        {medal ? (
          <SymbolView name="medal.fill" size={22} tintColor={medal} />
        ) : (
          <Text style={[type.body, { color: colors.secondaryLabel, fontVariant: ['tabular-nums'] }]}>{row.place}</Text>
        )}
      </View>
      <Avatar avatarKey={row.avatar_key} size={40} decorative />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={[type.headline, { color: row.is_me ? colors.tint : colors.label }]}>
          {row.is_me ? `${row.display_name} (jij)` : row.display_name}
        </Text>
        <Text numberOfLines={1} style={[type.footnote, { color: colors.secondaryLabel }]}>
          {shortLevelLabel(row.level, row.title)}
        </Text>
      </View>
      <Text style={[{ fontSize: 17, color: colors.label }, numberStyle]}>{row.points}</Text>
    </View>
  );
}

export function LeaderboardScreen() {
  const [period, setPeriod] = useState<LeaderboardPeriod>('week');
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [meVisible, setMeVisible] = useState(true);
  const dev = useDevMode();
  const includeTest = dev.showTestData;

  // Opened, or another period.
  useFocusEffect(
    useCallback(() => {
      track('leaderboard_viewed', { period });
    }, [period]),
  );

  // On focus and on every period switch; an older answer that arrives late
  // (fast switches) is ignored.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      fetchLeaderboard(period, includeTest)
        .then((next) => {
          if (!active) return;
          setRows(next);
          setError(null);
        })
        .catch((e) => active && setError(genericErrorMessage(e as Error)));
      return () => {
        active = false;
      };
    }, [period, includeTest]),
  );

  const pull = async () => {
    setRefreshing(true);
    try {
      setRows(await fetchLeaderboard(period, includeTest));
      setError(null);
    } catch (e) {
      setError(genericErrorMessage(e as Error));
    }
    setRefreshing(false);
  };

  // FlatList wants one callback for its whole life (no dependencies).
  const onViewable = useCallback(({ viewableItems }: { viewableItems: ViewToken<LeaderboardRow>[] }) => {
    setMeVisible(viewableItems.some((v) => v.item?.is_me));
  }, []);

  const me = rows?.find((r) => r.is_me) ?? null;
  const pinMe = !!me && !meVisible;

  const header = (
    <View style={{ gap: spacing.md, paddingBottom: spacing.sm }}>
      <Host matchContents={{ vertical: true }}>
        <Picker selection={period} onSelectionChange={(value) => setPeriod(value as LeaderboardPeriod)} modifiers={[pickerStyle('segmented')]}>
          {PERIODS.map((p) => (
            <SwiftText key={p.value} modifiers={[tag(p.value)]}>
              {p.label}
            </SwiftText>
          ))}
        </Picker>
      </Host>
      {dev.available ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <View style={{ flex: 1 }}>
            <Text style={[type.body, { color: colors.label }]}>Testdata tonen</Text>
            <Text style={[type.footnote, { color: colors.secondaryLabel }]}>
              Dev-modus: ook punten van testinworpen. Het level telt alleen echte punten.
            </Text>
          </View>
          <Switch value={dev.showTestData} onValueChange={dev.setShowTestData} accessibilityLabel="Testdata tonen" />
        </View>
      ) : null}
      {error ? <Text style={[type.footnote, { color: colors.red }]}>{error}</Text> : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.groupedBackground }}>
      <FlatList
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.lg + (pinMe ? ROW_HEIGHT + spacing.lg : 0) }}
        data={rows ?? []}
        keyExtractor={(row, index) => `${row.place}-${index}`}
        ListHeaderComponent={header}
        ListEmptyComponent={
          rows && !error ? (
            <EmptyState
              title={period === 'week' ? 'Nog geen punten deze week' : 'Nog geen punten'}
              systemImage="trophy"
              description="Punten verschijnen hier zodra een inworp is goedgekeurd."
            />
          ) : null
        }
        ListFooterComponent={
          rows && rows.length > 0 ? (
            <Text style={[type.footnote, { color: colors.secondaryLabel, paddingTop: spacing.sm }]}>
              Alleen naam, avatar en level zijn zichtbaar. Je naam wijzig je in Instellingen.
            </Text>
          ) : null
        }
        renderItem={({ item }) => <Row row={item} />}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={VIEWABILITY}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} />}
      />
      {pinMe && me ? (
        // The native safe area of this screen includes the tab bar.
        <SafeAreaView edges={['bottom']} pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
            <Row row={me} pinned />
          </View>
        </SafeAreaView>
      ) : null}
    </View>
  );
}
