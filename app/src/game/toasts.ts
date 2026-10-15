// Which toast shows where (pure, unit tested). Toasts are a queue in
// ToastProvider; every surface that can be on top (the tabs, each modal
// screen) has its own viewport, and only the top one shows the toast: a native
// modal covers anything rendered below it. A viewport that holds (the reveal,
// the celebrations) shows nothing and keeps the queue waiting.

export interface Toast {
  id: number;
  title: string;
  message?: string;
  /** An SF Symbol. */
  systemImage?: string;
}

export interface Viewport {
  id: number;
  hold: boolean;
}

/** How long a toast stays. */
export const TOAST_MS = 2600;

/** The viewport that shows toasts now: the one registered last, unless it holds. */
export function activeViewport(viewports: readonly Viewport[]): number | null {
  const top = viewports.at(-1);
  return top && !top.hold ? top.id : null;
}
