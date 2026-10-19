// A celebration on its own screen (docs/GAMIFICATION.md, chapter 4 step 11 and
// chapter 5): a milestone right after the reveal ("10 vuilbakken ontdekt",
// confetti, "+50 · wacht op goedkeuring"), or the moments missed since the
// last visit (from the MomentsPresenter). Its sound is a mixed soundtrack on
// the third player (celebrationSoundtrack), like the reveal. With Reduce
// Motion: no confetti, the reward fades in. Closing marks the moments seen on
// the server (not in the Dev mode preview).
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { holdAnalytics, track } from '@/analytics';
import { ChunkyButton, Confetti, GameNumber, PendingTag } from '@/components/game';
import { playFeedback } from '@/feedback/reveal/feedback';
import { playTimeline, type Playback } from '@/feedback/reveal/playback';
import type { Event } from '@/feedback/reveal/timeline';
import { stopAll } from '@/feedback/sfx/engine';
import { celebrationSoundtrack, warmUpSounds } from '@/feedback/sfx/soundtrack';
import { buildCelebrationTimeline, takePendingCelebration, type CelebrationData } from '@/game/celebration';
import { counterLabel, milestoneTitle, summarizeMoments } from '@/game/discoveries';
import { markMomentsSeen } from '@/lib/api';
import { useReduceMotion, useScreenReader } from '@/lib/useAccessibility';
import { useGame } from '@/providers/GameProvider';
import { ToastViewport } from '@/providers/ToastProvider';
import { numberStyle, playColors, spacing, type } from '@/theme';

/** At most this many bin numbers in the list of missed discoveries. */
const MAX_BINS_LISTED = 12;

/** What VoiceOver says: the milestone and its reward, or the discoveries. */
function summary(data: CelebrationData): string {
  if (data.kind === 'milestone') {
    const { threshold, points, status } = data.milestone;
    return `${milestoneTitle(threshold)}. ${points} punten${status === 'pending' ? ', wacht op goedkeuring' : ''}.`;
  }
  const { milestone, discoveries } = summarizeMoments(data.moments);
  const parts: string[] = [];
  if (milestone) parts.push(`${milestoneTitle(milestone.threshold)}. ${milestone.points} punten.`);
  if (discoveries.length > 0) parts.push(`${discoveries.length} nieuwe ${discoveries.length === 1 ? 'vuilbak' : 'vuilbakken'} ontdekt.`);
  return parts.join(' ');
}

