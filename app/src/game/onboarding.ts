// The onboarding (docs/GAMIFICATION.md, chapter 5): name, avatar, then the
// map. A guard with three states decides what the app shows: profile unknown
// → splash; onboarded_at empty → onboarding; profile not loaded (offline) →
// the app, so nobody gets stuck. Pure, unit tested.

export type Gate = 'splash' | 'login' | 'onboarding' | 'app';

export interface GateInput {
  /** The stored session is still being read. */
  loading: boolean;
  signedIn: boolean;
  /** The first profile request finished (also when it failed or timed out). */
  profileLoaded: boolean;
  profile: { onboardedAt: string | null } | null;
}

/** What the root stack shows now. */
export function gateFor({ loading, signedIn, profileLoaded, profile }: GateInput): Gate {
  if (loading) return 'splash';
  if (!signedIn) return 'login';
  if (!profileLoaded) return 'splash';
  if (!profile) return 'app';
  return profile.onboardedAt ? 'app' : 'onboarding';
}

/**
 * The gate after a change. Once the app is shown it only switches to the
 * onboarding when nothing is open (a tab screen, no modal: `canSwitch`), so a
 * profile that loads late never pulls someone out of the camera or a reveal.
 */
export function nextGate(previous: Gate | null, computed: Gate, canSwitch: boolean): Gate {
  if (previous === 'app' && computed === 'onboarding' && !canSwitch) return 'app';
  return computed;
}

/** The same rule as private.clean_name on the server. */
export const NAME_MIN = 2;
export const NAME_MAX = 24;

/** Whitespace collapsed to one space and trimmed. */
export function cleanName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Why a name cannot be saved (in Dutch), or null when it can. Counts characters, not UTF-16 units. */
export function nameError(raw: string): string | null {
  const name = cleanName(raw);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return 'Gebruik alleen letters, cijfers en leestekens.';
  const length = [...name].length;
  if (length < NAME_MIN) return `Gebruik minstens ${NAME_MIN} tekens.`;
  if (length > NAME_MAX) return `Gebruik hoogstens ${NAME_MAX} tekens.`;
  return null;
}
