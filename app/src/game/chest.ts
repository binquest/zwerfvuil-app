// The daily chest on its own screen (chest.tsx, docs/GAMIFICATION.md chapter
// 5): a tap, the chest shakes in three waves with knocks and a growing glow,
// it pops open and the reward card comes in, in its rarity colour, the number
// rolling, "wacht op goedkeuring" while the quests of that day wait. The
// sounds are two mixed timelines on the celebration player: the shake (mixed
// when the screen opens) and the opening (played once open_daily_chest has
// answered). Pure, so order, sounds and Reduce Motion are unit tested.
import type { Event } from '../feedback/reveal/timeline';
import { VOLUME } from '../feedback/reveal/tuning';
import type { Rarity } from '../theme/game';
import type { AvatarDef } from './avatars';
import { parseChestReward, type ChestReward } from './today';

/** The waves of the shake start here (scripts/generate-sfx.mjs, CHEST_WAVE_AT). */
export const CHEST_WAVE_MS = [0, 320, 640] as const;
/** The chest opens no earlier than this after the tap (the knocks have ended). */
export const CHEST_SHAKE_MS = 960;
/** The reward card comes in after the pop. */
export const CHEST_REWARD_MS = 120;
export const CHEST_CONFETTI = 40;

const WAVE_HAPTICS = ['light', 'medium', 'heavy'] as const;

/** The shake: the rattle, a haptic per wave, the chest shaking (not with Reduce Motion) and the glow growing. */
export function buildChestShakeTimeline({ reduceMotion }: { reduceMotion: boolean }): Event[] {
  const events: Event[] = [{ atMs: 0, type: 'sound', id: 'chest_rattle', volume: VOLUME.chestRattle }];
  CHEST_WAVE_MS.forEach((atMs, wave) => {
    events.push({ atMs, type: 'haptic', kind: WAVE_HAPTICS[wave] });
    if (!reduceMotion) events.push({ atMs, type: 'shake', px: 4 + 3 * wave, ms: 260, rotationDeg: 5 + 3 * wave });
    events.push({ atMs, type: 'part', index: wave });
  });
  return events;
}

/** The opening: the pop with a success haptic and a flash (none with Reduce Motion), then the reward; confetti for a rare find. */
export function buildChestOpenTimeline({ reduceMotion, confetti }: { reduceMotion: boolean; confetti: boolean }): Event[] {
  const events: Event[] = [
    { atMs: 0, type: 'sound', id: 'chest_open', volume: VOLUME.chestOpen },
    { atMs: 0, type: 'haptic', kind: 'success' },
  ];
  if (!reduceMotion) events.push({ atMs: 0, type: 'flash', opacity: 0.6 });
  events.push({ atMs: CHEST_REWARD_MS, type: 'reward' });
  if (confetti) events.push({ atMs: CHEST_REWARD_MS, type: 'confetti', pieces: reduceMotion ? 0 : CHEST_CONFETTI });
  return events;
}

/** The colour of the reward card: an avatar its own rarity; a freeze rare; points by amount (25 epic, 15 rare). */
export function rewardRarity(reward: Pick<ChestReward, 'kind' | 'amount' | 'avatarKey'>, avatars: readonly Pick<AvatarDef, 'key' | 'rarity'>[]): Rarity {
  if (reward.kind === 'avatar') return avatars.find((a) => a.key === reward.avatarKey)?.rarity ?? 'epic';
  if (reward.kind === 'freeze') return 'rare';
  const amount = reward.amount ?? 0;
  return amount >= 25 ? 'epic' : amount >= 15 ? 'rare' : 'common';
}

/** Confetti only for an epic or legendary find. */
export function isRareFind(rarity: Rarity): boolean {
  return rarity === 'epic' || rarity === 'legendary';
}

/** The words under the reward ("punten", "Bevriezer: redt een gemiste week", "Nieuwe avatar"). */
export function rewardCaption(reward: Pick<ChestReward, 'kind'>): string {
  if (reward.kind === 'points') return 'punten';
  if (reward.kind === 'freeze') return 'Redt een gemiste week van je reeks';
  return 'Nieuwe avatar: kies hem in je profiel';
}

/** What VoiceOver says when the chest opens. */
export function chestSummary(reward: ChestReward, title: string): string {
  const what = reward.kind === 'points' ? `${reward.amount ?? 0} punten` : title;
  return `Je kist: ${what}${reward.status === 'pending' ? ', wacht op goedkeuring' : ''}.`;
}

export interface ChestOpened {
  day: string;
  reward: ChestReward;
  /** It was opened before: the same reward again, no new draw. */
  alreadyOpened: boolean;
}

/** The answer of open_daily_chest, or null. */
export function parseChestOpened(value: unknown): ChestOpened | null {
  if (!value || typeof value !== 'object') return null;
  const { day, reward, already_opened } = value as Record<string, unknown>;
  const parsed = parseChestReward(reward);
  if (typeof day !== 'string' || !parsed) return null;
  return { day, reward: parsed, alreadyOpened: already_opened === true };
}

/** Dev mode: open the chest screen with this reward, without the server. */
export interface ChestPreview {
  reward: ChestReward;
  forceReduceMotion?: boolean;
  noSound?: boolean;
}

let pendingPreview: ChestPreview | null = null;
let pendingOnClose: (() => void) | null = null;

/** The presenter's done for the next chest screen (it calls it when it closes). */
export function setChestOnClose(onClose: () => void): void {
  pendingOnClose = onClose;
}

/** Read once by the chest screen. */
export function takeChestOnClose(): (() => void) | null {
  const onClose = pendingOnClose;
  pendingOnClose = null;
  return onClose;
}

export function setPendingChestPreview(preview: ChestPreview): void {
  pendingPreview = preview;
}

/** The preview for the chest screen; read once. */
export function takePendingChestPreview(): ChestPreview | null {
  const preview = pendingPreview;
  pendingPreview = null;
  return preview;
}
