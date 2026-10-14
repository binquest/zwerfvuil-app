// Dev mode only: measures the reveal on the phone, shown under the preview.
//   mix       mixing, encoding and writing the soundtrack (0 when reused)
//   load      the soundtrack file loading in its player
//   start     from play() until playback had really started
//   UI-thread round trip of a one-frame native animation, every 100 ms: the
//             median is the normal cost, the max minus the median a stall
//   haptic    a haptic's round trip; haptics run on the main thread too
//   sync      how far the visuals' clock was from the audio, plus how late
//             the runner fired an event after its planned time
//   commit    from an event setting the number to React committing it
//   JS        the longest stall of the JS thread (a 50 ms probe)

const PROBE_MS = 50;

export type SoundState = 'on' | 'off' | 'not ready' | 'did not start';

export interface RevealMeasurements {
  sound: SoundState;
  mixMs: number | null;
  mixCached: boolean;
  loadMs: number | null;
  startMs: number | null;
  frameMedianMs: number | null;
  frameMaxMs: number | null;
  hapticMaxMs: number;
  clockErrorMs: number;
  corrections: number;
  timerLateMs: number;
  commitLagMs: number;
  jsStallMs: number;
}

export interface RevealDiagnostics {
  sound(state: SoundState, timings?: { mixMs: number; mixCached: boolean; loadMs: number; startMs: number }): void;
  start(): void;
  late(ms: number): void;
  /** Clock minus audio at a check. */
  clockError(ms: number | null, corrections: number): void;
  /** The number was set to `value`; committed() reports when React shows it. */
  expect(value: number): void;
  committed(value: number): void;
  frame(ms: number): void;
  haptic(ms: number): void;
  stop(): RevealMeasurements;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function createDiagnostics(now: () => number = () => performance.now()): RevealDiagnostics {
  const m: RevealMeasurements = {
    sound: 'off',
    mixMs: null,
    mixCached: false,
    loadMs: null,
    startMs: null,
    frameMedianMs: null,
    frameMaxMs: null,
    hapticMaxMs: 0,
    clockErrorMs: 0,
    corrections: 0,
    timerLateMs: 0,
    commitLagMs: 0,
    jsStallMs: 0,
  };
  const frames: number[] = [];
  const pending = new Map<number, number>();
  let probe: ReturnType<typeof setInterval> | null = null;
  let lastTick = 0;
  return {
    sound(state, timings) {
      m.sound = state;
      if (timings) {
        m.mixMs = Math.round(timings.mixMs);
        m.mixCached = timings.mixCached;
        m.loadMs = Math.round(timings.loadMs);
        m.startMs = Math.round(timings.startMs);
      }
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
    clockError(ms, corrections) {
      if (ms !== null) m.clockErrorMs = Math.max(m.clockErrorMs, Math.round(Math.abs(ms)));
      m.corrections = corrections;
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
    frame(ms) {
      frames.push(ms);
    },
    haptic(ms) {
      m.hapticMaxMs = Math.max(m.hapticMaxMs, Math.round(ms));
    },
    stop() {
      if (probe) clearInterval(probe);
      probe = null;
      const mid = median(frames);
      return {
        ...m,
        frameMedianMs: mid === null ? null : Math.round(mid),
        frameMaxMs: frames.length ? Math.round(Math.max(...frames)) : null,
      };
    },
  };
}

const SOUND_TEXT: Record<SoundState, string> = {
  on: 'aan',
  off: 'uit',
  'not ready': 'niet op tijd klaar',
  'did not start': 'startte niet',
};

/** Three lines for the screen, in Dutch. */
export function describeMeasurements(m: RevealMeasurements): string {
  const audio =
    m.mixMs === null
      ? `Geluid ${SOUND_TEXT[m.sound]}`
      : `Geluid ${SOUND_TEXT[m.sound]} · mix ${m.mixCached ? 'uit cache' : `${m.mixMs} ms`} · laden ${m.loadMs} ms · start ${m.startMs} ms`;
  const stall = m.frameMedianMs === null || m.frameMaxMs === null ? null : m.frameMaxMs - m.frameMedianMs;
  const ui =
    m.frameMedianMs === null
      ? `UI-thread: geen meting · haptiek ≤ ${m.hapticMaxMs} ms`
      : `UI-thread: blokkade ≤ ${stall} ms (rondreis ${m.frameMedianMs}–${m.frameMaxMs} ms) · haptiek ≤ ${m.hapticMaxMs} ms`;
  const sync = `Beeld↔geluid ≤ ${m.clockErrorMs + m.timerLateMs} ms (klok ${m.clockErrorMs}, timer ${m.timerLateMs}; ${m.corrections} correcties) · commit ≤ ${m.commitLagMs} ms · JS ≤ ${m.jsStallMs} ms`;
  return `${audio}\n${ui}\n${sync}`;
}
