// Dev mode: test every feature on staging without walking to a bin. Only for
// admins on a local or staging server; the server checks that for every
// action, flags everything as test data and logs it.
import { Host } from '@expo/ui';
import { Button, Form, LabeledContent, Section, Stepper, Text, Toggle } from '@expo/ui/swift-ui';
import { disabled, monospacedDigit } from '@expo/ui/swift-ui/modifiers';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { initSfx } from '@/feedback/sfx/engine';
import { adminErrorMessage } from '@/lib/errors';
import { formatPoints, formatWeeks } from '@/lib/format';
import { BASE_POINTS, MAX_STAGES, pointStages, totalMultiplier, type BonusQuestion } from '@/lib/points';
import { setPendingReveal } from '@/lib/reveal';
import { useDevMode } from '@/providers/DevModeProvider';
import { useLocation } from '@/providers/LocationProvider';

/** Shown in the preview; the real questions come from the server. */
const PREVIEW_QUESTION: BonusQuestion = {
  key: 'preview',
  prompt: 'Hoe vol zat de vuilbak?',
  options: [
    { key: 'empty', label: 'Bijna leeg' },
    { key: 'half', label: 'Half vol' },
    { key: 'full', label: 'Vol of overvol' },
  ],
  points: 5,
};

export default function DevModeScreen() {
  const dev = useDevMode();
  const { fakeMode, setFakeMode } = useLocation();
  const [previewBase, setPreviewBase] = useState(BASE_POINTS);
  const [previewWeeks, setPreviewWeeks] = useState(3);
  const [previewBonus, setPreviewBonus] = useState(true);
  const [previewNoSound, setPreviewNoSound] = useState(false);
  const [override, setOverride] = useState(dev.status?.streakOverride ?? 4);
  const [busy, setBusy] = useState(false);

  // Load the reveal sounds while you set up the preview: the first load after
  // starting the app can take longer than the reveal waits for them.
  useEffect(() => {
    if (dev.available) initSfx();
  }, [dev.available]);

  if (!dev.available) {
    return (
      <EmptyState
        title="Dev-modus niet beschikbaar"
        systemImage="hammer"
        description="Alleen voor admins op een lokale of staging-server. In productie weigert de server elke Dev-modus-actie."
      />
    );
  }

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      Alert.alert('Niet gelukt', adminErrorMessage(error as Error));
    } finally {
      setBusy(false);
    }
  };

  const playPreview = () => {
    // The reveal waits for the sounds; start loading them now.
    if (!previewNoSound) initSfx();
    setPendingReveal({
      points: pointStages(previewBase, previewWeeks),
      question: previewBonus ? PREVIEW_QUESTION : null,
      checkinId: null,
      isTest: true,
      preview: true,
      noSound: previewNoSound,
    });
    router.push('/reveal');
  };

  const confirmReset = () =>
    Alert.alert(
      'Testdata resetten?',
      'Verwijdert je testinworpen (met foto en bonusantwoord), je testpunten en de geforceerde reeks. Je echte punten en inworpen blijven.',
      [
        { text: 'Annuleren', style: 'cancel' },
        {
          text: 'Resetten',
          style: 'destructive',
          onPress: () =>
            run(async () => {
              const removed = await dev.reset();
              Alert.alert('Gereset', `${removed} ${removed === 1 ? 'testinworp' : 'testinworpen'} verwijderd.`);
            }),
        },
      ],
    );

  const status = dev.status;
  const current = status?.streakOverride ?? null;
  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section
          footer={
            <Text>
              Alles hier werkt alleen voor jou als admin op local of staging. De server controleert dat bij elke actie,
              markeert alles als testdata en logt het. Testdata telt nooit mee voor echte punten, reeksen, de ranglijst
              of de analyse van ontbrekende vuilbakken.
            </Text>
          }>
          <LabeledContent label="Server">
            <Text>{status?.environment ?? '?'}</Text>
          </LabeledContent>
        </Section>

        <Section
          title="Onthulling bekijken"
          footer={
            <Text>
              Speelt de puntenonthulling af met geluid en haptiek. Schrijft niets weg. Na afloop staan onderaan de
              metingen (vertraging van timers, beeld en haptiek). &quot;Zonder geluid&quot; laadt de geluidsengine niet, om
              te zien of het geluid de vertraging veroorzaakt.
            </Text>
          }>
          <Stepper
            label={`Basispunten: ${previewBase}`}
            value={previewBase}
            min={1}
            max={500}
            step={previewBase < 20 ? 1 : 10}
            onValueChange={setPreviewBase}
          />
          <Stepper
            label={`Reeks: ${formatWeeks(previewWeeks)} (${totalMultiplier(Math.min(previewWeeks, MAX_STAGES))})`}
            value={previewWeeks}
            min={0}
            max={10}
            onValueChange={setPreviewWeeks}
          />
          <Toggle label="Met bonusvraag" isOn={previewBonus} onIsOnChange={setPreviewBonus} />
          <Toggle label="Zonder geluid (diagnose)" isOn={previewNoSound} onIsOnChange={setPreviewNoSound} />
          <Button label="Speel af" systemImage="play.fill" onPress={playPreview} />
        </Section>

        <Section
          title="Reeks forceren"
          footer={
            <Text>
              {current === null
                ? 'Uit. Je inworpen gebruiken je echte reeks.'
                : `Aan: je volgende inworpen gebruiken een reeks van ${formatWeeks(current)} en zijn testdata.`}
            </Text>
          }>
          <Stepper label={`Reeks: ${formatWeeks(override)}`} value={override} min={0} max={52} onValueChange={setOverride} />
          <Button
            label={current === override ? 'Ingesteld' : 'Instellen'}
            onPress={() => run(() => dev.setStreakOverride(override))}
            modifiers={[disabled(busy || current === override)]}
          />
          <Button
            label="Uitzetten"
            onPress={() => run(() => dev.setStreakOverride(null))}
            modifiers={[disabled(busy || current === null)]}
          />
        </Section>

        <Section
          title="Testlocatie"
          footer={
            <Text>
              Kies op de kaart waar je staat en doe een gewone inworp bij een vuilbak, met foto en bonusvraag. De inworp is
              testdata.
            </Text>
          }>
          <Toggle label="Testlocatie op de kaart" systemImage="mappin.and.ellipse" isOn={fakeMode} onIsOnChange={setFakeMode} />
        </Section>

        <Section title="Ranglijst">
          <Toggle label="Testdata tonen" systemImage="hammer" isOn={dev.showTestData} onIsOnChange={dev.setShowTestData} />
          <Button label="Open de ranglijst" systemImage="trophy" onPress={() => router.push('/leaderboard')} />
        </Section>

        <Section
          title="Testdata"
          footer={<Text>Verwijdert alleen jouw testdata. Je echte punten en inworpen, en de data van anderen, blijven.</Text>}>
          <LabeledContent label="Testinworpen">
            <Text modifiers={[monospacedDigit()]}>{String(status?.testCheckins ?? 0)}</Text>
          </LabeledContent>
          <LabeledContent label="Testpunten">
            <Text modifiers={[monospacedDigit()]}>{formatPoints(status?.testPoints ?? 0)}</Text>
          </LabeledContent>
          <Button label="Alles resetten" role="destructive" onPress={confirmReset} modifiers={[disabled(busy)]} />
        </Section>
      </Form>
    </Host>
  );
}
