// What this device remembers about notifications: the settings (they are
// local, like the notifications), what the planner scheduled and how the last
// ones were answered, whether we asked for permission, and the last tap we
// handled. localStorage (expo-sqlite) may throw or be empty: then the defaults
// apply, never an error.
import { parseRecord, parseSettings, type NotificationRecord, type NotificationSettings } from './planner';

const SETTINGS_KEY = 'notifications.settings';
const RECORD_KEY = 'notifications.record';
const ASKED_KEY = 'notifications.asked';
const HANDLED_KEY = 'notifications.handled';

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
    // Not remembered: the defaults apply next time.
  }
}

function readJson(key: string): unknown {
  const stored = read(key);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

export function loadSettings(): NotificationSettings {
  return parseSettings(readJson(SETTINGS_KEY));
}

export function saveSettings(settings: NotificationSettings): void {
  write(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadRecord(): NotificationRecord {
  return parseRecord(readJson(RECORD_KEY));
}

export function saveRecord(record: NotificationRecord | null): void {
  write(RECORD_KEY, record ? JSON.stringify(record) : null);
}

/** Our own explanation was shown on this device (we ask once). */
export function permissionAsked(): boolean {
  return read(ASKED_KEY) !== null;
}

export function markPermissionAsked(): void {
  write(ASKED_KEY, new Date().toISOString());
}

export function resetPermissionAsked(): void {
  write(ASKED_KEY, null);
}

/** The tap handled last (a cold start must not open it twice). */
export function lastHandledTap(): string | null {
  return read(HANDLED_KEY);
}

export function markTapHandled(id: string): void {
  write(HANDLED_KEY, id);
}
