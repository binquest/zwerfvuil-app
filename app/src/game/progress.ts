// Progress towards a goal (quests, milestones, levels), for bars and rings.

/** value / max as 0..1, safe for any input (no goal = no progress). */
export function progressFraction(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value / max));
}
