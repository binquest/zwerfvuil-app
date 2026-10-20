// A celebration on its own screen (docs/GAMIFICATION.md, chapter 4 step 11 and
// chapter 5): a milestone, quests done, the chest ready or a badge right after
// the reveal ("10 vuilbakken ontdekt", confetti, "+50 · wacht op goedkeuring";
// a ready chest makes the button open it), the moments missed since
// the last visit, or the decisions since then (the approval celebration:
// "Goedgekeurd! +16", the total rolling, a level-up, rejections calmly with
// their reason). The last two come from the MomentsPresenter. Its sound is a
// mixed soundtrack on the third player (celebrationSoundtrack), like the
// reveal. With Reduce Motion: no confetti, things fade in. Closing marks the
// moments or the results seen on the server (not in the Dev mode preview).
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ScrollView, Text, View } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { holdAnalytics, track } from '@/analytics';
import { ApprovalBody, BadgeIcon, ChunkyButton, Confetti, GameNumber, PendingTag } from '@/components/game';
import { playFeedback } from '@/feedback/reveal/feedback';
import { playTimeline, type Playback } from '@/feedback/reveal/playback';
import type { Event } from '@/feedback/reveal/timeline';
import { stopAll } from '@/feedback/sfx/engine';
import { celebrationSoundtrack, warmUpSounds } from '@/feedback/sfx/soundtrack';
import { APPROVAL_COUNT_MS, approvalParts, approvalSummary, buildApprovalTimeline, isLevelUp } from '@/game/approval';
import type { BadgeNews } from '@/game/badges';
import { buildCelebrationTimeline, takePendingCelebration, type CelebrationData } from '@/game/celebration';
import { counterLabel, milestoneTitle, summarizeMoments, type MissedQuest } from '@/game/discoveries';
import { questRewardLabel } from '@/game/today';
import { markChestAnnounced } from '@/game/todayMemory';
import { markMomentsSeen, markResultsSeen } from '@/lib/api';
import { useReduceMotion, useScreenReader } from '@/lib/useAccessibility';
import { useGame } from '@/providers/GameProvider';
import { ToastViewport } from '@/providers/ToastProvider';
import { numberStyle, playColors, playType, spacing, type } from '@/theme';

/** At most this many bin numbers in the list of missed discoveries. */
const MAX_BINS_LISTED = 12;

/** What VoiceOver says: the milestone and its reward, the discoveries, quests, chest and badges, or the decisions. */
function summary(data: CelebrationData): string {
  if (data.kind === 'approval') return approvalSummary(data.results);
  const { milestone, discoveries, badges, quests, chestDay, freezes } =
    data.kind === 'reveal' ? { ...data, discoveries: [] } : summarizeMoments(data.moments);
  const parts: string[] = [];
  if (milestone) {
    parts.push(`${milestoneTitle(milestone.threshold)}. ${milestone.points} punten${milestone.status === 'pending' ? ', wacht op goedkeuring' : ''}.`);
  }
  if (discoveries.length > 0) parts.push(`${discoveries.length} nieuwe ${discoveries.length === 1 ? 'vuilbak' : 'vuilbakken'} ontdekt.`);
  for (const quest of quests) parts.push(`Quest voltooid: ${quest.title}, ${questRewardLabel(quest)}${quest.status === 'pending' ? ', wacht op goedkeuring' : ''}.`);
  if (chestDay) parts.push('Je dagkist staat klaar.');
  if (freezes > 0) parts.push(freezes === 1 ? 'Een bevriezer erbij.' : `${freezes} bevriezers erbij.`);
  for (const badge of badges) parts.push(`Badge ${badge.name}${badge.status === 'pending' ? ', wacht op goedkeuring' : ''}.`);
  return parts.join(' ');
}

/** The quests done (after the reveal or while away), with their rewards in PUNTEN blue. */
function QuestsDone({ quests }: { quests: readonly MissedQuest[] }) {
  return (
    <View style={{ alignItems: 'center', gap: spacing.sm, alignSelf: 'stretch' }}>
      <Text style={[playType.label, { color: playColors.gold }]}>{quests.length === 1 ? 'Quest voltooid' : 'Quests voltooid'}</Text>
      {quests.map((quest) => (
        <View
          key={quest.id}
          style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, alignSelf: 'stretch', backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 16, borderCurve: 'continuous', padding: spacing.md }}>
          <SymbolView name={quest.period === 'week' ? 'calendar.badge.checkmark' : 'checkmark.circle.fill'} size={24} tintColor={playColors.chips} />
          <Text style={[type.body, { color: playColors.text, fontWeight: '600', flex: 1 }]} numberOfLines={2}>
            {quest.title}
          </Text>
          <Text style={{ color: playColors.chips, fontSize: 22, ...numberStyle }}>{questRewardLabel(quest)}</Text>
        </View>
      ))}
      {quests.some((q) => q.status === 'pending') ? <PendingTag style={{ alignSelf: 'center' }} /> : null}
    </View>
  );
}

