import { Host } from '@expo/ui';
import { Button, Label } from '@expo/ui/swift-ui';
import {
  buttonBorderShape,
  buttonStyle,
  controlSize,
  disabled,
  font,
  frame,
  labelStyle,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo, useRef } from 'react';
import { Alert, Linking, Text, View } from 'react-native';
import MapView, { Marker, Polygon, type LongPressEvent, type MapPressEvent } from 'react-native-maps';
import { SafeAreaView } from 'react-native-screens/experimental';
import type { SFSymbol } from 'sf-symbols-typescript';

import { track } from '@/analytics';
import { distanceBucket } from '@/analytics/props';
import { GlassPanel } from '@/components/GlassPanel';
import { MapPin } from '@/components/MapPin';
import { OsmAttribution } from '@/components/OsmAttribution';
import type { Bin } from '@/lib/api';
import { checkinAvailability, formatDistance, nearestEligibleBin } from '@/lib/geo';
import { INITIAL_MAP_REGION, isInRegion, REGION_OUTLINE } from '@/lib/region';
import { useAuth } from '@/providers/AuthProvider';
import { useBins } from '@/providers/BinsProvider';
import { useDevMode } from '@/providers/DevModeProvider';
import { useLocation } from '@/providers/LocationProvider';
import { colors, pinColors, spacing, type } from '@/theme';

/** A round glass button with an SF Symbol, like the map controls in Apple Maps. */
function MapButton({ symbol, label, onPress, active = false }: { symbol: SFSymbol; label: string; onPress: () => void; active?: boolean }) {
  return (
    <Host matchContents>
      <Button
        label={label}
        systemImage={symbol}
        onPress={onPress}
        modifiers={[
          buttonStyle(active ? 'glassProminent' : 'glass'),
          buttonBorderShape('circle'),
          labelStyle('iconOnly'),
          controlSize('large'),
          tint(active ? colors.purple : colors.tint),
        ]}
      />
    </Host>
  );
}

