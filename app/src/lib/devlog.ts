// Development-only logging to the Metro console. Never log tokens or keys.

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? ` (cause: ${cause.name}: ${cause.message})` : '';
    return `${error.name}: ${error.message}${causeText}`;
  }
  return String(error);
}

export function devLog(tag: string, ok: boolean, entry: Record<string, unknown>): void {
  if (!__DEV__) return;
  const line = `[${tag}] ${JSON.stringify(entry)}`;
  if (ok) console.log(line);
  else console.warn(line);
}
