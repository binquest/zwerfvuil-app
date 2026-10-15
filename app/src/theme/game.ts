// Game tokens (docs/GAMIFICATION.md, chapter 5): the native shell keeps the
// system colours of index.ts; the game parts (the reveal, celebrations, game
// components) use these. No imports, so Jest and worklets can load it.
//
// Colours that differ between light and dark mode are { light, dark } pairs:
// resolve them with resolveColor() before handing them to Reanimated, which
// needs a fixed value. The play surfaces of the reveal are always dark, so
// their colours are plain values.

export type ColorPair = { light: string; dark: string };
/** A colour scheme as useColorScheme() gives it; anything but 'dark' is light. */
export type Scheme = string | null | undefined;

/** The colour of `pair` for a colour scheme (light when unknown). */
export function resolveColor(pair: ColorPair, scheme: Scheme): string {
  'worklet';
  return scheme === 'dark' ? pair.dark : pair.light;
}

/** The dark play surfaces (the reveal and the celebrations). */
export const playColors = {
  /** The reveal's background: a deep green glow fading to black. */
  background: 'linear-gradient(180deg, #0E3A24 0%, #050806 65%)',
  /** Behind the reveal while it has nothing to show. */
  backdrop: '#000000',
  /** The CHIPS (points) chip. */
  chips: '#2E7CF6',
  /** The +5 of the bonus question. */
  bonus: '#30D158',
  /** The MULT badge ramps orange → red → magenta over the streak stages. */
  multRamp: ['#FF9F0A', '#FF3B30', '#FF2D95'],
  /** The glow behind MULT as the streak heats up. */
  heat: '#FF2D95',
  /** The particles of the slam. */
  particles: ['#FFD60A', '#FF9F0A', '#FFFFFF'],
  gold: '#FFD60A',
  flash: '#FFFFFF',
  text: '#FFFFFF',
} as const;

/** Rarity of badges, avatars and chest rewards: common grey · rare blue · epic purple · legendary gold. */
export const rarityColors: Record<'common' | 'rare' | 'epic' | 'legendary', ColorPair> = {
  common: { light: '#8E8E93', dark: '#98989D' },
  rare: { light: '#007AFF', dark: '#0A84FF' },
  epic: { light: '#AF52DE', dark: '#BF5AF2' },
  legendary: { light: '#C88A00', dark: '#FFD60A' },
};

export type Rarity = keyof typeof rarityColors;

/** Game components on the system background (light and dark mode). */
export const gameColors = {
  /** A chunky button's face and its darker lip. */
  primary: { light: '#248A3D', dark: '#30D158' } as ColorPair,
  primaryLip: { light: '#1A6B2F', dark: '#1F9E44' } as ColorPair,
  onPrimary: { light: '#FFFFFF', dark: '#04210E' } as ColorPair,
  secondary: { light: '#E5E5EA', dark: '#2C2C2E' } as ColorPair,
  secondaryLip: { light: '#C7C7CC', dark: '#1C1C1E' } as ColorPair,
  onSecondary: { light: '#1C1C1E', dark: '#FFFFFF' } as ColorPair,
  /** Progress: the filled part and the track. */
  progress: { light: '#248A3D', dark: '#30D158' } as ColorPair,
  track: { light: '#E5E5EA', dark: '#3A3A3C' } as ColorPair,
  /** "Wacht op goedkeuring": pending rewards. */
  pending: { light: '#C93400', dark: '#FF9F0A' } as ColorPair,
  pendingFill: { light: '#FFF1E0', dark: '#3A2A12' } as ColorPair,
};

/**
 * Numbers in the game: SF Pro Rounded, black, tabular digits, and a cap on
 * Dynamic Type so a big number keeps fitting.
 */
export const numberStyle: { fontFamily: string; fontWeight: '900'; fontVariant: ['tabular-nums'] } = {
  fontFamily: 'ui-rounded',
  fontWeight: '900',
  fontVariant: ['tabular-nums'],
};
export const NUMBER_MAX_FONT_SCALE = 1.3;

/** Thick rounded corners and the "lip" under a chunky button. */
export const shapes = {
  chunkyRadius: 16,
  chunkyLip: 4,
  pillRadius: 999,
  chipRadius: 18,
  barHeight: 10,
};

/** Springs and timings of game motion (Reanimated config objects). */
export const motionPresets = {
  pop: { damping: 12, stiffness: 260 },
  settle: { damping: 18, stiffness: 160 },
  press: { duration: 90 },
  roll: { duration: 450 },
  fill: { duration: 350 },
};
