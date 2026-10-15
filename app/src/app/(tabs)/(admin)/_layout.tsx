import { Stack } from 'expo-router';

import { colors } from '@/theme';

export default function AdminStack() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitleEnabled: true,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
      }}>
      {/* A list (FlatList): the large title collapses into a transparent bar. */}
      <Stack.Screen name="admin" options={{ title: 'Beheer', headerTransparent: true }} />
      {/* A SwiftUI form: opaque header in the grouped background color. */}
      <Stack.Screen
        name="dev-mode"
        options={{ title: 'Dev-modus', headerStyle: { backgroundColor: colors.groupedBackground as string } }}
      />
      {/* A React Native scroll view of the game components. */}
      <Stack.Screen name="dev-components" options={{ title: 'Componenten' }} />
    </Stack>
  );
}
