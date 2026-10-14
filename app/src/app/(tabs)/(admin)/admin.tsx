// Moderation: approve or reject check-ins and reports of missing bins.
import { Host } from '@expo/ui';
import { Button, HStack, Picker, Text as SwiftText } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, disabled, frame, pickerStyle, tag, tint } from '@expo/ui/swift-ui/modifiers';
import { router, useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useState, type ReactNode } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

import { EmptyState } from '@/components/EmptyState';
import { PrivatePhoto } from '@/components/PrivatePhoto';
import {
  fetchPendingCheckins,
  fetchPendingReports,
  reviewCheckin,
  reviewReport,
  type PendingCheckin,
  type PendingReport,
} from '@/lib/api';
import { adminErrorMessage, genericErrorMessage } from '@/lib/errors';
import { formatDateTime, formatWeeks } from '@/lib/format';
import { formatDistance } from '@/lib/geo';
import { useDevMode } from '@/providers/DevModeProvider';
import { colors, radius, spacing, type } from '@/theme';

type Tab = 'checkins' | 'reports';
const DUPLICATE_WARNING_M = 15;

function Flag({ symbol, color, children }: { symbol: SFSymbol; color: typeof colors.tint; children: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <SymbolView name={symbol} size={14} tintColor={color} />
      <Text style={[type.subheadline, { color, fontWeight: '600', flexShrink: 1 }]}>{children}</Text>
    </View>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: colors.cell,
        borderRadius: radius.card,
        borderCurve: 'continuous',
        padding: spacing.md,
        gap: spacing.xs + 2,
      }}>
      {children}
    </View>
  );
}

