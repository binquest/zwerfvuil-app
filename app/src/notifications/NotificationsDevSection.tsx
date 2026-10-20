// Dev mode, "Meldingen testen" (docs/GAMIFICATION.md, chapter 5 and phase 7):
// a test notification in 5 s that opens its screen, what the planner has in
// iOS now (and how many were ignored in a row), planning again, "nothing
// counts this week" until the next real check-in (to see the Sunday reminder
// come and go), and our own question for notifications as a preview. Writes
// nothing on the server.
import { Button, LabeledContent, Section, Stepper, Text, Toggle } from '@expo/ui/swift-ui';
import { disabled, monospacedDigit } from '@expo/ui/swift-ui/modifiers';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import { useGame } from '@/providers/GameProvider';
import { useToast } from '@/providers/ToastProvider';

import { pretendNoCheckinAt, setPretendNoCheckinAt } from './memory';
import {
  chestContent,
  NOTIFICATION_KIND_LABEL,
  NOTIFICATION_KINDS,
  questContent,
  streakContent,
  type PlanEntry,
} from './planner';
import { scheduledPlan, scheduleTestNotification, syncNotifications } from './scheduler';

function when(at: string): string {
  return new Date(at).toLocaleString('nl-BE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function NotificationsDevSection() {
  const { state } = useGame();
  const toast = useToast();
  const [kindIndex, setKindIndex] = useState(0);
  const kind = NOTIFICATION_KINDS[Math.min(kindIndex, NOTIFICATION_KINDS.length - 1)];
  const [plan, setPlan] = useState<{ entries: PlanEntry[]; ignoredInARow: number } | null>(null);
  const checkins = state?.stats?.checkins ?? null;
  const [pretendAt, setPretendAt] = useState(pretendNoCheckinAt);
  const pretending = pretendAt !== null && pretendAt === checkins;

  const load = useCallback(() => {
    scheduledPlan().then(setPlan, () => setPlan(null));
    setPretendAt(pretendNoCheckinAt());
  }, []);
  useFocusEffect(load);

  const sendTest = async () => {
    const today = state?.today ?? null;
    const content =
      kind === 'streak'
        ? streakContent(state?.streak ?? { weeks: 3, freezes: 0 })
        : kind === 'quest'
          ? questContent(today ? today.quests.filter((q) => q.status === 'open') : null)
          : chestContent(true);
    const chestDay = kind === 'chest' ? (today?.chestsReady[0] ?? null) : null;
    if (await scheduleTestNotification(kind, content, chestDay)) {
      toast.show({
        title: 'Testmelding over 5 s',
        message: 'Vergrendel je iPhone of ga naar het beginscherm; een tik opent het juiste scherm.',
        systemImage: 'bell.badge',
      });
    } else {
      Alert.alert('Meldingen staan uit', 'Zet ze aan in Instellingen (het tandwiel op Profiel).');
    }
  };

  const planAgain = async () => {
    if (state) await syncNotifications(state);
    load();
  };

  const pretend = async (on: boolean) => {
    setPretendNoCheckinAt(on ? checkins : null);
    await planAgain();
  };

  return (
    <Section
      title="Meldingen testen"
      footer={
        <Text>
          Een testmelding van de gekozen soort over 5 s (een kist opent het kistscherm als er een klaarstaat, anders
          Vandaag). Daaronder wat de planner nu in iOS heeft staan, in de tijd van je iPhone. “Doe alsof deze week
          nog niets telt” plant de reeksmelding van zondag 17:00 tot je volgende echte inworp (een testinworp telt
          niet). De vraag om meldingen toont onze uitleg zonder iOS te vragen.
        </Text>
      }>
      <Stepper
        label={`Soort: ${NOTIFICATION_KIND_LABEL[kind]}`}
        value={kindIndex}
        min={0}
        max={NOTIFICATION_KINDS.length - 1}
        onValueChange={setKindIndex}
      />
      <Button label="Testmelding over 5 s" systemImage="bell.badge" onPress={sendTest} />
      <LabeledContent label="Genegeerd op rij">
        <Text modifiers={[monospacedDigit()]}>{plan ? String(plan.ignoredInARow) : '…'}</Text>
      </LabeledContent>
      {plan && plan.entries.length === 0 ? (
        <LabeledContent label="Gepland">
          <Text>niets</Text>
        </LabeledContent>
      ) : null}
      {(plan?.entries ?? []).map((entry) => (
        <LabeledContent key={entry.id} label={NOTIFICATION_KIND_LABEL[entry.type]}>
          <Text>{when(entry.at)}</Text>
        </LabeledContent>
      ))}
      <Button label="Opnieuw plannen" systemImage="arrow.clockwise" onPress={planAgain} />
      <Toggle
        label="Doe alsof deze week nog niets telt"
        isOn={pretending}
        onIsOnChange={pretend}
        modifiers={[disabled(checkins === null)]}
      />
      <Button
        label="Vraag om meldingen tonen"
        systemImage="hand.raised"
        onPress={() => router.push({ pathname: '/notifications', params: { preview: '1' } })}
      />
    </Section>
  );
}
