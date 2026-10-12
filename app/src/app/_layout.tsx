import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Message } from '@/components/Message';
import { CONFIG_ERROR } from '@/lib/env';
import { AuthProvider, useAuth } from '@/providers/AuthProvider';
import { LocationProvider } from '@/providers/LocationProvider';
import { colors } from '@/theme';

export default function RootLayout() {
  if (CONFIG_ERROR) {
    return (
      <Message
        title="App niet geconfigureerd"
        text={`${CONFIG_ERROR}. Vul app/.env in (zie app/.env.example) en herstart Expo.`}
      />
    );
  }
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <RootStack />
      </AuthProvider>
      <StatusBar style="dark" />
    </SafeAreaProvider>
  );
}

function RootStack() {
  const { session, loading } = useAuth();
  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }
  return (
    <LocationProvider enabled={!!session}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={!session}>
          <Stack.Screen name="login" />
        </Stack.Protected>
        <Stack.Protected guard={!!session}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="camera" options={{ presentation: 'fullScreenModal' }} />
        </Stack.Protected>
      </Stack>
    </LocationProvider>
  );
}
