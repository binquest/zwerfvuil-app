// Weekly and all-time leaderboard: display names and points only.
import { Host } from '@expo/ui';
import { ContentUnavailableView, Form, HStack, Image, Picker, Section, Spacer, Text, Toggle } from '@expo/ui/swift-ui';
import {
  font,
  foregroundStyle,
  frame,
  monospacedDigit,
  pickerStyle,
  refreshable,
  tag,
} from '@expo/ui/swift-ui/modifiers';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { track } from '@/analytics';
import { fetchLeaderboard, type LeaderboardPeriod, type LeaderboardRow } from '@/lib/api';
import { genericErrorMessage } from '@/lib/errors';
import { useDevMode } from '@/providers/DevModeProvider';
import { colors } from '@/theme';

const MEDALS = [colors.yellow, colors.gray, colors.orange];

function Row({ row }: { row: LeaderboardRow }) {
  const medal = row.place <= 3 ? MEDALS[row.place - 1] : null;
  const weight = row.is_me ? 'bold' : 'regular';
  return (
    <HStack spacing={12}>
      {medal ? (
        <Image systemName="medal.fill" size={20} color={medal} modifiers={[frame({ width: 28 })]} />
      ) : (
        <Text modifiers={[font({ textStyle: 'body' }), monospacedDigit(), frame({ width: 28 }), foregroundStyle({ type: 'hierarchical', style: 'secondary' })]}>
          {String(row.place)}
        </Text>
      )}
      <Text modifiers={[font({ textStyle: 'body', weight }), ...(row.is_me ? [foregroundStyle(colors.tint)] : [])]}>
        {row.is_me ? `${row.display_name} (jij)` : row.display_name}
      </Text>
      <Spacer />
      <Text modifiers={[font({ textStyle: 'body', weight: 'semibold' }), monospacedDigit()]}>{String(row.points)}</Text>
    </HStack>
  );
}

export default function LeaderboardScreen() {
  const [period, setPeriod] = useState<LeaderboardPeriod>('week');
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dev = useDevMode();
  const includeTest = dev.showTestData;

  const load = useCallback(async () => {
    try {
      setRows(await fetchLeaderboard(period, includeTest));
      setError(null);
    } catch (e) {
      setError(genericErrorMessage(e as Error));
    }
  }, [period, includeTest]);

  // Opened, or another period.
  useFocusEffect(
    useCallback(() => {
      track('leaderboard_viewed', { period });
    }, [period]),
  );

  // On focus and on every period switch; an older answer that arrives late
  // (fast switches) is ignored.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      fetchLeaderboard(period, includeTest)
        .then((next) => {
          if (!active) return;
          setRows(next);
          setError(null);
        })
        .catch((e) => active && setError(genericErrorMessage(e as Error)));
      return () => {
        active = false;
      };
    }, [period, includeTest]),
  );

  return (
    <Host style={{ flex: 1 }}>
      <Form modifiers={[refreshable(load)]}>
        <Section>
          <Picker
            selection={period}
            onSelectionChange={(value) => setPeriod(value as LeaderboardPeriod)}
            modifiers={[pickerStyle('segmented')]}>
            <Text modifiers={[tag('week')]}>Deze week</Text>
            <Text modifiers={[tag('all')]}>Altijd</Text>
          </Picker>
        </Section>

        {dev.available ? (
          <Section footer={<Text>Dev-modus: toont ook punten van testinworpen, om te controleren dat ze verschijnen en na een reset verdwijnen.</Text>}>
            <Toggle label="Testdata tonen" systemImage="hammer" isOn={dev.showTestData} onIsOnChange={dev.setShowTestData} />
          </Section>
        ) : null}

        {error ? (
          <Section>
            <Text modifiers={[foregroundStyle(colors.red)]}>{error}</Text>
          </Section>
        ) : rows && rows.length === 0 ? (
          <Section>
            <ContentUnavailableView
              title={period === 'week' ? 'Nog geen punten deze week' : 'Nog geen punten'}
              systemImage="trophy"
              description="Punten verschijnen hier zodra een inworp is goedgekeurd."
            />
          </Section>
        ) : (
          <Section
            title={period === 'week' ? 'Deze week' : 'Altijd'}
            footer={<Text>Alleen weergavenamen zijn zichtbaar. Je naam wijzig je in je profiel.</Text>}>
            {(rows ?? []).map((row, index) => (
              <Row key={index} row={row} />
            ))}
          </Section>
        )}
      </Form>
    </Host>
  );
}
