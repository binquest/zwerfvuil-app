// Points of a check-in as the server returns them, and formatting. The server
// computes every real number (record_checkin); pointStages only mirrors the
// formula for the Dev mode preview, which writes nothing.

export const BASE_POINTS = 10;
export const STREAK_MULTIPLIER = 1.1;
/** At most this many x1.1 stages (x2.14 after two months). */
export const MAX_STAGES = 8;
export const BONUS_POINTS = 5;

export interface CheckinPoints {
  base: number;
  multiplier: number;
  streakWeeks: number;
  /** The total after each streak stage; empty without a streak. */
  stages: number[];
  total: number;
}

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

/** round(base * 1.1^k) for k = 1..min(weeks, 8), like checkin_point_stages(). */
export function pointStages(base: number, streakWeeks: number): CheckinPoints {
  const count = Math.min(Math.max(0, Math.floor(streakWeeks)), MAX_STAGES);
  const stages = Array.from({ length: count }, (_, i) => Math.round(base * STREAK_MULTIPLIER ** (i + 1)));
  return { base, multiplier: STREAK_MULTIPLIER, streakWeeks, stages, total: stages.at(-1) ?? base };
}

/** "×1,1", "×2,14": a multiplier in Dutch notation. */
export function formatMultiplier(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `×${String(rounded).replace('.', ',')}`;
}

/** The combined multiplier after `stages` stages, e.g. ×1,21 after 2. */
export function totalMultiplier(stages: number, multiplier = STREAK_MULTIPLIER): string {
  return formatMultiplier(multiplier ** stages);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The `points` object of a submit-checkin response, or null when it is missing or malformed. */
export function parsePoints(value: unknown): CheckinPoints | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!isNumber(v.base) || !isNumber(v.multiplier) || !isNumber(v.streak_weeks) || !isNumber(v.total)) return null;
  if (!Array.isArray(v.stages) || !v.stages.every(isNumber)) return null;
  return { base: v.base, multiplier: v.multiplier, streakWeeks: v.streak_weeks, stages: v.stages, total: v.total };
}

/** The `bonus_question` of a submit-checkin response, or null. */
export function parseBonusQuestion(value: unknown): BonusQuestion | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.key !== 'string' || typeof v.prompt !== 'string' || !Array.isArray(v.options)) return null;
  const options = v.options.filter(
    (o): o is BonusOption => !!o && typeof o.key === 'string' && typeof o.label === 'string',
  );
  if (options.length < 2) return null;
  return { key: v.key, prompt: v.prompt, options, points: isNumber(v.points) ? v.points : BONUS_POINTS };
}
