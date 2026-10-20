// The daily chest, full screen (docs/GAMIFICATION.md, chapter 4 and 5): the
// chest in the middle; a tap shakes it in three waves with knocks and a glow
// while open_daily_chest draws on the server; it pops open and the reward card
// comes in, in its rarity colour, the number rolling, "wacht op goedkeuring"
// while the quests of that day wait. "Kansen" shows the weights of
// chest_rewards. Everything is mounted when the screen opens and invisible
// until its event (no native view appears while it plays). With Reduce Motion
// nothing shakes and things fade; with VoiceOver it opens at once and says
// what was in it. Dev mode opens it with a chosen reward and draws nothing.
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, Text, View } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { holdAnalytics, track } from '@/analytics';
import { Avatar, ChunkyButton, Confetti, GameNumber, PendingTag } from '@/components/game';
import { playFeedback } from '@/feedback/reveal/feedback';
import { playTimeline, type Playback } from '@/feedback/reveal/playback';
import type { Event } from '@/feedback/reveal/timeline';
import { stopAll } from '@/feedback/sfx/engine';
import { celebrationSoundtrack, warmUpSounds } from '@/feedback/sfx/soundtrack';
import {
  buildChestOpenTimeline,
  buildChestShakeTimeline,
  CHEST_SHAKE_MS,
  chestSummary,
  isRareFind,
  rewardCaption,
  rewardRarity,
  takeChestOnClose,
  takePendingChestPreview,
  type ChestPreview,
} from '@/game/chest';
import { chestChances, daysBetween, dayLabel, rewardTitle, type ChestReward } from '@/game/today';
import { markChestAnnounced } from '@/game/todayMemory';
import { useGameCatalog } from '@/game/useGameCatalog';
import { openDailyChest } from '@/lib/api';
import { useReduceMotion, useScreenReader } from '@/lib/useAccessibility';
import { useGame } from '@/providers/GameProvider';
import { ToastViewport } from '@/providers/ToastProvider';
import { numberStyle, playColors, playType, spacing, type } from '@/theme';
import { rarityColors, resolveColor } from '@/theme/game';

type Phase = 'idle' | 'shaking' | 'open' | 'error';

const CHEST_SIZE = 150;

