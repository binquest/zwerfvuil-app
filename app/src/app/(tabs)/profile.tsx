import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { StatusBadge } from '@/components/StatusBadge';
import { fetchMyCheckins, type MyCheckin } from '@/lib/api';
import { genericErrorMessage } from '@/lib/errors';
import { formatDateTime, formatPoints } from '@/lib/format';
import { formatDistance } from '@/lib/geo';
import { useAuth } from '@/providers/AuthProvider';
import { colors, spacing } from '@/theme';

export default function ProfileScreen() {
  const { session, profile, refreshProfile, signOut } = useAuth();
  const [checkins, setCheckins] = useState<MyCheckin[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list] = await Promise.all([fetchMyCheckins(), refreshProfile()]);
      setCheckins(list);
      setError(null);
    } catch (e) {
      setError(genericErrorMessage(e as Error));
    }
  }, [refreshProfile]);

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

  const confirmSignOut = () =>
    Alert.alert('Afmelden?', 'Je kunt je later opnieuw aanmelden met een code per e-mail.', [
      { text: 'Annuleren', style: 'cancel' },
      { text: 'Afmelden', style: 'destructive', onPress: signOut },
    ]);

  const pending = checkins.filter((c) => c.status === 'pending').length;

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.content}
      data={checkins}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.pointsCard}>
            <Text style={styles.pointsLabel}>Jouw punten</Text>
            <Text style={styles.points}>{profile?.points ?? '–'}</Text>
            {pending > 0 ? (
              <Text style={styles.pendingText}>
                {pending} {pending === 1 ? 'inworp wacht' : 'inworpen wachten'} op goedkeuring
              </Text>
            ) : null}
          </View>
          <Text style={styles.name}>{profile?.displayName ?? 'Zonder naam'}</Text>
          <Text style={styles.email}>{session?.user.email}</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Text style={styles.sectionTitle}>Historiek</Text>
        </View>
      }
      ListEmptyComponent={
        <Text style={styles.empty}>Nog geen inworpen. Raap zwerfvuil op en gooi het in een vuilbak op de kaart.</Text>
      }
      renderItem={({ item }) => (
        <View style={styles.item}>
          <View style={styles.itemMain}>
            <Text style={styles.itemTitle}>Vuilbak #{item.bin_id}</Text>
            <Text style={styles.itemMeta}>
              {formatDateTime(item.created_at)} · {formatDistance(item.distance_m)}
              {__DEV__ && item.is_fake_location ? ' · nep-locatie (dev)' : ''}
            </Text>
          </View>
          <View style={styles.itemSide}>
            <StatusBadge status={item.status} />
            {item.status === 'approved' ? (
              <Text style={styles.itemPoints}>+{formatPoints(item.points_awarded)}</Text>
            ) : null}
          </View>
        </View>
      )}
      ListFooterComponent={<Button title="Afmelden" variant="secondary" onPress={confirmSignOut} style={styles.signOut} />}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.sm },
  header: { gap: spacing.xs, marginBottom: spacing.sm },
  pointsCard: {
    backgroundColor: colors.primary,
    borderRadius: 16,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  pointsLabel: { color: '#d8efdf', fontSize: 15 },
  points: { color: '#fff', fontSize: 44, fontWeight: '800' },
  pendingText: { color: '#d8efdf', fontSize: 14 },
  name: { fontSize: 20, fontWeight: '700', color: colors.text },
  email: { fontSize: 14, color: colors.muted },
  error: { color: colors.danger, marginTop: spacing.sm },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: colors.text, marginTop: spacing.lg },
  empty: { color: colors.muted, fontSize: 15, paddingVertical: spacing.lg },
  item: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  itemMain: { flex: 1, gap: 2 },
  itemTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
  itemMeta: { fontSize: 13, color: colors.muted },
  itemSide: { alignItems: 'flex-end', gap: 4 },
  itemPoints: { fontSize: 13, fontWeight: '700', color: colors.primary },
  signOut: { marginTop: spacing.xl },
});
