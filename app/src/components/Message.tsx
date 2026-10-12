import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '@/theme';

/** A centred title + text, for loading, empty and error states. */
export function Message({ title, text, children }: { title: string; text?: string; children?: ReactNode }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      {text ? <Text style={styles.text}>{text}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  title: { fontSize: 20, fontWeight: '700', color: colors.text, textAlign: 'center' },
  text: { fontSize: 15, color: colors.muted, textAlign: 'center' },
});
