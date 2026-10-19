// Dev mode: test every feature on staging without walking to a bin. Only for
// admins on a local or staging server; the server checks that for every
// action, flags everything as test data and logs it.
import { Host } from '@expo/ui';
import { Button, Form, LabeledContent, Section, Slider, Stepper, Text, Toggle } from '@expo/ui/swift-ui';
import { disabled, monospacedDigit } from '@expo/ui/swift-ui/modifiers';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { describeStressResult, runSoundStressTest } from '@/feedback/reveal/stress';
import { buildRevealTimeline } from '@/feedback/reveal/timeline';
import { warmUpSounds } from '@/feedback/sfx/soundtrack';
import { previewScore, streakMultiplierLabel, type GameConfig } from '@/game/catalog';
import { previewResults } from '@/game/approval';
import type { BadgeNews } from '@/game/badges';
import { setPendingCelebration } from '@/game/celebration';
import { milestoneTitle, type CheckinGame, type MissedMoment } from '@/game/discoveries';
import { useGameCatalog } from '@/game/useGameCatalog';
import { adminErrorMessage } from '@/lib/errors';
import { formatPoints, formatWeeks } from '@/lib/format';
import type { BonusQuestion } from '@/lib/points';
import { setPendingReveal } from '@/lib/reveal';
import { baseStep, discoveryStep, streakStep, type Score } from '@/lib/score';
import { useDevMode } from '@/providers/DevModeProvider';
import { useLocation } from '@/providers/LocationProvider';
import { useToast } from '@/providers/ToastProvider';

/** The preview's discovery: bin #58, the 12th of 120 (made-up numbers, nothing is read or written). */
const PREVIEW_DISCOVERY = { binId: 58, ordinal: 12, discovered: 12, totalBins: 120, status: 'pending' as const };

/** The preview's badge: Vroege vogel, waiting for an approval (as the server names it). */
const PREVIEW_BADGE: BadgeNews = {
  key: 'early_bird',
  name: 'Vroege vogel',
  description: "Doe een inworp tussen 5 en 8 uur 's ochtends.",
  symbol: 'sunrise.fill',
  rarity: 'rare',
  status: 'pending',
};

/**
 * The score of the preview: base, discovery, streak, and optionally a step the
 * app does not know: "PREMIE ×2" doubles the multiplier, as the bounty of
 * phase 8 will (×1,77 → ×3,54 after six weeks).
 */
function previewRevealScore(config: GameConfig, weeks: number, base: number, discovery: boolean, extended: boolean, unknownStep: boolean): Score {
  const score = previewScore(config, weeks, base, { discovery, streakExtended: extended });
  if (!unknownStep) return score;
  const chips = discoveryStep(score)?.chips ?? baseStep(score)?.chips ?? base;
  const mult = Math.round((streakStep(score)?.stages.at(-1)?.mult ?? 1) * 2 * 1e12) / 1e12;
  const total = Math.round(chips * mult);
  return { ...score, steps: [...score.steps, { kind: 'other', name: 'bounty', label: 'PREMIE ×2', total, chips, mult }], total };
}

/** The heaviest reveal there is today: a discovery, six weeks with the flame, a bounty and the bonus question. */
const HEAVY_PREVIEW = { weeks: 6, discovery: true, extended: true, unknownStep: true, bonus: true };

/** Shown in the preview, with the points from the config; the real questions come from the server. */
function previewQuestion(points: number): BonusQuestion {
  return {
    key: 'preview',
    prompt: 'Hoe vol zat de vuilbak?',
    options: [
      { key: 'empty', label: 'Bijna leeg' },
      { key: 'half', label: 'Half vol' },
      { key: 'full', label: 'Vol of overvol' },
    ],
    points,
  };
}

