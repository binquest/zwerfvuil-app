import { StyleSheet, Text, View } from 'react-native';

import { STATUS_LABEL, type ReviewStatus } from '@/lib/format';
import { colors } from '@/theme';

const COLORS: Record<ReviewStatus, { bg: string; fg: string }> = {
  pending: { bg: colors.warningLight, fg: colors.warning },
  approved: { bg: colors.primaryLight, fg: colors.primaryDark },
  rejected: { bg: colors.dangerLight, fg: colors.danger },
};

export function StatusBadge({ status }: { status: ReviewStatus }) {
  const { bg, fg } = COLORS[status];
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.text, { color: fg }]}>{STATUS_LABEL[status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' },
  text: { fontSize: 13, fontWeight: '600' },
});
