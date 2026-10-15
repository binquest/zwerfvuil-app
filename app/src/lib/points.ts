// The bonus question of a submit-checkin response, and formatting points. The
// score of a check-in (its steps) is in score.ts; the numbers of the game come
// from the server (game_config, through score.steps and game_catalog()).

export interface BonusOption {
  key: string;
  label: string;
}

export interface BonusQuestion {
  key: string;
  prompt: string;
  options: BonusOption[];
  points: number;
}

/** "×1,1", "×2,14": a multiplier in Dutch notation. */
export function formatMultiplier(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `×${String(rounded).replace('.', ',')}`;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The `bonus_question` of a submit-checkin response (with its points from the server), or null. */
export function parseBonusQuestion(value: unknown): BonusQuestion | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.key !== 'string' || typeof v.prompt !== 'string' || !Array.isArray(v.options) || !isNumber(v.points)) return null;
  const options = v.options.filter(
    (o): o is BonusOption => !!o && typeof o.key === 'string' && typeof o.label === 'string',
  );
  if (options.length < 2) return null;
  return { key: v.key, prompt: v.prompt, options, points: v.points };
}
