import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { Event } from '../../reveal/timeline';
import { prepareSoundtrack, Soundtrack } from '../soundtrack';
import { encodeWav } from '../wav';

const mockFiles = new Map<string, Uint8Array>();
const mockPlayers: { replace: jest.Mock; play: jest.Mock; pause: jest.Mock; seekTo: jest.Mock; isLoaded: boolean; currentTime: number; volume: number }[] = [];

jest.mock('expo-asset', () => ({
  Asset: { fromModule: () => ({ localUri: 'file:///asset.wav', uri: 'file:///asset.wav', downloadAsync: () => Promise.resolve() }) },
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
});

describe('prepareSoundtrack', () => {
  it('mixes into a cache file once and reuses it for the same timeline', async () => {
    const first = await prepareSoundtrack(events);
    expect(first.cached).toBe(false);
    expect(first.uri).toMatch(/^file:\/\/\/cache\/reveal-[0-9a-z]+\.wav$/);
    expect(mockFiles.get(first.uri)?.length).toBe(encodeWav(new Float32Array(Math.round(0.01 * 44100) + 2)).length);
    const again = await prepareSoundtrack(events);
    expect(again).toMatchObject({ uri: first.uri, cached: true, mixMs: 0 });
    expect(again.durationMs).toBeCloseTo(first.durationMs, 3);
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
