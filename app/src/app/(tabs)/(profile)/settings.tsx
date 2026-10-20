// Settings (docs/GAMIFICATION.md, chapter 5), a SwiftUI form from the gear on
// the profile: name and e-mail; notifications (per kind, the hour of the quest
// reminder); test points (Dev mode); version and updates; sign out.
import { Host } from '@expo/ui';
import { Button, Form, LabeledContent, Section, Text } from '@expo/ui/swift-ui';
import { monospacedDigit } from '@expo/ui/swift-ui/modifiers';
import Constants from 'expo-constants';
import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Alert } from 'react-native';

import { checkForUpdateNow, currentVersionLabel } from '@/components/UpdatePrompt';
import { cleanName, nameError, NAME_MAX, NAME_MIN } from '@/game/onboarding';
import { setMyName } from '@/lib/api';
import { identityErrorMessage } from '@/lib/errors';
import { formatPoints } from '@/lib/format';
import { NotificationSettingsSection } from '@/notifications/NotificationSettingsSection';
import { useAuth } from '@/providers/AuthProvider';
import { useDevMode } from '@/providers/DevModeProvider';

export default function SettingsScreen() {
  const { session, profile, updateProfile, signOut } = useAuth();
  const dev = useDevMode();
  const refreshDev = dev.refresh;

  useFocusEffect(
    useCallback(() => {
      refreshDev();
    }, [refreshDev]),
  );

  const editName = () =>
    Alert.prompt(
      'Naam',
      `Zo zien andere spelers je op de ranglijst (${NAME_MIN} tot ${NAME_MAX} tekens).`,
      [
        { text: 'Annuleren', style: 'cancel' },
        {
          text: 'Bewaren',
          onPress: async (value?: string) => {
            const problem = nameError(value ?? '');
            if (problem) {
              Alert.alert('Deze naam kan niet', problem);
              return;
            }
            try {
              updateProfile({ displayName: await setMyName(cleanName(value ?? '')) });
            } catch (e) {
              Alert.alert('Niet gelukt', identityErrorMessage(e as { code?: string }));
            }
          },
        },
      ],
      'plain-text',
      profile?.displayName ?? '',
    );

  const confirmSignOut = () =>
    Alert.alert('Afmelden?', 'Je kunt je later opnieuw aanmelden met een code per e-mail.', [
      { text: 'Annuleren', style: 'cancel' },
      { text: 'Afmelden', style: 'destructive', onPress: signOut },
    ]);

  const checkUpdates = async () => Alert.alert('Updates', await checkForUpdateNow());

  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section title="Account" footer={<Text>Je naam is zichtbaar voor andere spelers; je e-mailadres niet.</Text>}>
          <LabeledContent label="Naam">
            <Text>{profile?.displayName ?? 'Zonder naam'}</Text>
          </LabeledContent>
          <LabeledContent label="E-mail">
            <Text>{session?.user.email ?? ''}</Text>
          </LabeledContent>
          <Button label="Naam wijzigen" onPress={editName} />
        </Section>

        <NotificationSettingsSection />

        {dev.available ? (
          <Section title="Dev-modus" footer={<Text>Testpunten tellen niet mee voor je echte punten, je level of de ranglijst.</Text>}>
            <LabeledContent label="Testpunten">
              <Text modifiers={[monospacedDigit()]}>{formatPoints(dev.status?.testPoints ?? 0)}</Text>
            </LabeledContent>
          </Section>
        ) : null}

        <Section title="App">
          <LabeledContent label="Versie">
            <Text>{`${Constants.expoConfig?.version ?? '?'} · ${currentVersionLabel()}`}</Text>
          </LabeledContent>
          <Button label="Zoek naar updates" onPress={checkUpdates} />
        </Section>

        <Section>
          <Button label="Afmelden" role="destructive" onPress={confirmSignOut} />
        </Section>
      </Form>
    </Host>
  );
}
