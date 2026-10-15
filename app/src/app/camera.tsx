// Takes a photo with the camera (never the gallery) for a check-in or a
// report of a missing bin, compresses it and submits it. A successful check-in
// continues to the points reveal. While it uploads, the sound of the reveal
// the app expects (this week's streak) is mixed and loaded ahead: when the
// server's score matches, the reveal starts from that file at once.
import { Host } from '@expo/ui';
import { Button, HStack, Label } from '@expo/ui/swift-ui';
import { buttonBorderShape, buttonStyle, controlSize, disabled, frame, labelStyle, tint } from '@expo/ui/swift-ui/modifiers';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Linking, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { SFSymbol } from 'sf-symbols-typescript';

import { track } from '@/analytics';
import { EmptyState } from '@/components/EmptyState';
import { GlassPanel } from '@/components/GlassPanel';
import { expectedStreakWeeks, previewScore } from '@/game/catalog';
import { useGameCatalog } from '@/game/useGameCatalog';
import { fetchMyStreak, submitCheckin, submitReport, type Streak } from '@/lib/api';
import { FAILURE_TITLE } from '@/lib/checkin';
import { describeError, devLog } from '@/lib/devlog';
import { haptic } from '@/feedback/haptics';
import { preloadTimeline } from '@/feedback/reveal/playback';
import { buildRevealTimeline } from '@/feedback/reveal/timeline';
import { revealSoundtrack, warmUpSounds } from '@/feedback/sfx/soundtrack';
import { genericErrorMessage, reportErrorMessage } from '@/lib/errors';
import { compressPhoto } from '@/lib/photo';
import { setPendingReveal } from '@/lib/reveal';
import { useReduceMotion } from '@/lib/useAccessibility';
import { useDevMode } from '@/providers/DevModeProvider';
import { useLocation } from '@/providers/LocationProvider';
import { ToastViewport } from '@/providers/ToastProvider';
import { colors, radius, spacing, type } from '@/theme';

type Params = { mode?: string; binId?: string; lat?: string; lon?: string };
type Result = { ok: boolean; title: string; message: string };

function GlassAction({
  label,
  symbol,
  onPress,
  prominent = false,
  busy = false,
}: {
  label: string;
  symbol: SFSymbol;
  onPress: () => void;
  prominent?: boolean;
  busy?: boolean;
}) {
  return (
    <Button
      onPress={onPress}
      modifiers={[
        buttonStyle(prominent ? 'glassProminent' : 'glass'),
        controlSize('large'),
        tint(prominent ? colors.tint : 'white'),
        disabled(busy),
      ]}>
      <Label title={busy ? 'Versturen…' : label} systemImage={symbol} modifiers={[frame({ maxWidth: 10000 })]} />
    </Button>
  );
}

/** The camera screen with its own toast viewport: it is a modal above the tabs. */
export default function CameraScreen() {
  return (
    <View style={{ flex: 1 }}>
      <CameraContent />
      <ToastViewport />
    </View>
  );
}

