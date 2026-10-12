import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
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
import { formatDateTime } from '@/lib/format';
import { formatDistance } from '@/lib/geo';
import { colors, spacing } from '@/theme';

type Tab = 'checkins' | 'reports';
const DUPLICATE_WARNING_M = 15;

export default function AdminScreen() {
  const [tab, setTab] = useState<Tab>('checkins');
  const [checkins, setCheckins] = useState<PendingCheckin[]>([]);
  const [reports, setReports] = useState<PendingReport[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const tabs = (
    <View style={styles.tabs}>
      {(['checkins', 'reports'] as const).map((key) => (
        <Pressable
          key={key}
          onPress={() => setTab(key)}
          style={[styles.tab, tab === key && styles.tabActive]}
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === key }}>
          <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>
            {key === 'checkins' ? `Check-ins (${checkins.length})` : `Meldingen (${reports.length})`}
          </Text>
        </Pressable>
      ))}
    </View>
  );

  const header = (
    <View style={styles.header}>
      {tabs}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
  const refresh = <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />;

  if (tab === 'checkins') {
    return (
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.content}
        data={checkins}
        keyExtractor={(item) => item.id}
        refreshControl={refresh}
        ListHeaderComponent={header}
        ListEmptyComponent={<Text style={styles.empty}>Geen check-ins om te beoordelen.</Text>}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <PrivatePhoto bucket="checkin-photos" path={item.photo_path} />
            <Text style={styles.title}>{item.display_name ?? 'Onbekende gebruiker'}</Text>
            <Text style={styles.meta}>
              {formatDateTime(item.created_at)} · vuilbak #{item.bin_id}
            </Text>
            <Text style={styles.meta}>
              {formatDistance(item.distance_m)} van de vuilbak · gps ±{Math.round(item.accuracy_m)} m
            </Text>
            {item.is_fake_location ? <Text style={styles.flag}>Nep-locatie (dev)</Text> : null}
            {item.is_mocked ? <Text style={styles.flag}>Gesimuleerde locatie gemeld</Text> : null}
            <View style={styles.row}>
              <Button
                title="Afwijzen"
                variant="secondary"
                onPress={() => decideCheckin(item, false)}
                disabled={busyId !== null}
                style={styles.flex}
              />
              <Button
                title="Goedkeuren"
                onPress={() => decideCheckin(item, true)}
                loading={busyId === item.id}
                disabled={busyId !== null}
                style={styles.flex}
              />
            </View>
          </View>
        )}
      />
    );
  }

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.content}
      data={reports}
      keyExtractor={(item) => item.id}
      refreshControl={refresh}
      ListHeaderComponent={header}
      ListEmptyComponent={<Text style={styles.empty}>Geen meldingen om te beoordelen.</Text>}
      renderItem={({ item }) => (
        <View style={styles.card}>
          <PrivatePhoto bucket="report-photos" path={item.photo_path} />
          <Text style={styles.title}>{item.display_name ?? 'Onbekende gebruiker'}</Text>
          <Text style={styles.meta}>{formatDateTime(item.created_at)}</Text>
          <Text style={styles.meta}>
            {item.latitude.toFixed(6)}, {item.longitude.toFixed(6)}
          </Text>
          {item.note ? <Text style={styles.note}>“{item.note}”</Text> : null}
          {item.nearest_bin_m !== null ? (
            <Text style={item.nearest_bin_m < DUPLICATE_WARNING_M ? styles.flag : styles.meta}>
              Dichtstbijzijnde vuilbak: {formatDistance(item.nearest_bin_m)}
              {item.nearest_bin_m < DUPLICATE_WARNING_M ? ' (mogelijk dubbel)' : ''}
            </Text>
          ) : null}
          <View style={styles.row}>
            <Button
              title="Afwijzen"
              variant="secondary"
              onPress={() => decideReport(item, false)}
              disabled={busyId !== null}
              style={styles.flex}
            />
            <Button
              title="Goedkeuren"
              onPress={() => decideReport(item, true)}
              loading={busyId === item.id}
              disabled={busyId !== null}
              style={styles.flex}
            />
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md },
  header: { gap: spacing.sm },
  tabs: { flexDirection: 'row', backgroundColor: '#e6e8e6', borderRadius: 12, padding: 4 },
  tab: { flex: 1, paddingVertical: spacing.sm, borderRadius: 9, alignItems: 'center' },
  tabActive: { backgroundColor: colors.surface },
  tabText: { fontSize: 15, color: colors.muted, fontWeight: '600' },
  tabTextActive: { color: colors.text },
  error: { color: colors.danger },
  empty: { color: colors.muted, fontSize: 15, paddingVertical: spacing.lg, textAlign: 'center' },
  card: { backgroundColor: colors.surface, borderRadius: 14, padding: spacing.md, gap: spacing.xs },
  title: { fontSize: 17, fontWeight: '700', color: colors.text, marginTop: spacing.sm },
  meta: { fontSize: 14, color: colors.muted },
  note: { fontSize: 15, color: colors.text, fontStyle: 'italic' },
  flag: { fontSize: 14, fontWeight: '700', color: colors.warning },
  row: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  flex: { flex: 1 },
});
