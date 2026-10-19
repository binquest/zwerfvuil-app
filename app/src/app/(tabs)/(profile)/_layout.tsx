import { Stack } from 'expo-router';

import { colors } from '@/theme';

// Profile, leaderboard and collection are React Native on the grouped
// background; settings is a SwiftUI form. An opaque header in the grouped
// background colour keeps the content below it, like Settings.
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
      <Stack.Screen name="settings" options={{ title: 'Instellingen', headerLargeTitleEnabled: false }} />
    </Stack>
  );
}