function CameraContent() {
  const params = useLocalSearchParams<Params>();
  const mode = params.mode === 'report' ? 'report' : 'checkin';
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const { freshPosition } = useLocation();

  const [ready, setReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const photosTaken = useRef(0);
  const catalog = useGameCatalog();
  const reduceMotion = useReduceMotion();
  const dev = useDevMode();
  const [streak, setStreak] = useState<Streak | null>(null);

  useEffect(() => {
    track('camera_opened', { mode });
  }, [mode]);

  // Prime the sounds of a skip and learn the streak while the photo is taken,
  // well before the reveal; the voices stay loaded for the next check-in.
  useEffect(() => {
    if (mode !== 'checkin') return;
    warmUpSounds();
    fetchMyStreak().then(setStreak, () => {});
  }, [mode]);

  /** Mixes and loads the reveal the app expects, while the check-in uploads. */
  const prepareExpectedReveal = () => {
    if (!catalog || reduceMotion === null) return;
    const weeks = expectedStreakWeeks(streak, dev.status?.streakOverride ?? null);
    preloadTimeline(buildRevealTimeline({ score: previewScore(catalog.config, weeks), reduceMotion }), revealSoundtrack);
  };

  const close = () => router.back();

  const takePhoto = async () => {
    if (!camera.current || !ready) return;
    setCapturing(true);
    try {
      const picture = await camera.current.takePictureAsync({ quality: 0.8, exif: false });
      track('photo_taken', { mode, retake: photosTaken.current > 0 });
      photosTaken.current += 1;
      setPhotoUri(picture.uri);
    } catch {
      setResult({ ok: false, title: 'Foto mislukt', message: 'De camera kon geen foto nemen. Probeer het opnieuw.' });
    } finally {
      setCapturing(false);
    }
  };

  const submit = async () => {
    if (!photoUri) return;
    setBusy(true);
    try {
      const compressed = await compressPhoto(photoUri);
      if (mode === 'checkin') {
        prepareExpectedReveal();
        const position = await freshPosition();
        if (!position) {
          setResult({ ok: false, title: 'Geen locatie', message: 'Je locatie is onbekend. Sta locatietoegang toe.' });
          return;
        }
        const outcome = await submitCheckin({
          binId: Number(params.binId),
          latitude: position.latitude,
          longitude: position.longitude,
          accuracy: position.accuracy,
          mocked: position.mocked,
          fake: position.fake,
          photoUri: compressed,
        });
        if (outcome.ok && outcome.score) {
          setPendingReveal({
            score: outcome.score,
            question: outcome.question,
            checkinId: outcome.checkinId,
            isTest: outcome.isTest,
            preview: false,
          });
          router.replace('/reveal');
          return;
        }
        if (outcome.ok) haptic.success();
        else haptic.warning();
        setResult(
          outcome.ok
            ? { ok: true, title: 'Inworp geregistreerd', message: outcome.message }
            : { ok: false, title: FAILURE_TITLE[outcome.kind], message: outcome.message },
        );
      } else {
        await submitReport({
          latitude: Number(params.lat),
          longitude: Number(params.lon),
          note,
          photoUri: compressed,
        });
        track('report_submitted', { ok: true });
        haptic.success();
        setResult({
          ok: true,
          title: 'Bedankt voor je melding',
          message: 'Een admin bekijkt je foto. Na goedkeuring verschijnt de vuilbak op de kaart.',
        });
      }
    } catch (error) {
      devLog(mode === 'report' ? 'submit-report' : 'submit-checkin', false, { error: describeError(error) });
      if (mode === 'report') track('report_submitted', { ok: false });
      haptic.warning();
      const message = mode === 'report' ? reportErrorMessage(error as Error) : genericErrorMessage(error as Error);
      setResult({ ok: false, title: 'Niet gelukt', message });
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <EmptyState
          title={result.title}
          systemImage={result.ok ? 'checkmark.circle.fill' : 'exclamationmark.triangle.fill'}
          description={result.message}
          actions={[
            ...(!result.ok && photoUri ? [{ label: 'Opnieuw proberen', onPress: () => setResult(null) }] : []),
            { label: 'Terug naar de kaart', onPress: close, prominent: true },
          ]}
        />
      </View>
    );
  }

  if (!permission) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <EmptyState
          title="Camera nodig"
          systemImage="camera.fill"
          description="Neem een foto als bewijs. Een foto uit je galerij is niet mogelijk."
          actions={[
            permission.canAskAgain
              ? { label: 'Camera toestaan', onPress: requestPermission, prominent: true }
              : { label: 'Open Instellingen', onPress: () => Linking.openSettings(), prominent: true },
            { label: 'Annuleren', onPress: close },
          ]}
        />
      </View>
    );
  }

  if (photoUri) {
    return (
      <View style={{ flex: 1, backgroundColor: 'black' }}>
        <Image source={{ uri: photoUri }} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }} contentFit="contain" />
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'flex-end' }}>
          <SafeAreaView edges={['bottom']} style={{ padding: spacing.lg }}>
            <GlassPanel dark style={{ padding: spacing.md, gap: spacing.md }}>
              {mode === 'report' ? (
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Opmerking (optioneel), bv. naast de bushalte"
                  placeholderTextColor="rgba(235,235,245,0.4)"
                  keyboardAppearance="dark"
                  maxLength={500}
                  multiline
                  style={[
                    type.body,
                    {
                      color: 'white',
                      backgroundColor: 'rgba(118,118,128,0.3)',
                      borderRadius: radius.control,
                      borderCurve: 'continuous',
                      padding: spacing.md,
                      minHeight: 60,
                    },
                  ]}
                />
              ) : null}
              <Host matchContents={{ vertical: true }} style={{ alignSelf: 'stretch' }}>
                <HStack spacing={10}>
                  <GlassAction
                    label="Opnieuw"
                    symbol="arrow.counterclockwise"
                    onPress={() => {
                      // The camera remounts; wait for onCameraReady again.
                      setReady(false);
                      setPhotoUri(null);
                    }}
                    busy={busy}
                  />
                  <GlassAction
                    label={mode === 'checkin' ? 'Versturen' : 'Melden'}
                    symbol="paperplane.fill"
                    onPress={submit}
                    prominent
                    busy={busy}
                  />
                </HStack>
              </Host>
            </GlassPanel>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: 'black' }}>
      <CameraView
        ref={camera}
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
        facing="back"
        onCameraReady={() => setReady(true)}
      />
      <SafeAreaView style={{ flex: 1, justifyContent: 'space-between', padding: spacing.lg }} pointerEvents="box-none">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <Host matchContents>
            <Button
              label="Sluiten"
              systemImage="xmark"
              onPress={close}
              modifiers={[buttonStyle('glass'), buttonBorderShape('circle'), labelStyle('iconOnly'), controlSize('large'), tint('white')]}
            />
          </Host>
          <GlassPanel dark style={{ flex: 1, borderRadius: 999, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm + 2 }}>
            <Text style={[type.subheadline, { color: 'white', fontWeight: '600' }]}>
              {mode === 'checkin' ? 'Fotografeer je inworp in de vuilbak' : 'Fotografeer de ontbrekende vuilbak'}
            </Text>
          </GlassPanel>
        </View>
        <View style={{ alignItems: 'center', paddingBottom: spacing.lg }}>
          <Pressable
            onPress={takePhoto}
            disabled={!ready || capturing}
            accessibilityRole="button"
            accessibilityLabel="Foto nemen"
            style={{ width: 80, height: 80, borderRadius: 40, borderWidth: 5, borderColor: 'white', alignItems: 'center', justifyContent: 'center' }}>
            {({ pressed }) => (
              <View
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 32,
                  backgroundColor: 'white',
                  transform: [{ scale: pressed || capturing ? 0.88 : 1 }],
                  opacity: ready ? 1 : 0.5,
                }}
              />
            )}
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}
