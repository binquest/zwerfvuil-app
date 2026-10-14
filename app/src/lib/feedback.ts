// Sounds and haptics of the points reveal.
//
// Sounds use the ambient audio session (playsInSilentMode: false): they follow
// the ring/silent switch and mix with the user's music. Haptics follow the
// system setting. Both are iOS-first; elsewhere they quietly do nothing.
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';

import { MAX_STAGES } from './points';

const SOURCES = {
  tick: require('../../assets/sounds/tick.wav'),
  total: require('../../assets/sounds/total.wav'),
  bonus: require('../../assets/sounds/bonus.wav'),
  'stage-1': require('../../assets/sounds/stage-1.wav'),
  'stage-2': require('../../assets/sounds/stage-2.wav'),
  'stage-3': require('../../assets/sounds/stage-3.wav'),
  'stage-4': require('../../assets/sounds/stage-4.wav'),
  'stage-5': require('../../assets/sounds/stage-5.wav'),
  'stage-6': require('../../assets/sounds/stage-6.wav'),
  'stage-7': require('../../assets/sounds/stage-7.wav'),
  'stage-8': require('../../assets/sounds/stage-8.wav'),
} as const;

type SoundName = keyof typeof SOURCES;

const IOS = process.env.EXPO_OS === 'ios';

/** Preloaded players; ticks get a small pool so fast counting does not cut itself off. */
export class SoundBoard {
  private pools = new Map<SoundName, AudioPlayer[]>();
  private turn = new Map<SoundName, number>();
  private disposed = false;

  async load(): Promise<void> {
    try {
      await setAudioModeAsync({
        playsInSilentMode: false,
        interruptionMode: 'mixWithOthers',
        shouldPlayInBackground: false,
        allowsRecording: false,
      });
    } catch {
      // Sounds are a bonus; the reveal works without them.
    }
    if (this.disposed) return;
    for (const name of Object.keys(SOURCES) as SoundName[]) {
      const size = name === 'tick' ? 4 : 1;
      this.pools.set(
        name,
        Array.from({ length: size }, () => {
          const player = createAudioPlayer(SOURCES[name]);
          player.volume = name === 'tick' ? 0.5 : 0.8;
          return player;
        }),
      );
    }
  }

  play(name: SoundName): void {
    const pool = this.pools.get(name);
    if (!pool?.length) return;
    const index = (this.turn.get(name) ?? 0) % pool.length;
    this.turn.set(name, index + 1);
    const player = pool[index];
    // seekTo is asynchronous on iOS: play once the player is back at the start.
    player
      .seekTo(0)
      .then(() => player.play())
      .catch(() => {});
  }

  /** Streak stage k (1-based), each a whole tone higher. */
  stage(k: number): void {
    this.play(`stage-${Math.min(Math.max(1, k), MAX_STAGES)}` as SoundName);
  }

  stopAll(): void {
    for (const pool of this.pools.values()) for (const player of pool) player.pause();
  }

  dispose(): void {
    this.disposed = true;
    for (const pool of this.pools.values()) for (const player of pool) player.remove();
    this.pools.clear();
  }
}

function ignore(promise: Promise<void>): void {
  promise.catch(() => {});
}

export const haptic = {
  tick(): void {
    if (IOS) ignore(Haptics.selectionAsync());
  },
  /** Stronger with every streak stage. */
  stage(k: number): void {
    if (!IOS) return;
    const style =
      k <= 2
        ? Haptics.ImpactFeedbackStyle.Light
        : k <= 4
          ? Haptics.ImpactFeedbackStyle.Medium
          : k <= 6
            ? Haptics.ImpactFeedbackStyle.Heavy
            : Haptics.ImpactFeedbackStyle.Rigid;
    ignore(Haptics.impactAsync(style));
  },
  success(): void {
    if (IOS) ignore(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
  },
  warning(): void {
    if (IOS) ignore(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
  },
};
