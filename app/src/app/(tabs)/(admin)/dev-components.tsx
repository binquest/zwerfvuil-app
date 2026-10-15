// Dev mode: the shared game components on one screen, to check them on the
// phone (light and dark mode, Dynamic Type, Reduce Motion, VoiceOver) before
// the screens of later phases use them. Writes nothing.
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { ChunkyButton, GameNumber, PendingTag, ProgressBar, ProgressRing } from '@/components/game';
import { colors, spacing, type } from '@/theme';

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={[type.footnote, { color: colors.secondaryLabel, fontWeight: '600', textTransform: 'uppercase' }]}>{title}</Text>
      {children}
    </View>
  );
}

export default function DevComponentsScreen() {
  const [points, setPoints] = useState(120);
  const [progress, setProgress] = useState(3);
  const max = 10;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.xl }}>
      <Block title="GameNumber (rollend)">
        <GameNumber value={points} style={{ fontSize: 56, color: colors.label }} />
        <GameNumber value={points - 100} prefix="+" style={{ fontSize: 22, color: colors.tint }} />
      </Block>

      <Block title="ChunkyButton">
        <ChunkyButton title="+16 punten" onPress={() => setPoints((p) => p + 16)} />
        <ChunkyButton title="Terug naar 120" variant="secondary" onPress={() => setPoints(120)} />
        <ChunkyButton title="Uitgeschakeld" onPress={() => {}} disabled />
      </Block>

      <Block title={`ProgressBar en ProgressRing (${progress}/${max})`}>
        <ProgressBar value={progress} max={max} label="Volgende mijlpaal" />
        <ProgressBar value={progress} max={max} label="Dikke balk" height={18} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.lg }}>
          <ProgressRing value={progress} max={max} size={44} label="Level" />
          <ProgressRing value={progress} max={max} size={72} label="Level" center="7" />
          <ProgressRing value={progress} max={max} size={120} label="Level" center="7" />
        </View>
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <ChunkyButton title="−1" variant="secondary" onPress={() => setProgress((p) => Math.max(0, p - 1))} style={{ flex: 1 }} />
          <ChunkyButton title="+1" onPress={() => setProgress((p) => Math.min(max, p + 1))} style={{ flex: 1 }} />
        </View>
      </Block>

      <Block title="PendingTag">
        <PendingTag />
        <PendingTag text="+15 · wacht" />
      </Block>
    </ScrollView>
  );
}
