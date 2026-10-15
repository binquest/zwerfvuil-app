// A bin's details as a sheet over the map, with the admin action to exclude
// or re-admit it.
import { Host } from '@expo/ui';
import { Button, Form, LabeledContent, Section, Text } from '@expo/ui/swift-ui';
import { scrollContentBackground } from '@expo/ui/swift-ui/modifiers';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { binDiscoveryLabel } from '@/game/discoveries';
import type { Bin } from '@/lib/api';
import { adminErrorMessage } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { distanceMeters, formatDistance } from '@/lib/geo';
import { useAuth } from '@/providers/AuthProvider';
import { useBins } from '@/providers/BinsProvider';
import { useGame } from '@/providers/GameProvider';
import { useLocation } from '@/providers/LocationProvider';

const WASTE_LABELS: Record<string, string> = {
  trash: 'restafval',
  cigarettes: 'sigaretten',
  dog_excrement: 'hondenpoep',
  sharps: 'naalden',
  recycling: 'recyclage',
};

function wasteTypes(bin: Bin): string | null {
  const waste = bin.tags.waste
    ?.split(';')
    .map((v) => WASTE_LABELS[v.trim()] ?? v.trim())
    .filter(Boolean)
    .join(', ');
  return waste || null;
}

export default function BinSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { bins, setSelectedId, setEligibility } = useBins();
  const { position } = useLocation();
  const { profile } = useAuth();
  const { collection } = useGame();
  const [busy, setBusy] = useState(false);
  const bin = bins.find((b) => b.id === Number(id)) ?? null;

  // Closing the sheet clears the highlight on the map.
  useEffect(() => () => setSelectedId(null), [setSelectedId]);

  const toggleEligibility = (target: Bin) => {
    const exclude = target.eligible;
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
            setBusy(true);
            try {
              await setEligibility(target.id, !exclude);
            } catch (error) {
              Alert.alert('Niet gelukt', adminErrorMessage(error as Error));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const waste = bin ? wasteTypes(bin) : null;
  return (
    <>
      <Stack.Screen options={{ title: bin ? `Vuilbak #${bin.id}` : 'Vuilbak' }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Sluiten" onPress={() => router.back()} />
      </Stack.Toolbar>
      <Host style={{ flex: 1 }}>
        <Form modifiers={[scrollContentBackground('hidden')]}>
          {bin ? (
            <>
              <Section>
                {collection && bin.eligible ? (
                  <LabeledContent label="Ontdekt">
                    <Text>{binDiscoveryLabel(collection.get(bin.id), formatDate)}</Text>
                  </LabeledContent>
                ) : null}
                <LabeledContent label="Bron">
                  <Text>{bin.source === 'user' ? 'Gemeld door een gebruiker' : 'OpenStreetMap'}</Text>
                </LabeledContent>
                {waste ? (
                  <LabeledContent label="Afval">
                    <Text>{waste}</Text>
                  </LabeledContent>
                ) : null}
                {position ? (
                  <LabeledContent label="Afstand">
                    <Text>{formatDistance(distanceMeters(position, bin))}</Text>
                  </LabeledContent>
                ) : null}
                <LabeledContent label="Punten">
                  <Text>{bin.eligible ? 'Ja' : 'Nee, uitgesloten'}</Text>
                </LabeledContent>
              </Section>
              {profile?.isAdmin ? (
                <Section
                  footer={
                    <Text>
                      {bin.eligible
                        ? 'Sluit vuilbakken uit waar je geen punten mee mag verdienen, bv. privé of voor hondenpoep.'
                        : 'Uitgesloten vuilbakken zie je alleen als admin, in het grijs.'}
                    </Text>
                  }>
                  <Button
                    label={busy ? 'Even geduld…' : bin.eligible ? 'Uitsluiten' : 'Opnieuw toelaten'}
                    role={bin.eligible ? 'destructive' : 'default'}
                    onPress={() => !busy && toggleEligibility(bin)}
                  />
                </Section>
              ) : null}
            </>
          ) : (
            <Section>
              <Text>Deze vuilbak bestaat niet meer.</Text>
            </Section>
          )}
        </Form>
      </Host>
    </>
  );
}
