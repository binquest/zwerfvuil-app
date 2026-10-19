// Levels (docs/GAMIFICATION.md, chapter 3). The server decides the level from
// the granted real points: `level` in my_game_state() and in every row of the
// leaderboard; the catalog has the curve and the titles. The app only shows
// the progress to the next level. Pure, unit tested.

export interface Level {
  level: number;
  title: string;
  minPoints: number;
}

/** `level` of my_game_state(): the current level and the next one (null at the top). */
export interface LevelState extends Level {
  next: Level | null;
}

export interface LevelProgress {
  /** Points above the threshold of the current level, at most `max`. */
  value: number;
  /** Points from the current level to the next (1 at the top, where value is 1 too). */
  max: number;
  /** Points still needed for the next level; null at the top. */
  toNext: number | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** One level ({level, title, min_points}), or null. */
export function parseLevel(value: unknown): Level | null {
  if (!isObject(value) || !isNumber(value.level) || !isNumber(value.min_points) || typeof value.title !== 'string') {
    return null;
  }
  return { level: value.level, title: value.title, minPoints: value.min_points };
}

/** `level` of my_game_state(), or null when it is missing. */
export function parseLevelState(value: unknown): LevelState | null {
  const level = parseLevel(value);
  if (!level || !isObject(value)) return null;
  return { ...level, next: parseLevel(value.next) };
}

/** The levels of game_catalog(), ascending; malformed rows are left out. */
export function parseLevels(value: unknown): Level[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => parseLevel(row) ?? []).sort((a, b) => a.level - b.level);
}

/** How far `points` are from the current level to the next one. */
export function levelProgress(state: LevelState, points: number): LevelProgress {
  if (!state.next) return { value: 1, max: 1, toNext: null };
  const max = Math.max(1, state.next.minPoints - state.minPoints);
  const value = Math.min(Math.max(0, Math.floor(points) - state.minPoints), max);
  return { value, max, toNext: Math.max(0, state.next.minPoints - Math.floor(points)) };
}

/** "Level 5 · Papiertjesprof". */
export function levelLabel(level: number, title: string): string {
  return title ? `Level ${level} · ${title}` : `Level ${level}`;
}

/** "Lv 5 · Papiertjesprof", for a leaderboard row. */
export function shortLevelLabel(level: number, title: string): string {
  return title ? `Lv ${level} · ${title}` : `Lv ${level}`;
}

/** "Nog 115 punten tot level 6", or the top. */
export function toNextLabel(state: LevelState, points: number): string {
  const { toNext } = levelProgress(state, points);
  if (toNext === null || !state.next) return 'Hoogste level bereikt';
  return `Nog ${toNext} ${toNext === 1 ? 'punt' : 'punten'} tot level ${state.next.level}`;
}
