// The score of a check-in as the server sends it (submit-checkin, from
// private.checkin_score): the steps of the reveal, each with its running
// total, and the total. The app plays exactly these numbers and computes
// nothing itself (docs/GAMIFICATION.md, chapter 4).
//
// Known steps: base and streak. A step of another kind is kept with its label
// and total, so a new kind of bonus does not break the reveal: it lands on the
// total either way.

export interface StreakStage {
  /** The combined multiplier after this stage, rounded for display (1.21). */
  mult: number;
  total: number;
}

export type ScoreStep =
  | { kind: 'base'; label: string; chips: number; mult: number; total: number }
  | { kind: 'streak'; label: string; weeks: number; perWeek: number; stages: StreakStage[] }
  | { kind: 'other'; name: string; label: string; total: number | null };

export interface Score {
  steps: ScoreStep[];
  total: number;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseStep(value: unknown): ScoreStep | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== 'string' || typeof v.label !== 'string') return null;
  if (v.kind === 'base') {
    if (!isNumber(v.chips) || !isNumber(v.mult) || !isNumber(v.total)) return null;
    return { kind: 'base', label: v.label, chips: v.chips, mult: v.mult, total: v.total };
  }
  if (v.kind === 'streak') {
    if (!isNumber(v.weeks) || !isNumber(v.per_week) || !Array.isArray(v.stages)) return null;
    const stages = v.stages.filter(
      (s): s is StreakStage => !!s && typeof s === 'object' && isNumber(s.mult) && isNumber(s.total),
    );
    if (stages.length !== v.stages.length) return null;
    return { kind: 'streak', label: v.label, weeks: v.weeks, perWeek: v.per_week, stages };
  }
  return { kind: 'other', name: v.kind, label: v.label, total: isNumber(v.total) ? v.total : null };
}

/** The `score` of a submit-checkin response, or null when it is missing or malformed. */
export function parseScore(value: unknown): Score | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!isNumber(v.total) || !Array.isArray(v.steps) || v.steps.length === 0) return null;
  const steps = v.steps.map(parseStep);
  if (steps.some((step) => step === null)) return null;
  return { steps: steps as ScoreStep[], total: v.total };
}

export type BaseStep = Extract<ScoreStep, { kind: 'base' }>;
export type StreakStep = Extract<ScoreStep, { kind: 'streak' }>;

export function baseStep(score: Score): BaseStep | null {
  return (score.steps.find((step) => step.kind === 'base') as BaseStep | undefined) ?? null;
}

export function streakStep(score: Score): StreakStep | null {
  return (score.steps.find((step) => step.kind === 'streak') as StreakStep | undefined) ?? null;
}

/** The streak in weeks (0 without a streak step). */
export function streakWeeks(score: Score): number {
  return streakStep(score)?.weeks ?? 0;
}
