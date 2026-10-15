// app.json plus the "development" variant "Zwerfvuil Dev": a Release build
// against the staging server that installs next to the staging app and gets
// new JavaScript as EAS Updates on the channel "dev", so screens change
// without a new IPA (scripts/update-dev.mjs publishes them).
//   APP_VARIANT=development npx expo prebuild --platform ios --clean
// Without APP_VARIANT this is app.json unchanged (staging, later production),
// with updates switched off.
import type { ConfigContext, ExpoConfig } from 'expo/config';

const IS_DEV = process.env.APP_VARIANT === 'development';

// The EAS project that hosts the updates (`eas init`); not a secret.
const EAS_OWNER: string | null = 'binquest';
const EAS_PROJECT_ID: string | null = 'dda1a728-27ff-4675-b3b0-d17b617d3401';

// Updates only reach builds with the same runtime version. Bump it whenever
// native code changes (a package with native code, a config plugin, app.json)
// and build a new IPA.
const DEV_RUNTIME_VERSION = '1';
const DEV_UPDATE_CHANNEL = 'dev';

export default ({ config }: ConfigContext): ExpoConfig => {
  const base = config as ExpoConfig;
  if (!IS_DEV) return { ...base, updates: { ...base.updates, enabled: false } };
  const dev: ExpoConfig = {
    ...base,
    name: 'Zwerfvuil Dev',
    ios: { ...base.ios, bundleIdentifier: 'be.zwerfvuil.app.dev' },
  };
  // Until `eas init` has run there is no update URL; ios-dev.yml refuses to
  // build without one.
  if (!EAS_PROJECT_ID || !EAS_OWNER) return { ...dev, ...(EAS_OWNER ? { owner: EAS_OWNER } : {}) };
  return {
    ...dev,
    owner: EAS_OWNER,
    runtimeVersion: DEV_RUNTIME_VERSION,
    updates: {
      ...base.updates,
      enabled: true,
      url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
      requestHeaders: { 'expo-channel-name': DEV_UPDATE_CHANNEL },
      // Start with what is on the phone and download a new update in the
      // background; the app offers to restart when it is ready.
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
    },
    extra: { ...base.extra, eas: { ...base.extra?.eas, projectId: EAS_PROJECT_ID } },
  };
};
