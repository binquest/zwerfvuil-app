// Data access for the screens. All rules are enforced server-side.
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';

import { track } from '@/analytics';

import {
  parseCollection,
  parseGameState,
  parseUnseen,
  type CollectionEntry,
  type GameState,
  type Unseen,
} from '../game/discoveries';
import { CHECKIN_TIMEOUT_MS, localFailure, parseCheckinResponse, type CheckinOutcome } from './checkin';
import { describeError, devLog } from './devlog';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './env';
import type { HistoryCheckin, LedgerEntry } from './history';
import { buildMultipart } from './multipart';
import { REGION_CENTER, REGION_RADIUS_M } from './region';
import { supabase } from './supabase';

export interface Bin {
  id: number;
  latitude: number;
  longitude: number;
  eligible: boolean;
  source: 'osm' | 'user';
  tags: Record<string, string>;
}

export interface Profile {
  displayName: string | null;
  points: number;
  /** Points of approved test check-ins (Dev mode), never part of points. */
  testPoints: number;
  isAdmin: boolean;
}

export interface PendingCheckin {
  id: string;
  created_at: string;
  display_name: string | null;
  bin_id: number;
  distance_m: number;
  accuracy_m: number;
  is_mocked: boolean;
  is_fake_location: boolean;
  photo_path: string;
  streak_weeks: number;
  points_earned: number;
  bonus_points: number;
  bonus_suspicious: boolean;
  is_test: boolean;
}

export interface ApprovedCheckin {
  id: string;
  created_at: string;
  reviewed_at: string;
  display_name: string | null;
  bin_id: number;
  distance_m: number;
  accuracy_m: number;
  is_mocked: boolean;
  is_fake_location: boolean;
  photo_path: string;
  streak_weeks: number;
  /** Granted points of the check-in (with the bonus). */
  points: number;
  is_test: boolean;
}

export interface PendingReport {
  id: string;
  created_at: string;
  display_name: string | null;
  latitude: number;
  longitude: number;
  note: string | null;
  photo_path: string;
  nearest_bin_m: number | null;
}

/** All active bins of the test region, including ineligible ones (the UI decides). */
export async function fetchBins(): Promise<Bin[]> {
  const { data, error } = await supabase.rpc('nearby_bins', {
    lat: REGION_CENTER.latitude,
    lon: REGION_CENTER.longitude,
    radius_m: REGION_RADIUS_M,
  });
  if (error) throw error;
  return (data ?? []) as Bin[];
}

export async function fetchProfile(userId: string): Promise<Profile> {
  const { data, error } = await supabase
    .from('profiles')
    .select('display_name, points, test_points, is_admin')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return { displayName: data.display_name, points: data.points, testPoints: data.test_points, isAdmin: data.is_admin };
}

/** 1 to 50 characters; shown on the leaderboard. */
export async function updateDisplayName(userId: string, name: string): Promise<void> {
  const { error } = await supabase.from('profiles').update({ display_name: name }).eq('id', userId);
  if (error) throw error;
}

export interface Streak {
  /** Consecutive weeks with a check-in; still alive this week if last week counted. */
  weeks: number;
  thisWeek: boolean;
}

export async function fetchMyStreak(): Promise<Streak> {
  const { data, error } = await supabase.rpc('my_streak');
  if (error) throw error;
  const row = (data as { weeks: number; this_week: boolean }[] | null)?.[0];
  return { weeks: row?.weeks ?? 0, thisWeek: row?.this_week ?? false };
}

export type LeaderboardPeriod = 'week' | 'all';

export interface LeaderboardRow {
  place: number;
  display_name: string;
  points: number;
  is_me: boolean;
}

/** Display names and points only. includeTest is Dev mode only (the server refuses others). */
export async function fetchLeaderboard(period: LeaderboardPeriod, includeTest = false): Promise<LeaderboardRow[]> {
  const { data, error } = await supabase.rpc('leaderboard', { period, max_rows: 50, include_test: includeTest });
  if (error) throw error;
  return (data ?? []) as LeaderboardRow[];
}

/** Starts the answer timer of the bonus question (the server flags very fast answers). */
/** my_game_state(): points, streak, the discovery counter and the next milestone. */
export async function fetchMyGameState(): Promise<GameState> {
  const { data, error } = await supabase.rpc('my_game_state');
  if (error) throw error;
  const state = parseGameState(data);
  if (!state) throw new Error('my_game_state: unexpected answer');
  return state;
}

/** my_collection(): every bin of the region and every bin discovered, with the discovery. */
export async function fetchMyCollection(): Promise<CollectionEntry[]> {
  const { data, error } = await supabase.rpc('my_collection');
  if (error) throw error;
  return parseCollection(data);
}

