// app.json plus the "development" variant: a debug build with expo-dev-client
// that loads the JS from Metro on the PC and installs next to the staging app.
//   APP_VARIANT=development npx expo prebuild --platform ios --clean
// Without APP_VARIANT this is app.json unchanged (staging, later production).
import type { ConfigContext, ExpoConfig } from 'expo/config';

const IS_DEV = process.env.APP_VARIANT === 'development';

export default ({ config }: ConfigContext): ExpoConfig => {
  // Only the dev client registers the exp+zwerfvuil-app:// scheme that the
  // QR code of `expo start` opens.
  const plugins: ExpoConfig['plugins'] = [...(config.plugins ?? []), ['expo-dev-client', { addGeneratedScheme: IS_DEV }]];
  const base = { ...config, plugins } as ExpoConfig;
  if (!IS_DEV) return base;
  return {
    ...base,
    name: 'Zwerfvuil Dev',
    ios: {
      ...base.ios,
      bundleIdentifier: 'be.zwerfvuil.app.dev',
      infoPlist: {
        ...base.ios?.infoPlist,
        // Metro and the local Supabase are plain http on the PC's LAN or
        // Tailscale IP. Only in this variant; staging and production use https.
        NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      },
    },
  };
};
