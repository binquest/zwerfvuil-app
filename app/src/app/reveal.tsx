// The points reveal after a check-in. The POINTS chip counts up to the base,
// the MULT badge climbs with every streak week (bigger, faster, hotter), the
// total slams in, then an optional bonus question with its +5. Tap to skip.
// Respects the silent switch (sounds) and Reduce Motion (same sounds and
// haptics, no movement). Every number comes from the server's score
// (score.steps); the Dev mode preview builds its own and sends nothing.
//
// The beats are a timeline (src/feedback/reveal/timeline.ts). playTimeline
// plays its mixed soundtrack and runs the visual and haptic events on the
// audio clock; this screen turns visual events into Reanimated motion
// (useRevealMotion) and the numbers into a small store (state.ts). The number,
// the chips and the MULT badge are memoised components that read only their
// part of that store, so a tick re-renders the number and nothing else.
//
// A skip, the app going to the background and VoiceOver all end on the
// timeline's own end state (endState): the background silently, VoiceOver
// with one spoken summary instead of the animation.
import { Host } from '@expo/ui';
import { Button, Label, Text as SwiftText } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, disabled, font, frame, tint } from '@expo/ui/swift-ui/modifiers';
import { router } from 'expo-router';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, AppState, Pressable, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { holdAnalytics, track } from '@/analytics';
import { roundTo100 } from '@/analytics/props';
import { GlassPanel } from '@/components/GlassPanel';
import { fireHaptic, setHapticProbe } from '@/feedback/haptics';
import { createDiagnostics, describeMeasurements, type RevealMeasurements } from '@/feedback/reveal/diagnostics';
import { playFeedback } from '@/feedback/reveal/feedback';
import { FrameProbe } from '@/feedback/reveal/FrameProbe';
import { BADGE_OFFSET } from '@/feedback/reveal/motion';
import { playTimeline, preloadTimeline, type Playback, type PlaybackStart } from '@/feedback/reveal/playback';
import { applyRevealEvent, endState, INITIAL_REVEAL_STATE, multiplierLabel, type RevealState } from '@/feedback/reveal/state';
import { buildBonusTimeline, buildRevealTimeline, type Event } from '@/feedback/reveal/timeline';
import { VOLUME } from '@/feedback/reveal/tuning';
import { MAX_PARTICLES, useParticleStyle, useRevealMotion } from '@/feedback/reveal/useRevealMotion';
import { play, stopAll } from '@/feedback/sfx/engine';
import { bonusSoundtrack, revealSoundtrack, warmUpSounds } from '@/feedback/sfx/soundtrack';
import { answerBonus, markBonusShown } from '@/lib/api';
import { formatWeeks } from '@/lib/format';
import { formatMultiplier, type BonusOption } from '@/lib/points';
import { revealSummary, setPendingReveal, takePendingReveal, type RevealData } from '@/lib/reveal';
import { baseStep, streakStep, type StreakStep } from '@/lib/score';
import { useReduceMotion, useScreenReader } from '@/lib/useAccessibility';
import { ToastViewport } from '@/providers/ToastProvider';
import { createStore, useSyncState, type Store } from '@/lib/useSyncState';
import { colors, numberStyle, playColors, spacing, type } from '@/theme';

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

/** The big number shrinks with its digits (the Dev preview goes up to four), so it always fits next to its badge. */
function totalFontSize(value: number): number {
  return value >= 1000 ? 84 : value >= 100 ? 104 : 120;
}

