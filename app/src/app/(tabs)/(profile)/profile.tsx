import { Host } from '@expo/ui';
import { Button, Form, HStack, Image, LabeledContent, Section, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  animation,
  Animation,
  contentTransition,
  font,
  foregroundStyle,
  frame,
  listRowBackground,
  monospacedDigit,
  padding,
  refreshable,
} from '@expo/ui/swift-ui/modifiers';
import Constants from 'expo-constants';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';

import { checkForUpdateNow, currentVersionLabel } from '@/components/UpdatePrompt';
import { fetchMyCheckins, fetchMyStreak, updateDisplayName, type MyCheckin, type Streak } from '@/lib/api';
import { genericErrorMessage } from '@/lib/errors';
import { formatDateTime, formatPoints, formatWeeks, STATUS_LABEL, type ReviewStatus } from '@/lib/format';
import { formatDistance } from '@/lib/geo';
import { MAX_STAGES, totalMultiplier } from '@/lib/points';
import { useAuth } from '@/providers/AuthProvider';
import { useDevMode } from '@/providers/DevModeProvider';
import { colors } from '@/theme';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

const STATUS_STYLE: Record<ReviewStatus, { symbol: SFSymbol; color: typeof colors.tint }> = {
  pending: { symbol: 'clock.fill', color: colors.orange },
  approved: { symbol: 'checkmark.circle.fill', color: colors.green },
  rejected: { symbol: 'xmark.circle.fill', color: colors.red },
};

function checkinPoints(item: MyCheckin): string {
  if (item.status === 'approved') return `+${item.points_awarded}`;
  if (item.status === 'rejected') return '0';
  return `${item.points_earned + item.bonus_points} verwacht`;
}

function HistoryRow({ item }: { item: MyCheckin }) {
  const status = STATUS_STYLE[item.status];
  return (
    <HStack spacing={12}>
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[font({ textStyle: 'body' })]}>{`Vuilbak #${item.bin_id}${item.is_test ? ' · test' : ''}`}</Text>
        <Text modifiers={[font({ textStyle: 'footnote' }), secondary]}>
          {`${formatDateTime(item.created_at)} · ${formatDistance(item.distance_m)}`}
        </Text>
      </VStack>
      <Spacer />
      <VStack alignment="trailing" spacing={2}>
        <HStack spacing={4}>
          <Image systemName={status.symbol} size={13} color={status.color} />
          <Text modifiers={[font({ textStyle: 'footnote' }), secondary]}>{STATUS_LABEL[item.status]}</Text>
        </HStack>
        <Text modifiers={[font({ textStyle: 'footnote', weight: 'semibold' }), monospacedDigit()]}>{checkinPoints(item)}</Text>
      </VStack>
    </HStack>
  );
}

