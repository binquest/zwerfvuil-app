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

/**
 * The dark play surfaces (the reveal and the celebrations). Colour is a label,
 * as in Balatro: blue is PUNTEN (everything that adds up), the MULT scale is
 * everything that multiplies, gold is only for what is new (a discovery, a
 * milestone); the rest is neutral. Green is kept for the Klaar button.
 */
export const playColors = {
  /** The reveal's background: a neutral dark glow fading to black. */
  background: 'linear-gradient(180deg, #1B1E26 0%, #050608 65%)',
  /** Behind the reveal while it has nothing to show. */
  backdrop: '#000000',
  /** The PUNTEN bin, and every pop-up that adds points. */
  chips: '#2E7CF6',
  /** The MULT bin ramps orange → red → magenta over the streak stages; pop-ups that multiply use its top. */
  multRamp: ['#FF9F0A', '#FF3B30', '#FF2D95'],
  /** The glow behind MULT as the streak heats up, and the streak flame. */
  heat: '#FF2D95',
  /** The particles of the slam: neutral, PUNTEN and MULT. */
  particles: ['#FFFFFF', '#2E7CF6', '#FF9F0A'],
  /** Only for what is new: the discovery pop-up, a milestone. */
  gold: '#FFD60A',
  /** Text on gold. */
  onGold: '#1C1C1E',
  flash: '#FFFFFF',
  text: '#FFFFFF',
  /** Labels and the context line. */
  label: 'rgba(255,255,255,0.72)',
  /** Hints and explanations. */
  muted: 'rgba(255,255,255,0.55)',
} as const;

/**
 * The type scale of the play surfaces: three sizes only. The total (smaller
 * for long numbers, see the reveal), the values in the bins, and the labels;
 * every label in one style (capitals, one weight, one spacing).
 */
export const playType = {
  total: { fontSize: 120, lineHeight: 132 },
  value: { fontSize: 34, lineHeight: 40 },
  label: { fontSize: 13, lineHeight: 16, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase' },
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

/** Thick rounded corners and the "lip" under a chunky button; the bins and badges of the reveal. */
export const shapes = {
  chunkyRadius: 16,
  chunkyLip: 4,
  pillRadius: 999,
  chipRadius: 18,
  barHeight: 10,
  /** The PUNTEN and MULT bins. */
  binRadius: 18,
  binMinWidth: 120,
  /** Every badge and pop-up: one height, one radius. */
  badgeHeight: 30,
  badgeRadius: 15,
};

/** Springs and timings of game motion (Reanimated config objects). */
export const motionPresets = {
  pop: { damping: 12, stiffness: 260 },
  settle: { damping: 18, stiffness: 160 },
  press: { duration: 90 },
  roll: { duration: 450 },
  fill: { duration: 350 },
};