/** One part of the reveal's state; re-renders only when that part changes (and in the same task, see useSyncState). */
function useRevealPart<T>(store: RevealStore, select: (state: RevealState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

const chipText = { color: 'white', fontSize: 34, ...numberStyle } as const;

const ChipsValue = memo(function ChipsValue({ store, base }: { store: RevealStore; base: number }) {
  const value = useRevealPart(store, (state) => Math.min(state.value, base));
  return <Text style={chipText}>{value}</Text>;
});

const MultBadgeText = memo(function MultBadgeText({ store }: { store: RevealStore }) {
  const max = useRevealPart(store, (state) => state.max);
  const multiplier = useRevealPart(store, (state) => state.multiplier);
  return (
    <>
      <Text style={[type.footnote, { color: 'rgba(255,255,255,0.9)', fontWeight: '800', letterSpacing: 1 }]}>{max ? 'MULT · MAX' : 'MULT'}</Text>
      <Text style={chipText}>{multiplierLabel(multiplier)}</Text>
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
    <Text numberOfLines={1} style={{ color: 'white', fontSize: totalFontSize(value), lineHeight: 132, ...numberStyle }}>
      {value}
    </Text>
  );
});

const StreakLine = memo(function StreakLine({ store, streak }: { store: RevealStore; streak: StreakStep | null }) {
  const max = useRevealPart(store, (state) => state.max);
  const weeks = streak?.weeks ?? 0;
  return (
    <Text style={[type.subheadline, { color: 'rgba(255,255,255,0.8)', textAlign: 'center' }]}>
      {streak && streak.stages.length > 0
        ? `Reeks van ${formatWeeks(weeks)}${max ? ' · maximum' : ''}`
        : `Check volgende week opnieuw in voor een reeks${streak ? `: ${formatMultiplier(streak.perWeek)} per week` : ''}.`}
    </Text>
  );
});

function BonusPill({ points }: { points: number }) {
  return (
    <View style={{ backgroundColor: playColors.bonus, borderRadius: 14, borderCurve: 'continuous', paddingHorizontal: 12, paddingVertical: 5 }}>
      <Text style={{ color: 'white', fontSize: 20, fontWeight: '900', fontFamily: 'ui-rounded' }}>{`+${points}`}</Text>
    </View>
  );
}

function Particle({ index, motion }: { index: number; motion: ReturnType<typeof useRevealMotion> }) {
  const style = useParticleStyle(index, motion.burst, motion.burstCount);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          width: 10,
          height: 10,
          marginLeft: -5,
          marginTop: -5,
          borderRadius: 5,
          backgroundColor: playColors.particles[index % playColors.particles.length],
        },
        style,
      ]}
    />
  );
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
  // What the timeline shows (number, MULT) lives in a store the memoised parts
  // read; the rest of the screen changes a few times per reveal.
  const [store] = useState(() => createStore<RevealState>(INITIAL_REVEAL_STATE));
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
  const mounted = useRef(true);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // The reveal's own timeline: its end state is where a skip lands.
  const timeline = useRef<Event[] | null>(null);
  const phaseNow = useRef<Phase>('loading');
  useEffect(() => {
    phaseNow.current = phase;
  }, [phase]);

  const score = data?.score ?? null;
  const question = data?.question ?? null;
  const base = score ? (baseStep(score)?.total ?? 0) : 0;
  // Analytics: when the question appeared (previews are test events).
  const questionShownAt = useRef<number | null>(null);

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

  /** Applies a batch of events to the number and the badge in one store update (one render). */
  const show = useCallback(
    (events: readonly Event[]) => {
      const next = events.reduce(applyRevealEvent, store.get());
      for (const event of events) {
        if (event.type === 'count' || event.type === 'mult' || event.type === 'slam') diagnostics?.expect(next.value);
      }
      store.set(next);
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
      const events = timeline.current;
      if (!score || !events) return;
      if (endedBy === 'skip') {
        const { stage } = store.get();
        track('reveal_skipped', { step: stage > 0 ? `streak_${stage}` : 'base' }, { isTest: data?.preview ?? false });
      }
      playbacks.current.forEach((playback) => playback.cancel(endedBy === 'background' ? 0 : 30));
      playbacks.current = [];
      timers.current.forEach(clearTimeout);
      timers.current = [];
      const end = endState(events);
      motion.settle(end.stage);
      store.set(end);
      setPhase(question ? 'total' : 'done');
      if (endedBy === 'skip' && withSound.current) play('total_chord', VOLUME.total);
      if (endedBy !== 'background') fireHaptic('success');
      if (endedBy === 'voiceover') AccessibilityInfo.announceForAccessibilityWithOptions(revealSummary(score, data?.preview), { queue: true });
      stopDiagnostics();
      schedule(endedBy === 'skip' && !reduceMotion ? 500 : 0, showQuestion);
    },
    [score, question, motion, store, schedule, reduceMotion, showQuestion, stopDiagnostics, setPhase, data],
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
    if (!score || reduceMotion === null || screenReader === null || started.current) return;
    started.current = true;
    track(
      'reveal_shown',
      { total: score.total, discovery: false, streak_weeks: streakStep(score)?.weeks ?? 0, preview: data?.preview ?? false },
      { isTest: data?.preview ?? false },
    );
    timeline.current = buildRevealTimeline({ score, reduceMotion, bonus: !!question });
    if (screenReader) {
      finish('voiceover');
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
    const playback = playTimeline(timeline.current, noSound ? null : revealSoundtrack, onEvents, {
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
    question,
    reduceMotion,
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

  if (!data || !score) return <View style={{ flex: 1, backgroundColor: playColors.backdrop }} />;

  const playing = phase === 'playing';
  const showDone = phase === 'done' || phase === 'answered';
  const { styles } = motion;

  return (
    <Pressable
      style={{ flex: 1, experimental_backgroundImage: playColors.background }}
      onPress={playing ? () => finish('skip') : undefined}
      // Not one big VoiceOver element: the answers and buttons inside stay reachable.
      accessible={false}
      onAccessibilityEscape={() => router.back()}>
      {diagnostics ? <FrameProbe active={probing} onSample={diagnostics.frame} /> : null}
      <SafeAreaView style={{ flex: 1, padding: spacing.xl }}>
        <View style={{ alignItems: 'center', gap: spacing.xs }}>
          <Text style={[type.footnote, { color: 'rgba(255,255,255,0.7)', fontWeight: '700', letterSpacing: 1.5 }]}>
            {data.preview ? 'VOORBEELD · DEV-MODUS' : data.isTest ? 'TESTINWORP · DEV-MODUS' : 'INWORP GEREGISTREERD'}
          </Text>
        </View>

        <Animated.View style={[{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.xl }, styles.shakeStyle]}>
          {/* POINTS × MULT */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
            <Animated.View
              style={[
                { backgroundColor: playColors.chips, borderRadius: 18, borderCurve: 'continuous', paddingHorizontal: 18, paddingVertical: 10, alignItems: 'center', minWidth: 112 },
                styles.chipStyle,
              ]}>
              <Text style={[type.footnote, { color: 'rgba(255,255,255,0.85)', fontWeight: '800', letterSpacing: 1 }]}>PUNTEN</Text>
              <ChipsValue store={store} base={base} />
            </Animated.View>
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 28, fontWeight: '800' }}>×</Text>
            <View>
              <Animated.View
                pointerEvents="none"
                style={[
                  { position: 'absolute', top: -10, right: -10, bottom: -10, left: -10, borderRadius: 28, backgroundColor: playColors.heat, boxShadow: `0 0 24px ${playColors.heat}` },
                  styles.glowStyle,
                ]}
              />
              <Animated.View
                style={[{ borderRadius: 18, borderCurve: 'continuous', paddingHorizontal: 18, paddingVertical: 10, alignItems: 'center', minWidth: 112 }, styles.multStyle]}>
                <MultBadgeText store={store} />
              </Animated.View>
            </View>
          </View>

          {/* TOTAL, with the slam's particles, the bonus ring, the flying +5 and its badge */}
          <View style={{ alignItems: 'center' }}>
            {/* The box hugs the number: the badge sits on its corner, the flying +5 aims at the measured size. */}
            <View
              onLayout={(e) => motion.setNumberSize(e.nativeEvent.layout.width, e.nativeEvent.layout.height)}
              style={{ alignItems: 'center', justifyContent: 'center' }}>
              <Animated.View
                pointerEvents="none"
                style={[{ position: 'absolute', width: 180, height: 180, borderRadius: 90, borderWidth: 4, borderColor: playColors.bonus }, styles.ringStyle]}
              />
              <Animated.View style={styles.totalStyle}>
                <TotalNumber store={store} onCommit={diagnostics ? onNumberCommit : undefined} />
              </Animated.View>
              <View pointerEvents="none" style={{ position: 'absolute', top: '50%', left: '50%' }}>
                {Array.from({ length: MAX_PARTICLES }, (_, i) => (
                  <Particle key={i} index={i} motion={motion} />
                ))}
                <Animated.View style={[{ position: 'absolute', marginLeft: -26, marginTop: -16 }, styles.arcStyle]}>
                  <BonusPill points={question?.points ?? 5} />
                </Animated.View>
              </View>
              <Animated.View pointerEvents="none" style={[{ position: 'absolute', ...BADGE_OFFSET }, styles.badgeStyle]}>
                <BonusPill points={question?.points ?? 5} />
              </Animated.View>
            </View>
            <Text style={[type.title3, { color: 'rgba(255,255,255,0.75)' }]}>{bonusShown ? 'punten met bonus' : 'punten'}</Text>
          </View>

          <StreakLine store={store} streak={streakStep(score)} />
        </Animated.View>

        {playing ? (
          <Text
            onPress={() => finish('skip')}
            accessibilityRole="button"
            accessibilityLabel="Overslaan"
            style={[type.footnote, { color: 'rgba(255,255,255,0.5)', textAlign: 'center' }]}>
            Tik om over te slaan
          </Text>
        ) : null}

        {question && (phase === 'question' || phase === 'answering') ? (
          <Animated.View style={styles.sheetStyle}>
            <GlassPanel dark style={{ padding: spacing.lg, gap: spacing.md }}>
              <Text style={[type.footnote, { color: colors.yellow, fontWeight: '700' }]}>{`BONUSVRAAG · +${question.points} PUNTEN`}</Text>
              <Text style={[type.title3, { color: 'white' }]}>{question.prompt}</Text>
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
                  style={[type.subheadline, { color: 'rgba(255,255,255,0.7)', textAlign: 'center', paddingTop: spacing.xs }]}>
                  Overslaan
                </Text>
              ) : null}
            </GlassPanel>
          </Animated.View>
        ) : null}

        {showDone ? (
          <View style={{ gap: spacing.md }}>
            {message ? <Text style={[type.subheadline, { color: colors.orange, textAlign: 'center' }]}>{message}</Text> : null}
            {measured ? (
              <Text selectable style={[type.footnote, { fontSize: 11, color: 'rgba(255,255,255,0.55)', textAlign: 'center' }]}>
                {describeMeasurements(measured)}
              </Text>
            ) : null}
            <Text style={[type.footnote, { color: 'rgba(255,255,255,0.65)', textAlign: 'center' }]}>
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
              <Button onPress={() => router.back()} modifiers={[buttonStyle('glassProminent'), controlSize('extraLarge'), tint(colors.tint)]}>
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
