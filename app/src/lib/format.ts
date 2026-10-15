// Dutch (Belgian) display formatting.

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export const STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: 'In behandeling',
  approved: 'Goedgekeurd',
  rejected: 'Afgewezen',
};

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('nl-BE', {
    timeZone: 'Europe/Brussels',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatPoints(points: number): string {
  return `${points} ${points === 1 ? 'punt' : 'punten'}`;
}

export function formatWeeks(weeks: number): string {
  return `${weeks} ${weeks === 1 ? 'week' : 'weken'}`;
}
