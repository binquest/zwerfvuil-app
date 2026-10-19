import { describe, expect, it } from '@jest/globals';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { AVATAR_IMAGES } from '../avatarImages';
import {
  choiceLine,
  companionLine,
  defaultAvatarKey,
  MASCOT,
  parseMyAvatars,
  resolveAvatar,
  THUMB_MAX_PT,
  UNKNOWN_AVATAR,
  type AvatarDef,
} from '../avatars';

const DEFS: AvatarDef[] = [
  { key: 'vos', name: 'Vos', rarity: 'common', unlockType: 'default', sort: 2, symbol: 'pawprint.fill', color: '#C8553D' },
  { key: 'spruit', name: 'Spruit', rarity: 'common', unlockType: 'default', sort: 1, symbol: 'leaf.fill', color: '#4E9A52' },
  { key: 'bloem', name: 'Bloem', rarity: 'rare', unlockType: 'level', sort: 5, symbol: 'camera.macro', color: '#C2508A' },
];
const IMAGES = { vos: { full: 101, thumb: 102 } };

describe('the avatar map (scripts/avatars.mjs)', () => {
  it('has exactly the drawings in assets/avatars (run npm run avatars)', () => {
    const dir = join(__dirname, '..', '..', '..', 'assets', 'avatars');
    const drawings = readdirSync(dir)
      .filter((name) => name.endsWith('.png'))
      .map((name) => name.replace(/\.png$/, ''))
      .sort();
    expect(Object.keys(AVATAR_IMAGES).sort()).toEqual(drawings);
  });

  it('gives every drawing a full image and a thumbnail', () => {
    for (const image of Object.values(AVATAR_IMAGES)) {
      expect(image.full).toBeDefined();
      expect(image.thumb).toBeDefined();
    }
  });
});

describe('resolveAvatar', () => {
  it('draws the PNG when there is one: the thumbnail up to 64 pt, the full image above', () => {
    expect(resolveAvatar('vos', DEFS, IMAGES, THUMB_MAX_PT)).toEqual({
      key: 'vos', name: 'Vos', symbol: 'pawprint.fill', color: '#C8553D', image: 102,
    });
    expect(resolveAvatar('vos', DEFS, IMAGES, 96).image).toBe(101);
  });

  it('draws the placeholder of the catalog without a PNG', () => {
    expect(resolveAvatar('bloem', DEFS, IMAGES, 44)).toEqual({
      key: 'bloem', name: 'Bloem', symbol: 'camera.macro', color: '#C2508A', image: null,
    });
  });

  it('uses the standard avatar without a key, and a neutral placeholder for an unknown key', () => {
    expect(resolveAvatar(null, DEFS, IMAGES, 44).key).toBe('spruit');
    expect(resolveAvatar('draak', DEFS, IMAGES, 44)).toEqual({ key: 'draak', ...UNKNOWN_AVATAR, image: null });
    expect(resolveAvatar('toString', DEFS, IMAGES, 44).image).toBeNull();
  });

  it('knows the mascot, which is not in the catalog', () => {
    expect(resolveAvatar(MASCOT.key, DEFS, IMAGES, 96)).toMatchObject({ name: 'Zwerfie', symbol: MASCOT.symbol });
  });

  it('works before the catalog is loaded', () => {
    expect(defaultAvatarKey([])).toBeNull();
    expect(resolveAvatar(null, [], {}, 44)).toEqual({ key: null, ...UNKNOWN_AVATAR, image: null });
  });
});

describe('parseMyAvatars', () => {
  it('reads my_avatars(), by sort, and skips malformed rows', () => {
    const rows = [
      { key: 'bloem', name: 'Bloem', rarity: 'rare', unlock_type: 'level', unlock_param: '5', sort: 5, placeholder_symbol: 'camera.macro', placeholder_color: '#C2508A', status: 'locked', hint: 'Bereik level 5', is_current: false },
      { key: 'spruit', name: 'Spruit', rarity: 'common', unlock_type: 'default', unlock_param: null, sort: 1, placeholder_symbol: 'leaf.fill', placeholder_color: '#4E9A52', status: 'unlocked', hint: null, is_current: true },
      { key: 'raar', name: 'Raar', placeholder_symbol: 'x', placeholder_color: '#000000', status: 'maybe' },
    ];
    const choices = parseMyAvatars(rows);
    expect(choices.map((c) => `${c.key}:${c.status}:${c.current}`)).toEqual(['spruit:unlocked:true', 'bloem:locked:false']);
    expect(choices[1].hint).toBe('Bereik level 5');
  });
});

describe('texts', () => {
  it('names the companion and says how to unlock an avatar', () => {
    expect(companionLine('Vos')).toBe('Vos gaat met je mee.');
    const base = { ...DEFS[2], hint: 'Bereik level 5', current: false };
    expect(choiceLine({ ...base, status: 'locked' })).toBe('Bereik level 5');
    expect(choiceLine({ ...base, status: 'pending' })).toBe('Wacht op goedkeuring');
    expect(choiceLine({ ...base, status: 'unlocked', hint: null })).toBe('Zeldzaam');
    expect(choiceLine({ ...base, status: 'unlocked', hint: null, current: true })).toBe('Zeldzaam · je draagt deze avatar');
  });
});
