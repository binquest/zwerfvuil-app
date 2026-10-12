// Data access for the screens. All rules are enforced server-side.
import { randomUUID } from 'expo-crypto';

import { NETWORK_ERROR_MESSAGE, parseCheckinResponse, type CheckinOutcome } from './checkin';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './env';
import type { ReviewStatus } from './format';
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
  isAdmin: boolean;
}

export interface MyCheckin {
  id: string;
  created_at: string;
  status: ReviewStatus;
  points_awarded: number;
  distance_m: number;
  bin_id: number;
  is_fake_location: boolean;
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
    .select('display_name, points, is_admin')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return { displayName: data.display_name, points: data.points, isAdmin: data.is_admin };
}

export async function fetchMyCheckins(): Promise<MyCheckin[]> {
  const { data, error } = await supabase
    .from('checkins')
    .select('id, created_at, status, points_awarded, distance_m, bin_id, is_fake_location')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data as MyCheckin[];
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

/** Calls the submit-checkin edge function with a multipart form. */
export async function submitCheckin(input: CheckinInput): Promise<CheckinOutcome> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { ok: false, code: 'unauthorized', message: 'Je sessie is verlopen. Meld je opnieuw aan.' };

  const form = new FormData();
  form.append('bin_id', String(input.binId));
  form.append('lat', String(input.latitude));
  form.append('lon', String(input.longitude));
  form.append('accuracy_m', input.accuracy === null ? '' : String(input.accuracy));
  form.append('is_mocked', String(input.mocked));
  if (input.fake) form.append('fake_location', 'true');
  // React Native uploads a local file from a { uri, name, type } descriptor.
  form.append('photo', { uri: input.photoUri, name: 'photo.jpg', type: 'image/jpeg' } as unknown as Blob);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/submit-checkin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_PUBLISHABLE_KEY },
      body: form,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return parseCheckinResponse(response.status, body);
  } catch {
    return { ok: false, code: 'network', message: NETWORK_ERROR_MESSAGE };
  } finally {
    clearTimeout(timeout);
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
  const bytes = await (await fetch(input.photoUri)).arrayBuffer();
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

export async function reviewCheckin(id: string, approve: boolean): Promise<void> {
  const { error } = await supabase.rpc('review_checkin', { id, approve });
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
