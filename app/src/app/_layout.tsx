import { Stack } from 'expo-router';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router/react-navigation';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AnalyticsTracker } from '@/analytics/AnalyticsTracker';
import { EmptyState } from '@/components/EmptyState';
import { UpdatePrompt } from '@/components/UpdatePrompt';
import { CONFIG_ERROR } from '@/lib/env';
import { AuthProvider, useAuth } from '@/providers/AuthProvider';
import { BinsProvider } from '@/providers/BinsProvider';
import { DevModeProvider } from '@/providers/DevModeProvider';
import { LocationProvider } from '@/providers/LocationProvider';
import { MomentsPresenter } from '@/providers/MomentsPresenter';
import { ToastProvider } from '@/providers/ToastProvider';
import { colors } from '@/theme';

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <SafeAreaProvider>
      <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
        {CONFIG_ERROR ? (
          <EmptyState
            title="App niet geconfigureerd"
            systemImage="wrench.and.screwdriver"
            description={`${CONFIG_ERROR}. Vul app/.env.local in (zie app/.env.example) en herstart Expo.`}
          />
        ) : (
          <AuthProvider>
            <RootStack />
          </AuthProvider>
        )}
        <StatusBar style="auto" />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function RootStack() {
  const { session, loading, profile } = useAuth();
  if (loading) return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  const signedIn = !!session;
  return (
    <LocationProvider enabled={signedIn}>
      <DevModeProvider isAdmin={signedIn && !!profile?.isAdmin}>
        <BinsProvider enabled={signedIn}>
          <AnalyticsTracker userId={session?.user.id ?? null} />
          <UpdatePrompt />
          <ToastProvider>
            <MomentsPresenter enabled={signedIn}>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Protected guard={!signedIn}>
                  <Stack.Screen name="login" />
                </Stack.Protected>
                <Stack.Protected guard={signedIn}>
                  <Stack.Screen name="(tabs)" />
                  <Stack.Screen
                    name="bin/[id]"
                    // One bin sheet: tapping another pin while it is open shows that bin.
                    dangerouslySingular={() => 'bin'}
                    options={{
                      presentation: 'formSheet',
                      sheetAllowedDetents: [0.4, 0.75],
                      sheetGrabberVisible: true,
                      // The map stays usable behind the smallest detent.
                      sheetLargestUndimmedDetentIndex: 0,
                      // Transparent: Liquid Glass sheet on iOS 26.
                      contentStyle: { backgroundColor: 'transparent' },
                      headerShown: true,
                      headerTransparent: true,
                      headerShadowVisible: false,
                      title: '',
                    }}
                  />
                  <Stack.Screen name="camera" options={{ presentation: 'fullScreenModal' }} />
                  <Stack.Screen
                    name="reveal"
                    options={{ presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }}
                  />
                </Stack.Protected>
              </Stack>
            </MomentsPresenter>
          </ToastProvider>
        </BinsProvider>
      </DevModeProvider>
    </LocationProvider>
  );
}
