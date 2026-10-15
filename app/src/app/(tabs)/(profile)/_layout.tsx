import { Stack } from 'expo-router';

import { colors } from '@/theme';

// Profile and leaderboard are SwiftUI forms: an opaque header in the grouped
// background color keeps the form below it, like Settings. The collection is a
// React Native grid on the same background.
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
      <Stack.Screen name="collection" options={{ title: 'Collectie' }} />
    </Stack>
  );
}
