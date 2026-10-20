// The events the app logs, with their props (docs/ANALYTICS.md). Every name
// is also a row in public.event_names (the server's whitelist) and in the
// table of docs/ANALYTICS.md: a Jest test and the Deno integration test keep
// the three equal. No imports, so the Deno test can read this file too.
//
// Props are flat: strings, numbers, booleans or null, under snake_case keys.
// Never a location (the server drops keys like lat, lon, geom, location);
// bin_id is fine, bins are public.

export type DistanceBucket = '0_10' | '10_25' | '25_50' | '50_plus' | 'unknown';
export type PhotoMode = 'checkin' | 'report';
/** Where a celebration was shown: in the reveal (or right after it) or as a missed moment. */
export type CelebrationSource = 'reveal' | 'missed';
/** Where a badge was shown: a celebration source or the approval celebration (confirmed). */
export type BadgeSource = CelebrationSource | 'approval';
export type OnboardingStep = 'name' | 'avatar';
/** The one-time explanations on Today. */
export type TipKind = 'streak' | 'quests' | 'chest';

export interface EventProps {
  app_open: { kind: 'cold' | 'warm' };
  session_start: Record<string, never>;
  session_end: { duration_s: number };
  app_background: { foreground_s: number };
  screen_view: { screen: string };
  map_bin_tap: { bin_id: number; discovered: boolean };
  checkin_flow_start: { bin_id: number; distance_bucket: DistanceBucket };
  camera_opened: { mode: PhotoMode };
  photo_taken: { mode: PhotoMode; retake: boolean };
  checkin_submitted: { bin_id: number; upload_kb: number };
  checkin_result: { ok: boolean; reason: string | null; duration_ms: number };
  reveal_shown: { total: number; discovery: boolean; streak_weeks: number; preview: boolean };
  reveal_skipped: { step: string };
  bonus_question_answered: { question_key: string; answered: boolean; response_ms: number | null };
  discovery_shown: { ordinal: number | null; status: string | null; source: CelebrationSource };
  milestone_shown: { threshold: number; status: string; source: CelebrationSource };
  avatar_changed: { avatar_key: string; from: 'onboarding' | 'profile' };
  onboarding_step: { step: OnboardingStep };
  onboarding_completed: Record<string, never>;
  collection_viewed: { discovered: number; total: number };
  leaderboard_viewed: { period: 'week' | 'all' };
  report_flow_start: Record<string, never>;
  report_submitted: { ok: boolean };
  approval_shown: { approved: number; rejected: number; points: number };
  level_up_shown: { level: number; previous: number };
  badge_shown: { badge_key: string; status: string; source: BadgeSource };
  quest_viewed: { open: number; done: number };
  quest_completed: { template_key: string; period: 'day' | 'week'; source: CelebrationSource };
  chest_opened: { reward_kind: string; amount: number | null; days_ago: number };
  tip_shown: { tip: TipKind };
}

export type EventName = keyof EventProps;

// `satisfies` makes the compiler refuse a missing or an extra name.
const NAMES = {
  app_open: true,
  session_start: true,
  session_end: true,
  app_background: true,
  screen_view: true,
  map_bin_tap: true,
  checkin_flow_start: true,
  camera_opened: true,
  photo_taken: true,
  checkin_submitted: true,
  checkin_result: true,
  reveal_shown: true,
  reveal_skipped: true,
  bonus_question_answered: true,
  discovery_shown: true,
  milestone_shown: true,
  avatar_changed: true,
  onboarding_step: true,
  onboarding_completed: true,
  collection_viewed: true,
  leaderboard_viewed: true,
  report_flow_start: true,
  report_submitted: true,
  approval_shown: true,
  level_up_shown: true,
  badge_shown: true,
  quest_viewed: true,
  quest_completed: true,
  chest_opened: true,
  tip_shown: true,
} satisfies Record<EventName, true>;

export const EVENT_NAMES = Object.keys(NAMES) as EventName[];