/** my_unseen(): the moments missed since the last visit. */
export async function fetchMyUnseen(): Promise<Unseen> {
  const { data, error } = await supabase.rpc('my_unseen');
  if (error) throw error;
  const unseen = parseUnseen(data);
  if (!unseen) throw new Error('my_unseen: unexpected answer');
  return unseen;
}

/** Marks the moments up to `until` (a server time) as seen. */
export async function markMomentsSeen(until: string): Promise<void> {
  const { error } = await supabase.rpc('mark_seen', { kind: 'moments', until });
  if (error) throw error;
}

export async function markBonusShown(checkinId: string): Promise<void> {
  const { error } = await supabase.rpc('mark_bonus_question_shown', { checkin_id: checkinId });
  if (error) throw error;
}

/** Returns the bonus points, granted together with the check-in. */
export async function answerBonus(checkinId: string, answer: string): Promise<number> {
  const { data, error } = await supabase.rpc('answer_bonus_question', { checkin_id: checkinId, answer });
  if (error) throw error;
  return data as number;
}

/**
 * My last check-ins with their ledger rows, and my ledger rows without a
 * check-in (adjustments). Filtered on my id: admins may read everyone's rows.
 */
export async function fetchMyHistory(userId: string): Promise<{ checkins: HistoryCheckin[]; entries: LedgerEntry[] }> {
  const [checkins, entries] = await Promise.all([
    supabase
      .from('checkins')
      .select(
        'id, created_at, status, review_reason, revoked_at, distance_m, bin_id, is_test, ' +
          'points:point_transactions!point_transactions_checkin_id_fkey(source, amount, status)',
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('point_transactions')
      .select('id, source, amount, status, earned_at, is_test, details')
      .eq('user_id', userId)
      .is('checkin_id', null)
      .order('earned_at', { ascending: false })
      .limit(50),
  ]);
  if (checkins.error) throw checkins.error;
  if (entries.error) throw entries.error;
  return { checkins: checkins.data as unknown as HistoryCheckin[], entries: entries.data as LedgerEntry[] };
}

export interface CheckinInput {
  binId: number;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  mocked: boolean;
  fake: boolean;
  photoUri: string;
}

/** Reads a local photo (file:// URI) into memory. */
async function readPhoto(uri: string): Promise<Uint8Array> {
  const file = new File(uri);
  if (!file.exists) throw new Error(`photo not found: ${uri}`);
  return file.bytes();
}

/**
 * Calls the submit-checkin edge function. The multipart body is built by hand
 * (see multipart.ts): expo/fetch cannot upload React Native `{ uri }` parts.
 */
export async function submitCheckin(input: CheckinInput): Promise<CheckinOutcome> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { ok: false, kind: 'auth', code: 'unauthorized', message: 'Je sessie is verlopen. Meld je opnieuw aan.' };

  let photo: Uint8Array;
  try {
    photo = await readPhoto(input.photoUri);
  } catch (error) {
    devLog('submit-checkin', false, { stage: 'read-photo', error: describeError(error) });
    return localFailure('photo', __DEV__ ? describeError(error) : undefined);
  }

  const fields: Record<string, string> = {
    bin_id: String(input.binId),
    lat: String(input.latitude),
    lon: String(input.longitude),
    accuracy_m: input.accuracy === null ? '' : String(input.accuracy),
    is_mocked: String(input.mocked),
  };
  // Dev mode test location; the server only accepts it from admins on local or staging.
  if (input.fake) fields.fake_location = 'true';
  const { body, contentType } = buildMultipart(fields, {
    field: 'photo',
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    bytes: photo,
  });

  track('checkin_submitted', { bin_id: input.binId, upload_kb: Math.round(body.byteLength / 1024) });
  const started = Date.now();
  let timedOut = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CHECKIN_TIMEOUT_MS);
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/submit-checkin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': contentType },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    const durationMs = Date.now() - started;
    const outcome = parseCheckinResponse(
      response.status,
      text,
      __DEV__ ? `status ${response.status}, ${durationMs} ms, ${body.byteLength} bytes` : undefined,
    );
    devLog('submit-checkin', outcome.ok, {
      status: response.status,
      durationMs,
      uploadBytes: body.byteLength,
      outcome: outcome.ok ? 'ok' : `${outcome.kind}/${outcome.code}`,
      body: text.slice(0, 500),
    });
    track('checkin_result', { ok: outcome.ok, reason: outcome.ok ? null : outcome.code, duration_ms: durationMs });
    return outcome;
  } catch (error) {
    const durationMs = Date.now() - started;
    const kind = timedOut ? 'timeout' : 'network';
    devLog('submit-checkin', false, { stage: 'fetch', kind, durationMs, uploadBytes: body.byteLength, error: describeError(error) });
    track('checkin_result', { ok: false, reason: kind, duration_ms: durationMs });
    return localFailure(kind, __DEV__ ? `${describeError(error)}, ${durationMs} ms, ${body.byteLength} bytes` : undefined);
  } finally {
    clearTimeout(timer);
  }
}

