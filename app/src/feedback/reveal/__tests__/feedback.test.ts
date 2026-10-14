import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Haptics from 'expo-haptics';

import * as engine from '../../sfx/engine';
import { playFeedback } from '../feedback';

jest.mock('../../sfx/engine', () => ({ play: jest.fn(), loop: jest.fn(), stopLoop: jest.fn() }));
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(() => Promise.resolve()),
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy', Rigid: 'rigid' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('playFeedback', () => {
  it('plays sounds, loops and stops', () => {
    expect(playFeedback({ atMs: 0, type: 'sound', id: 'tick_0', volume: 0.5 }, true)).toBe(true);
    expect(engine.play).toHaveBeenCalledWith('tick_0', 0.5);
    playFeedback({ atMs: 0, type: 'sound', id: 'heat_loop', volume: 0.1, loop: true }, true);
    expect(engine.loop).toHaveBeenCalledWith('heat_loop', 0.1);
    playFeedback({ atMs: 0, type: 'soundStop', id: 'heat_loop' }, true);
    expect(engine.stopLoop).toHaveBeenCalledWith('heat_loop');
  });

  it('keeps the haptics but drops the sounds when the sounds were not ready', () => {
    playFeedback({ atMs: 0, type: 'sound', id: 'tick_0', volume: 0.5 }, false);
    playFeedback({ atMs: 0, type: 'haptic', kind: 'selection' }, false);
    expect(engine.play).not.toHaveBeenCalled();
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });

  it('maps every haptic kind', () => {
    playFeedback({ atMs: 0, type: 'haptic', kind: 'light' }, true);
    playFeedback({ atMs: 0, type: 'haptic', kind: 'rigid' }, true);
    playFeedback({ atMs: 0, type: 'haptic', kind: 'success' }, true);
    expect(Haptics.impactAsync).toHaveBeenNthCalledWith(1, 'light');
    expect(Haptics.impactAsync).toHaveBeenNthCalledWith(2, 'rigid');
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
  });

  it('leaves visual events to the screen', () => {
    expect(playFeedback({ atMs: 0, type: 'count', value: 3 }, true)).toBe(false);
    expect(engine.play).not.toHaveBeenCalled();
  });

  it('does not throw when a haptic fails', () => {
    jest.mocked(Haptics.impactAsync).mockImplementationOnce(() => {
      throw new Error('no engine');
    });
    expect(() => playFeedback({ atMs: 0, type: 'haptic', kind: 'heavy' }, true)).not.toThrow();
  });
});
