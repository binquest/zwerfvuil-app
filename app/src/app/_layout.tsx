import { Stack, useSegments } from 'expo-router';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router/react-navigation';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AnalyticsTracker } from '@/analytics/AnalyticsTracker';
import { EmptyState } from '@/components/EmptyState';
import { UpdatePrompt } from '@/components/UpdatePrompt';
import { canPresent } from '@/game/moments';
import { gateFor, nextGate, type Gate } from '@/game/onboarding';
import { CONFIG_ERROR } from '@/lib/env';
import { AuthProvider, useAuth } from '@/providers/AuthProvider';
import { BinsProvider } from '@/providers/BinsProvider';
import { DevModeProvider } from '@/providers/DevModeProvider';
import { GameProvider } from '@/providers/GameProvider';
import { LocationProvider } from '@/providers/LocationProvider';
import { ChestMoment } from '@/providers/ChestMoment';
import { MissedMoments } from '@/providers/MissedMoments';
import { MomentsPresenter } from '@/providers/MomentsPresenter';
import { NotificationCenter } from '@/providers/NotificationCenter';
import { NotificationsMoment } from '@/providers/NotificationsMoment';
import { ToastProvider } from '@/providers/ToastProvider';
import { colors } from '@/theme';

// The native splash stays until the guard knows what to show; never longer
// than SPLASH_MAX_MS (the profile request gives up after 5 s anyway).
SplashScreen.preventAutoHideAsync().catch(() => {});
const SPLASH_MAX_MS = 8000;

export default function RootLayout() {
  const scheme = useColorScheme();
  useEffect(() => {
    if (CONFIG_ERROR) SplashScreen.hide();
    const timer = setTimeout(() => SplashScreen.hide(), SPLASH_MAX_MS);
    return () => clearTimeout(timer);
  }, []);
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

/**
 * The guard (src/game/onboarding.ts): splash while the profile is unknown,
 * the onboarding until it is done, else the app (also when the profile could
 * not be loaded). A profile that loads late only switches to the onboarding
 * on a tab screen with nothing open.
 */
function useGate(): Gate {
  const { session, loading, profile, profileLoaded } = useAuth();
  const segments = useSegments();
  const computed = gateFor({ loading, signedIn: !!session, profileLoaded, profile });
  const [gate, setGate] = useState<Gate>(computed);
  const next = nextGate(gate, computed, canPresent(segments, false));
  if (next !== gate) setGate(next);
  return next;
}

function RootStack() {
  const { session, loading, profile } = useAuth();
  const gate = useGate();
  useEffect(() => {
    if (gate !== 'splash') SplashScreen.hide();
  }, [gate]);
  if (loading) return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  const signedIn = !!session;
  const inApp = signedIn && gate !== 'onboarding';
  return (
    <LocationProvider enabled={signedIn}>
      <DevModeProvider isAdmin={signedIn && !!profile?.isAdmin}>
        <BinsProvider enabled={signedIn}>
          <GameProvider enabled={signedIn}>
          <AnalyticsTracker userId={session?.user.id ?? null} />
          <UpdatePrompt />
          <ToastProvider>
            {/* Nothing is presented over the onboarding or before the profile is known. */}
            <MomentsPresenter enabled={signedIn && gate === 'app'}>
              {/* Registered before the presenter's first start runs (child effects run first). */}
              {signedIn ? <MissedMoments /> : null}
              {signedIn ? <NotificationsMoment /> : null}
              {signedIn ? <ChestMoment /> : null}
              {signedIn ? <NotificationCenter ready={gate === 'app'} /> : null}
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Protected guard={!signedIn}>
                  <Stack.Screen name="login" />
                </Stack.Protected>
                <Stack.Protected guard={signedIn && gate === 'onboarding'}>
                  <Stack.Screen name="onboarding" options={{ gestureEnabled: false }} />
                </Stack.Protected>
                <Stack.Protected guard={inApp}>
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
                  <Stack.Screen
                    name="celebrate"
                    options={{ presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }}
                  />
                  <Stack.Screen
                    name="chest"
                    options={{ presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }}
                  />
                  <Stack.Screen
                    name="avatar-picker"
                    options={{
                      presentation: 'formSheet',
                      sheetAllowedDetents: [0.75, 1],
                      sheetGrabberVisible: true,
                      // Transparent: Liquid Glass sheet on iOS 26, like the bin sheet.
                      contentStyle: { backgroundColor: 'transparent' },
                      headerShown: true,
                      headerTransparent: true,
                      headerShadowVisible: false,
                    }}
                  />
                  <Stack.Screen
                    name="notifications"
                    options={{
                      presentation: 'formSheet',
                      sheetAllowedDetents: [0.8, 1],
                      sheetGrabberVisible: true,
                      // Transparent: Liquid Glass sheet on iOS 26, like the other sheets.
                      contentStyle: { backgroundColor: 'transparent' },
                    }}
                  />
                  <Stack.Screen name="onboarding-preview" options={{ presentation: 'fullScreenModal', gestureEnabled: false }} />
                </Stack.Protected>
              </Stack>
            </MomentsPresenter>
          </ToastProvider>
          </GameProvider>
        </BinsProvider>
      </DevModeProvider>
    </LocationProvider>
  );
}
