import { Stack } from 'expo-router';

import { colors } from '@/theme';

// Both screens are SwiftUI forms: an opaque header in the grouped background
// color keeps the form below it, like Settings.
export default function ProfileStack() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitleEnabled: true,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerStyle: { backgroundColor: colors.groupedBackground as string },
        headerBackButtonDisplayMode: 'minimal',
      }}>
      <Stack.Screen name="profile" options={{ title: 'Profiel' }} />
      <Stack.Screen name="leaderboard" options={{ title: 'Ranglijst' }} />
    </Stack>
  );
}
