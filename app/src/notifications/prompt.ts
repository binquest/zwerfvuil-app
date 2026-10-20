// Our own explanation before the system prompt for notifications
// (docs/GAMIFICATION.md, chapter 5 and phase 7): what we would send, with the
// numbers of the planner, and the close callback of the presenter.
import { NOTIFICATION_RULES } from './planner';

export interface PromptRow {
  symbol: 'flame.fill' | 'checklist' | 'shippingbox.fill';
  title: string;
  body: string;
}

const hour = (h: number) => `${h}:00`;

export const PROMPT_TITLE = 'Zullen we je eraan herinneren?';

export const PROMPT_ROWS: readonly PromptRow[] = [
  {
    symbol: 'flame.fill',
    title: 'Je reeks loopt af',
    body: `Zondag om ${hour(NOTIFICATION_RULES.streakHour)}, als je die week nog niets ingeworpen hebt.`,
  },
  {
    symbol: 'checklist',
    title: 'Je quests van vandaag',
    body: `Om ${hour(NOTIFICATION_RULES.defaultQuestHour)} als er nog open staan. Het uur kies je zelf.`,
  },
  { symbol: 'shippingbox.fill', title: 'Je dagkist staat klaar', body: 'Als je ze nog niet opende.' },
];

export const PROMPT_FOOTER =
  `Hooguit één melding per dag, nooit tussen ${hour(NOTIFICATION_RULES.quietFrom)} en ` +
  `${hour(NOTIFICATION_RULES.quietUntil)}. Elke soort zet je uit in Instellingen.`;

let onClose: (() => void) | null = null;

/** What the presenter does when the explanation closes (the next moment may come). */
export function setPromptOnClose(callback: (() => void) | null): void {
  onClose = callback;
}

export function takePromptOnClose(): (() => void) | null {
  const callback = onClose;
  onClose = null;
  return callback;
}
