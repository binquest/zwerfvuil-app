// Takes a photo with the camera (never the gallery) for a check-in or a
// report of a missing bin, compresses it and submits it.
import Ionicons from '@expo/vector-icons/Ionicons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Message } from '@/components/Message';
import { submitCheckin, submitReport } from '@/lib/api';
import { genericErrorMessage, reportErrorMessage } from '@/lib/errors';
import { compressPhoto } from '@/lib/photo';
import { useLocation } from '@/providers/LocationProvider';
import { colors, spacing } from '@/theme';

type Params = { mode?: string; binId?: string; lat?: string; lon?: string };
type Result = { ok: boolean; title: string; message: string };

export default function CameraScreen() {
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

  const close = () => router.back();

  const takePhoto = async () => {
    if (!camera.current || !ready) return;
    setCapturing(true);
    try {
      const picture = await camera.current.takePictureAsync({ quality: 0.8, exif: false });
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
        setResult(
          outcome.ok
            ? { ok: true, title: 'Inworp geregistreerd', message: outcome.message }
            : { ok: false, title: 'Inworp geweigerd', message: outcome.message },
        );
      } else {
        await submitReport({
          latitude: Number(params.lat),
          longitude: Number(params.lon),
          note,
          photoUri: compressed,
        });
        setResult({
          ok: true,
          title: 'Bedankt voor je melding',
          message: 'Een admin bekijkt je foto. Na goedkeuring verschijnt de vuilbak op de kaart.',
        });
      }
    } catch (error) {
      const message = mode === 'report' ? reportErrorMessage(error as Error) : genericErrorMessage(error as Error);
      setResult({ ok: false, title: 'Niet gelukt', message });
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <SafeAreaView style={styles.light}>
        <Message title={result.title} text={result.message}>
          <Ionicons
            name={result.ok ? 'checkmark-circle' : 'alert-circle'}
            size={64}
            color={result.ok ? colors.primary : colors.danger}
          />
          <View style={styles.resultButtons}>
            {!result.ok && photoUri ? (
              <Button title="Opnieuw proberen" variant="secondary" onPress={() => setResult(null)} />
            ) : null}
            <Button title="Terug naar de kaart" onPress={close} />
          </View>
        </Message>
      </SafeAreaView>
    );
  }

  if (!permission) {
    return (
      <View style={[styles.light, styles.center]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.light}>
        <Message title="Camera nodig" text="Neem een foto als bewijs. Een foto uit je galerij is niet mogelijk.">
          <View style={styles.resultButtons}>
            {permission.canAskAgain ? (
              <Button title="Camera toestaan" onPress={requestPermission} />
            ) : (
              <Button title="Open instellingen" onPress={() => Linking.openSettings()} />
            )}
            <Button title="Annuleren" variant="secondary" onPress={close} />
          </View>
        </Message>
      </SafeAreaView>
    );
  }

  if (photoUri) {
    return (
      <SafeAreaView style={styles.dark}>
        <Image source={{ uri: photoUri }} style={styles.preview} resizeMode="contain" />
        <View style={styles.panel}>
          {mode === 'report' ? (
            <TextInput
              style={styles.note}
              value={note}
              onChangeText={setNote}
              placeholder="Opmerking (optioneel), bv. naast de bushalte"
              maxLength={500}
              multiline
            />
          ) : null}
          <View style={styles.row}>
            <Button
              title="Opnieuw"
              variant="secondary"
              onPress={() => setPhotoUri(null)}
              disabled={busy}
              style={styles.flex}
            />
            <Button
              title={mode === 'checkin' ? 'Versturen' : 'Melding versturen'}
              onPress={submit}
              loading={busy}
              style={styles.flex}
            />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.dark}>
      <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" onCameraReady={() => setReady(true)} />
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.header}>
          <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel="Sluiten">
            <Ionicons name="close" size={30} color="#fff" />
          </Pressable>
          <Text style={styles.headerText}>
            {mode === 'checkin' ? 'Fotografeer je inworp in de vuilbak' : 'Fotografeer de ontbrekende vuilbak'}
          </Text>
        </View>
        <View style={styles.shutterRow}>
          <Pressable
            onPress={takePhoto}
            disabled={!ready || capturing}
            style={({ pressed }) => [styles.shutter, (pressed || capturing) && styles.shutterPressed]}
            accessibilityRole="button"
            accessibilityLabel="Foto nemen"
          />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  light: { flex: 1, backgroundColor: colors.background },
  dark: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  overlay: { flex: 1, justifyContent: 'space-between' },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  headerText: { color: '#fff', fontSize: 16, fontWeight: '600', flex: 1 },
  shutterRow: { alignItems: 'center', paddingBottom: spacing.xl },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 6, borderColor: '#fff', backgroundColor: 'rgba(255,255,255,0.3)' },
  shutterPressed: { backgroundColor: 'rgba(255,255,255,0.8)' },
  preview: { flex: 1 },
  panel: { padding: spacing.lg, gap: spacing.md, backgroundColor: '#000' },
  note: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    fontSize: 15,
    minHeight: 60,
  },
  row: { flexDirection: 'row', gap: spacing.md },
  flex: { flex: 1 },
  resultButtons: { alignSelf: 'stretch', gap: spacing.md, marginTop: spacing.lg },
});