export default function DevModeScreen() {
  const dev = useDevMode();
  const { fakeMode, setFakeMode } = useLocation();
  const toast = useToast();
  // The numbers of the game (game_config); the preview builds its score from them.
  const config = useGameCatalog()?.config ?? null;
  const [chosenBase, setPreviewBase] = useState<number | null>(null);
  const previewBase = chosenBase ?? config?.checkinBaseChips ?? 0;
  const [previewWeeks, setPreviewWeeks] = useState(3);
  const [previewBonus, setPreviewBonus] = useState(true);
  const [previewAwarded, setPreviewAwarded] = useState(true);
  const [previewReduceMotion, setPreviewReduceMotion] = useState(false);
  const [previewNoSound, setPreviewNoSound] = useState(false);
  const [previewDiscovery, setPreviewDiscovery] = useState(true);
  const [previewExtended, setPreviewExtended] = useState(true);
  const [previewUnknownStep, setPreviewUnknownStep] = useState(false);
  const [previewMilestone, setPreviewMilestone] = useState(false);
  const [previewBadge, setPreviewBadge] = useState(false);
  const milestones = useGameCatalog()?.milestones ?? [];
  const [milestoneIndex, setMilestoneIndex] = useState(0);
  const [milestoneGranted, setMilestoneGranted] = useState(false);
  const chosenMilestone = milestones[Math.min(milestoneIndex, Math.max(0, milestones.length - 1))] ?? null;
  const levels = useGameCatalog()?.levels ?? [];
  const [approvedCount, setApprovedCount] = useState(2);
  const [rejectedCount, setRejectedCount] = useState(1);
  const [approvalLevelUp, setApprovalLevelUp] = useState(true);
  const [approvalBadge, setApprovalBadge] = useState(true);
  const [stress, setStress] = useState<string | null>(null);
  const stopStress = useRef<(() => void) | null>(null);
  const [override, setOverride] = useState(dev.status?.streakOverride ?? 4);
  const [busy, setBusy] = useState(false);

  // Load the sounds of the preview while you set it up: the first load after
  // starting the app can take longer than the reveal waits for them.
  useEffect(() => {
    if (!dev.available) return;
    warmUpSounds(
      config
        ? buildRevealTimeline({
            score: previewRevealScore(config, previewWeeks, previewBase, previewDiscovery, previewExtended, previewUnknownStep),
            reduceMotion: false,
          })
        : [],
    );
  }, [dev.available, config, previewWeeks, previewBase, previewDiscovery, previewExtended, previewUnknownStep]);

  // A stress test still running when the screen goes stops.
  useEffect(() => () => stopStress.current?.(), []);

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

  const playPreview = (options = { weeks: previewWeeks, discovery: previewDiscovery, extended: previewExtended, unknownStep: previewUnknownStep, bonus: previewBonus }) => {
    if (!config) return;
    const score = previewRevealScore(config, options.weeks, previewBase, options.discovery, options.extended, options.unknownStep);
    // The reveal waits for the sounds; start loading them now.
    if (!previewNoSound) warmUpSounds(buildRevealTimeline({ score, reduceMotion: previewReduceMotion }));
    const game: CheckinGame = {
      discovery: options.discovery ? PREVIEW_DISCOVERY : null,
      milestone: previewMilestone && chosenMilestone ? { ...chosenMilestone, status: 'pending' } : null,
      badges: previewBadge ? [PREVIEW_BADGE] : [],
      asOf: null,
    };
    setPendingReveal({
      score,
      game,
      question: options.bonus ? previewQuestion(config.bonusQuestionPoints) : null,
      checkinId: null,
      isTest: true,
      preview: true,
      noSound: previewNoSound,
      previewAwarded,
      forceReduceMotion: previewReduceMotion,
    });
    router.push('/reveal');
  };

  /** The heavy preview, with the switches set to it (base, sound and Reduce Motion as chosen). */
  const playHeavyPreview = () => {
    setPreviewWeeks(HEAVY_PREVIEW.weeks);
    setPreviewDiscovery(HEAVY_PREVIEW.discovery);
    setPreviewExtended(HEAVY_PREVIEW.extended);
    setPreviewUnknownStep(HEAVY_PREVIEW.unknownStep);
    setPreviewBonus(HEAVY_PREVIEW.bonus);
    playPreview(HEAVY_PREVIEW);
  };

  /** The milestone celebration on its own, as after a reveal. */
  const showMilestone = () => {
    if (!chosenMilestone) return;
    setPendingCelebration({
      kind: 'reveal',
      milestone: { ...chosenMilestone, status: milestoneGranted ? 'granted' : 'pending' },
      badges: [],
      discovered: chosenMilestone.threshold,
      totalBins: 120,
      asOf: null,
      preview: true,
      forceReduceMotion: previewReduceMotion,
      noSound: previewNoSound,
    });
    router.push('/celebrate');
  };

  /** A badge on its own, as after a reveal. */
  const showBadge = () => {
    setPendingCelebration({
      kind: 'reveal',
      milestone: null,
      badges: [PREVIEW_BADGE],
      discovered: null,
      totalBins: null,
      asOf: null,
      preview: true,
      forceReduceMotion: previewReduceMotion,
      noSound: previewNoSound,
    });
    router.push('/celebrate');
  };

  /** The approval celebration as it appears when the app opens: the chosen numbers, made up. */
  const showApproval = (options = { approved: approvedCount, rejected: rejectedCount, levelUp: approvalLevelUp, badge: approvalBadge }) => {
    setPendingCelebration({
      kind: 'approval',
      results: previewResults(options, levels),
      asOf: null,
      preview: true,
      forceReduceMotion: previewReduceMotion,
      noSound: previewNoSound,
    });
    router.push('/celebrate');
  };

  /** Missed moments as the presenter shows them: three discoveries, the chosen milestone and a badge. */
  const showMissed = () => {
    const at = new Date().toISOString();
    const moments: MissedMoment[] = [58, 61, 74].map((binId, i) => ({ kind: 'discovery', at, binId, ordinal: 10 + i, status: 'pending' }));
    if (chosenMilestone) moments.push({ kind: 'milestone', at, ...chosenMilestone, status: 'pending' });
    moments.push({ kind: 'badge', at, badge: PREVIEW_BADGE });
    setPendingCelebration({
      kind: 'missed',
      moments,
      total: moments.length,
      asOf: null,
      preview: true,
      forceReduceMotion: previewReduceMotion,
      noSound: previewNoSound,
    });
    router.push('/celebrate');
  };

  const startStressTest = () => {
    stopStress.current?.();
    setStress('Bezig… luister of er een tick of akkoord wegvalt of afgekapt klinkt.');
    stopStress.current = runSoundStressTest((result) => {
      stopStress.current = null;
      setStress(describeStressResult(result));
    });
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
              metingen (vertraging van timers, beeld en haptiek). &quot;Toegekend&quot; uit: het antwoord levert geen
              punten op, zoals overslaan. &quot;Zonder geluid&quot; laadt de geluidsengine niet, om te zien of het geluid de
              vertraging veroorzaakt.
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
          <LabeledContent label="Reeks">
            <Text modifiers={[monospacedDigit()]}>
              {config
                ? `${formatWeeks(previewWeeks)} (${streakMultiplierLabel(config, previewWeeks)}${previewWeeks > config.streakMaxSteps ? ', maximum' : ''})`
                : formatWeeks(previewWeeks)}
            </Text>
          </LabeledContent>
          <Slider value={previewWeeks} min={0} max={10} step={1} onValueChange={(weeks) => setPreviewWeeks(Math.round(weeks))} />
          <Toggle label="Nieuwe vuilbak (ontdekking)" isOn={previewDiscovery} onIsOnChange={setPreviewDiscovery} />
          <Toggle label="Reeks verlengd (vlam)" isOn={previewExtended} onIsOnChange={setPreviewExtended} />
          <Toggle label="Onbekende stap (PREMIE ×2)" isOn={previewUnknownStep} onIsOnChange={setPreviewUnknownStep} />
          <Toggle label="Daarna een mijlpaal" isOn={previewMilestone} onIsOnChange={setPreviewMilestone} />
          <Toggle label="Daarna een badge (Vroege vogel)" isOn={previewBadge} onIsOnChange={setPreviewBadge} />
          <Toggle label="Met bonusvraag" isOn={previewBonus} onIsOnChange={setPreviewBonus} />
          <Toggle
            label="Bonus toegekend"
            isOn={previewAwarded}
            onIsOnChange={setPreviewAwarded}
            modifiers={[disabled(!previewBonus)]}
          />
          <Toggle label="Reduce Motion forceren" isOn={previewReduceMotion} onIsOnChange={setPreviewReduceMotion} />
          <Toggle label="Zonder geluid (diagnose)" isOn={previewNoSound} onIsOnChange={setPreviewNoSound} />
          <Button label={config ? 'Speel af' : 'Config laden…'} systemImage="play.fill" onPress={() => playPreview()} modifiers={[disabled(!config)]} />
          <Button
            label="Zware preview (ontdekking, 6 weken, premie, bonusvraag)"
            systemImage="gauge.with.dots.needle.67percent"
            onPress={playHeavyPreview}
            modifiers={[disabled(!config)]}
          />
        </Section>

        <Section
          title="Vieringen bekijken"
          footer={
            <Text>
              De mijlpaalviering (volledig scherm, confetti), een badge, de gemiste momenten en de goedkeuringsviering
              zoals ze na het openen verschijnen (met verzonnen getallen). Reduce Motion en geluid volgen de schakelaars
              hierboven. Schrijft niets weg en markeert niets als gezien.
            </Text>
          }>
          <Stepper
            label={chosenMilestone ? `Mijlpaal: ${milestoneTitle(chosenMilestone.threshold)} · +${chosenMilestone.points}` : 'Mijlpalen laden…'}
            value={milestoneIndex}
            min={0}
            max={Math.max(0, milestones.length - 1)}
            onValueChange={setMilestoneIndex}
          />
          <Toggle label="Al toegekend" isOn={milestoneGranted} onIsOnChange={setMilestoneGranted} />
          <Button label="Mijlpaal tonen" systemImage="flag.checkered" onPress={showMilestone} modifiers={[disabled(!chosenMilestone)]} />
          <Button label="Badge tonen" systemImage="rosette" onPress={showBadge} />
          <Button label="Gemiste momenten tonen" systemImage="tray.full" onPress={showMissed} />
          <Stepper label={`Goedgekeurd: ${approvedCount}`} value={approvedCount} min={0} max={5} onValueChange={setApprovedCount} />
          <Stepper label={`Afgewezen: ${rejectedCount}`} value={rejectedCount} min={0} max={3} onValueChange={setRejectedCount} />
          <Toggle label="Met level-up" isOn={approvalLevelUp} onIsOnChange={setApprovalLevelUp} />
          <Toggle label="Met badge en avatar" isOn={approvalBadge} onIsOnChange={setApprovalBadge} />
          <Button
            label="Goedkeuring tonen"
            systemImage="checkmark.seal"
            onPress={() => showApproval()}
            modifiers={[disabled(approvedCount + rejectedCount === 0 && !approvalLevelUp && !approvalBadge)]}
          />
          <Button
            label="Alleen een level-up tonen"
            systemImage="arrow.up.circle"
            onPress={() => showApproval({ approved: 0, rejected: 0, levelUp: true, badge: false })}
            modifiers={[disabled(levels.length === 0)]}
          />
        </Section>

        <Section
          title="Onboarding bekijken"
          footer={
            <Text>
              Naam en avatar zoals een nieuw account ze ziet, met je huidige naam ingevuld. Bewaart niets: de laatste
              knop sluit de preview.
            </Text>
          }>
          <Button label="Onboarding tonen" systemImage="person.crop.circle.badge.plus" onPress={() => router.push('/onboarding-preview')} />
        </Section>

        <Section
          title="Spelonderdelen"
          footer={
            <Text>
              De gedeelde spelcomponenten (getal, knop, balk, ring, wacht-label) en een testtoast. Een toast verschijnt
              boven het bovenste scherm; tijdens een onthulling wacht hij tot ze dicht is.
            </Text>
          }>
          <Button label="Componenten bekijken" systemImage="square.grid.2x2" onPress={() => router.push('/dev-components')} />
          <Button
            label="Testtoast tonen"
            systemImage="bell"
            onPress={() => toast.show({ title: 'Testtoast', message: 'Zo ziet een melding in de app eruit.', systemImage: 'bell.fill' })}
          />
        </Section>

        <Section
          title="Geluid testen"
          footer={
            <Text>
              {stress ??
                `Speelt 20 ticks om de 40 ms (gemixt, zoals elke onthulling) en daarna 6 akkoorden om de 120 ms via de losse spelers (zoals overslaan). Niets mag wegvallen of afgekapt klinken.`}
            </Text>
          }>
          <Button label="Stresstest" systemImage="waveform" onPress={startStressTest} />
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
