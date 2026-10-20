// The points reveal after a check-in, in the style of Balatro: two bins with a
// fixed colour, PUNTEN (blue: everything that adds up) × MULT (the orange →
// magenta scale: everything that multiplies), and the total they make.
//
// The base counts up into PUNTEN. Everything else is a pop-up above the bins
// that lands in a bin and is gone: a new bin's banner (gold, the only colour
// for what is new) sends its +5 into PUNTEN and shrinks into the context line;
// the streak flame beats at MULT; the streak climbs MULT; a step the app does
// not know flies into MULT (×) or PUNTEN (+); the total slams in; the bonus
// question's "+5 bonusvraag" drops into the total. The end state is calm: the
// two bins, the total, one neutral context line and the buttons, on one
// vertical axis. A milestone follows on its own screen (celebrate.tsx).
//
// Tap to skip. Respects the silent switch (sounds) and Reduce Motion (same
// sounds and haptics; pop-ups fade instead of flying, nothing shakes). Every
// number comes from the server's score (score.steps); the Dev mode preview
// builds its own and sends nothing.
//
// The beats are a timeline (src/feedback/reveal/timeline.ts). playTimeline
// plays its mixed soundtrack and runs the visual and haptic events on the
// audio clock; this screen turns visual events into Reanimated motion
// (useRevealMotion) and the numbers into a small store (state.ts). The number,
// the chips and the MULT badge are memoised components that read only their
// part of that store, so a tick re-renders the number and nothing else. Every
// pop-up, icon and the context line is mounted with the screen (invisible):
// while the reveal plays no native view is created.
//
// A skip, the app going to the background and VoiceOver all end on the
// timeline's own end state (endState): the background silently, VoiceOver
// with one spoken summary instead of the animation.
import { Host } from '@expo/ui';
import { Button, Label, Text as SwiftText } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, disabled, font, frame, tint } from '@expo/ui/swift-ui/modifiers';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState, Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import Animated, { type SharedValue } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { SFSymbol } from 'sf-symbols-typescript';

import { holdAnalytics, track } from '@/analytics';
import { roundTo100 } from '@/analytics/props';
import { GlassPanel } from '@/components/GlassPanel';
import { fireHaptic, setHapticProbe } from '@/feedback/haptics';
import { createDiagnostics, describeMeasurements, type RevealMeasurements } from '@/feedback/reveal/diagnostics';
import { playFeedback } from '@/feedback/reveal/feedback';
import { FrameProbe } from '@/feedback/reveal/FrameProbe';
import { flightTargets, type FlightTargets, type RevealRects } from '@/feedback/reveal/layout';
import { playTimeline, preloadTimeline, type Playback, type PlaybackStart } from '@/feedback/reveal/playback';
import { applyRevealEvent, endState, INITIAL_REVEAL_STATE, multiplierLabel, type RevealState } from '@/feedback/reveal/state';
import { buildBonusTimeline, buildRevealTimeline, stepPopup, type Event, type PopupId, type PopupTarget } from '@/feedback/reveal/timeline';
import { DISCOVERY_SPARKLES, VOLUME } from '@/feedback/reveal/tuning';
import { MAX_PARTICLES, useParticleStyle, usePopupStyle, useRevealMotion, type PopupValues } from '@/feedback/reveal/useRevealMotion';
import { play, stopAll } from '@/feedback/sfx/engine';
import { bonusSoundtrack, revealSoundtrack, warmUpSounds } from '@/feedback/sfx/soundtrack';
import { hasRevealNews, revealNews, setPendingCelebration } from '@/game/celebration';
import type { MissedMoment } from '@/game/discoveries';
import { answerBonus, fetchMyUnseen, markBonusShown, markMomentsSeen } from '@/lib/api';
import { formatWeeks } from '@/lib/format';
import type { BonusOption } from '@/lib/points';
import { revealSummary, setPendingReveal, takePendingReveal, type RevealData } from '@/lib/reveal';
import { baseStep, discoveryStep, streakStep, type Score } from '@/lib/score';
import { useReduceMotion, useScreenReader } from '@/lib/useAccessibility';
import { createStore, useSyncState, type Store } from '@/lib/useSyncState';
import { useGame } from '@/providers/GameProvider';
import { ToastViewport } from '@/providers/ToastProvider';
import { colors, numberStyle, playColors, playType, shapes, spacing, type } from '@/theme';

