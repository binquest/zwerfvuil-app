import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { runTimeline } from '../run';
import type { Event } from '../timeline';

const count = (atMs: number, value: number): Event => ({ atMs, type: 'count', value });

let lag = 0;
const now = () => Date.now() + lag;

beforeEach(() => {
  jest.useFakeTimers();
  lag = 0;
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('runTimeline', () => {
  it('runs events at their time and events with the same time in one call', () => {
    const calls: number[][] = [];
    runTimeline([count(0, 1), count(100, 2), count(100, 3), count(250, 4)], (batch) => calls.push(batch.map((e) => (e.type === 'count' ? e.value : -1))), now);
    expect(calls).toEqual([[1]]);
    jest.advanceTimersByTime(99);
    expect(calls).toEqual([[1]]);
    jest.advanceTimersByTime(1);
    expect(calls).toEqual([[1], [2, 3]]);
    jest.advanceTimersByTime(150);
    expect(calls).toEqual([[1], [2, 3], [4]]);
  });

  it('measures every delay from the start, so a late timer does not shift what follows', () => {
    const seen: number[] = [];
    const start = Date.now();
    runTimeline([count(100, 1), count(200, 2), count(300, 3)], () => seen.push(now() - start), now);
    lag = 60; // the JS thread falls behind by 60 ms
    jest.advanceTimersByTime(300);
    expect(seen).toEqual([160, 200, 300]);
  });

  it('catches up in order when the thread was blocked past several events', () => {
    const seen: number[] = [];
    runTimeline([count(100, 1), count(200, 2), count(300, 3)], (batch) => batch.forEach((e) => e.type === 'count' && seen.push(e.value)), now);
    lag = 250;
    jest.advanceTimersByTime(100);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('stops on cancel', () => {
    const seen: number[] = [];
    const run = runTimeline([count(0, 1), count(100, 2)], (batch) => batch.forEach((e) => e.type === 'count' && seen.push(e.value)), now);
    run.cancel();
    jest.advanceTimersByTime(500);
    expect(seen).toEqual([1]);
  });

  it('keeps going when one event fails', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: number[] = [];
    runTimeline(
      [count(0, 1), count(50, 2)],
      (batch) => {
        const value = batch[0].type === 'count' ? batch[0].value : 0;
        if (value === 1) throw new Error('boom');
        seen.push(value);
      },
      now,
    );
    jest.advanceTimersByTime(50);
    expect(seen).toEqual([2]);
    expect(console.warn).toHaveBeenCalled();
  });
});