/** The badges a check-in or the missed moments earned, under the milestone or the discoveries. */
function EarnedBadges({ badges }: { badges: readonly BadgeNews[] }) {
  return (
    <View style={{ alignItems: 'center', gap: spacing.sm }}>
      <Text style={[playType.label, { color: playColors.gold }]}>{badges.length === 1 ? 'Nieuwe badge' : 'Nieuwe badges'}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.md }}>
        {badges.map((badge) => (
          <View key={badge.key} style={{ alignItems: 'center', gap: spacing.xs, width: 96 }}>
            <BadgeIcon badge={badge} size={56} scheme="dark" decorative />
            <Text numberOfLines={2} style={[type.footnote, { color: playColors.text, fontWeight: '700', textAlign: 'center' }]}>
              {badge.name}
            </Text>
          </View>
        ))}
      </View>
      {badges.some((b) => b.status === 'pending') ? <PendingTag style={{ alignSelf: 'center' }} /> : null}
    </View>
  );
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
  // The approval celebration: how many blocks are in, and the total shown.
  const step = useSharedValue(0);
  const [total, setTotal] = useState(data?.kind === 'approval' ? data.results.pointsBefore : 0);

  const moments = useMemo(() => (data?.kind === 'missed' ? summarizeMoments(data.moments) : null), [data]);
  const parts = useMemo(() => (data?.kind === 'approval' ? approvalParts(data.results) : []), [data]);
  const milestone = data?.kind === 'reveal' ? data.milestone : (moments?.milestone ?? null);
  const badges = useMemo(() => (data?.kind === 'reveal' ? data.badges : (moments?.badges ?? [])), [data, moments]);
  const discoveries = useMemo(() => moments?.discoveries ?? [], [moments]);
  const quests = useMemo(() => (data?.kind === 'reveal' ? data.quests : (moments?.quests ?? [])), [data, moments]);
  const chestDay = data?.kind === 'reveal' ? data.chestDay : (moments?.chestDay ?? null);
  const freezes = data?.kind === 'reveal' ? data.freezes : (moments?.freezes ?? 0);

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

    let events: Event[];
    if (data.kind === 'approval') {
      const { results } = data;
      track('approval_shown', { approved: results.approvedCount, rejected: results.rejectedCount, points: results.gained }, { isTest });
      if (isLevelUp(results)) track('level_up_shown', { level: results.levelAfter, previous: results.levelBefore }, { isTest });
      for (const badge of results.badges) track('badge_shown', { badge_key: badge.key, status: badge.status, source: 'approval' }, { isTest });
      if (screenReader) {
        // At once on the end state (the total too, see below).
        step.set(parts.length);
        AccessibilityInfo.announceForAccessibilityWithOptions(summary(data), { queue: true });
        return;
      }
      events = buildApprovalTimeline({ results, reduceMotion });
    } else {
      const source = data.kind === 'reveal' ? 'reveal' : 'missed';
      if (milestone) track('milestone_shown', { threshold: milestone.threshold, status: milestone.status, source }, { isTest });
      for (const discovery of discoveries) {
        track('discovery_shown', { ordinal: discovery.ordinal, status: discovery.status, source: 'missed' }, { isTest });
      }
      for (const badge of badges) track('badge_shown', { badge_key: badge.key, status: badge.status, source }, { isTest });
      for (const quest of quests) {
        track('quest_completed', { template_key: quest.templateKey, period: quest.period, source }, { isTest });
      }
      if (screenReader) {
        reward.set(1);
        rewardPop.set(1);
        AccessibilityInfo.announceForAccessibilityWithOptions(summary(data), { queue: true });
        return;
      }
      events = buildCelebrationTimeline({
        milestone: !!milestone,
        discoveries: discoveries.length > 0,
        quests: quests.length > 0 || chestDay !== null || freezes > 0,
        reduceMotion,
      });
    }

    const showReward = () => {
      reward.set(withTiming(1, { duration: 240, easing: Easing.out(Easing.quad), reduceMotion: ReduceMotion.Never }));
      rewardPop.set(withSpring(1, { damping: 12, stiffness: 220, reduceMotion: data.forceReduceMotion ? ReduceMotion.Always : ReduceMotion.System }));
    };
    if (!data.noSound) warmUpSounds(events);
    playback.current = playTimeline(events, data.noSound ? null : celebrationSoundtrack, (batch: Event[]) => {
      for (const event of batch) {
        if (playFeedback(event)) continue;
        if (event.type === 'confetti') {
          setPieces(event.pieces);
          setBurst((b) => b + 1);
        } else if (event.type === 'reward') {
          showReward();
        } else if (event.type === 'part') {
          step.set(withTiming(event.index + 1, { duration: 240, easing: Easing.out(Easing.quad), reduceMotion: ReduceMotion.Never }));
          // The total rolls from old to new as its block comes in.
          if (data.kind === 'approval' && parts[event.index] === 'total') setTotal(data.results.pointsAfter);
        }
      }
    });
  }, [data, milestone, discoveries, badges, quests, chestDay, freezes, parts, reduceMotion, screenReader, reward, rewardPop, step]);

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
    if (!data.preview && data.asOf) {
      (data.kind === 'approval' ? markResultsSeen(data.asOf) : markMomentsSeen(data.asOf)).catch(() => {});
    }
    // Before the presenter moves on: the chest this leads to is announced (ChestMoment skips it).
    if (chestDay && !data.preview) markChestAnnounced(chestDay);
    data.onClose?.();
    refresh();
    // A chest that became ready: straight to it.
    if (chestDay && !data.preview) router.replace({ pathname: '/chest', params: { day: chestDay } });
    else router.back();
  };

  if (!data) return <View style={{ flex: 1, backgroundColor: playColors.backdrop }} />;

  const label = data.preview
    ? 'VOORBEELD · DEV-MODUS'
    : data.kind === 'approval'
      ? 'SINDS JE VORIGE BEZOEK'
      : milestone
        ? 'MIJLPAAL'
        : data.kind === 'missed'
          ? 'TERWIJL JE WEG WAS'
          : quests.length > 0
            ? quests.length === 1 ? 'QUEST' : 'QUESTS'
            : chestDay
              ? 'DAGKIST'
              : 'BADGE';

  return (
    <View style={{ flex: 1, experimental_backgroundImage: playColors.background }} accessible={false} onAccessibilityEscape={close}>
      <SafeAreaView style={{ flex: 1, padding: spacing.xl, gap: spacing.lg }}>
        <Text style={[type.footnote, { color: 'rgba(255,255,255,0.7)', fontWeight: '700', letterSpacing: 1.5, textAlign: 'center' }]}>
          {label}
        </Text>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg }}
          showsVerticalScrollIndicator={false}>
          {data.kind === 'approval' ? (
            <ApprovalBody
              results={data.results}
              parts={parts}
              step={step}
              total={screenReader ? data.results.pointsAfter : total}
              countMs={APPROVAL_COUNT_MS}
              reduceMotion={reduceMotion ?? false}
            />
          ) : null}

          {milestone ? (
            <>
              <GameNumber value={milestone.threshold} style={{ color: 'white', fontSize: 120, lineHeight: 132, ...numberStyle }} />
              <Text style={[type.title2, { color: 'white', fontWeight: '800', textAlign: 'center' }]}>{milestoneTitle(milestone.threshold)}</Text>
              {data.kind === 'reveal' && data.discovered !== null && data.totalBins !== null ? (
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

          {quests.length > 0 ? (
            <Animated.View style={[{ alignSelf: 'stretch' }, rewardStyle]}>
              <QuestsDone quests={quests} />
            </Animated.View>
          ) : null}

          {chestDay ? (
            <Animated.View style={[{ alignItems: 'center', gap: spacing.sm }, rewardStyle]}>
              <SymbolView name="shippingbox.fill" size={64} tintColor={playColors.gold} />
              <Text style={[type.title3, { color: 'white', fontWeight: '800', textAlign: 'center' }]}>Je dagkist staat klaar</Text>
            </Animated.View>
          ) : null}

          {freezes > 0 ? (
            <Animated.View style={[{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }, rewardStyle]}>
              <SymbolView name="snowflake" size={22} tintColor={playColors.chips} />
              <Text style={[type.headline, { color: 'white' }]}>{freezes === 1 ? 'Een bevriezer erbij' : `${freezes} bevriezers erbij`}</Text>
            </Animated.View>
          ) : null}

          {badges.length > 0 ? (
            <Animated.View style={rewardStyle}>
              <EarnedBadges badges={badges} />
            </Animated.View>
          ) : null}
        </ScrollView>

        <ChunkyButton title={chestDay && !data.preview ? 'Open je kist' : 'Verder'} onPress={close} />
      </SafeAreaView>
      <Confetti pieces={pieces} burst={burst} />
      {/* No general toasts during a celebration: they wait until it closes. */}
      <ToastViewport hold />
    </View>
  );
}