/** What the bonus answer added after the check-in (a quest, the chest): moments after game.asOf. */
type Later = { moments: MissedMoment[]; asOf: string };

function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

// total: the total has landed and the bonus question is about to appear.
type Phase = 'loading' | 'playing' | 'total' | 'question' | 'answering' | 'answered' | 'done';

/** How a reveal ends early: a tap, the app leaving the screen, or VoiceOver from the start. */
type EndedBy = 'skip' | 'background' | 'voiceover';

type RevealStore = Store<RevealState>;

function bonusErrorMessage(error: { code?: string } | null): string {
  if (error?.code === '55000') return 'Deze vraag is verlopen of al beantwoord.';
  if (error?.code === 'P0002') return 'Deze vraag hoort niet bij je inworp.';
  return 'Je antwoord kon niet bewaard worden.';
}

/** The big number shrinks with its digits (the Dev preview goes up to four), so it always fits. */
function totalFontSize(value: number): number {
  return value >= 1000 ? 84 : value >= 100 ? 104 : playType.total.fontSize;
}

/** One part of the reveal's state; re-renders only when that part changes (and in the same task, see useSyncState). */
function useRevealPart<T>(store: RevealStore, select: (state: RevealState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

const labelText = { ...playType.label, color: playColors.label } as const;
const binLabel = { ...playType.label, color: 'rgba(255,255,255,0.85)' } as const;
const valueText = { color: playColors.text, ...playType.value, ...numberStyle } as const;
const binShape = {
  borderRadius: shapes.binRadius,
  borderCurve: 'continuous',
  minWidth: shapes.binMinWidth,
  paddingHorizontal: spacing.lg,
  paddingVertical: spacing.sm,
  alignItems: 'center',
} as const;

// PUNTEN: the base while it counts, then whatever a step put in.
const ChipsValue = memo(function ChipsValue({ store, base }: { store: RevealStore; base: number }) {
  const value = useRevealPart(store, (state) => state.chips ?? Math.min(state.value, base));
  return <Text style={valueText}>{value}</Text>;
});

const MultBadgeText = memo(function MultBadgeText({ store }: { store: RevealStore }) {
  const max = useRevealPart(store, (state) => state.max);
  const multiplier = useRevealPart(store, (state) => state.multiplier);
  return (
    <>
      <Text style={binLabel}>{max ? 'MULT · MAX' : 'MULT'}</Text>
      <Text style={valueText}>{multiplierLabel(multiplier)}</Text>
    </>
  );
});

const TotalNumber = memo(function TotalNumber({ store, onCommit }: { store: RevealStore; onCommit?: (value: number) => void }) {
  const value = useRevealPart(store, (state) => state.value);
  // Diagnostics: when React has committed the number an event set.
  useLayoutEffect(() => {
    onCommit?.(value);
  }, [onCommit, value]);
  return (
    <Text numberOfLines={1} style={{ color: playColors.text, fontSize: totalFontSize(value), lineHeight: playType.total.lineHeight, ...numberStyle }}>
      {value}
    </Text>
  );
});

/** A pop-up: one badge shape for all of them, in the colour of where it goes. */
const Popup = memo(function Popup({
  values,
  targets,
  text,
  color,
  ink,
  icon,
}: {
  values: PopupValues;
  targets: SharedValue<FlightTargets>;
  text: string;
  color: string;
  ink: string;
  icon?: SFSymbol;
}) {
  const style = usePopupStyle(values, targets);
  return (
    <Animated.View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[
        {
          position: 'absolute',
          height: shapes.badgeHeight,
          borderRadius: shapes.badgeRadius,
          borderCurve: 'continuous',
          paddingHorizontal: spacing.md,
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.xs,
          backgroundColor: color,
        },
        style,
      ]}>
      {icon ? <SymbolView name={icon} size={playType.label.fontSize} tintColor={ink} /> : null}
      <Text style={[playType.label, { color: ink }]}>{text}</Text>
    </Animated.View>
  );
});

// Memoised: a phase change of the screen (at the slam) does not re-render the 28 particles and sparkles.
const Particle = memo(function Particle({
  index,
  burst,
  count,
  color,
  size,
}: {
  index: number;
  burst: SharedValue<number>;
  count: SharedValue<number>;
  color: string;
  size: number;
}) {
  const style = useParticleStyle(index, burst, count);
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: 'absolute', width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2, borderRadius: size / 2, backgroundColor: color }, style]}
    />
  );
});

