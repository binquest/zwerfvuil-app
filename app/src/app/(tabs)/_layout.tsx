import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { View } from 'react-native';

import { useAuth } from '@/providers/AuthProvider';
import { ToastViewport } from '@/providers/ToastProvider';
import { colors } from '@/theme';

// The system tab bar (Liquid Glass on iOS 26). Each tab has its own stack for
// headers. Tabs must not change after the first render, so wait for the
// profile before deciding whether the Beheer tab exists. Toasts show on top of
// the tabs unless a modal screen is open (it has its own viewport).
export default function TabsLayout() {
  const { profile, profileLoaded } = useAuth();
  if (!profileLoaded) return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  const isAdmin = !!profile?.isAdmin;
  return (
    <View style={{ flex: 1 }}>
      <NativeTabs tintColor={colors.tint} minimizeBehavior="onScrollDown">
        <NativeTabs.Trigger name="(map)" disableTransparentOnScrollEdge>
          <NativeTabs.Trigger.Icon sf={{ default: 'map', selected: 'map.fill' }} md="map" />
          <NativeTabs.Trigger.Label>Kaart</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="(profile)">
          <NativeTabs.Trigger.Icon sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }} md="person" />
          <NativeTabs.Trigger.Label>Profiel</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="(admin)" hidden={!isAdmin}>
          <NativeTabs.Trigger.Icon sf={{ default: 'checkmark.shield', selected: 'checkmark.shield.fill' }} md="verified_user" />
          <NativeTabs.Trigger.Label>Beheer</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
      <ToastViewport />
    </View>
  );
}