export interface ReportInput {
  latitude: number;
  longitude: number;
  note: string;
  photoUri: string;
}

/** Uploads the photo to the user's folder and files a pending bin report. */
export async function submitReport(input: ReportInput): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error('not signed in');

  const path = `${auth.user.id}/${randomUUID()}.jpg`;
  const bytes = await readPhoto(input.photoUri);
  const upload = await supabase.storage
    .from('report-photos')
    .upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
  if (upload.error) throw upload.error;

  const { error } = await supabase.from('bin_reports').insert({
    geom: `SRID=4326;POINT(${input.longitude} ${input.latitude})`,
    photo_path: path,
    note: input.note.trim() || null,
  });
  if (error) throw error;
}

// --- admin -----------------------------------------------------------------

export async function fetchPendingCheckins(): Promise<PendingCheckin[]> {
  const { data, error } = await supabase.rpc('pending_checkins');
  if (error) throw error;
  return (data ?? []) as PendingCheckin[];
}

export async function fetchPendingReports(): Promise<PendingReport[]> {
  const { data, error } = await supabase.rpc('pending_bin_reports');
  if (error) throw error;
  return (data ?? []) as PendingReport[];
}

/** The 50 most recently approved check-ins, newest decision first (for revoking). */
export async function fetchApprovedCheckins(): Promise<ApprovedCheckin[]> {
  const { data, error } = await supabase.rpc('approved_checkins', { max_rows: 50 });
  if (error) throw error;
  return (data ?? []) as ApprovedCheckin[];
}

/** reason only for a rejection (optional, at most 200 characters). */
export async function reviewCheckin(id: string, approve: boolean, reason?: string): Promise<void> {
  const { error } = await supabase.rpc('review_checkin', { id, approve, reason: approve ? null : (reason ?? null) });
  if (error) throw error;
}

/** Rejects an approved check-in after all; its points are taken back. The reason is required. */
export async function revokeCheckin(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_checkin', { id, reason });
  if (error) throw error;
}

export async function reviewReport(id: string, approve: boolean): Promise<void> {
  const { error } = await supabase.rpc('review_bin_report', { id, approve });
  if (error) throw error;
}

/** Excludes (false) or re-admits (true) a bin; the server sets eligible_override. */
export async function setBinEligibility(id: number, eligible: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_bin_eligibility', { id, eligible });
  if (error) throw error;
}

/** A short-lived URL for a private photo (admins can read every photo). */
export async function photoUrl(bucket: 'checkin-photos' | 'report-photos', path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 600);
  if (error) throw error;
  return data.signedUrl;
}

// --- Dev mode (admins on local or staging; the server checks everything) -----

export interface DevModeStatus {
  allowed: boolean;
  environment: string | null;
  streakOverride: number | null;
  testPoints: number;
  testCheckins: number;
}

export async function fetchDevModeStatus(): Promise<DevModeStatus> {
  const { data, error } = await supabase.rpc('dev_mode_status');
  if (error) throw error;
  const row = (data as Record<string, unknown>[] | null)?.[0] ?? {};
  return {
    allowed: row.allowed === true,
    environment: typeof row.environment === 'string' ? row.environment : null,
    streakOverride: typeof row.streak_override === 'number' ? row.streak_override : null,
    testPoints: typeof row.test_points === 'number' ? row.test_points : 0,
    testCheckins: typeof row.test_checkins === 'number' ? row.test_checkins : 0,
  };
}

/** null clears the override. */
export async function setDevStreakOverride(weeks: number | null): Promise<void> {
  const { error } = await supabase.rpc('set_dev_streak_override', { weeks });
  if (error) throw error;
}

/**
 * Removes my test check-ins (with bonus answers), test points and override,
 * then the photos of those check-ins. Returns how many check-ins were removed.
 */
export async function resetDevTestData(): Promise<number> {
  const { data, error } = await supabase.rpc('reset_dev_test_data');
  if (error) throw error;
  const row = (data as { deleted_checkins: number; photo_paths: string[] }[] | null)?.[0];
  const paths = row?.photo_paths ?? [];
  if (paths.length) {
    // The storage policy only allows my own photos that no check-in uses.
    const removed = await supabase.storage.from('checkin-photos').remove(paths);
    if (removed.error) devLog('dev-reset', false, { stage: 'photos', error: describeError(removed.error) });
  }
  return row?.deleted_checkins ?? 0;
}
