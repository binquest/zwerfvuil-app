// Notifications in Settings (docs/GAMIFICATION.md, chapter 5): the permission,
// a switch per kind and the hour of the quest reminder. Per device, like the
// notifications themselves; every change plans again.
import { Button, Section, Stepper, Text, Toggle } from '@expo/ui/swift-ui';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking } from 'react-native';

import { useGame } from '@/providers/GameProvider';

import { loadSettings, markPermissionAsked, saveSettings } from './memory';
import { NOTIFICATION_KIND_LABEL, NOTIFICATION_RULES, type NotificationSettings } from './planner';
import { notificationPermission, requestNotificationPermission, syncNotifications, type PermissionState } from './scheduler';

const RULES_TEXT =
  `Reeks: zondag om ${NOTIFICATION_RULES.streakHour}:00 als je die week nog niets ingeworpen hebt. ` +
  `Quests en kist: om het uur hierboven. Hooguit één melding per dag, nooit tussen ` +
  `${NOTIFICATION_RULES.quietFrom}:00 en ${NOTIFICATION_RULES.quietUntil}:00; ` +
  `na ${NOTIFICATION_RULES.calmAfterIgnored} genegeerde meldingen alleen nog de reeks.`;

export function NotificationSettingsSection() {
  const { state } = useGame();
  const [settings, setSettings] = useState<NotificationSettings>(loadSettings);
  const [permission, setPermission] = useState<PermissionState | null>(null);

  // On every visit and when coming back from the iOS settings.
  const check = useCallback(() => {
    notificationPermission().then(setPermission);
  }, []);
  useFocusEffect(check);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') check();
    });
    return () => subscription.remove();
  }, [check]);

  const change = (patch: Partial<NotificationSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
    if (state) void syncNotifications(state);
  };

  const turnOn = async () => {
    if (permission === 'denied') {
      await Linking.openSettings();
      return;
    }
    // Our own explanation is not needed any more: this section is it.
    markPermissionAsked();
    const result = await requestNotificationPermission('settings');
    setPermission(result);
    if (result === 'granted' && state) void syncNotifications(state);
  };

  const status =
    permission === 'denied'
      ? 'Meldingen staan uit in de iOS-instellingen van deze app. '
      : permission === 'undetermined'
        ? 'Meldingen staan nog uit. '
        : '';

  return (
    <Section title="Meldingen" footer={<Text>{status + RULES_TEXT}</Text>}>
      {permission === 'denied' || permission === 'undetermined' ? (
        <Button label={permission === 'denied' ? 'Open iOS-instellingen' : 'Meldingen aanzetten'} onPress={turnOn} />
      ) : null}
      <Toggle label={NOTIFICATION_KIND_LABEL.streak} isOn={settings.streak} onIsOnChange={(on) => change({ streak: on })} />
      <Toggle label={NOTIFICATION_KIND_LABEL.quest} isOn={settings.quest} onIsOnChange={(on) => change({ quest: on })} />
      <Toggle label={NOTIFICATION_KIND_LABEL.chest} isOn={settings.chest} onIsOnChange={(on) => change({ chest: on })} />
      <Stepper
        label={`Herinnering om ${settings.questHour}:00`}
        value={settings.questHour}
        min={NOTIFICATION_RULES.questHourMin}
        max={NOTIFICATION_RULES.questHourMax}
        onValueChange={(hour) => change({ questHour: hour })}
      />
    </Section>
  );
}