/** The pop-up colour of each target: blue into PUNTEN or the total, the hot end of MULT into MULT. */
function targetColor(to: PopupTarget | undefined): string {
  return to === 'mult' ? playColors.multRamp[2] : playColors.chips;
}

/** "REEKS 6 WEKEN" (· MAX past the maximum), or "NOG GEEN REEKS". */
function streakContext(score: Score): string {
  const streak = streakStep(score);
  const weeks = streak?.weeks ?? 0;
  if (weeks <= 0) return 'NOG GEEN REEKS';
  const max = !!streak && weeks > streak.stages.length && streak.stages.length > 0;
  return `REEKS ${formatWeeks(weeks).toUpperCase()}${max ? ' · MAX' : ''}`;
}

function trackBonusAnswer(questionKey: string, answered: boolean, shownAt: number | null, isTest: boolean) {
  const responseMs = shownAt === null ? null : roundTo100(Date.now() - shownAt);
  track('bonus_question_answered', { question_key: questionKey, answered, response_ms: responseMs }, { isTest });
}

export default function RevealScreen() {
  const [data] = useState<RevealData | null>(() => takePendingReveal());
  const systemReduceMotion = useReduceMotion();
  const screenReader = useScreenReader();
  // The Dev mode preview can force Reduce Motion, whatever the system setting.
  const forceReduceMotion = data?.forceReduceMotion ?? false;
  const reduceMotion = forceReduceMotion || systemReduceMotion;
  const motion = useRevealMotion(forceReduceMotion);
  // What the timeline shows (number, PUNTEN, MULT) lives in a store the
  // memoised parts read; the rest of the screen changes a few times per reveal.
  const [store] = useState(() => createStore<RevealState>(INITIAL_REVEAL_STATE));
  const { refresh: refreshGame } = useGame();
  const [phase, setPhase] = useSyncState<Phase>('loading');
  const [bonusShown, setBonusShown] = useSyncState(false);
  const [message, setMessage] = useState<string | null>(null);
  const noSound = data?.noSound ?? false;
  // Dev mode preview only: timing measurements, shown when the reveal is done.
  const [diagnostics] = useState(() => (data?.preview ? createDiagnostics() : null));
  const [measured, setMeasured] = useState<RevealMeasurements | null>(null);
  const [probing, setProbing] = useState(false);

  // False when the soundtrack did not play: a skip then lands without its chord.
  const withSound = useRef(false);
  const playbacks = useRef<Playback[]>([]);
  const answering = useRef(false);
  const later = useRef<Promise<Later | null> | null>(null);
  const leaving = useRef(false);
  const mounted = useRef(true);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const phaseNow = useRef<Phase>('loading');
  useEffect(() => {
    phaseNow.current = phase;
  }, [phase]);

  const score = data?.score ?? null;
  const question = data?.question ?? null;
  const game = data?.game ?? null;
  const base = score ? (baseStep(score)?.total ?? 0) : 0;
  const discovery = score ? discoveryStep(score) : null;
  // Analytics: when the question appeared (previews are test events).
  const questionShownAt = useRef<number | null>(null);

  // The reveal's own timeline, as soon as Reduce Motion is known: its end
  // state is where a skip lands, and it says which pop-ups go where.
  const timeline = useMemo(
    () => (score && reduceMotion !== null ? buildRevealTimeline({ score, reduceMotion, bonus: !!question }) : null),
    [score, reduceMotion, question],
  );
  const popupTargets = useMemo(() => {
    const targets = new Map<PopupId, PopupTarget>();
    for (const event of timeline ?? []) if (event.type === 'popupOut') targets.set(event.popup, event.to);
    return targets;
  }, [timeline]);
  // A step multiplied on top of the streak: MULT stays at its hottest after a skip.
  const hot = useMemo(() => (timeline ?? []).some((event) => event.type === 'bins' && event.multiplier !== null), [timeline]);

  // Where the pop-ups fly to: measured once the layout is there.
  const rects = useRef<RevealRects>({});
  const measure = useCallback(
    (key: keyof RevealRects) => (event: LayoutChangeEvent) => {
      rects.current[key] = event.nativeEvent.layout;
      const targets = flightTargets(rects.current);
      if (targets) motion.setTargets(targets);
    },
    [motion],
  );
  const onAnchorLayout = useMemo(() => measure('anchor'), [measure]);
  const onRowLayout = useMemo(() => measure('row'), [measure]);
  const onChipsLayout = useMemo(() => measure('chips'), [measure]);
  const onMultLayout = useMemo(() => measure('mult'), [measure]);
  const onTotalLayout = useMemo(() => measure('total'), [measure]);
  const onContextLayout = useMemo(() => measure('context'), [measure]);

  // No analytics I/O while the reveal plays (see src/analytics/queue.ts).
  useEffect(() => holdAnalytics(), []);

  // Nothing to show (e.g. after a reload): back to the map.
  useEffect(() => {
    if (!data) router.back();
  }, [data]);

  useEffect(() => {
    // Usually long ready: the camera and the Dev mode screen start it, and it
    // stays loaded for the next reveal.
    if (!noSound) warmUpSounds();
    mounted.current = true;
    return () => {
      mounted.current = false;
      playbacks.current.forEach((playback) => playback.cancel(30));
      playbacks.current = [];
      timers.current.forEach(clearTimeout);
      timers.current = [];
      setHapticProbe(null);
      diagnostics?.stop();
      stopAll(30);
    };
  }, [noSound, diagnostics]);

  const onNumberCommit = useCallback((value: number) => diagnostics?.committed(value), [diagnostics]);

  const startDiagnostics = useCallback(
    (start: PlaybackStart) => {
      if (!diagnostics) return;
      diagnostics.sound(start.sound, start.timings);
      setHapticProbe(diagnostics.haptic);
      diagnostics.start();
      setProbing(true);
    },
    [diagnostics],
  );

  const stopDiagnostics = useCallback(() => {
    if (!diagnostics) return;
    setHapticProbe(null);
    setProbing(false);
    setMeasured(diagnostics.stop());
  }, [diagnostics]);

  const schedule = useCallback((ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  /** Applies a batch of events to the number and the bins in one store update (one render). */
  const show = useCallback(
    (events: readonly Event[]) => {
      const next = events.reduce(applyRevealEvent, store.get());
      for (const event of events) {
        if (event.type === 'count' || event.type === 'mult' || event.type === 'slam' || event.type === 'bins') diagnostics?.expect(next.value);
      }
      if (next !== store.get()) store.set(next);
    },
    [store, diagnostics],
  );

  const bonusTimeline = useCallback(
    (bonus: number) => buildBonusTimeline({ awarded: bonus > 0, points: bonus, fromTotal: score?.total ?? 0, reduceMotion: !!reduceMotion }),
    [score, reduceMotion],
  );

  const showQuestion = useCallback(() => {
    if (!question) return;
    setPhase('question');
    motion.showSheet();
    questionShownAt.current = Date.now();
    // The server measures the answer time from here.
    if (data?.checkinId && !data.preview) markBonusShown(data.checkinId).catch(() => {});
    // Mix and load the +5 now, so it plays at once after the answer.
    if (!noSound) preloadTimeline(bonusTimeline(question.points), bonusSoundtrack);
  }, [question, motion, data, setPhase, noSound, bonusTimeline]);

  // Stop the timeline and stand still on its end state. A skip fades out the
  // soundtrack and plays only the chord and the success haptic; the background
  // ends silently; VoiceOver gets the success haptic and a summary.
  const finish = useCallback(
    (endedBy: EndedBy) => {
      const events = timeline;
      if (!score || !events) return;
      if (endedBy === 'skip') {
        const { stage, discovery: added } = store.get();
        track('reveal_skipped', { step: stage > 0 ? `streak_${stage}` : added > 0 ? 'discovery' : 'base' }, { isTest: data?.preview ?? false });
      }
      playbacks.current.forEach((playback) => playback.cancel(endedBy === 'background' ? 0 : 30));
      playbacks.current = [];
      timers.current.forEach(clearTimeout);
      timers.current = [];
      const end = endState(events);
      motion.settle(end.stage, hot);
      store.set(end);
      setPhase(question ? 'total' : 'done');
      if (endedBy === 'skip' && withSound.current) play('total_chord', VOLUME.total);
      if (endedBy !== 'background') fireHaptic('success');
      if (endedBy === 'voiceover') AccessibilityInfo.announceForAccessibilityWithOptions(revealSummary(score, data?.preview), { queue: true });
      stopDiagnostics();
      schedule(endedBy === 'skip' && !reduceMotion ? 500 : 0, showQuestion);
    },
    [timeline, score, question, motion, hot, store, schedule, reduceMotion, showQuestion, stopDiagnostics, setPhase, data],
  );

  // Going to the background mid-reveal ends it silently on its end state: the
  // audio clock would run on and everything would fire at once on return.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background' && (phaseNow.current === 'loading' || phaseNow.current === 'playing')) finish('background');
    });
    return () => subscription.remove();
  }, [finish]);

  // Play the timeline once, as soon as Reduce Motion and VoiceOver are known
  // (a later change of either does not restart the reveal): with its mixed
  // soundtrack, or without sound when that is not ready in time. A skip and
  // leaving the screen cancel it. With VoiceOver it starts on the end state.
  const started = useRef(false);
  useEffect(() => {
    if (!score || !timeline || screenReader === null || started.current) return;
    started.current = true;
    const discovered = discoveryStep(score) !== null;
    track(
      'reveal_shown',
      { total: score.total, discovery: discovered, streak_weeks: streakStep(score)?.weeks ?? 0, preview: data?.preview ?? false },
      { isTest: data?.preview ?? false },
    );
    if (discovered) {
      const news = data?.game?.discovery ?? null;
      track('discovery_shown', { ordinal: news?.ordinal ?? null, status: news?.status ?? null, source: 'reveal' }, { isTest: data?.preview ?? false });
    }
    if (screenReader) {
      // Right after this effect (it sets state): the end state and the summary.
      schedule(0, () => finish('voiceover'));
      return;
    }
    const onEvents = (batch: Event[], lateMs: number) => {
      diagnostics?.late(lateMs);
      const shown: Event[] = [];
      for (const event of batch) {
        if (playFeedback(event)) continue;
        // Motion first (UI thread), then the numbers (one sync render per batch).
        motion.apply(event);
        shown.push(event);
      }
      show(shown);
      for (const event of shown) {
        if (event.type === 'chipIn') {
          setPhase('playing');
        } else if (event.type === 'slam') {
          setPhase(question ? 'total' : 'done');
          schedule(600, stopDiagnostics);
        } else if (event.type === 'showBonusQuestion') {
          showQuestion();
        }
      }
    };
    const playback = playTimeline(timeline, noSound ? null : revealSoundtrack, onEvents, {
      onStarted: (start) => {
        if (!mounted.current) return;
        withSound.current = start.sound === 'on';
        startDiagnostics(start);
      },
      onClockCheck: (errorMs, corrections) => diagnostics?.clockError(errorMs, corrections),
    });
    playbacks.current.push(playback);
  }, [
    score,
    timeline,
    question,
    screenReader,
    noSound,
    diagnostics,
    motion,
    schedule,
    show,
    finish,
    showQuestion,
    startDiagnostics,
    stopDiagnostics,
    setPhase,
    data,
  ]);

  /** The +5 with its own soundtrack, or one quiet tock when there are no points. */
  const playBonus = (bonus: number) => {
    if (!score) return;
    if (bonus <= 0) {
      if (!noSound) play('neutral_tock', VOLUME.tock);
      return;
    }
    const onEvents = (batch: Event[]) => {
      const shown: Event[] = [];
      for (const event of batch) {
        if (playFeedback(event)) continue;
        motion.apply(event);
        shown.push(event);
        if (event.type === 'badge') setBonusShown(true);
      }
      show(shown);
    };
    playbacks.current.push(playTimeline(bonusTimeline(bonus), noSound ? null : bonusSoundtrack, onEvents));
  };

  const trackAnswer = (answered: boolean) => {
    if (question) trackBonusAnswer(question.key, answered, questionShownAt.current, data?.preview ?? false);
  };

  const answer = async (option: BonusOption) => {
    if (!score || !question || answering.current) return;
    answering.current = true;
    trackAnswer(true);
    setPhase('answering');
    // The preview awards the points unless Dev mode says not to.
    let bonus = data?.preview && data.previewAwarded === false ? 0 : question.points;
    if (data?.checkinId && !data.preview) {
      try {
        bonus = await answerBonus(data.checkinId, option.key);
        // The answer can complete a quest or make the chest ready: ask what is
        // new since the check-in, for the celebration after "Klaar".
        if (game?.asOf) {
          const since = Date.parse(game.asOf);
          later.current = fetchMyUnseen().then(
            (unseen) => ({ moments: unseen.moments.filter((m) => Date.parse(m.at) > since), asOf: unseen.asOf }),
            () => null,
          );
        }
      } catch (error) {
        if (!mounted.current) return;
        setMessage(bonusErrorMessage(error as { code?: string }));
        setPhase('answered');
        return;
      }
    }
    if (!mounted.current) return;
    setPhase('answered');
    playBonus(bonus);
  };

  const skipQuestion = () => {
    trackAnswer(false);
    setPhase('done');
    playBonus(0);
  };

  /** Dev mode preview: the same reveal once more, on a fresh screen. */
  const replay = () => {
    if (!data) return;
    setPendingReveal(data);
    router.replace('/reveal');
  };

  // Done: a milestone, quests done, the chest ready or a badge (also from the
  // bonus answer) get their own celebration next; otherwise the moments of
  // this check-in are seen, and the map and counter catch up.
  const leave = async () => {
    if (leaving.current) return;
    leaving.current = true;
    const extra = later.current ? await within(later.current, 1000) : null;
    const news = revealNews(game, extra?.moments ?? []);
    const asOf = extra?.asOf ?? game?.asOf ?? null;
    if (hasRevealNews(news) && data) {
      setPendingCelebration({
        kind: 'reveal',
        ...news,
        discovered: game?.discovery?.discovered ?? null,
        totalBins: game?.discovery?.totalBins ?? null,
        asOf,
        preview: data.preview,
        forceReduceMotion: data.forceReduceMotion,
        noSound: data.noSound,
      });
      router.replace('/celebrate');
      return;
    }
    if (asOf && !data?.preview) markMomentsSeen(asOf).catch(() => {});
    if (!data?.preview) refreshGame();
    router.back();
  };

  if (!data || !score) return <View style={{ flex: 1, backgroundColor: playColors.backdrop }} />;

  const playing = phase === 'playing';
  const showDone = phase === 'done' || phase === 'answered';
  const { styles, popups, targets } = motion;
  const weeks = streakStep(score)?.weeks ?? 0;
  const others = score.steps.filter((step) => step.kind === 'other');
  const news = game?.discovery ?? null;

  return (
    <Pressable
      style={{ flex: 1, experimental_backgroundImage: playColors.background }}
      onPress={playing ? () => finish('skip') : undefined}
      // Not one big VoiceOver element: the answers and buttons inside stay reachable.
      accessible={false}
      onAccessibilityEscape={leave}>
      {diagnostics ? <FrameProbe active={probing} onSample={diagnostics.frame} /> : null}
      <SafeAreaView style={{ flex: 1, padding: spacing.xl }}>
        <Text style={[labelText, { textAlign: 'center' }]}>
          {data.preview ? 'VOORBEELD · DEV-MODUS' : data.isTest ? 'TESTINWORP · DEV-MODUS' : 'INWORP GEREGISTREERD'}
        </Text>

        {/* One vertical axis: the pop-up anchor, PUNTEN × MULT, the total and its label, the context line. */}
        <Animated.View style={[{ flex: 1, alignItems: 'center', justifyContent: 'center' }, styles.shakeStyle]}>
          {/* The anchor: pop-ups appear here and fly to their target. */}
          <View onLayout={onAnchorLayout} style={{ alignSelf: 'stretch', height: shapes.badgeHeight, alignItems: 'center', justifyContent: 'center' }}>
            {discovery ? (
              <>
                <View pointerEvents="none" style={{ position: 'absolute', top: '50%', left: '50%' }}>
                  {Array.from({ length: DISCOVERY_SPARKLES }, (_, i) => (
                    <Particle key={i} index={i} burst={motion.sparkle} count={motion.sparkleCount} color={playColors.gold} size={6} />
                  ))}
                </View>
                <Popup
                  values={popups.discovery}
                  targets={targets}
                  text={news ? `NIEUWE VUILBAK · #${news.binId}` : 'NIEUWE VUILBAK'}
                  color={playColors.gold}
                  ink={playColors.onGold}
                  icon="sparkles"
                />
                <Popup values={popups.discoveryAdd} targets={targets} text={`+${discovery.add}`} color={playColors.chips} ink={playColors.text} />
              </>
            ) : null}
            {score.streakExtended && weeks > 0 ? (
              <Popup
                values={popups.flame}
                targets={targets}
                text={weeks === 1 ? 'REEKS GESTART' : `REEKS VERLENGD · ${formatWeeks(weeks).toUpperCase()}`}
                color={playColors.heat}
                ink={playColors.text}
                icon="flame.fill"
              />
            ) : null}
            {others.slice(0, 3).map((step, i) => {
              const id = stepPopup(i);
              return (
                <Popup key={id} values={popups[id]} targets={targets} text={step.label} color={targetColor(popupTargets.get(id))} ink={playColors.text} />
              );
            })}
            {question ? (
              <Popup values={popups.bonus} targets={targets} text={`+${question.points} BONUSVRAAG`} color={playColors.chips} ink={playColors.text} />
            ) : null}
          </View>

          {/* PUNTEN × MULT: two bins, one shape. */}
          <View onLayout={onRowLayout} style={{ marginTop: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
            <Animated.View onLayout={onChipsLayout} style={[binShape, { backgroundColor: playColors.chips }, styles.chipStyle]}>
              <Text style={binLabel}>PUNTEN</Text>
              <ChipsValue store={store} base={base} />
            </Animated.View>
            <Text style={[valueText, { color: playColors.muted, fontWeight: '300' }]}>×</Text>
            <View onLayout={onMultLayout}>
              <Animated.View
                pointerEvents="none"
                style={[
                  { position: 'absolute', top: -10, right: -10, bottom: -10, left: -10, borderRadius: 28, backgroundColor: playColors.heat, boxShadow: `0 0 24px ${playColors.heat}` },
                  styles.glowStyle,
                ]}
              />
              <Animated.View style={[binShape, styles.multStyle]}>
                <MultBadgeText store={store} />
              </Animated.View>
            </View>
          </View>

          {/* The total, with the slam's particles and the bonus ring. */}
          <View onLayout={onTotalLayout} style={{ marginTop: spacing.xl, alignItems: 'center', justifyContent: 'center' }}>
            <Animated.View
              pointerEvents="none"
              style={[{ position: 'absolute', width: 180, height: 180, borderRadius: 90, borderWidth: 4, borderColor: playColors.chips }, styles.ringStyle]}
            />
            <Animated.View style={styles.totalStyle}>
              <TotalNumber store={store} onCommit={diagnostics ? onNumberCommit : undefined} />
            </Animated.View>
            <View pointerEvents="none" style={{ position: 'absolute', top: '50%', left: '50%' }}>
              {Array.from({ length: MAX_PARTICLES }, (_, i) => (
                <Particle
                  key={i}
                  index={i}
                  burst={motion.burst}
                  count={motion.burstCount}
                  color={playColors.particles[i % playColors.particles.length]}
                  size={10}
                />
              ))}
            </View>
          </View>
          <Text style={[labelText, { marginTop: spacing.xs }]}>{bonusShown ? 'TOTAAL · MET BONUSVRAAG' : 'TOTAAL'}</Text>

          {/* One neutral context line: what this check-in was. */}
          <Animated.View
            onLayout={onContextLayout}
            style={[{ marginTop: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.xs }, styles.contextStyle]}>
            {discovery ? (
              <>
                <SymbolView name="trash.fill" size={playType.label.fontSize} tintColor={playColors.label} />
                <Text style={labelText}>{news ? `#${news.binId} ONTDEKT · ${news.discovered}/${news.totalBins}` : 'NIEUWE VUILBAK'}</Text>
                <Text style={labelText}>·</Text>
              </>
            ) : null}
            <SymbolView name="flame.fill" size={playType.label.fontSize} tintColor={playColors.label} />
            <Text style={labelText}>{streakContext(score)}</Text>
          </Animated.View>
        </Animated.View>

        {playing ? (
          <Text
            onPress={() => finish('skip')}
            accessibilityRole="button"
            accessibilityLabel="Overslaan"
            style={[labelText, { color: playColors.muted, textAlign: 'center' }]}>
            TIK OM OVER TE SLAAN
          </Text>
        ) : null}

        {question && (phase === 'question' || phase === 'answering') ? (
          <Animated.View style={styles.sheetStyle}>
            <GlassPanel dark style={{ padding: spacing.lg, gap: spacing.md }}>
              <Text style={labelText}>{`BONUSVRAAG · +${question.points} PUNTEN`}</Text>
              <Text style={[type.title3, { color: playColors.text }]}>{question.prompt}</Text>
              {question.options.map((option) => (
                <Host key={option.key} matchContents={{ vertical: true }} style={{ alignSelf: 'stretch' }}>
                  <Button
                    onPress={() => answer(option)}
                    modifiers={[buttonStyle('glass'), controlSize('large'), tint('white'), disabled(phase === 'answering')]}>
                    <SwiftText modifiers={[frame({ maxWidth: 10000 }), font({ textStyle: 'headline' })]}>{option.label}</SwiftText>
                  </Button>
                </Host>
              ))}
              {phase === 'question' ? (
                <Text
                  onPress={skipQuestion}
                  accessibilityRole="button"
                  accessibilityLabel="Overslaan"
                  style={[labelText, { textAlign: 'center', paddingTop: spacing.xs }]}>
                  OVERSLAAN
                </Text>
              ) : null}
            </GlassPanel>
          </Animated.View>
        ) : null}

        {showDone ? (
          <View style={{ gap: spacing.md }}>
            {message ? <Text style={{ fontSize: playType.label.fontSize, color: colors.orange, textAlign: 'center' }}>{message}</Text> : null}
            {measured ? (
              <Text selectable style={{ fontSize: 11, color: playColors.muted, textAlign: 'center' }}>
                {describeMeasurements(measured)}
              </Text>
            ) : null}
            <Text style={{ fontSize: playType.label.fontSize, lineHeight: 18, color: playColors.muted, textAlign: 'center' }}>
              {data.preview ? 'Voorbeeld: er is niets bewaard.' : 'Je krijgt de punten zodra een admin je foto goedkeurt.'}
            </Text>
            {data.preview ? (
              <Host matchContents={{ vertical: true }} style={{ alignSelf: 'stretch' }}>
                <Button onPress={replay} modifiers={[buttonStyle('glass'), controlSize('large'), tint('white')]}>
                  <Label title="Opnieuw afspelen" systemImage="arrow.counterclockwise" modifiers={[frame({ maxWidth: 10000 }), font({ textStyle: 'headline' })]} />
                </Button>
              </Host>
            ) : null}
            <Host matchContents={{ vertical: true }} style={{ alignSelf: 'stretch' }}>
              <Button onPress={leave} modifiers={[buttonStyle('glassProminent'), controlSize('extraLarge'), tint(colors.tint)]}>
                <Label title="Klaar" systemImage="checkmark" modifiers={[frame({ maxWidth: 10000 }), font({ textStyle: 'headline' })]} />
              </Button>
            </Host>
          </View>
        ) : null}
      </SafeAreaView>
      {/* No general toasts during the reveal: they wait until it closes. */}
      <ToastViewport hold />
      {/* The flash covers everything, on top. */}
      <Animated.View
        pointerEvents="none"
        style={[{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: playColors.flash }, styles.flashStyle]}
      />
    </Pressable>
  );
}
