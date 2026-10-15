import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { Event } from '../../reveal/timeline';
import { prepareSoundtrack, samplesReady, Soundtrack, soundIds, soundtrackFileName } from '../soundtrack';
import { encodeWav } from '../wav';

const mockFiles = new Map<string, Uint8Array>();
/** Every read of a sound file; the hash every sound file has; a read that fails. */
const mockReads = { count: 0, failNext: false };
let mockHash = 'hash-a';
const mockPlayers: { replace: jest.Mock; play: jest.Mock; pause: jest.Mock; seekTo: jest.Mock; isLoaded: boolean; currentTime: number; volume: number }[] = [];

jest.mock('expo-asset', () => ({
  Asset: {
    fromModule: () => ({ localUri: 'file:///asset.wav', uri: 'file:///asset.wav', hash: mockHash, downloadAsync: () => Promise.resolve() }),
  },
}));
jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
    }
    get name() {
      return this.uri.split('/').pop() ?? '';
    }
    get exists() {
      return mockFiles.has(this.uri) || this.uri.endsWith('asset.wav');
    }
    get size() {
      return mockFiles.get(this.uri)?.length ?? 0;
    }
    bytes() {
      mockReads.count++;
      if (mockReads.failNext) {
        mockReads.failNext = false;
        return Promise.reject(new Error('unreadable'));
      }
      const { encodeWav: encode } = jest.requireActual<typeof import('../wav')>('../wav');
      return Promise.resolve(encode(Float32Array.from([0.5, 0.25])));
    }
    create() {}
    write(bytes: Uint8Array) {
      mockFiles.set(this.uri, bytes);
    }
    info() {
      return { modificationTime: 0 };
    }
    delete() {
      mockFiles.delete(this.uri);
    }
  }
  return { File: MockFile, Paths: { cache: { uri: 'file:///cache', list: () => [] } } };
});
jest.mock('expo-audio', () => ({
  createAudioPlayer: () => {
    const player = {
      replace: jest.fn(),
      play: jest.fn(),
      pause: jest.fn(),
      seekTo: jest.fn(() => Promise.resolve()),
      isLoaded: true,
      currentTime: 0,
      volume: 1,
    };
    mockPlayers.push(player);
    return player;
  },
  setAudioModeAsync: () => Promise.resolve(),
  setIsAudioActiveAsync: () => Promise.resolve(),
}));

const events: Event[] = [
  { atMs: 0, type: 'sound', id: 'tick_0', volume: 1 },
  { atMs: 10, type: 'sound', id: 'tick_1', volume: 0.5 },
];

beforeEach(() => {
  mockFiles.clear();
  mockPlayers.length = 0;
  mockReads.count = 0;
  mockReads.failNext = false;
  mockHash = 'hash-a';
});

describe('prepareSoundtrack', () => {
  it('mixes into a cache file once and reuses it for the same timeline', async () => {
    const first = await prepareSoundtrack(events);
    expect(first.cached).toBe(false);
    expect(first.uri).toMatch(/^file:\/\/\/cache\/reveal-[0-9a-z]+-[0-9a-z]+\.wav$/);
    expect(mockFiles.get(first.uri)?.length).toBe(encodeWav(new Float32Array(Math.round(0.01 * 44100) + 2)).length);
    const again = await prepareSoundtrack(events);
    expect(again).toMatchObject({ uri: first.uri, cached: true, mixMs: 0 });
    expect(again.durationMs).toBeCloseTo(first.durationMs, 3);
  });

  it('decodes only the sounds the timeline plays, each once', async () => {
    const two: Event[] = [
      { atMs: 0, type: 'sound', id: 'mult_5', volume: 1 },
      { atMs: 5, type: 'haptic', kind: 'light' },
      { atMs: 10, type: 'sound', id: 'mult_6', volume: 1 },
      { atMs: 20, type: 'sound', id: 'mult_5', volume: 0.5 },
    ];
    expect(soundIds(two)).toEqual(['mult_5', 'mult_6']);
    await prepareSoundtrack(two);
    expect(mockReads.count).toBe(2);
    await prepareSoundtrack([...two, { atMs: 30, type: 'sound', id: 'mult_7', volume: 1 }]);
    expect(mockReads.count).toBe(3);
  });

  it('names the mix after the sound files too: new sounds in an update never play an old mix', () => {
    const before = soundtrackFileName(events);
    expect(soundtrackFileName(events)).toBe(before);
    mockHash = 'hash-b';
    expect(soundtrackFileName(events)).not.toBe(before);
    expect(soundtrackFileName(events).split('-')[1]).toBe(before.split('-')[1]);
  });

  it('reads a sound that failed again next time', async () => {
    const one: Event[] = [{ atMs: 0, type: 'sound', id: 'mult_8', volume: 1 }];
    mockReads.failNext = true;
    expect(await samplesReady(one)).toBe(false);
    expect(await samplesReady(one)).toBe(true);
    expect(mockReads.count).toBe(2);
  });
});

describe('Soundtrack', () => {
  it('creates one player, replaces its file for a new soundtrack and only rewinds the same one', async () => {
    const track = new Soundtrack();
    await track.load('file:///a.wav');
    expect(mockPlayers).toHaveLength(1);
    await track.load('file:///b.wav');
    expect(mockPlayers).toHaveLength(1);
    expect(mockPlayers[0].replace).toHaveBeenCalledWith({ uri: 'file:///b.wav' });
    await track.load('file:///b.wav');
    expect(mockPlayers[0].replace).toHaveBeenCalledTimes(1);
    expect(mockPlayers[0].seekTo).toHaveBeenCalledWith(0, 0, 0);
  });

  it('starts with a provisional clock and anchors it once playback has really started', async () => {
    const track = new Soundtrack();
    await track.load('file:///a.wav');
    const { clock, started } = track.start(250);
    expect(mockPlayers[0].play).toHaveBeenCalled();
    expect(clock.now()).toBeLessThanOrEqual(250);
    mockPlayers[0].currentTime = 0.012; // playing for 12 ms when read
    const start = await started;
    expect(start.started).toBe(true);
    expect(clock.now()).toBeGreaterThanOrEqual(12);
  });
});