export default function ChestScreen() {
  const params = useLocalSearchParams<{ day?: string }>();
  const [preview] = useState<ChestPreview | null>(() => takePendingChestPreview());
  // The presenter's done (a chest shown at start); called however the screen closes.
  const [onClose] = useState(() => takeChestOnClose());
  const { state, refresh } = useGame();
  const catalog = useGameCatalog();
  const systemReduceMotion = useReduceMotion();
  const screenReader = useScreenReader();
  const reduceMotion = (preview?.forceReduceMotion ?? false) || !!systemReduceMotion;
  const noSound = preview?.noSound ?? false;

  const today = state?.today?.date ?? new Date().toISOString().slice(0, 10);
  const day = typeof params.day === 'string' ? params.day : today;
  const [phase, setPhase] = useState<Phase>('idle');
  const [reward, setReward] = useState<ChestReward | null>(null);
  const [shownAmount, setShownAmount] = useState(0);
  const [showChances, setShowChances] = useState(false);
  const [burst, setBurst] = useState(0);
  const [pieces, setPieces] = useState(0);
  const playbacks = useRef<Playback[]>([]);
  const result = useRef<Promise<{ reward: ChestReward; alreadyOpened: boolean } | null> | null>(null);
  const mounted = useRef(true);

  const shakeX = useSharedValue(0);
  const tilt = useSharedValue(0);
  const glow = useSharedValue(0);
  const chestOut = useSharedValue(0);
  const flash = useSharedValue(0);
  const rewardIn = useSharedValue(0);

  const avatarName = useCallback((key: string) => catalog?.avatars.find((a) => a.key === key)?.name ?? null, [catalog]);
  const rarity = reward ? rewardRarity(reward, catalog?.avatars ?? []) : 'common';
  const rewardColor = resolveColor(rarityColors[rarity], 'dark');
  const chances = useMemo(() => chestChances(catalog?.chestRewards ?? [], avatarName), [catalog, avatarName]);

  // No analytics I/O while it plays; this chest counts as announced (MomentsPresenter).
  useEffect(() => holdAnalytics(), []);
  useEffect(() => {
    if (!preview) markChestAnnounced(day);
  }, [preview, day]);
  useEffect(() => {
    if (!noSound) warmUpSounds(buildChestShakeTimeline({ reduceMotion }));
    if (!noSound) warmUpSounds(buildChestOpenTimeline({ reduceMotion, confetti: false }));
  }, [noSound, reduceMotion]);
  useEffect(
    () => () => {
      mounted.current = false;
      for (const playback of playbacks.current) playback.cancel(30);
      stopAll(30);
      onClose?.();
    },
    [onClose],
  );

  const onEvents = (batch: Event[]) => {
    for (const event of batch) {
      if (playFeedback(event)) continue;
      if (event.type === 'shake') {
        const deg = event.rotationDeg;
        const third = event.ms / 3;
        tilt.set(withSequence(withTiming(deg, { duration: third / 2 }), withTiming(-deg, { duration: third }), withTiming(deg / 2, { duration: third }), withTiming(0, { duration: third / 2 })));
        shakeX.set(withSequence(withTiming(event.px, { duration: third / 2 }), withTiming(-event.px, { duration: third }), withTiming(0, { duration: third })));
      } else if (event.type === 'part') {
        glow.set(withTiming((event.index + 1) / 3, { duration: 200, reduceMotion: ReduceMotion.Never }));
      } else if (event.type === 'flash') {
        flash.set(withSequence(withTiming(event.opacity, { duration: 60 }), withTiming(0, { duration: 260 })));
      } else if (event.type === 'confetti') {
        setPieces(event.pieces);
        setBurst((b) => b + 1);
      } else if (event.type === 'reward') {
        showReward();
      }
    }
  };

  const showReward = () => {
    chestOut.set(withTiming(1, { duration: 220, easing: Easing.out(Easing.quad), reduceMotion: ReduceMotion.Never }));
    rewardIn.set(withSpring(1, { damping: 12, stiffness: 220, reduceMotion: reduceMotion ? ReduceMotion.Always : ReduceMotion.System }));
  };

  const reveal = (found: ChestReward, alreadyOpened: boolean, animate: boolean) => {
    setReward(found);
    setPhase('open');
    if (!alreadyOpened) {
      track('chest_opened', { reward_kind: found.kind, amount: found.amount, days_ago: Math.max(0, daysBetween(day, today)) }, { isTest: !!preview });
    }
    const title = rewardTitle(found, avatarName);
    if (!animate) {
      chestOut.set(1);
      rewardIn.set(1);
      setShownAmount(found.amount ?? 0);
      AccessibilityInfo.announceForAccessibilityWithOptions(chestSummary(found, title), { queue: true });
      return;
    }
    setShownAmount(0);
    const events = buildChestOpenTimeline({ reduceMotion, confetti: isRareFind(rewardRarity(found, catalog?.avatars ?? [])) });
    playbacks.current.push(
      playTimeline(events, noSound ? null : celebrationSoundtrack, (batch) => {
        onEvents(batch);
        if (batch.some((e) => e.type === 'reward')) setShownAmount(found.amount ?? 0);
      }),
    );
    if (!preview) refresh();
  };

  const open = async () => {
    if (phase !== 'idle') return;
    result.current = preview
      ? Promise.resolve({ reward: preview.reward, alreadyOpened: false })
      : openDailyChest(day).then(
          (opened) => ({ reward: opened.reward, alreadyOpened: opened.alreadyOpened }),
          () => null,
        );
    if (screenReader) {
      const found = await result.current;
      if (!mounted.current) return;
      if (found) reveal(found.reward, found.alreadyOpened, false);
      else setPhase('error');
      return;
    }
    setPhase('shaking');
    playbacks.current.push(playTimeline(buildChestShakeTimeline({ reduceMotion }), noSound ? null : celebrationSoundtrack, onEvents));
    const [found] = await Promise.all([result.current, new Promise((resolve) => setTimeout(resolve, CHEST_SHAKE_MS))]);
    if (!mounted.current) return;
    if (!found) {
      glow.set(withTiming(0, { duration: 200 }));
      setPhase('error');
      return;
    }
    reveal(found.reward, found.alreadyOpened, true);
  };

  const close = () => {
    if (!preview) refresh();
    router.back();
  };

  const chestStyle = useAnimatedStyle(() => ({
    opacity: 1 - chestOut.get(),
    transform: [{ translateX: shakeX.get() }, { rotate: `${tilt.get()}deg` }, { scale: 1 + chestOut.get() * (reduceMotion ? 0.05 : 0.4) }],
  }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.get() * 0.8 * (1 - chestOut.get()), transform: [{ scale: 0.8 + glow.get() * 0.5 }] }));
  const flashStyle = useAnimatedStyle(() => ({ opacity: flash.get() }));
  const rewardStyle = useAnimatedStyle(() => ({
    opacity: rewardIn.get(),
    transform: [{ scale: (reduceMotion ? 0.95 : 0.6) + (reduceMotion ? 0.05 : 0.4) * rewardIn.get() }],
  }));

  const heading = preview ? 'VOORBEELD · DEV-MODUS' : `DAGKIST · ${dayLabel(day, today).toUpperCase()}`;
  const title = reward ? rewardTitle(reward, avatarName) : '';

  return (
    <View style={{ flex: 1, experimental_backgroundImage: playColors.background }}>
      <SafeAreaView style={{ flex: 1, padding: spacing.xl, gap: spacing.lg }}>
        <Text style={[type.footnote, { color: playColors.label, fontWeight: '700', letterSpacing: 1.5, textAlign: 'center' }]}>{heading}</Text>

        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          {/* The glow behind the chest grows with every wave. */}
          <Animated.View
            pointerEvents="none"
            style={[{ position: 'absolute', width: CHEST_SIZE * 1.8, height: CHEST_SIZE * 1.8, borderRadius: CHEST_SIZE, backgroundColor: playColors.gold }, glowStyle]}
          />
          <Pressable
            onPress={open}
            disabled={phase !== 'idle'}
            accessibilityRole="button"
            accessibilityLabel="Open je kist"
            accessibilityState={{ disabled: phase !== 'idle' }}>
            <Animated.View style={chestStyle}>
              <SymbolView name="shippingbox.fill" size={CHEST_SIZE} tintColor={playColors.gold} />
            </Animated.View>
          </Pressable>

          {/* The reward card, mounted from the start and invisible until the chest opens. */}
          <Animated.View
            pointerEvents={phase === 'open' ? 'auto' : 'none'}
            accessibilityElementsHidden={phase !== 'open'}
            importantForAccessibility={phase === 'open' ? 'auto' : 'no-hide-descendants'}
            style={[
              {
                position: 'absolute',
                alignItems: 'center',
                gap: spacing.sm,
                minWidth: 220,
                padding: spacing.xl,
                borderRadius: 28,
                borderCurve: 'continuous',
                borderWidth: 3,
                borderColor: rewardColor,
                backgroundColor: 'rgba(0,0,0,0.45)',
              },
              rewardStyle,
            ]}>
            {reward?.kind === 'avatar' && reward.avatarKey ? (
              <Avatar avatarKey={reward.avatarKey} size={110} decorative />
            ) : reward?.kind === 'freeze' ? (
              <SymbolView name="snowflake" size={84} tintColor={rewardColor} />
            ) : (
              <GameNumber value={shownAmount} prefix="+" durationMs={600} style={{ color: rewardColor, fontSize: 88, lineHeight: 96, ...numberStyle }} />
            )}
            <Text style={[type.title2, { color: playColors.text, fontWeight: '800', textAlign: 'center' }]}>
              {reward?.kind === 'points' ? 'punten' : title}
            </Text>
            {reward && reward.kind !== 'points' ? (
              <Text style={[type.footnote, { color: playColors.label, textAlign: 'center' }]}>{rewardCaption(reward)}</Text>
            ) : null}
            {reward?.status === 'pending' ? <PendingTag style={{ alignSelf: 'center' }} /> : null}
          </Animated.View>
        </View>

        <View style={{ gap: spacing.md, minHeight: 120, justifyContent: 'flex-end' }}>
          {phase === 'idle' ? (
            <Text style={[type.headline, { color: playColors.text, textAlign: 'center' }]}>Tik op je kist om ze te openen</Text>
          ) : null}
          {phase === 'error' ? (
            <Text style={[type.subheadline, { color: playColors.text, textAlign: 'center' }]}>
              De kist ging niet open. Controleer je verbinding en probeer het later opnieuw.
            </Text>
          ) : null}
          {showChances && phase !== 'open' ? (
            <View style={{ gap: 4, padding: spacing.md, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.08)' }}>
              <Text style={[playType.label, { color: playColors.label }]}>Kansen</Text>
              {chances.map((chance) => (
                <View key={chance.key} style={{ flexDirection: 'row' }}>
                  <Text style={[type.footnote, { color: playColors.text, flex: 1 }]}>{chance.label}</Text>
                  <Text style={[type.footnote, { color: playColors.text, fontVariant: ['tabular-nums'] }]}>{chance.percent}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {phase === 'open' || phase === 'error' ? (
            <ChunkyButton title="Verder" onPress={close} />
          ) : (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Pressable onPress={close} accessibilityRole="button" hitSlop={10} disabled={phase !== 'idle'}>
                <Text style={[type.headline, { color: playColors.label, opacity: phase === 'idle' ? 1 : 0.4 }]}>Later</Text>
              </Pressable>
              {chances.length > 0 ? (
                <Pressable onPress={() => setShowChances((s) => !s)} accessibilityRole="button" hitSlop={10}>
                  <Text style={[type.headline, { color: playColors.label }]}>{showChances ? 'Verberg kansen' : 'Kansen'}</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </View>
      </SafeAreaView>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: playColors.flash }, flashStyle]} />
      <Confetti pieces={pieces} burst={burst} />
      {/* No general toasts on the chest: they wait until it closes. */}
      <ToastViewport hold />
    </View>
  );
}
