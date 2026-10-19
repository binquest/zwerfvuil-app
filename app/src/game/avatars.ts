// Avatars (docs/GAMIFICATION.md, chapters 3 and 5; docs/AVATARS.md): the
// catalog (game_catalog()), the picker (my_avatars()) and what an avatar
// looks like: the drawing from app/assets/avatars when there is one, else the
// placeholder of the catalog (an SF Symbol on a circle in its colour). An
// unknown key gets a neutral placeholder; no key means the standard avatar.
// Pure, unit tested; the component is components/game/Avatar.tsx.
import type { Rarity } from '../theme/game';

export type UnlockType = 'default' | 'level' | 'milestone' | 'badge' | 'quest' | 'chest';
/** unlocked: can be worn; pending: once points or a milestone are approved; locked: see the hint. */
export type AvatarStatus = 'unlocked' | 'pending' | 'locked';

export interface AvatarDef {
  key: string;
  name: string;
  rarity: Rarity;
  unlockType: UnlockType;
  sort: number;
  /** The placeholder until the drawing is there. */
  symbol: string;
  color: string;
}

/** A row of my_avatars(). */
export interface AvatarChoice extends AvatarDef {
  status: AvatarStatus;
  /** How to unlock it ("Bereik level 5"); null when unlocked. */
  hint: string | null;
  /** Worn now (the standard avatar when none was chosen). */
  current: boolean;
}

/** The drawing of an avatar: the 512 px PNG and its thumbnail (scripts/avatars.mjs). */
export interface AvatarImage {
  full: number;
  thumb: number;
}

/**
 * The mascot: the guide of the onboarding and the empty screens, not one of
 * the avatars a player can wear. Its drawing is assets/avatars/zwerfie.png.
 */
export const MASCOT: AvatarDef = {
  key: 'zwerfie',
  name: 'Zwerfie',
  rarity: 'common',
  unlockType: 'default',
  sort: 0,
  symbol: 'face.smiling.inverse',
  color: '#23A465',
};

/** The placeholder of a key the catalog does not know. */
export const UNKNOWN_AVATAR = { name: 'Avatar', symbol: 'person.fill', color: '#8E8E93' } as const;

/** Up to this size in points the thumbnail is sharp (192 px = 64 pt at @3x). */
export const THUMB_MAX_PT = 64;

export const RARITY_LABEL: Record<Rarity, string> = {
  common: 'Gewoon',
  rare: 'Zeldzaam',
  epic: 'Episch',
  legendary: 'Legendarisch',
};

const RARITIES: readonly string[] = ['common', 'rare', 'epic', 'legendary'];
const UNLOCK_TYPES: readonly string[] = ['default', 'level', 'milestone', 'badge', 'quest', 'chest'];
const STATUSES: readonly string[] = ['unlocked', 'pending', 'locked'];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseDef(row: unknown): AvatarDef | null {
  if (!isObject(row) || typeof row.key !== 'string' || typeof row.name !== 'string') return null;
  if (typeof row.placeholder_symbol !== 'string' || typeof row.placeholder_color !== 'string') return null;
  return {
    key: row.key,
    name: row.name,
    rarity: RARITIES.includes(row.rarity as string) ? (row.rarity as Rarity) : 'common',
    // A kind of a later phase: locked to this app, like the chest.
    unlockType: UNLOCK_TYPES.includes(row.unlock_type as string) ? (row.unlock_type as UnlockType) : 'chest',
    sort: typeof row.sort === 'number' ? row.sort : 0,
    symbol: row.placeholder_symbol,
    color: row.placeholder_color,
  };
}

function bySort(a: AvatarDef, b: AvatarDef): number {
  return a.sort - b.sort || a.key.localeCompare(b.key);
}

/** The avatars of game_catalog(), by sort; malformed rows are left out. */
export function parseAvatarDefs(value: unknown): AvatarDef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => parseDef(row) ?? []).sort(bySort);
}

/** The rows of my_avatars(), by sort; malformed rows are left out. */
export function parseMyAvatars(value: unknown): AvatarChoice[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((row): AvatarChoice[] => {
      const def = parseDef(row);
      if (!def || !isObject(row) || !STATUSES.includes(row.status as string)) return [];
      return [
        {
          ...def,
          status: row.status as AvatarStatus,
          hint: typeof row.hint === 'string' ? row.hint : null,
          current: row.is_current === true,
        },
      ];
    })
    .sort(bySort);
}

/** The standard avatar: the first default of the catalog. */
export function defaultAvatarKey(defs: readonly AvatarDef[]): string | null {
  return [...defs].sort(bySort).find((d) => d.unlockType === 'default')?.key ?? null;
}

export interface ResolvedAvatar {
  key: string | null;
  name: string;
  symbol: string;
  color: string;
  /** The drawing for this size (a require() number), or null for the placeholder. */
  image: number | null;
}

/** What to draw for `key` at `size` points. */
export function resolveAvatar(
  key: string | null | undefined,
  defs: readonly AvatarDef[],
  images: Readonly<Record<string, AvatarImage>>,
  size: number,
): ResolvedAvatar {
  const wanted = key ?? defaultAvatarKey(defs);
  const def = wanted ? (defs.find((d) => d.key === wanted) ?? (wanted === MASCOT.key ? MASCOT : null)) : null;
  const drawing = wanted && Object.hasOwn(images, wanted) ? images[wanted] : null;
  return {
    key: wanted,
    name: def?.name ?? UNKNOWN_AVATAR.name,
    symbol: def?.symbol ?? UNKNOWN_AVATAR.symbol,
    color: def?.color ?? UNKNOWN_AVATAR.color,
    image: drawing ? (size <= THUMB_MAX_PT ? drawing.thumb : drawing.full) : null,
  };
}

/** "Vos gaat met je mee." (onboarding, after a choice). */
export function companionLine(name: string): string {
  return `${name} gaat met je mee.`;
}

/** The line under an avatar in the picker. */
export function choiceLine(choice: AvatarChoice): string {
  if (choice.status === 'pending') return 'Wacht op goedkeuring';
  if (choice.status === 'locked') return choice.hint ?? 'Nog vergrendeld';
  return choice.current ? `${RARITY_LABEL[choice.rarity]} · je draagt deze avatar` : RARITY_LABEL[choice.rarity];
}
