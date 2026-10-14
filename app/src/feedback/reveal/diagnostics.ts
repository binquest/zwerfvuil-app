// Dev mode only: measures where the reveal loses time, shown under the preview.
// Each number is the worst case during the reveal, in milliseconds:
//   ready   until the sounds were loaded and primed (or the wait gave up)
//   timers  how late the runner ran an event after its planned time
//   commit  from an event setting the number to React committing it
//   haptic  from a haptic call to its promise resolving: haptics run on the
//           main (UI) thread, so this shows a blocked UI thread
//   js      the longest stall of the JS thread (a 50 ms probe)

const PROBE_MS = 50;

export interface RevealMeasurements {
  readyMs: number | null;
  sound: 'on' | 'off' | 'not ready';
  timerLateMs: number;
  commitLagMs: number;
  hapticLagMs: number;
  jsStallMs: number;
}

export interface RevealDiagnostics {
  ready(ms: number, sound: RevealMeasurements['sound']): void;
  start(): void;
  late(ms: number): void;
  /** The number was set to `value`; committed() reports when React shows it. */
  expect(value: number): void;
  committed(value: number): void;
  haptic(ms: number): void;
  stop(): RevealMeasurements;
}

export function createDiagnostics(now: () => number = () => performance.now()): RevealDiagnostics {
  const m: RevealMeasurements = { readyMs: null, sound: 'off', timerLateMs: 0, commitLagMs: 0, hapticLagMs: 0, jsStallMs: 0 };
  const pending = new Map<number, number>();
  let probe: ReturnType<typeof setInterval> | null = null;
  let lastTick = 0;
  return {
    ready(ms, sound) {
      m.readyMs = Math.round(ms);
      m.sound = sound;
    },
    start() {
      lastTick = now();
      probe = setInterval(() => {
        const t = now();
        m.jsStallMs = Math.max(m.jsStallMs, Math.round(t - lastTick - PROBE_MS));
        lastTick = t;
      }, PROBE_MS);
    },
    late(ms) {
      m.timerLateMs = Math.max(m.timerLateMs, Math.round(ms));
    },
    expect(value) {
      if (!pending.has(value)) pending.set(value, now());
    },
    committed(value) {
      const since = pending.get(value);
      if (since === undefined) return;
      pending.delete(value);
      m.commitLagMs = Math.max(m.commitLagMs, Math.round(now() - since));
    },
    haptic(ms) {
      m.hapticLagMs = Math.max(m.hapticLagMs, Math.round(ms));
    },
    stop() {
      if (probe) clearInterval(probe);
      probe = null;
      return { ...m };
    },
  };
}

/** One line for the screen, in Dutch. */
export function describeMeasurements(m: RevealMeasurements): string {
  const sound = m.sound === 'on' ? 'aan' : m.sound === 'off' ? 'uit' : 'niet op tijd klaar';
  const ready = m.readyMs === null ? '' : ` (klaar na ${m.readyMs} ms)`;
  return `Geluid ${sound}${ready} · timers ≤ ${m.timerLateMs} ms te laat · commit ≤ ${m.commitLagMs} ms · haptiek ≤ ${m.hapticLagMs} ms · JS-stilstand ≤ ${m.jsStallMs} ms`;
}