export default function ProfileScreen() {
  const { session, profile, refreshProfile, signOut } = useAuth();
  const dev = useDevMode();
  const refreshDev = dev.refresh;
  const [checkins, setCheckins] = useState<MyCheckin[]>([]);
  const [streak, setStreak] = useState<Streak | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, nextStreak] = await Promise.all([fetchMyCheckins(), fetchMyStreak(), refreshProfile()]);
      setCheckins(list);
      setStreak(nextStreak);
      setError(null);
    } catch (e) {
      setError(genericErrorMessage(e as Error));
    }
    refreshDev();
  }, [refreshProfile, refreshDev]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const pending = checkins.filter((c) => c.status === 'pending');
  const points = profile?.points ?? 0;
  const weeks = streak?.weeks ?? 0;
  const nextWeeks = streak?.thisWeek ? weeks : weeks + 1;

  const editName = () => {
    const userId = session?.user.id;
    if (!userId) return;
    Alert.prompt(
      'Weergavenaam',
      'Zo verschijn je op de ranglijst (1 tot 50 tekens).',
      [
        { text: 'Annuleren', style: 'cancel' },
        {
          text: 'Bewaren',
          onPress: async (value?: string) => {
            const name = (value ?? '').trim();
            if (name.length < 1 || name.length > 50) {
              Alert.alert('Ongeldige naam', 'Gebruik 1 tot 50 tekens.');
              return;
            }
            try {
              await updateDisplayName(userId, name);
              await refreshProfile();
            } catch (e) {
              Alert.alert('Niet gelukt', genericErrorMessage(e as Error));
            }
          },
        },
      ],
      'plain-text',
      profile?.displayName ?? '',
    );
  };

  const confirmSignOut = () =>
    Alert.alert('Afmelden?', 'Je kunt je later opnieuw aanmelden met een code per e-mail.', [
      { text: 'Annuleren', style: 'cancel' },
      { text: 'Afmelden', style: 'destructive', onPress: signOut },
    ]);

  const checkUpdates = async () => Alert.alert('Updates', await checkForUpdateNow());

  return (
    <Host style={{ flex: 1 }}>
      <Form modifiers={[refreshable(load)]}>
        <Section>
          <VStack spacing={4} modifiers={[frame({ maxWidth: 10000 }), padding({ vertical: 8 }), listRowBackground('clear')]}>
            <Text modifiers={[font({ textStyle: 'subheadline' }), secondary]}>Jouw punten</Text>
            <Text
              modifiers={[
                font({ size: 64, weight: 'black', design: 'rounded' }),
                monospacedDigit(),
                foregroundStyle(colors.tint),
                contentTransition('numericText'),
                animation(Animation.snappy(), points),
              ]}>
              {String(points)}
            </Text>
            {pending.length > 0 ? (
              <Text modifiers={[font({ textStyle: 'footnote' }), secondary]}>
                {`${pending.length} ${pending.length === 1 ? 'inworp wacht' : 'inworpen wachten'} op goedkeuring`}
              </Text>
            ) : null}
          </VStack>
        </Section>

        {error ? (
          <Section>
            <Text modifiers={[foregroundStyle(colors.red)]}>{error}</Text>
          </Section>
        ) : null}

        <Section
          title="Reeks"
          footer={
            <Text>
              {`Elke week met minstens één inworp telt. Elke week in je reeks geeft ×1,1 extra, tot ${totalMultiplier(MAX_STAGES)}.`}
            </Text>
          }>
          <HStack spacing={12}>
            <Image systemName="flame.fill" size={28} color={weeks > 0 ? colors.orange : colors.gray} />
            <VStack alignment="leading" spacing={2}>
              <Text modifiers={[font({ textStyle: 'headline' })]}>{weeks > 0 ? formatWeeks(weeks) : 'Nog geen reeks'}</Text>
              <Text modifiers={[font({ textStyle: 'footnote' }), secondary]}>
                {streak?.thisWeek
                  ? `Deze week telt al. Je inworpen krijgen ${totalMultiplier(Math.min(weeks, MAX_STAGES))}.`
                  : weeks > 0
                    ? `Check deze week in om je reeks te houden: ${totalMultiplier(Math.min(nextWeeks, MAX_STAGES))}.`
                    : 'Je eerste inworp start een reeks.'}
              </Text>
            </VStack>
          </HStack>
        </Section>

        <Section>
          <Button onPress={() => router.push('/leaderboard')}>
            <HStack>
              <Image systemName="trophy.fill" size={18} color={colors.yellow} />
              <Text modifiers={[foregroundStyle({ type: 'hierarchical', style: 'primary' })]}>Ranglijst</Text>
              <Spacer />
              <Image systemName="chevron.right" size={13} color={colors.tertiaryLabel} />
            </HStack>
          </Button>
        </Section>

        <Section title="Account">
          <LabeledContent label="Naam">
            <Text>{profile?.displayName ?? 'Zonder naam'}</Text>
          </LabeledContent>
          <LabeledContent label="E-mail">
            <Text>{session?.user.email ?? ''}</Text>
          </LabeledContent>
          <Button label="Naam wijzigen" onPress={editName} />
        </Section>

        {dev.available ? (
          <Section title="Dev-modus" footer={<Text>Testpunten tellen niet mee voor je echte punten of de ranglijst.</Text>}>
            <LabeledContent label="Testpunten">
              <Text modifiers={[monospacedDigit()]}>{formatPoints(dev.status?.testPoints ?? 0)}</Text>
            </LabeledContent>
          </Section>
        ) : null}

        <Section title="Historiek">
          {checkins.length === 0 ? (
            <Text modifiers={[secondary]}>Nog geen inworpen. Raap zwerfvuil op en gooi het in een vuilbak op de kaart.</Text>
          ) : (
            checkins.map((item) => <HistoryRow key={item.id} item={item} />)
          )}
        </Section>

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