export default function CelebrateScreen() {
  const [data] = useState<CelebrationData | null>(() => takePendingCelebration());
  const systemReduceMotion = useReduceMotion();
  const screenReader = useScreenReader();
  const reduceMotion = (data?.forceReduceMotion ?? false) || systemReduceMotion;
  const { refresh } = useGame();
  const [burst, setBurst] = useState(0);
  const [pieces, setPieces] = useState(0);
  const playback = useRef<Playback | null>(null);
  const closed = useRef(false);
  const reward = useSharedValue(0);
  const rewardPop = useSharedValue(0);

  const moments = useMemo(() => (data?.kind === 'missed' ? summarizeMoments(data.moments) : null), [data]);
  const milestone = data?.kind === 'milestone' ? data.milestone : (moments?.milestone ?? null);

  // No analytics I/O while celebrating (see src/analytics/queue.ts).
  useEffect(() => holdAnalytics(), []);

  // Nothing to show (e.g. after a reload): back.
  useEffect(() => {
    if (!data) router.back();
  }, [data]);

  // Play once, as soon as Reduce Motion and VoiceOver are known.
  const started = useRef(false);
  useEffect(() => {
    if (!data || reduceMotion === null || screenReader === null || started.current) return;
    started.current = true;
    const isTest = data.preview;
    if (milestone) track('milestone_shown', { threshold: milestone.threshold, status: milestone.status, source: data.kind === 'milestone' ? 'reveal' : 'missed' }, { isTest });
    for (const discovery of moments?.discoveries ?? []) {
      track('discovery_shown', { ordinal: discovery.ordinal, status: discovery.status, source: 'missed' }, { isTest });
    }

    const showReward = () => {
      reward.set(withTiming(1, { duration: 240, easing: Easing.out(Easing.quad), reduceMotion: ReduceMotion.Never }));
      rewardPop.set(withSpring(1, { damping: 12, stiffness: 220, reduceMotion: data.forceReduceMotion ? ReduceMotion.Always : ReduceMotion.System }));
    };
    if (screenReader) {
      showReward();
      AccessibilityInfo.announceForAccessibilityWithOptions(summary(data), { queue: true });
      return;
    }
    const events = buildCelebrationTimeline({ milestone: !!milestone, reduceMotion });
    if (!data.noSound) warmUpSounds(events);
    playback.current = playTimeline(events, data.noSound ? null : celebrationSoundtrack, (batch: Event[]) => {
      for (const event of batch) {
        if (playFeedback(event)) continue;
        if (event.type === 'confetti') {
          setPieces(event.pieces);
          setBurst((b) => b + 1);
        } else if (event.type === 'reward') {
          showReward();
        }
      }
    });
  }, [data, milestone, moments, reduceMotion, screenReader, reward, rewardPop]);

  useEffect(
    () => () => {
      playback.current?.cancel(30);
      stopAll(30);
    },
    [],
  );

  const rewardStyle = useAnimatedStyle(() => ({ opacity: reward.get(), transform: [{ scale: 0.7 + 0.3 * rewardPop.get() }] }));

  const close = () => {
    if (!data || closed.current) return;
    closed.current = true;
    playback.current?.cancel(60);
    if (!data.preview && data.asOf) markMomentsSeen(data.asOf).catch(() => {});
    data.onClose?.();
    refresh();
    router.back();
  };

  if (!data) return <View style={{ flex: 1, backgroundColor: playColors.backdrop }} />;

  const label = data.preview ? 'VOORBEELD · DEV-MODUS' : milestone ? 'MIJLPAAL' : 'TERWIJL JE WEG WAS';
  const discoveries = moments?.discoveries ?? [];

  return (
    <View style={{ flex: 1, experimental_backgroundImage: playColors.background }} accessible={false} onAccessibilityEscape={close}>
      <SafeAreaView style={{ flex: 1, padding: spacing.xl, gap: spacing.lg }}>
        <Text style={[type.footnote, { color: 'rgba(255,255,255,0.7)', fontWeight: '700', letterSpacing: 1.5, textAlign: 'center' }]}>
          {label}
        </Text>

        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg }}>
          {milestone ? (
            <>
              <GameNumber value={milestone.threshold} style={{ color: 'white', fontSize: 120, lineHeight: 132, ...numberStyle }} />
              <Text style={[type.title2, { color: 'white', fontWeight: '800', textAlign: 'center' }]}>{milestoneTitle(milestone.threshold)}</Text>
              {data.kind === 'milestone' && data.discovered !== null && data.totalBins !== null ? (
                <Text style={[type.subheadline, { color: 'rgba(255,255,255,0.75)' }]}>{counterLabel(data.discovered, data.totalBins)}</Text>
              ) : null}
              <Animated.View
                style={[
                  { alignItems: 'center', gap: spacing.sm, backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 20, borderCurve: 'continuous', padding: spacing.lg },
                  rewardStyle,
                ]}>
                <Text style={{ color: playColors.gold, fontSize: 44, ...numberStyle }}>{`+${milestone.points}`}</Text>
                {milestone.status === 'pending' ? (
                  <PendingTag style={{ alignSelf: 'center' }} />
                ) : (
                  <Text style={[type.footnote, { color: 'rgba(255,255,255,0.8)', fontWeight: '600' }]}>toegekend</Text>
                )}
              </Animated.View>
            </>
          ) : null}

          {discoveries.length > 0 ? (
            <Animated.View style={[{ alignItems: 'center', gap: spacing.sm }, milestone ? null : rewardStyle]}>
              <Text style={[milestone ? type.headline : type.title2, { color: 'white', fontWeight: '800', textAlign: 'center' }]}>
                {`${discoveries.length} nieuwe ${discoveries.length === 1 ? 'vuilbak' : 'vuilbakken'} ontdekt`}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.xs }}>
                {discoveries.slice(-MAX_BINS_LISTED).map((d) => (
                  <View key={d.binId} style={{ backgroundColor: playColors.chips, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 }}>
                    <Text style={{ color: 'white', fontWeight: '800', fontFamily: 'ui-rounded' }}>{`#${d.binId}`}</Text>
                  </View>
                ))}
              </View>
              {discoveries.some((d) => d.status === 'pending') ? <PendingTag style={{ alignSelf: 'center' }} /> : null}
            </Animated.View>
          ) : null}
        </View>

        <ChunkyButton title="Verder" onPress={close} />
      </SafeAreaView>
      <Confetti pieces={pieces} burst={burst} />
      {/* No general toasts during a celebration: they wait until it closes. */}
      <ToastViewport hold />
    </View>
  );
}
