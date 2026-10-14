import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { Soundtrack } from '../../sfx/soundtrack';
import { playTimeline } from '../playback';
import type { Event } from '../timeline';

const mockWarmUp = jest.fn(() => Promise.resolve(true));
const mockPrepare = jest.fn(() => Promise.resolve({ uri: 'file:///mix.wav', durationMs: 3000, mixMs: 12, cached: false }));

jest.mock('../../sfx/soundtrack', () => ({
  warmUpSounds: () => mockWarmUp(),
  prepareSoundtrack: () => mockPrepare(),
}));
jest.mock('../../sfx/engine', () => ({ READY_TIMEOUT_MS: 800 }));

const events: Event[] = [
  { atMs: 0, type: 'sound', id: 'tick_0', volume: 1 },
  { atMs: 20, type: 'count', value: 1 },
  { atMs: 1000, type: 'count', value: 2 },
];

let audioNow = 0;

function fakeSoundtrack(started = true) {
  const track = {
    load: jest.fn(() => Promise.resolve(40)),
    start: jest.fn(() =>
      Promise.resolve({
        clock: { now: () => audioNow, check: jest.fn(() => 3), corrections: () => 0 },
        start: { anchor: 0, started, latencyMs: 30 },
      }),
    ),
    stop: jest.fn(),
  };
  return track as unknown as Soundtrack & typeof track;
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  jest.useFakeTimers();
  audioNow = 0;
  mockWarmUp.mockImplementation(() => Promise.resolve(true));
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('playTimeline', () => {
  it('starts the soundtrack and runs the visuals on its clock', async () => {
    const track = fakeSoundtrack();
    const seen: number[] = [];
    const onStarted = jest.fn();
    playTimeline(events, track, (batch) => batch.forEach((e) => e.type === 'count' && seen.push(e.value)), { onStarted });
    await flush();
    expect(track.load).toHaveBeenCalledWith('file:///mix.wav');
    expect(onStarted).toHaveBeenCalledWith({ sound: 'on', timings: { mixMs: 12, mixCached: false, loadMs: 40, startMs: 30 } });
    expect(seen).toEqual([]);
    audioNow = 25; // the audio, not performance.now(), decides
    jest.advanceTimersByTime(20);
    expect(seen).toEqual([1]);
    audioNow = 1000;
    jest.advanceTimersByTime(975);
    expect(seen).toEqual([1, 2]);
  });

  it('checks the clock against the audio every 500 ms', async () => {
    const track = fakeSoundtrack();
    const onClockCheck = jest.fn();
    playTimeline(events, track, () => {}, { onClockCheck });
    await flush();
    jest.advanceTimersByTime(1000);
    expect(onClockCheck).toHaveBeenCalledTimes(2);
    expect(onClockCheck).toHaveBeenCalledWith(3, 0);
  });

  it('runs without sound when the sounds are not ready in time', async () => {
    mockWarmUp.mockImplementation(() => new Promise(() => {}));
    const track = fakeSoundtrack();
    const onStarted = jest.fn();
    playTimeline(events, track, () => {}, { onStarted });
    jest.advanceTimersByTime(800);
    await flush();
    expect(onStarted).toHaveBeenCalledWith({ sound: 'not ready' });
    expect(track.start).not.toHaveBeenCalled();
  });

  it('runs without sound when there is no soundtrack (Dev mode)', () => {
    const onStarted = jest.fn();
    const seen: number[] = [];
    playTimeline(events, null, (batch) => batch.forEach((e) => e.type === 'count' && seen.push(e.value)), { onStarted });
    expect(onStarted).toHaveBeenCalledWith({ sound: 'off' });
    jest.advanceTimersByTime(1000);
    expect(seen).toEqual([1, 2]);
  });

  it('reports a soundtrack that never started playing', async () => {
    const onStarted = jest.fn();
    playTimeline(events, fakeSoundtrack(false), () => {}, { onStarted });
    await flush();
    expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ sound: 'did not start' }));
  });

  it('stops the visuals and fades the soundtrack on cancel', async () => {
    const track = fakeSoundtrack();
    const seen: number[] = [];
    const playback = playTimeline(events, track, (batch) => batch.forEach((e) => e.type === 'count' && seen.push(e.value)));
    await flush();
    playback.cancel(30);
    audioNow = 2000;
    jest.advanceTimersByTime(2000);
    expect(seen).toEqual([]);
    expect(track.stop).toHaveBeenCalledWith(30);
  });
});
