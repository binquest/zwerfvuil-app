import { Stack } from 'expo-router';

import { colors } from '@/theme';

// Today, and the leaderboard and collection in its own stack (the screens are
// shared with the profile: src/screens). Same headers as the profile.
export default function TodayStack() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitleEnabled: true,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerStyle: { backgroundColor: colors.groupedBackground as string },
        headerBackButtonDisplayMode: 'minimal',
      }}>
      <Stack.Screen name="today" options={{ title: 'Vandaag' }} />
      <Stack.Screen name="leaderboard" options={{ title: 'Ranglijst' }} />
      <Stack.Screen name="collection" options={{ title: 'Collectie' }} />
    </Stack>
  );
}
