// The audio clock: the reveal's visuals and haptics follow the mixed soundtrack.
//
// Reading the player's position is a native call, so it is not polled every
// frame. When playback starts, its position is read until it is past 0; that
// gives an anchor (the performance.now() moment the soundtrack was at 0), and
// from then on the clock is performance.now() minus the anchor. Every so often
// check() compares it with the real position and moves the anchor when the two
// are more than a threshold apart.

/** The clock is corrected when it is this far from the audio. */
export const DRIFT_THRESHOLD_MS = 12;
/** How often the reveal checks the clock against the audio. */
export const DRIFT_CHECK_MS = 500;
/** How often the position is read while waiting for playback to start. */
const START_POLL_MS = 4;

export interface AudioClock {
  /** Milliseconds since the soundtrack was at 0. */
  now(): number;
  /** Compares with the real position; corrects when needed. Returns clock minus audio, or null when unknown. */
  check(): number | null;
  /** How often check() moved the anchor. */
  corrections(): number;
}

export function createAudioClock(
  anchor: number,
  readPositionMs: () => number | null,
  now: () => number = () => performance.now(),
  thresholdMs = DRIFT_THRESHOLD_MS,
): AudioClock {
  let corrections = 0;
  return {
    now: () => now() - anchor,
    check() {
      const position = readPositionMs();
      if (position === null) return null;
      const error = now() - anchor - position;
      if (Math.abs(error) > thresholdMs) {
        anchor += error;
        corrections++;
      }
      return error;
    },
    corrections: () => corrections,
  };
}

export interface StartResult {
  /** performance.now() at soundtrack position 0. */
  anchor: number;
  /** False when the position never moved within the timeout: the anchor is then the play() call. */
  started: boolean;
  /** From play() to the moment it was seen playing. */
  latencyMs: number;
}

/** Waits until the position is past 0 (at most `timeoutMs`) and returns the anchor. */
export function waitForStart(
  readPositionMs: () => number | null,
  playedAt: number,
  timeoutMs: number,
  now: () => number = () => performance.now(),
): Promise<StartResult> {
  return new Promise((resolve) => {
    const poll = () => {
      const t = now();
      const position = readPositionMs();
      if (position !== null && position > 0) {
        resolve({ anchor: t - position, started: true, latencyMs: t - position - playedAt });
        return;
      }
      if (t - playedAt >= timeoutMs) {
        resolve({ anchor: playedAt, started: false, latencyMs: t - playedAt });
        return;
      }
      setTimeout(poll, START_POLL_MS);
    };
    poll();
  });
}
