// Mixes the sound events of a timeline into one buffer: every one-shot at its
// exact sample, loops tiled with smooth volume changes and a fade at their
// stop. Pure, so the offsets and levels are unit tested. Playing one mixed
// file instead of two dozen separate players keeps expo-audio (AVPlayer) off
// the main thread during the reveal, and the rhythm no longer depends on when
// a JS timer happens to fire.
import type { Event } from '../reveal/timeline';
import type { SfxId } from './sources';
import { SAMPLE_RATE } from './wav';

/** A loop changes volume over this long, so a new level does not click. */
export const LOOP_RAMP_MS = 20;
/** A loop fades out over this long at its stop. */
export const LOOP_FADE_MS = 120;
/** The mix is scaled down when it would peak above this. */
export const MIX_CEILING = 0.98;

type Sources = Partial<Record<SfxId, Float32Array>>;

interface LoopPlan {
  start: number;
  stop: number | null;
  levels: { at: number; volume: number }[];
}

/** The sound events of `events` as one buffer of samples. Sounds without a source are left out. */
export function mixTimeline(events: readonly Event[], sources: Sources, sampleRate = SAMPLE_RATE): Float32Array {
  const toSample = (ms: number) => Math.round((ms / 1000) * sampleRate);
  const oneShots: { at: number; source: Float32Array; volume: number }[] = [];
  const loops = new Map<SfxId, LoopPlan>();
  let length = 0;

  for (const event of events) {
    if (event.type === 'sound') {
      const source = sources[event.id];
      if (!source) continue;
      const at = toSample(event.atMs);
      if (event.loop) {
        const plan = loops.get(event.id);
        if (plan && plan.stop === null) plan.levels.push({ at, volume: event.volume });
        else loops.set(event.id, { start: at, stop: null, levels: [{ at, volume: event.volume }] });
      } else {
        oneShots.push({ at, source, volume: event.volume });
        length = Math.max(length, at + source.length);
      }
    } else if (event.type === 'soundStop') {
      const plan = loops.get(event.id);
      if (plan && plan.stop === null) {
        plan.stop = toSample(event.atMs);
        length = Math.max(length, plan.stop + toSample(LOOP_FADE_MS));
      }
    }
  }

  const out = new Float32Array(length);
  for (const { at, source, volume } of oneShots) {
    for (let i = 0; i < source.length; i++) out[at + i] += source[i] * volume;
  }

  const ramp = Math.max(1, toSample(LOOP_RAMP_MS));
  const fade = Math.max(1, toSample(LOOP_FADE_MS));
  for (const [id, plan] of loops) {
    const source = sources[id]!;
    const end = plan.stop === null ? length : Math.min(length, plan.stop + fade);
    // Every level is reached in LOOP_RAMP_MS, the first one from silence: no clicks.
    let from = 0;
    let target = plan.levels[0].volume;
    let rampStart = plan.start;
    let next = 1;
    const gainAt = (i: number) => from + (target - from) * Math.min(1, (i - rampStart) / ramp);
    for (let i = plan.start; i < end; i++) {
      while (next < plan.levels.length && plan.levels[next].at <= i) {
        from = gainAt(i);
        target = plan.levels[next++].volume;
        rampStart = i;
      }
      const fadeOut = plan.stop !== null && i >= plan.stop ? 1 - (i - plan.stop) / fade : 1;
      out[i] += source[(i - plan.start) % source.length] * gainAt(i) * fadeOut;
    }
  }

  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > MIX_CEILING) {
    const scale = MIX_CEILING / peak;
    for (let i = 0; i < out.length; i++) out[i] *= scale;
  }
  return out;
}

/** A short, stable key for the sound events of a timeline: the same reveal reuses its mixed file. */
export function mixKey(events: readonly Event[]): string {
  let hash = 5381;
  for (const event of events) {
    if (event.type !== 'sound' && event.type !== 'soundStop') continue;
    const text = event.type === 'sound' ? `${event.atMs}|${event.id}|${event.volume.toFixed(4)}|${event.loop ? 1 : 0};` : `${event.atMs}|stop|${event.id};`;
    for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}
