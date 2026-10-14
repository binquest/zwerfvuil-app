import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { createDiagnostics, describeMeasurements, type RevealMeasurements } from '../diagnostics';

afterEach(() => {
  jest.useRealTimers();
});

const BASE: RevealMeasurements = {
  sound: 'on',
  mixMs: 24,
  mixCached: false,
  loadMs: 61,
  startMs: 38,
  frameMedianMs: 35,
  frameMaxMs: 52,
  hapticMaxMs: 9,
  clockErrorMs: 6,
  corrections: 0,
  timerLateMs: 17,
  commitLagMs: 4,
  jsStallMs: 17,
};

describe('createDiagnostics', () => {
  it('keeps the worst case of every measurement and the median of the frame probe', () => {
    let clock = 0;
    const d = createDiagnostics(() => clock);
    d.sound('on', { mixMs: 23.6, mixCached: false, loadMs: 60.8, startMs: 38.2 });
    d.late(3);
    d.late(12.6);
    d.haptic(8);
    d.haptic(2);
    d.clockError(-7.4, 0);
    d.clockError(3, 1);
    d.clockError(null, 1);
    [34, 36, 35, 90, 33].forEach((ms) => d.frame(ms));
    d.expect(11);
    clock = 40;
    d.committed(11);
    d.committed(99); // never expected: ignored
    expect(d.stop()).toEqual({
      sound: 'on',
      mixMs: 24,
      mixCached: false,
      loadMs: 61,
      startMs: 38,
      frameMedianMs: 35,
      frameMaxMs: 90,
      hapticMaxMs: 8,
      clockErrorMs: 7,
      corrections: 1,
      timerLateMs: 13,
      commitLagMs: 40,
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
});

describe('describeMeasurements', () => {
  it('shows audio, UI thread and sync on three lines', () => {
    expect(describeMeasurements(BASE).split('\n')).toEqual([
      'Geluid aan · mix 24 ms · laden 61 ms · start 38 ms',
      'UI-thread: blokkade ≤ 17 ms (rondreis 35–52 ms) · haptiek ≤ 9 ms',
      'Beeld↔geluid ≤ 23 ms (klok 6, timer 17; 0 correcties) · commit ≤ 4 ms · JS ≤ 17 ms',
    ]);
  });

  it('says when the mix came from the cache, or when there was no sound', () => {
    expect(describeMeasurements({ ...BASE, mixCached: true })).toContain('mix uit cache');
    const silent = describeMeasurements({ ...BASE, sound: 'off', mixMs: null, frameMedianMs: null, frameMaxMs: null });
    expect(silent.split('\n')[0]).toBe('Geluid uit');
    expect(silent).toContain('UI-thread: geen meting');
  });
});
