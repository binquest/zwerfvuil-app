import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { createAudioClock, waitForStart } from '../clock';

afterEach(() => {
  jest.useRealTimers();
});

describe('createAudioClock', () => {
  it('runs on performance time from the anchor, without reading the position', () => {
    let t = 1000;
    const read = jest.fn(() => 0);
    const clock = createAudioClock(900, read, () => t);
    expect(clock.now()).toBe(100);
    t = 1250;
    expect(clock.now()).toBe(350);
    expect(read).not.toHaveBeenCalled();
  });

  it('leaves a small difference alone and corrects a large one', () => {
    let t = 1000;
    let position = 98;
    const clock = createAudioClock(900, () => position, () => t, 12);
    expect(clock.check()).toBe(2);
    expect(clock.now()).toBe(100);
    t = 1500;
    position = 560; // the audio is 40 ms behind the clock
    expect(clock.check()).toBe(40);
    expect(clock.now()).toBe(560);
    expect(clock.corrections()).toBe(1);
  });

  it('provisionally runs from play() and holds at the first sound until anchored', () => {
    let t = 1000;
    const clock = createAudioClock(1000, () => 0, () => t, 12, 250);
    t = 1100;
    expect(clock.now()).toBe(100); // the silent start already runs
    t = 1400;
    expect(clock.now()).toBe(250); // but stops short of the first sound
    expect(clock.check()).toBeNull(); // nothing to correct while holding
    clock.anchorAt(1160); // the audio really started 160 ms after play()
    expect(clock.now()).toBe(240);
    t = 1500;
    expect(clock.now()).toBe(340);
  });

  it('runs on when playback never starts', () => {
    let t = 1000;
    const clock = createAudioClock(1000, () => 0, () => t, 12, 250);
    t = 1600;
    expect(clock.now()).toBe(250);
    clock.release();
    expect(clock.now()).toBe(600);
  });

  it('cannot check without a position', () => {
    const clock = createAudioClock(0, () => null, () => 10);
    expect(clock.check()).toBeNull();
    expect(clock.now()).toBe(10);
  });
});

describe('waitForStart', () => {
  it('anchors on the moment the position is past 0', async () => {
    jest.useFakeTimers();
    let t = 100;
    let position = 0;
    const result = waitForStart(() => position, 100, 500, () => t);
    t = 130;
    jest.advanceTimersByTime(4);
    t = 160;
    position = 12; // playing for 12 ms when seen
    jest.advanceTimersByTime(4);
    await expect(result).resolves.toEqual({ anchor: 148, started: true, latencyMs: 48 });
  });

  it('gives up after the timeout and anchors on the play() call', async () => {
    jest.useFakeTimers();
    let t = 100;
    const result = waitForStart(() => 0, 100, 50, () => t);
    t = 160;
    jest.advanceTimersByTime(4);
    await expect(result).resolves.toEqual({ anchor: 100, started: false, latencyMs: 60 });
  });
});
