// EAS Update (only in builds with updates on, i.e. "Zwerfvuil Dev"): checks
// for a new version when the app comes to the foreground and offers to restart
// once it is downloaded.
import * as Updates from 'expo-updates';
import { useEffect, useRef } from 'react';
import { Alert, AppState } from 'react-native';

const CHECK_INTERVAL_MS = 60_000;

async function checkAndDownload(): Promise<void> {
  try {
    const result = await Updates.checkForUpdateAsync();
    if (result.isAvailable) await Updates.fetchUpdateAsync();
  } catch {
    // Offline or the update server is unreachable: try again next time.
  }
}

export function UpdatePrompt() {
  const { isUpdatePending, downloadedUpdate } = Updates.useUpdates();
  const asked = useRef<string | null>(null);
  const lastCheck = useRef(0);

  useEffect(() => {
    if (!Updates.isEnabled) return;
    // expo-updates already checks at launch (checkAutomatically: ON_LOAD).
    lastCheck.current = Date.now();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || Date.now() - lastCheck.current < CHECK_INTERVAL_MS) return;
      lastCheck.current = Date.now();
      checkAndDownload();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const id = downloadedUpdate?.updateId ?? 'pending';
    if (!isUpdatePending || asked.current === id) return;
    asked.current = id;
    Alert.alert('Nieuwe versie klaar', 'Herstart de app om de nieuwe versie te gebruiken.', [
      { text: 'Later', style: 'cancel' },
      { text: 'Herstarten', onPress: () => Updates.reloadAsync() },
    ]);
  }, [isUpdatePending, downloadedUpdate]);

  return null;
}

/** "3f2a91c0 · 14 okt 22:31" or "ingebouwd"; for the profile screen. */
export function currentVersionLabel(): string {
  if (!Updates.isEnabled) return 'updates uit';
  if (Updates.isEmbeddedLaunch || !Updates.updateId) return 'ingebouwde versie';
  const created = Updates.createdAt
    ? Updates.createdAt.toLocaleString('nl-BE', {
        timeZone: 'Europe/Brussels',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  return `${Updates.updateId.slice(0, 8)}${created ? ` · ${created}` : ''}`;
}

/** Checks now; resolves with a Dutch status for an alert. */
export async function checkForUpdateNow(): Promise<string> {
  if (!Updates.isEnabled) return 'Deze build krijgt geen updates.';
  try {
    const result = await Updates.checkForUpdateAsync();
    if (!result.isAvailable) return 'Je hebt de nieuwste versie.';
    await Updates.fetchUpdateAsync();
    return 'Nieuwe versie gedownload.';
  } catch {
    return 'Kon niet zoeken naar updates. Controleer je verbinding.';
  }
}
