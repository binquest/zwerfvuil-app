// System colors and type styles. On iOS every color is a semantic UIKit color
// (or a dynamic pair), so light mode, dark mode and Increase Contrast follow
// the system. The hex values are only used on other platforms. The game
// tokens (game.ts) are exported from here as well.
import { Color } from 'expo-router';
import { DynamicColorIOS, Platform, type ColorValue, type TextStyle } from 'react-native';

function pick(ios: () => ColorValue, fallback: string): ColorValue {
  return Platform.OS === 'ios' ? ios() : fallback;
}

export const colors = {
  // The app's green: Apple's accessible system green, so white text on it
  // stays readable in light mode.
  tint: pick(() => DynamicColorIOS({ light: '#248A3D', dark: '#30D158', highContrastLight: '#1C6E31', highContrastDark: '#31DE5F' }), '#248A3D'),
  label: pick(() => Color.ios.label, '#000000'),
  secondaryLabel: pick(() => Color.ios.secondaryLabel, '#3c3c4399'),
  tertiaryLabel: pick(() => Color.ios.tertiaryLabel, '#3c3c434d'),
  separator: pick(() => Color.ios.separator, '#3c3c434a'),
  background: pick(() => Color.ios.systemBackground, '#ffffff'),
  groupedBackground: pick(() => Color.ios.systemGroupedBackground, '#f2f2f7'),
  cell: pick(() => Color.ios.secondarySystemGroupedBackground, '#ffffff'),
  fill: pick(() => Color.ios.tertiarySystemFill, '#7676801f'),
  red: pick(() => Color.ios.systemRed, '#ff3b30'),
  orange: pick(() => Color.ios.systemOrange, '#ff9500'),
  yellow: pick(() => Color.ios.systemYellow, '#ffcc00'),
  blue: pick(() => Color.ios.systemBlue, '#007aff'),
  purple: pick(() => Color.ios.systemPurple, '#af52de'),
  gray: pick(() => Color.ios.systemGray, '#8e8e93'),
  green: pick(() => Color.ios.systemGreen, '#34c759'),
};

/** Map pins: eligible bins in the app green, the nearest in blue, excluded (admins only) in gray. */
export const pinColors = {
  eligible: colors.tint,
  nearest: colors.blue,
  excluded: colors.gray,
  test: colors.purple,
};

/** The iOS text styles (San Francisco is the system font). */
export const type = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700' },
  title1: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  title3: { fontSize: 20, lineHeight: 25, fontWeight: '600' },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 22 },
  callout: { fontSize: 16, lineHeight: 21 },
  subheadline: { fontSize: 15, lineHeight: 20 },
  footnote: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16 },
} satisfies Record<string, TextStyle>;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

/** Corner radius of cards and glass panels (continuous curve). */
export const radius = { card: 22, control: 14 };

// The game tokens: play surfaces, rarity, numbers, chunky shapes, motion.
export * from './game';
