import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { buildStressTimeline, describeStressResult, runSoundStressTest, STRESS_CHORDS } from '../stress';

const mockPlay = jest.fn();
let mockOnStarted: ((start: unknown) => void) | undefined;
const mockCancel = jest.fn();

jest.mock('../../sfx/engine', () => ({ play: (...args: unknown[]) => mockPlay(...args) }));
jest.mock('../../sfx/soundtrack', () => ({ revealSoundtrack: {} }));
jest.mock('../playback', () => ({
  playTimeline: (_events: unknown, _track: unknown, _onEvents: unknown, hooks: { onStarted?: (start: unknown) => void }) => {
    mockOnStarted = hooks.onStarted;
    return { cancel: mockCancel };
  },
}));

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('buildStressTimeline', () => {
  it('is 20 ticks, 40 ms apart, through all five pitches', () => {
    const events = buildStressTimeline();
    expect(events).toHaveLength(20);
    expect(events.map((e) => e.atMs)).toEqual(Array.from({ length: 20 }, (_, i) => i * 40));
    expect(events.slice(0, 6).map((e) => (e.type === 'sound' ? e.id : ''))).toEqual(['tick_0', 'tick_1', 'tick_2', 'tick_3', 'tick_4', 'tick_0']);
  });
});

describe('runSoundStressTest', () => {
  it('plays the mixed ticks, then six chords through the pool, then reports', () => {
    const onDone = jest.fn();
    runSoundStressTest(onDone);
    mockOnStarted?.({ sound: 'on', timings: { mixMs: 30, mixCached: false, loadMs: 5, startMs: 120 } });
    jest.advanceTimersByTime(20 * 40 + 400 - 1);
    expect(mockPlay).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1 + 5 * 120);
    expect(mockPlay).toHaveBeenCalledTimes(STRESS_CHORDS);
    expect(mockPlay).toHaveBeenCalledWith('total_chord', expect.any(Number));
    jest.advanceTimersByTime(120 + 1200);
    expect(onDone).toHaveBeenCalledWith({ sound: 'on', mixMs: 30, mixCached: false, startMs: 120, chords: 6 });
  });

  it('stops when cancelled', () => {
    const onDone = jest.fn();
    const stop = runSoundStressTest(onDone);
    mockOnStarted?.({ sound: 'on', timings: { mixMs: 0, mixCached: true, loadMs: 1, startMs: 100 } });
    stop();
    jest.advanceTimersByTime(5000);
    expect(mockPlay).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalledWith(30);
  });
});

describe('describeStressResult', () => {
  it('describes a run, and a run without sound', () => {
    expect(describeStressResult({ sound: 'on', mixMs: 31.4, mixCached: false, startMs: 118.6, chords: 6 })).toBe(
      '20 ticks om de 40 ms gemixt (mix 31 ms, start 119 ms), daarna 6 akkoorden om de 120 ms via de pool.',
    );
    expect(describeStressResult({ sound: 'on', mixCached: true, startMs: 100, chords: 6 })).toContain('mix uit cache');
    expect(describeStressResult({ sound: 'not ready', chords: 6 })).toBe('Geen geluid (niet op tijd klaar).');
  });
});
