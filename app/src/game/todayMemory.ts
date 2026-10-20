// What this device remembers about Today (docs/GAMIFICATION.md, chapter 5):
// which one-time explanations were shown, and up to which day ready chests
// were announced. localStorage (expo-sqlite) may throw or be empty: then the
// app shows a tip or an announcement again, never an error.
import type { TipKind } from './today';

const TIPS_KEY = 'today.tips.seen';
const CHEST_KEY = 'today.chest.announced';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Not remembered: shown again next time.
  }
}

const TIPS: readonly TipKind[] = ['streak', 'quests', 'chest'];

/** The explanations already shown on this device. */
export function seenTips(): Set<TipKind> {
  const stored = read(TIPS_KEY);
  if (!stored) return new Set();
  try {
    const list: unknown = JSON.parse(stored);
    return new Set(Array.isArray(list) ? TIPS.filter((t) => list.includes(t)) : []);
  } catch {
    return new Set();
  }
}

/** Remembers that these explanations were shown. */
export function markTipsSeen(tips: readonly TipKind[]): void {
  if (!tips.length) return;
  const seen = seenTips();
  for (const tip of tips) seen.add(tip);
  write(TIPS_KEY, JSON.stringify(TIPS.filter((t) => seen.has(t))));
}

/** Dev mode: show every explanation again. */
export function resetTips(): void {
  write(TIPS_KEY, null);
}

/** True when the ready chest of `day` (YYYY-MM-DD) was already announced on this device. */
export function chestAnnounced(day: string): boolean {
  const stored = read(CHEST_KEY);
  return !!stored && stored >= day;
}

/** Remembers that the chests up to `day` were announced (the chest screen was shown). */
export function markChestAnnounced(day: string): void {
  const stored = read(CHEST_KEY);
  if (!stored || day > stored) write(CHEST_KEY, day);
}
