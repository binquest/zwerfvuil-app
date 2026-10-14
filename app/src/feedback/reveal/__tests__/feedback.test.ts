import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Haptics from 'expo-haptics';

import { playFeedback } from '../feedback';

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
  it('maps every haptic kind', () => {
    expect(playFeedback({ atMs: 0, type: 'haptic', kind: 'selection' })).toBe(true);
    playFeedback({ atMs: 0, type: 'haptic', kind: 'light' });
    playFeedback({ atMs: 0, type: 'haptic', kind: 'rigid' });
    playFeedback({ atMs: 0, type: 'haptic', kind: 'success' });
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenNthCalledWith(1, 'light');
    expect(Haptics.impactAsync).toHaveBeenNthCalledWith(2, 'rigid');
    expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
  });

  it('takes sound events as handled: they are in the mixed soundtrack', () => {
    expect(playFeedback({ atMs: 0, type: 'sound', id: 'tick_0', volume: 0.5 })).toBe(true);
    expect(playFeedback({ atMs: 0, type: 'soundStop', id: 'heat_loop' })).toBe(true);
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
  });

  it('leaves visual events to the screen', () => {
    expect(playFeedback({ atMs: 0, type: 'count', value: 3 })).toBe(false);
  });

  it('does not throw when a haptic fails', () => {
    jest.mocked(Haptics.impactAsync).mockImplementationOnce(() => {
      throw new Error('no engine');
    });
    expect(() => playFeedback({ atMs: 0, type: 'haptic', kind: 'heavy' })).not.toThrow();
  });
});