export default function MapScreen() {
  const mapRef = useRef<MapView>(null);
  const { profile } = useAuth();
  const isAdmin = !!profile?.isAdmin;
  const { bins, loadError, reload, selectedId, setSelectedId } = useBins();
  const { permission, requestPermission, position, fakeMode, setFakeMode, setFakeLocation } = useLocation();
  const dev = useDevMode();

  // Excluded bins are only shown (in gray) to admins.
  const visibleBins = useMemo(() => (isAdmin ? bins : bins.filter((b) => b.eligible)), [bins, isAdmin]);
  const nearest = useMemo(() => (position ? nearestEligibleBin(bins, position) : null), [bins, position]);
  const availability = checkinAvailability(position, nearest);

  const openBin = (bin: Bin) => {
    track('map_bin_tap', { bin_id: bin.id });
    setSelectedId(bin.id);
    router.push({ pathname: '/bin/[id]', params: { id: String(bin.id) } });
  };

  const onMapPress = (event: MapPressEvent) => {
    if (event.nativeEvent.action === 'marker-press') return;
    if (fakeMode) setFakeLocation(event.nativeEvent.coordinate);
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
          onPress: () => {
            track('report_flow_start', {});
            router.push({
              pathname: '/camera',
              params: { mode: 'report', lat: String(point.latitude), lon: String(point.longitude) },
            });
          },
        },
      ],
    );
  };

  const centerOnMe = () => {
    if (!position) return;
    mapRef.current?.animateToRegion({ ...position, latitudeDelta: 0.004, longitudeDelta: 0.004 }, 400);
  };

  const toggleTestLocation = () => {
    const next = !fakeMode;
    setFakeMode(next);
    if (next) {
      Alert.alert(
        'Testlocatie aan',
        'Kies waar je staat door op de kaart te tikken. Inworpen vanaf een testlocatie zijn testdata: ze tellen niet mee voor echte punten, reeksen of de ranglijst.',
      );
    }
  };

  const startCheckin = () => {
    if (!nearest) return;
    track('checkin_flow_start', { bin_id: nearest.bin.id, distance_bucket: distanceBucket(nearest.distanceM) });
    router.push({ pathname: '/camera', params: { mode: 'checkin', binId: String(nearest.bin.id) } });
  };

  const pinColor = (bin: Bin) => {
    if (!bin.eligible) return pinColors.excluded;
    return nearest?.bin.id === bin.id ? pinColors.nearest : pinColors.eligible;
  };

  return (
    <View style={{ flex: 1 }}>
      <MapView
        ref={mapRef}
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        initialRegion={INITIAL_MAP_REGION}
        showsUserLocation={permission === 'granted' && !fakeMode}
        showsMyLocationButton={false}
        showsCompass
        toolbarEnabled={false}
        onPress={onMapPress}
        onLongPress={onLongPress}>
        <Polygon coordinates={REGION_OUTLINE} strokeColor="#248A3D" fillColor="rgba(36,138,61,0.05)" strokeWidth={2} />
        {visibleBins.map((bin) => {
          const selected = bin.id === selectedId;
          return (
            <Marker
              key={`${bin.id}-${String(pinColor(bin))}-${selected}`}
              coordinate={bin}
              anchor={{ x: 0.5, y: 0.5 }}
              tracksViewChanges={false}
              zIndex={selected ? 2 : 1}
              onPress={() => openBin(bin)}>
              <MapPin color={pinColor(bin)} selected={selected} />
            </Marker>
          );
        })}
        {fakeMode && position ? (
          <Marker coordinate={position} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} zIndex={3}>
            <MapPin color={pinColors.test} symbol="mappin" selected />
          </Marker>
        ) : null}
      </MapView>

      <SafeAreaView
        edges={{ top: true, bottom: true, left: true, right: true }}
        insetType="all"
        style={{ flex: 1 }}
        pointerEvents="box-none">
        <View style={{ flex: 1, padding: spacing.lg, justifyContent: 'space-between' }} pointerEvents="box-none">
          <View style={{ gap: spacing.sm }} pointerEvents="box-none">
            <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' }} pointerEvents="box-none">
              <GlassPanel style={{ flex: 1, padding: spacing.md + 2, gap: 2 }}>
                {fakeMode ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <SymbolView name="hammer.fill" size={12} tintColor={colors.purple} />
                    <Text style={[type.caption, { color: colors.purple, fontWeight: '600' }]}>
                      Testlocatie · tik op de kaart om ze te verplaatsen
                    </Text>
                  </View>
                ) : null}
                <Text style={[type.headline, { color: colors.label }]}>
                  {nearest ? `Dichtstbijzijnde vuilbak · ${formatDistance(nearest.distanceM)}` : 'Dichtstbijzijnde vuilbak'}
                </Text>
                <Text style={[type.subheadline, { color: colors.secondaryLabel }]}>{availability.message}</Text>
              </GlassPanel>
              <View style={{ gap: spacing.sm }}>
                <MapButton symbol="location.fill" label="Toon mijn locatie" onPress={centerOnMe} />
                {dev.available ? (
                  <MapButton symbol="mappin.and.ellipse" label="Testlocatie" onPress={toggleTestLocation} active={fakeMode} />
                ) : null}
              </View>
            </View>

            {permission === 'denied' && !fakeMode ? (
              <GlassPanel style={{ padding: spacing.md + 2, gap: spacing.sm }}>
                <Text style={[type.subheadline, { color: colors.label }]}>
                  Zonder toegang tot je locatie kun je geen inworp registreren.
                </Text>
                <Host matchContents>
                  <Button
                    label="Open Instellingen"
                    systemImage="gear"
                    onPress={() => Linking.openSettings()}
                    modifiers={[buttonStyle('glass'), tint(colors.tint)]}
                  />
                </Host>
                <Text onPress={requestPermission} style={[type.footnote, { color: colors.tint }]}>
                  Opnieuw vragen
                </Text>
              </GlassPanel>
            ) : null}

            {loadError ? (
              <GlassPanel interactive style={{ padding: spacing.md + 2 }}>
                <Text onPress={reload} style={[type.subheadline, { color: colors.label }]}>
                  {loadError} Tik om opnieuw te proberen.
                </Text>
              </GlassPanel>
            ) : null}
          </View>

          <View style={{ gap: spacing.sm }} pointerEvents="box-none">
            <OsmAttribution style={{ alignSelf: 'flex-start' }} />
            <Host matchContents={{ vertical: true }} style={{ alignSelf: 'stretch' }}>
              <Button
                onPress={startCheckin}
                modifiers={[
                  buttonStyle('glassProminent'),
                  controlSize('extraLarge'),
                  tint(fakeMode ? colors.purple : colors.tint),
                  disabled(!availability.enabled),
                ]}>
                {/* The label stretches, so the glass button spans the width. */}
                <Label
                  title="Inworp registreren"
                  systemImage="camera.fill"
                  modifiers={[frame({ maxWidth: 10000 }), font({ textStyle: 'headline' })]}
                />
              </Button>
            </Host>
            <GlassPanel style={{ alignSelf: 'center', borderRadius: 999, paddingHorizontal: spacing.md, paddingVertical: 4 }}>
              <Text style={[type.caption, { color: colors.secondaryLabel, textAlign: 'center' }]}>
                Houd de kaart ingedrukt om een ontbrekende vuilbak te melden.
              </Text>
            </GlassPanel>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}