/** Reject (bordered, red) and approve (filled, green), side by side. */
function Decision({ busy, onReject, onApprove }: { busy: boolean; onReject: () => void; onApprove: () => void }) {
  return (
    <Host matchContents={{ vertical: true }} style={{ alignSelf: 'stretch', marginTop: spacing.sm }}>
      <HStack spacing={10}>
        <Button
          role="destructive"
          onPress={onReject}
          modifiers={[buttonStyle('bordered'), controlSize('large'), disabled(busy)]}>
          <SwiftText modifiers={[frame({ maxWidth: 10000 })]}>Afwijzen</SwiftText>
        </Button>
        <Button
          onPress={onApprove}
          modifiers={[buttonStyle('borderedProminent'), controlSize('large'), tint(colors.tint), disabled(busy)]}>
          <SwiftText modifiers={[frame({ maxWidth: 10000 })]}>{busy ? 'Even geduld…' : 'Goedkeuren'}</SwiftText>
        </Button>
      </HStack>
    </Host>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <Text style={[type.subheadline, { color: colors.secondaryLabel }]}>{children}</Text>;
}

export default function AdminScreen() {
  const [tab, setTab] = useState<Tab>('checkins');
  const [checkins, setCheckins] = useState<PendingCheckin[]>([]);
  const [reports, setReports] = useState<PendingReport[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dev = useDevMode();

  const load = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([fetchPendingCheckins(), fetchPendingReports()]);
      setCheckins(c);
      setReports(r);
      setError(null);
    } catch (e) {
      setError(genericErrorMessage(e as Error));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const decideCheckin = async (item: PendingCheckin, approve: boolean) => {
    setBusyId(item.id);
    try {
      await reviewCheckin(item.id, approve);
      setCheckins((list) => list.filter((c) => c.id !== item.id));
    } catch (e) {
      Alert.alert('Niet gelukt', adminErrorMessage(e as Error));
      load();
    } finally {
      setBusyId(null);
    }
  };

  const decideReport = (item: PendingReport, approve: boolean) => {
    const run = async () => {
      setBusyId(item.id);
      try {
        await reviewReport(item.id, approve);
        setReports((list) => list.filter((r) => r.id !== item.id));
      } catch (e) {
        Alert.alert('Niet gelukt', adminErrorMessage(e as Error));
        load();
      } finally {
        setBusyId(null);
      }
    };
    if (!approve) return run();
    Alert.alert('Vuilbak toevoegen?', 'Na goedkeuring verschijnt deze vuilbak op de kaart en kunnen gebruikers er punten mee verdienen.', [
      { text: 'Annuleren', style: 'cancel' },
      { text: 'Toevoegen', onPress: run },
    ]);
  };

  const header = (
    <View style={{ gap: spacing.md, paddingBottom: spacing.sm }}>
      {dev.available ? (
        <Pressable
          onPress={() => router.push('/dev-mode')}
          accessibilityRole="button"
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.md,
            backgroundColor: colors.cell,
            borderRadius: radius.card,
            borderCurve: 'continuous',
            padding: spacing.md,
            opacity: pressed ? 0.7 : 1,
          })}>
          <SymbolView name="hammer.circle.fill" size={30} tintColor={colors.purple} />
          <View style={{ flex: 1 }}>
            <Text style={[type.headline, { color: colors.label }]}>Dev-modus</Text>
            <Text style={[type.footnote, { color: colors.secondaryLabel }]}>
              {`Test alles op ${dev.status?.environment ?? 'deze server'} zonder rond te lopen`}
            </Text>
          </View>
          <SymbolView name="chevron.right" size={14} tintColor={colors.tertiaryLabel} />
        </Pressable>
      ) : null}
      <Host matchContents={{ vertical: true }} style={{ alignSelf: 'stretch' }}>
        <Picker selection={tab} onSelectionChange={(value) => setTab(value as Tab)} modifiers={[pickerStyle('segmented')]}>
          <SwiftText modifiers={[tag('checkins')]}>{`Inworpen (${checkins.length})`}</SwiftText>
          <SwiftText modifiers={[tag('reports')]}>{`Meldingen (${reports.length})`}</SwiftText>
        </Picker>
      </Host>
      {error ? <Flag symbol="exclamationmark.triangle.fill" color={colors.red}>{error}</Flag> : null}
    </View>
  );

  const listProps = {
    style: { flex: 1, backgroundColor: colors.groupedBackground },
    contentInsetAdjustmentBehavior: 'automatic' as const,
    contentContainerStyle: { padding: spacing.lg, gap: spacing.md },
    refreshControl: <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />,
    ListHeaderComponent: header,
  };

  if (tab === 'checkins') {
    return (
      <FlatList
        {...listProps}
        data={checkins}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={
          <EmptyState title="Geen inworpen" systemImage="checkmark.seal" description="Er wachten geen inworpen op goedkeuring." style={{ height: 320 }} />
        }
        renderItem={({ item }) => (
          <Card>
            <PrivatePhoto bucket="checkin-photos" path={item.photo_path} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs }}>
              <Text style={[type.headline, { color: colors.label, flexShrink: 1 }]}>{item.display_name ?? 'Onbekende gebruiker'}</Text>
              {item.is_test ? (
                <Text style={[type.caption, { color: 'white', backgroundColor: colors.purple, paddingHorizontal: 6, borderRadius: 6, overflow: 'hidden', fontWeight: '700' }]}>
                  TEST
                </Text>
              ) : null}
            </View>
            <Meta>{`${formatDateTime(item.created_at)} · vuilbak #${item.bin_id}`}</Meta>
            <Meta>{`${formatDistance(item.distance_m)} van de vuilbak · gps ±${Math.round(item.accuracy_m)} m`}</Meta>
            <Meta>
              {`Levert ${item.points_earned + item.bonus_points} punten op · reeks ${formatWeeks(item.streak_weeks)}${
                item.bonus_points > 0 ? ` · bonus +${item.bonus_points}` : ''
              }`}
            </Meta>
            {item.is_fake_location ? (
              <Flag symbol="mappin.and.ellipse" color={colors.purple}>Testlocatie (Dev-modus)</Flag>
            ) : null}
            {item.is_mocked ? <Flag symbol="location.slash.fill" color={colors.orange}>Gesimuleerde locatie gemeld</Flag> : null}
            {item.bonus_suspicious ? (
              <Flag symbol="stopwatch.fill" color={colors.orange}>Bonusvraag verdacht snel beantwoord</Flag>
            ) : null}
            <Decision
              busy={busyId !== null}
              onReject={() => decideCheckin(item, false)}
              onApprove={() => decideCheckin(item, true)}
            />
          </Card>
        )}
      />
    );
  }

  return (
    <FlatList
      {...listProps}
      data={reports}
      keyExtractor={(item) => item.id}
      ListEmptyComponent={
        <EmptyState title="Geen meldingen" systemImage="mappin.slash" description="Er wachten geen meldingen van ontbrekende vuilbakken." style={{ height: 320 }} />
      }
      renderItem={({ item }) => (
        <Card>
          <PrivatePhoto bucket="report-photos" path={item.photo_path} />
          <Text style={[type.headline, { color: colors.label, marginTop: spacing.xs }]}>{item.display_name ?? 'Onbekende gebruiker'}</Text>
          <Meta>{formatDateTime(item.created_at)}</Meta>
          <Text selectable style={[type.subheadline, { color: colors.secondaryLabel, fontVariant: ['tabular-nums'] }]}>
            {`${item.latitude.toFixed(6)}, ${item.longitude.toFixed(6)}`}
          </Text>
          {item.note ? <Text style={[type.body, { color: colors.label, fontStyle: 'italic' }]}>{`“${item.note}”`}</Text> : null}
          {item.nearest_bin_m !== null ? (
            item.nearest_bin_m < DUPLICATE_WARNING_M ? (
              <Flag symbol="exclamationmark.triangle.fill" color={colors.orange}>
                {`Dichtstbijzijnde vuilbak: ${formatDistance(item.nearest_bin_m)} (mogelijk dubbel)`}
              </Flag>
            ) : (
              <Meta>{`Dichtstbijzijnde vuilbak: ${formatDistance(item.nearest_bin_m)}`}</Meta>
            )
          ) : null}
          <Decision busy={busyId !== null} onReject={() => decideReport(item, false)} onApprove={() => decideReport(item, true)} />
        </Card>
      )}
    />
  );
}
