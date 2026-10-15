// The collection (docs/GAMIFICATION.md, chapter 5): "34/120 ontdekt" with the
// bar to the next milestone, a filter (Alle / Ontdekt / Nog niet) and a grid
// of four: a discovered bin as a card with its number, date and check-ins, one
// waiting for approval with a clock, one not discovered as a silhouette
// "#59 ???". A tap shows the bin on the map. One screen, routed from the
// profile (and from Vandaag in phase 6).
import { Host } from '@expo/ui';
import { Picker, Text as SwiftText } from '@expo/ui/swift-ui';
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { router, useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, Text, useColorScheme, useWindowDimensions, View } from 'react-native';

import { track } from '@/analytics';
import { ProgressBar } from '@/components/game';
import { EmptyState } from '@/components/EmptyState';
import { collectionFilter, counterLabel, nextMilestoneLabel, type CollectionEntry, type CollectionFilter } from '@/game/discoveries';
import { formatDate } from '@/lib/format';
import { useBins } from '@/providers/BinsProvider';
import { useGame } from '@/providers/GameProvider';
import { colors, numberStyle, spacing, type } from '@/theme';
import { gameColors, resolveColor, shapes } from '@/theme/game';

const COLUMNS = 4;
const FILTERS: { value: CollectionFilter; label: string }[] = [
  { value: 'all', label: 'Alle' },
  { value: 'discovered', label: 'Ontdekt' },
  { value: 'undiscovered', label: 'Nog niet' },
];

function Card({ entry, size, onPress }: { entry: CollectionEntry; size: number; onPress: () => void }) {
  const scheme = useColorScheme();
  const found = entry.status !== null;
  const accessibilityLabel = found
    ? `Vuilbak ${entry.binId}, ontdekt${entry.discoveredAt ? ` op ${formatDate(entry.discoveredAt)}` : ''}, ${entry.checkins} keer${entry.status === 'pending' ? ', wacht op goedkeuring' : ''}`
    : `Vuilbak ${entry.binId}, nog niet ontdekt`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Toont de vuilbak op de kaart"
      style={({ pressed }) => ({
        width: size,
        height: size * 1.15,
        borderRadius: shapes.chunkyRadius,
        borderCurve: 'continuous',
        padding: spacing.sm,
        justifyContent: 'space-between',
        opacity: pressed ? 0.7 : 1,
        backgroundColor: found ? resolveColor(gameColors.primary, scheme) : colors.cell,
        borderWidth: found ? 0 : 1,
        borderColor: colors.separator,
      })}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <SymbolView name={found ? 'trash.fill' : 'questionmark'} size={14} tintColor={found ? 'white' : colors.tertiaryLabel} />
        {entry.status === 'pending' ? <SymbolView name="clock" size={13} tintColor="white" /> : null}
      </View>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={{ fontSize: 20, color: found ? 'white' : colors.tertiaryLabel, ...numberStyle }}>{`#${entry.binId}`}</Text>
      <Text numberOfLines={1} style={[type.caption, { color: found ? 'rgba(255,255,255,0.9)' : colors.tertiaryLabel, fontWeight: '600' }]}>
        {found ? `${entry.discoveredAt ? formatDate(entry.discoveredAt) : ''} · ${entry.checkins}×` : '???'}
      </Text>
    </Pressable>
  );
}

export function CollectionScreen() {
  const { state, collection, loadError, refresh } = useGame();
  const { showOnMap } = useBins();
  const { width } = useWindowDimensions();
  const [filter, setFilter] = useState<CollectionFilter>('all');

  // Fresh numbers every time the collection opens, and the event with them.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      refresh().then((next) => {
        if (active && next) track('collection_viewed', { discovered: next.discovered, total: next.totalBins });
      });
      return () => {
        active = false;
      };
    }, [refresh]),
  );

  const entries = useMemo(() => collectionFilter([...(collection?.values() ?? [])], filter), [collection, filter]);
  const size = Math.floor((width - spacing.lg * 2 - spacing.sm * (COLUMNS - 1)) / COLUMNS);

  const open = (entry: CollectionEntry) => {
    showOnMap(entry.binId);
    router.navigate('/(tabs)/(map)');
  };

  const header = (
    <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
      {state ? (
        <View style={{ gap: spacing.xs }}>
          <Text style={[type.title2, { color: colors.label, fontWeight: '800' }]}>{counterLabel(state.discovered, state.totalBins)}</Text>
          {state.nextMilestone ? (
            <ProgressBar
              value={state.discovered - state.nextMilestone.previous}
              max={state.nextMilestone.threshold - state.nextMilestone.previous}
              label={`Volgende mijlpaal: ${state.nextMilestone.threshold} ontdekt`}
            />
          ) : null}
          <Text style={[type.footnote, { color: colors.secondaryLabel }]}>
            {nextMilestoneLabel(state.discovered, state.nextMilestone) ?? 'Alle mijlpalen gehaald'}
          </Text>
        </View>
      ) : null}
      <Host matchContents={{ vertical: true }}>
        <Picker selection={filter} onSelectionChange={(value) => setFilter(value as CollectionFilter)} modifiers={[pickerStyle('segmented')]}>
          {FILTERS.map((f) => (
            <SwiftText key={f.value} modifiers={[tag(f.value)]}>
              {f.label}
            </SwiftText>
          ))}
        </Picker>
      </Host>
    </View>
  );

  if (!collection) {
    return loadError ? (
      <EmptyState title="Collectie niet geladen" systemImage="wifi.exclamationmark" description={loadError} />
    ) : (
      <View style={{ flex: 1, backgroundColor: colors.groupedBackground }} />
    );
  }

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: colors.groupedBackground }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm }}
      columnWrapperStyle={{ gap: spacing.sm }}
      numColumns={COLUMNS}
      data={entries}
      keyExtractor={(entry) => String(entry.binId)}
      ListHeaderComponent={header}
      ListEmptyComponent={
        <Text style={[type.subheadline, { color: colors.secondaryLabel, textAlign: 'center', paddingTop: spacing.xl }]}>
          {filter === 'discovered' ? 'Nog niets ontdekt. Gooi iets weg bij een vuilbak met een "?" op de kaart.' : 'Alles ontdekt!'}
        </Text>
      }
      renderItem={({ item }) => <Card entry={item} size={size} onPress={() => open(item)} />}
    />
  );
}
