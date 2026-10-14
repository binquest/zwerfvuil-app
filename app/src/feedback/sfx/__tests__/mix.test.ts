import { describe, expect, it } from '@jest/globals';

import { buildRevealTimeline, type Event } from '../../reveal/timeline';
import { LOOP_FADE_MS, LOOP_RAMP_MS, MIX_CEILING, mixKey, mixTimeline } from '../mix';
import { decodeWav, encodeWav } from '../wav';

const RATE = 1000; // one sample per millisecond keeps the offsets readable
const sound = (atMs: number, id: Extract<Event, { type: 'sound' }>['id'], volume = 1, loop = false): Event => ({
  atMs,
  type: 'sound',
  id,
  volume,
  loop,
});

describe('mixTimeline', () => {
  it('places every one-shot at its exact sample, scaled by its volume', () => {
    const click = Float32Array.from([0.5, 0.25]);
    const out = mixTimeline([sound(0, 'tick_0', 1), sound(5, 'tick_1', 0.5)], { tick_0: click, tick_1: click }, RATE);
    expect(Array.from(out)).toEqual([0.5, 0.25, 0, 0, 0, 0.25, 0.125]);
  });

  it('adds overlapping sounds together', () => {
    const one = Float32Array.from([0.2, 0.2, 0.2]);
    const out = mixTimeline([sound(0, 'mult_1'), sound(1, 'transient')], { mult_1: one, transient: one }, RATE);
    expect(Array.from(out).map((v) => Math.round(v * 100) / 100)).toEqual([0.2, 0.4, 0.4, 0.2]);
  });

  it('ignores haptics, visuals and sounds without a source', () => {
    const one = Float32Array.from([0.1]);
    const out = mixTimeline(
      [sound(0, 'tick_0'), { atMs: 0, type: 'haptic', kind: 'light' }, { atMs: 3, type: 'count', value: 1 }, sound(9, 'riser')],
      { tick_0: one },
      RATE,
    );
    expect(out).toHaveLength(1);
  });

  it('scales the whole mix down when it would clip', () => {
    const loud = Float32Array.from([0.9]);
    const out = mixTimeline([sound(0, 'tick_0'), sound(0, 'tick_1')], { tick_0: loud, tick_1: loud }, RATE);
    expect(out[0]).toBeCloseTo(MIX_CEILING, 5);
  });

  it('tiles a loop, ramps to every new level and fades out at its stop', () => {
    const loop = new Float32Array(10).fill(1);
    const events: Event[] = [
      sound(0, 'heat_loop', 0.2, true),
      sound(100, 'heat_loop', 0.4, true),
      { atMs: 200, type: 'soundStop', id: 'heat_loop' },
    ];
    const out = mixTimeline(events, { heat_loop: loop }, RATE);
    expect(out).toHaveLength(200 + LOOP_FADE_MS);
    expect(out[0]).toBe(0); // from silence, no click
    expect(out[LOOP_RAMP_MS]).toBeCloseTo(0.2, 5);
    expect(out[50]).toBeCloseTo(0.2, 5);
    expect(out[100 + LOOP_RAMP_MS / 2]).toBeCloseTo(0.3, 5);
    expect(out[150]).toBeCloseTo(0.4, 5);
    expect(out[200 + LOOP_FADE_MS / 2]).toBeCloseTo(0.2, 5);
    expect(out.at(-1)).toBeLessThan(0.01);
  });

  it('mixes a whole reveal: as long as its last sound or the fade of the heat loop', () => {
    const events = buildRevealTimeline({ basePoints: 10, streakWeeks: 8, reduceMotion: false });
    const sources = Object.fromEntries(
      events.filter((e): e is Extract<Event, { type: 'sound' }> => e.type === 'sound').map((e) => [e.id, new Float32Array(50).fill(0.1)]),
    );
    const out = mixTimeline(events, sources, RATE);
    const lastSound = Math.max(...events.filter((e) => e.type === 'sound' && !e.loop).map((e) => e.atMs));
    const loopStop = events.find((e) => e.type === 'soundStop')!.atMs;
    expect(out.length).toBe(Math.max(lastSound + 50, loopStop + LOOP_FADE_MS));
    expect(out.every((v) => Number.isFinite(v) && Math.abs(v) <= MIX_CEILING + 1e-6)).toBe(true);
  });
});

describe('mixKey', () => {
  it('is the same for the same sounds and differs when a sound changes', () => {
    const a = buildRevealTimeline({ basePoints: 10, streakWeeks: 3, reduceMotion: false });
    const b = buildRevealTimeline({ basePoints: 10, streakWeeks: 3, reduceMotion: false, bonus: true });
    const c = buildRevealTimeline({ basePoints: 10, streakWeeks: 4, reduceMotion: false });
    const d = buildRevealTimeline({ basePoints: 10, streakWeeks: 3, reduceMotion: true });
    expect(mixKey(a)).toBe(mixKey(b)); // the question changes no sound
    expect(mixKey(a)).not.toBe(mixKey(c));
    expect(mixKey(a)).not.toBe(mixKey(d));
  });
});

describe('WAV', () => {
  it('round-trips samples through a 16-bit file', () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 0.25, -1, 0.999]);
    const back = decodeWav(encodeWav(samples, 44100));
    expect(back).toHaveLength(samples.length);
    back.forEach((v, i) => expect(Math.abs(v - samples[i])).toBeLessThan(1 / 16000));
  });

  it('writes a valid header', () => {
    const bytes = encodeWav(new Float32Array(3), 44100);
    const text = (o: number) => String.fromCharCode(...bytes.slice(o, o + 4));
    const view = new DataView(bytes.buffer);
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint32(40, true)).toBe(6);
    expect(bytes.length).toBe(50);
  });

  it('refuses what it cannot read', () => {
    expect(() => decodeWav(new Uint8Array(20))).toThrow('not a WAV file');
  });
});
