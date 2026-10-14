import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Audio from 'expo-audio';

import { initSfx, loop, play, releaseSfx, stopAll, stopLoop } from '../engine';
import { SFX_IDS, SFX_SOURCES, SFX_VOICES, type SfxId } from '../sources';

type Status = { didJustFinish?: boolean };

let mockStartLoaded = true;

class MockPlayer {
  volume = 1;
  loop = false;
  isLoaded = mockStartLoaded;
  duration = 0.2;
  removed = false;
  calls: string[] = [];
  seeks: number[][] = [];
  volumesAtPlay: number[] = [];
  listeners: ((status: Status) => void)[] = [];
  constructor(
    public source: unknown,
    public options: Record<string, unknown>,
  ) {}
  play() {
    this.calls.push('play');
    this.volumesAtPlay.push(this.volume);
  }
  pause() {
    this.calls.push('pause');
  }
  seekTo(...args: number[]) {
    this.calls.push('seek');
    this.seeks.push(args);
    return Promise.resolve();
  }
  remove() {
    this.removed = true;
  }
  addListener(_event: string, listener: (status: Status) => void) {
    this.listeners.push(listener);
    return { remove: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  }
  finish() {
    for (const listener of this.listeners) listener({ didJustFinish: true });
  }
}

const mockPlayers: MockPlayer[] = [];

jest.mock('expo-audio', () => ({
  createAudioPlayer: (source: unknown, options: Record<string, unknown>) => {
    const player = new MockPlayer(source, options);
    mockPlayers.push(player);
    return player;
  },
  setAudioModeAsync: jest.fn(() => Promise.resolve()),
  setIsAudioActiveAsync: jest.fn(() => Promise.resolve()),
}));

let clock = 1000;
// Jest turns every asset into the same stub, so a sound's players are found by
// creation order: the engine creates the voices in SFX_IDS order.
function playersOf(id: SfxId): MockPlayer[] {
  const start = SFX_IDS.slice(0, SFX_IDS.indexOf(id)).reduce((sum, other) => sum + SFX_VOICES[other], 0);
  return mockPlayers.slice(start, start + SFX_VOICES[id]);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ready() {
  expect(await initSfx()).toBe(true);
  for (const player of mockPlayers) {
    player.calls = [];
    player.seeks = [];
    player.volumesAtPlay = [];
  }
}

beforeEach(() => {
  clock = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  releaseSfx();
  mockPlayers.length = 0;
  mockStartLoaded = true;
  jest.restoreAllMocks();
});

describe('initSfx', () => {
  it('sets the silent-switch audio mode once and creates every voice with the session kept active', async () => {
    await initSfx();
    expect(Audio.setAudioModeAsync).toHaveBeenCalledTimes(1);
    expect(Audio.setAudioModeAsync).toHaveBeenCalledWith({
      playsInSilentMode: false,
      interruptionMode: 'mixWithOthers',
      shouldPlayInBackground: false,
      allowsRecording: false,
    });
    const total = SFX_IDS.reduce((sum, id) => sum + SFX_VOICES[id], 0);
    expect(mockPlayers).toHaveLength(total);
    expect(mockPlayers.map((p) => p.source)).toEqual(SFX_IDS.flatMap((id) => Array(SFX_VOICES[id]).fill(SFX_SOURCES[id])));
    expect(mockPlayers.every((p) => p.options.keepAudioSessionActive === true)).toBe(true);
  });

  it('primes every voice silently, puts it back at the start and restores the volume', async () => {
    await initSfx();
    for (const player of mockPlayers) {
      expect(player.calls).toEqual(['play', 'pause', 'seek']);
      expect(player.volumesAtPlay).toEqual([0]);
      expect(player.seeks).toEqual([[0, 0, 0]]);
      expect(player.volume).toBe(1);
    }
  });

  it('is idempotent until released', async () => {
    const first = initSfx();
    expect(initSfx()).toBe(first);
    await first;
    const count = mockPlayers.length;
    await initSfx();
    expect(mockPlayers).toHaveLength(count);
  });

  it('resolves false when a file does not load within the timeout', async () => {
    // Every look at the clock moves it 100 ms on, so READY_TIMEOUT_MS passes quickly.
    jest.spyOn(performance, 'now').mockImplementation(() => (clock += 100));
    mockStartLoaded = false;
    const promise = initSfx();
    mockStartLoaded = true;
    mockPlayers.slice(1).forEach((p) => (p.isLoaded = true));
    expect(await promise).toBe(false);
    // The loaded voices are primed all the same.
    expect(mockPlayers[1].calls).toEqual(['play', 'pause', 'seek']);
    expect(mockPlayers[0].calls).toEqual([]);
  });
});

describe('play', () => {
  it('returns nothing (never a promise) and plays a rewound voice without seeking', async () => {
    await ready();
    const result = play('mult_1');
    expect(result).toBeUndefined();
    expect(playersOf('mult_1')[0].calls).toEqual(['play']);
  });

  it('uses a free voice before stealing one', async () => {
    await ready();
    const [a, b] = playersOf('tick_0');
    play('tick_0');
    clock += 1;
    play('tick_0');
    expect(a.calls).toEqual(['play']);
    expect(b.calls).toEqual(['play']);
  });

  it('restarts the oldest voice when all are busy', async () => {
    await ready();
    const [a, b] = playersOf('tick_0');
    play('tick_0');
    clock += 5;
    play('tick_0');
    clock += 5;
    play('tick_0');
    expect(a.calls).toEqual(['play', 'seek', 'play']);
    expect(a.seeks).toEqual([[0, 0, 0]]);
    expect(b.calls).toEqual(['play']);
  });

  it('frees a voice again after its duration', async () => {
    await ready();
    const [a, b] = playersOf('tick_0');
    play('tick_0');
    clock += 250;
    a.finish();
    await Promise.resolve();
    play('tick_0');
    expect(a.calls).toEqual(['play', 'pause', 'seek', 'play']);
    expect(b.calls).toEqual([]);
  });

  it('lowers the volume by 1/sqrt(k) with k voices sounding, down to 0.5', async () => {
    await ready();
    (['mult_1', 'mult_2', 'mult_3', 'mult_4', 'mult_5'] as SfxId[]).forEach((id) => play(id, 0.8));
    const volumes = (['mult_1', 'mult_2', 'mult_3', 'mult_4', 'mult_5'] as SfxId[]).map((id) => playersOf(id)[0].volumesAtPlay[0]);
    expect(volumes.map((v) => Math.round(v * 1000) / 1000)).toEqual([0.8, 0.566, 0.462, 0.4, 0.4]);
  });
});

describe('rewinding', () => {
  it('pauses and seeks exactly to 0 when a sound finishes', async () => {
    await ready();
    const player = playersOf('mult_2')[0];
    play('mult_2');
    clock += 210;
    player.finish();
    expect(player.calls).toEqual(['play', 'pause', 'seek']);
    expect(player.seeks).toEqual([[0, 0, 0]]);
  });

  it('ignores a late finish event of a play that was restarted since', async () => {
    await ready();
    const player = playersOf('mult_3')[0];
    play('mult_3');
    clock += 300; // free by time, but the finish event has not come in yet
    play('mult_3');
    clock += 5;
    player.finish(); // the late event of the first play
    expect(player.calls).toEqual(['play', 'seek', 'play']);
  });
});

describe('loops and stopping', () => {
  it('starts a loop once and only changes its volume after that', async () => {
    await ready();
    const player = playersOf('heat_loop')[0];
    loop('heat_loop', 0.05);
    loop('heat_loop', 0.1);
    expect(player.loop).toBe(true);
    expect(player.calls).toEqual(['play']);
    expect(player.volume).toBe(0.1);
    stopLoop('heat_loop', 0);
    expect(player.loop).toBe(false);
    expect(player.calls).toEqual(['play', 'pause', 'seek']);
  });

  it('stopAll fades out what sounds, then pauses and rewinds it', async () => {
    await ready();
    const sounding = playersOf('total_chord')[0];
    const silent = playersOf('bonus_land')[0];
    play('total_chord', 1);
    stopAll(30); // the fade itself runs on real timers

    await sleep(80);
    expect(sounding.volume).toBe(0);
    expect(sounding.calls).toEqual(['play', 'pause', 'seek']);
    expect(silent.calls).toEqual([]);
  });
});

describe('releaseSfx', () => {
  it('removes every player and lets the audio session go', async () => {
    await initSfx();
    releaseSfx();
    expect(mockPlayers.every((p) => p.removed)).toBe(true);
    expect(mockPlayers.every((p) => p.listeners.length === 0)).toBe(true);
    expect(Audio.setIsAudioActiveAsync).toHaveBeenCalledWith(false);
    // A sound after release is ignored, not a crash.
    expect(() => play('tick_0')).not.toThrow();
  });
});
