import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polygon, type LongPressEvent, type MapPressEvent } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { OsmAttribution } from '@/components/OsmAttribution';
import { fetchBins, setBinEligibility, type Bin } from '@/lib/api';
import { adminErrorMessage, genericErrorMessage } from '@/lib/errors';
import { checkinAvailability, distanceMeters, formatDistance, nearestEligibleBin } from '@/lib/geo';
import { INITIAL_MAP_REGION, isInRegion, REGION_OUTLINE } from '@/lib/region';
import { useAuth } from '@/providers/AuthProvider';
import { useLocation } from '@/providers/LocationProvider';
import { colors, spacing } from '@/theme';

const WASTE_LABELS: Record<string, string> = {
  trash: 'restafval',
  cigarettes: 'sigaretten',
  dog_excrement: 'hondenpoep',
  sharps: 'naalden',
  recycling: 'recyclage',
};

function describeBin(bin: Bin): string {
  const waste = bin.tags.waste
    ?.split(';')
    .map((v) => WASTE_LABELS[v.trim()] ?? v.trim())
    .join(', ');
  const source = bin.source === 'user' ? 'Gemeld door een gebruiker' : 'Uit OpenStreetMap';
  return waste ? `${source} · ${waste}` : source;
}

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const mapRef = useRef<MapView>(null);
  const { profile } = useAuth();
  const isAdmin = !!profile?.isAdmin;
  const { permission, requestPermission, position, fakeMode, setFakeMode, setFakeLocation } = useLocation();

  const [bins, setBins] = useState<Bin[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [changing, setChanging] = useState(false);

  const loadBins = useCallback(async () => {
    try {
      setBins(await fetchBins());
      setLoadError(null);
    } catch (error) {
      setLoadError(`Vuilbakken laden lukte niet. ${genericErrorMessage(error as Error)}`);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadBins();
    }, [loadBins]),
  );

  // Excluded bins are only shown (in grey) to admins.
  const visibleBins = useMemo(() => (isAdmin ? bins : bins.filter((b) => b.eligible)), [bins, isAdmin]);
  const nearest = useMemo(() => (position ? nearestEligibleBin(bins, position) : null), [bins, position]);
  const availability = checkinAvailability(position, nearest);
  const selected = visibleBins.find((b) => b.id === selectedId) ?? null;

  const onMapPress = (event: MapPressEvent) => {
    if (event.nativeEvent.action === 'marker-press') return;
    if (fakeMode) setFakeLocation(event.nativeEvent.coordinate);
    else setSelectedId(null);
  };

  const onLongPress = (event: LongPressEvent) => {
    const point = event.nativeEvent.coordinate;
    if (!isInRegion(point)) {
      Alert.alert('Buiten de testregio', 'Je kunt alleen vuilbakken melden in de testregio rond de Oude Houtlei.');
      return;
    }
    Alert.alert(
      'Ontbrekende vuilbak melden?',
      'Neem een foto van de openbare vuilbak op deze plek. Een admin bekijkt je melding.',
      [
        { text: 'Annuleren', style: 'cancel' },
        {
          text: 'Foto nemen',
          onPress: () =>
            router.push({
              pathname: '/camera',
              params: { mode: 'report', lat: String(point.latitude), lon: String(point.longitude) },
            }),
        },
      ],
    );
  };

  const toggleEligibility = (bin: Bin) => {
    const exclude = bin.eligible;
    Alert.alert(
      exclude ? 'Vuilbak uitsluiten?' : 'Vuilbak opnieuw toelaten?',
      exclude
        ? 'Gebruikers zien deze vuilbak niet meer en kunnen er geen punten mee verdienen.'
        : 'Gebruikers zien deze vuilbak opnieuw en kunnen er punten mee verdienen.',
      [
        { text: 'Annuleren', style: 'cancel' },
        {
          text: exclude ? 'Uitsluiten' : 'Opnieuw toelaten',
          style: exclude ? 'destructive' : 'default',
          onPress: async () => {
            setChanging(true);
            try {
              await setBinEligibility(bin.id, !exclude);
              await loadBins();
            } catch (error) {
              Alert.alert('Niet gelukt', adminErrorMessage(error as Error));
            } finally {
              setChanging(false);
            }
          },
        },
      ],
    );
  };

  const toggleFakeMode = () => {
    if (!__DEV__) return;
    const next = !fakeMode;
    setFakeMode(next);
    Alert.alert(
      next ? 'Nep-locatie aan (dev)' : 'Nep-locatie uit',
      next
        ? 'Tik op de kaart om je locatie te kiezen. De server aanvaardt dit enkel met ALLOW_FAKE_LOCATION=true.'
        : 'De app gebruikt weer je echte gps-locatie.',
    );
  };

  const centerOnMe = () => {
    if (!position) return;
    mapRef.current?.animateToRegion({ ...position, latitudeDelta: 0.004, longitudeDelta: 0.004 }, 400);
  };

  const startCheckin = () => {
    if (!nearest) return;
    router.push({ pathname: '/camera', params: { mode: 'checkin', binId: String(nearest.bin.id) } });
  };

  const pinColor = (bin: Bin) => {
    if (!bin.eligible) return colors.binExcluded;
    return nearest?.bin.id === bin.id ? colors.binNearest : colors.binEligible;
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={INITIAL_MAP_REGION}
        showsUserLocation={permission === 'granted' && !fakeMode}
        showsMyLocationButton={false}
        toolbarEnabled={false}
        onPress={onMapPress}
        onLongPress={onLongPress}>
        <Polygon
          coordinates={REGION_OUTLINE}
          strokeColor="rgba(31,122,58,0.7)"
          fillColor="rgba(31,122,58,0.04)"
          strokeWidth={2}
        />
        {visibleBins.map((bin) => {
          const color = pinColor(bin);
          return (
            <Marker
              key={`${bin.id}-${color}`}
              coordinate={bin}
              pinColor={color}
              tracksViewChanges={false}
              onPress={() => setSelectedId(bin.id)}
            />
          );
        })}
        {fakeMode && position ? (
          <Marker coordinate={position} pinColor="purple" title="Nep-locatie (dev)" tracksViewChanges={false} />
        ) : null}
      </MapView>

      <View style={[styles.top, { paddingTop: insets.top + spacing.sm }]} pointerEvents="box-none">
        <Pressable onLongPress={toggleFakeMode} delayLongPress={1500} style={styles.card}>
          {fakeMode ? <Text style={styles.devBadge}>DEV · nep-locatie: tik op de kaart</Text> : null}
          <Text style={styles.cardTitle}>
            {nearest ? `Dichtstbijzijnde vuilbak: ${formatDistance(nearest.distanceM)}` : 'Dichtstbijzijnde vuilbak'}
          </Text>
          <Text style={styles.cardText}>{availability.message}</Text>
        </Pressable>
        {permission === 'denied' ? (
          <View style={[styles.card, styles.warning]}>
            <Text style={styles.cardText}>Zonder toegang tot je locatie kun je geen inworp registreren.</Text>
            <View style={styles.row}>
              <Button title="Opnieuw vragen" variant="secondary" onPress={requestPermission} style={styles.flex} />
              <Button title="Instellingen" variant="secondary" onPress={() => Linking.openSettings()} style={styles.flex} />
            </View>
          </View>
        ) : null}
        {loadError ? (
          <Pressable onPress={loadBins} style={[styles.card, styles.warning]}>
            <Text style={styles.cardText}>{loadError} Tik om opnieuw te proberen.</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={[styles.bottom, { paddingBottom: spacing.md }]} pointerEvents="box-none">
        <View style={styles.bottomRow} pointerEvents="box-none">
          <OsmAttribution />
          <Pressable
            onPress={centerOnMe}
            style={styles.roundButton}
            accessibilityRole="button"
            accessibilityLabel="Toon mijn locatie">
            <Ionicons name="locate" size={22} color={colors.primary} />
          </Pressable>
        </View>

        {selected ? (
          <View style={styles.card}>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>Vuilbak #{selected.id}</Text>
              <Pressable onPress={() => setSelectedId(null)} hitSlop={10} accessibilityLabel="Sluiten">
                <Ionicons name="close" size={22} color={colors.muted} />
              </Pressable>
            </View>
            <Text style={styles.cardText}>{describeBin(selected)}</Text>
            {position ? (
              <Text style={styles.cardText}>Op {formatDistance(distanceMeters(position, selected))} van jou</Text>
            ) : null}
            {!selected.eligible ? <Text style={styles.excluded}>Uitgesloten: geen punten</Text> : null}
            {isAdmin ? (
              <Button
                title={selected.eligible ? 'Uitsluiten' : 'Opnieuw toelaten'}
                variant={selected.eligible ? 'danger' : 'primary'}
                loading={changing}
                onPress={() => toggleEligibility(selected)}
              />
            ) : null}
          </View>
        ) : null}

        <Button title="Inworp registreren" onPress={startCheckin} disabled={!availability.enabled} />
        <Text style={styles.hint}>Houd de kaart ingedrukt om een ontbrekende vuilbak te melden.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  top: { position: 'absolute', left: 0, right: 0, top: 0, paddingHorizontal: spacing.md, gap: spacing.sm },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: spacing.md, gap: spacing.sm },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: spacing.md,
    gap: spacing.xs,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  warning: { backgroundColor: colors.warningLight },
  cardTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  cardText: { fontSize: 15, color: colors.text },
  excluded: { fontSize: 14, fontWeight: '600', color: colors.muted },
  devBadge: { fontSize: 12, fontWeight: '700', color: '#6a1b9a' },
  row: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  bottomRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  flex: { flex: 1 },
  roundButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 3,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  hint: {
    fontSize: 12,
    color: colors.text,
    textAlign: 'center',
    backgroundColor: 'rgba(255,255,255,0.8)',
    alignSelf: 'center',
    paddingHorizontal: 8,
    borderRadius: 6,
  },
});
