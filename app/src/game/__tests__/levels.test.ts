import { describe, expect, it } from '@jest/globals';

import { levelLabel, levelProgress, parseLevelState, shortLevelLabel, toNextLabel, type LevelState } from '../levels';

const LEVEL_3: LevelState = { level: 3, title: 'Peukenpikker', minPoints: 60, next: { level: 4, title: 'Stoepridder', minPoints: 175 } };
const TOP: LevelState = { level: 20, title: 'Vuilbakkoning', minPoints: 21125, next: null };

describe('levelProgress', () => {
  it('runs from the threshold of the current level to the next one', () => {
    expect(levelProgress(LEVEL_3, 60)).toEqual({ value: 0, max: 115, toNext: 115 });
    expect(levelProgress(LEVEL_3, 100)).toEqual({ value: 40, max: 115, toNext: 75 });
    expect(levelProgress(LEVEL_3, 174)).toEqual({ value: 114, max: 115, toNext: 1 });
  });

  it('stays inside the ring when the points and the level disagree (a stale state)', () => {
    expect(levelProgress(LEVEL_3, 10)).toEqual({ value: 0, max: 115, toNext: 165 });
    expect(levelProgress(LEVEL_3, 400)).toEqual({ value: 115, max: 115, toNext: 0 });
  });

  it('is full at the top level', () => {
    expect(levelProgress(TOP, 30000)).toEqual({ value: 1, max: 1, toNext: null });
  });
});

describe('labels', () => {
  it('names the level with its title', () => {
    expect(levelLabel(5, 'Papiertjesprof')).toBe('Level 5 · Papiertjesprof');
    expect(shortLevelLabel(7, 'Pleinpatrouille')).toBe('Lv 7 · Pleinpatrouille');
    expect(levelLabel(2, '')).toBe('Level 2');
  });

  it('says how far the next level is', () => {
    expect(toNextLabel(LEVEL_3, 100)).toBe('Nog 75 punten tot level 4');
    expect(toNextLabel(LEVEL_3, 174)).toBe('Nog 1 punt tot level 4');
    expect(toNextLabel(TOP, 30000)).toBe('Hoogste level bereikt');
  });
});

describe('parseLevelState', () => {
  it('reads `level` of my_game_state()', () => {
    expect(parseLevelState({ level: 20, title: 'Vuilbakkoning', min_points: 21125, next: null })).toEqual(TOP);
  });

  it('refuses a level without its numbers', () => {
    expect(parseLevelState(null)).toBeNull();
    expect(parseLevelState({ level: '3', title: 'x', min_points: 60 })).toBeNull();
  });
});
