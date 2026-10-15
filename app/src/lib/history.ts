// The points history of the profile, built from the ledger (point_transactions):
// one item per check-in (the sum of its rows) and one per row that belongs to
// no check-in (adjustments; later quests, milestones, the daily chest).
import type { ReviewStatus } from './format';

export type LedgerStatus = 'pending' | 'granted' | 'revoked';

export interface LedgerRow {
  source: string;
  amount: number;
  status: LedgerStatus;
}

/** One of my check-ins with its ledger rows. */
export interface HistoryCheckin {
  id: string;
  created_at: string;
  status: ReviewStatus;
  review_reason: string | null;
  revoked_at: string | null;
  distance_m: number;
  bin_id: number;
  is_test: boolean;
  points: LedgerRow[];
}

/** A ledger row without a check-in. */
export interface LedgerEntry extends LedgerRow {
  id: number;
  earned_at: string;
  is_test: boolean;
  details: { reason?: unknown } | null;
}

export type HistoryState = 'pending' | 'granted' | 'rejected' | 'revoked';

export interface HistoryItem {
  key: string;
  date: string;
  title: string;
  /** The reason of a rejection, revocation or adjustment. */
  reason: string | null;
  isTest: boolean;
  /** Only for check-ins. */
  distanceM: number | null;
  state: HistoryState;
  /** Pending or granted points; for rejected and revoked items what was taken back. */
  points: number;
}

export const HISTORY_LABEL: Record<HistoryState, string> = {
  pending: 'Wacht op goedkeuring',
  granted: 'Goedgekeurd',
  rejected: 'Afgewezen',
  revoked: 'Herroepen',
};

const SOURCE_TITLE: Record<string, string> = {
  adjustment: 'Correctie',
  milestone: 'Mijlpaal',
  quest: 'Quest',
  weekly: 'Weekuitdaging',
  chest: 'Dagkist',
};

function sum(rows: LedgerRow[], status: LedgerStatus): number {
  return rows.reduce((total, row) => (row.status === status ? total + row.amount : total), 0);
}

export function checkinState(checkin: Pick<HistoryCheckin, 'status' | 'revoked_at'>): HistoryState {
  if (checkin.status === 'pending') return 'pending';
  if (checkin.status === 'approved') return 'granted';
  return checkin.revoked_at ? 'revoked' : 'rejected';
}

/** Newest first, at most `limit` items. */
export function buildHistory(checkins: HistoryCheckin[], entries: LedgerEntry[], limit = 50): HistoryItem[] {
  const items: HistoryItem[] = [
    ...checkins.map((c): HistoryItem => {
      const state = checkinState(c);
      const rows = state === 'pending' ? 'pending' : state === 'granted' ? 'granted' : 'revoked';
      return {
        key: `checkin:${c.id}`,
        date: c.created_at,
        title: `Vuilbak #${c.bin_id}`,
        reason: c.review_reason,
        isTest: c.is_test,
        distanceM: c.distance_m,
        state,
        points: sum(c.points ?? [], rows),
      };
    }),
    ...entries.map(
      (e): HistoryItem => ({
        key: `entry:${e.id}`,
        date: e.earned_at,
        title: SOURCE_TITLE[e.source] ?? 'Punten',
        reason: typeof e.details?.reason === 'string' ? e.details.reason : null,
        isTest: e.is_test,
        distanceM: null,
        state: e.status,
        points: e.amount,
      }),
    ),
  ];
  return items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, limit);
}

/** Real points that wait for approval (test points never count). */
export function pendingPoints(items: HistoryItem[]): number {
  return items.reduce((total, item) => (item.state === 'pending' && !item.isTest ? total + item.points : total), 0);
}

/** "+16", "−30" (a real minus sign), and "0" for rejected or revoked items. */
export function formatHistoryPoints(item: Pick<HistoryItem, 'state' | 'points'>): string {
  if (item.state === 'rejected' || item.state === 'revoked') return '0';
  return item.points < 0 ? `−${-item.points}` : `+${item.points}`;
}
