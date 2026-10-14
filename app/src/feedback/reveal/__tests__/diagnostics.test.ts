import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { createDiagnostics, describeMeasurements } from '../diagnostics';

afterEach(() => {
  jest.useRealTimers();
});

describe('createDiagnostics', () => {
  it('keeps the worst case of every measurement', () => {
    let clock = 0;
    const d = createDiagnostics(() => clock);
    d.ready(412.4, 'on', 15320.2);
    d.late(3);
    d.late(12.6);
    d.late(5);
    d.haptic(8);
    d.haptic(2);
    d.expect(11);
    clock = 40;
    d.committed(11);
    d.expect(12);
    clock = 45;
    d.committed(12);
    d.committed(99); // never expected: ignored
    expect(d.stop()).toEqual({
      readyMs: 412,
      poolAgeMs: 15320,
      sound: 'on',
      timerLateMs: 13,
      commitLagMs: 40,
      hapticLagMs: 8,
      jsStallMs: 0,
    });
  });

  it('measures how long the JS thread stalls', () => {
    jest.useFakeTimers();
    let clock = 0;
    const d = createDiagnostics(() => clock);
    d.start();
    clock = 50;
    jest.advanceTimersByTime(50);
    clock = 400; // the next tick comes 300 ms late
    jest.advanceTimersByTime(50);
    expect(d.stop().jsStallMs).toBe(300);
  });

  it('describes the measurements in one line', () => {
    expect(
      describeMeasurements({ readyMs: 2, poolAgeMs: 15320, sound: 'on', timerLateMs: 4, commitLagMs: 9, hapticLagMs: 30, jsStallMs: 12 }),
    ).toBe('Geluid aan (klaar na 2 ms) · pool 15,3 s oud · timers ≤ 4 ms te laat · commit ≤ 9 ms · haptiek ≤ 30 ms · JS-stilstand ≤ 12 ms');
    expect(
      describeMeasurements({ readyMs: 800, poolAgeMs: null, sound: 'not ready', timerLateMs: 0, commitLagMs: 0, hapticLagMs: 0, jsStallMs: 0 }),
    ).toContain('Geluid niet op tijd klaar (klaar na 800 ms) · timers');
  });
});
