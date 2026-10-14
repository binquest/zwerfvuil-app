// The points reveal after a check-in: the number counts up to the base, then
// every streak week lands as its own beat (bigger, faster, higher), then the
// total, then an optional bonus question. Tap to skip. Respects the silent
// switch (sounds) and Reduce Motion (same sounds and haptics, no movement).
// The numbers come from the server; the Dev mode preview computes them locally
// and sends nothing.
//
// The beats are a timeline (src/feedback/reveal/timeline.ts) played by
// runTimeline; sounds and haptics come from src/feedback. This screen only
// turns the visual events into its (still simple) animations.
import { Host } from '@expo/ui';
import { Button, Label, Text as SwiftText } from '@expo/ui/swift-ui';
import {
  animation,
  Animation,
  buttonStyle,
  contentTransition,
  controlSize,
  disabled,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  minimumScaleFactor,
  monospacedDigit,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { router } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassPanel } from '@/components/GlassPanel';
import { fireHaptic, setHapticProbe } from '@/feedback/haptics';
import { createDiagnostics, describeMeasurements, type RevealMeasurements } from '@/feedback/reveal/diagnostics';
import { playFeedback } from '@/feedback/reveal/feedback';
import { runTimeline, type TimelineRun } from '@/feedback/reveal/run';
import { buildBonusTimeline, buildRevealTimeline, type Event } from '@/feedback/reveal/timeline';
import { VOLUME } from '@/feedback/reveal/tuning';
import { initSfx, play, READY_TIMEOUT_MS, releaseSfx, stopAll } from '@/feedback/sfx/engine';
import { answerBonus, markBonusShown } from '@/lib/api';
import { formatWeeks } from '@/lib/format';
import { formatMultiplier, MAX_STAGES, totalMultiplier, type BonusOption } from '@/lib/points';
import { takePendingReveal, type RevealData } from '@/lib/reveal';
import { useSyncState } from '@/lib/useSyncState';
import { colors, spacing, type } from '@/theme';

// total: the total has landed and the bonus question is about to appear.
type Phase = 'loading' | 'playing' | 'total' | 'question' | 'answering' | 'answered' | 'done';

const CHIP_BLUE = '#2E7CF6';
const CHIP_RED = '#F2453D';

function useReduceMotion(): boolean | null {
  const [reduce, setReduce] = useState<boolean | null>(null);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduce, () => setReduce(false));
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => subscription.remove();
  }, []);
  return reduce;
}

function bonusErrorMessage(error: { code?: string } | null): string {
  if (error?.code === '55000') return 'Deze vraag is verlopen of al beantwoord.';
  if (error?.code === 'P0002') return 'Deze vraag hoort niet bij je inworp.';
  return 'Je antwoord kon niet bewaard worden.';
}

export default function RevealScreen() {
  const [data] = useState<RevealData | null>(() => takePendingReveal());
  const reduceMotion = useReduceMotion();
  // Everything the timeline changes renders in the same JS task as its sound
  // (see useSyncState); with plain useState the screen lagged behind the sounds.
  const [phase, setPhase] = useSyncState<Phase>('loading');
  const [value, setValue] = useSyncState(0);
  const [stagesShown, setStagesShown] = useSyncState(0);
  const [bonusShown, setBonusShown] = useSyncState(false);
  const [message, setMessage] = useState<string | null>(null);
  const noSound = data?.noSound ?? false;
  // Dev mode preview only: timing measurements, shown when the reveal is done.
  const [diagnostics] = useState(() => (data?.preview ? createDiagnostics() : null));
  const [measured, setMeasured] = useState<RevealMeasurements | null>(null);

  // False when the sounds were not ready in time: the reveal then runs with haptics only.
  const withSound = useRef(false);
  const runs = useRef<TimelineRun[]>([]);
  const answering = useRef(false);
  const mounted = useRef(true);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [scale] = useState(() => new Animated.Value(1));
  const [flash] = useState(() => new Animated.Value(0));
  const [sheet] = useState(() => new Animated.Value(0));
  const [chipScales] = useState(() => Array.from({ length: MAX_STAGES + 2 }, () => new Animated.Value(0)));

  const points = data?.points ?? null;
  const question = data?.question ?? null;

  // Nothing to show (e.g. after a reload): back to the map.
  useEffect(() => {
    if (!data) router.back();
  }, [data]);

  useEffect(() => {
    // Usually already running: the camera and the Dev mode preview start it.
    if (!noSound) initSfx();
    mounted.current = true;
    return () => {
      mounted.current = false;
      runs.current.forEach((run) => run.cancel());
      runs.current = [];
      timers.current.forEach(clearTimeout);
      timers.current = [];
      setHapticProbe(null);
      diagnostics?.stop();
      releaseSfx();
    };
  }, [noSound, diagnostics]);

  // Diagnostics: when React has committed the number an event set.
  useLayoutEffect(() => {
    diagnostics?.committed(value);
  }, [diagnostics, value]);

  const stopDiagnostics = useCallback(() => {
    if (!diagnostics) return;
    setHapticProbe(null);
    setMeasured(diagnostics.stop());
  }, [diagnostics]);

  const schedule = useCallback((ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  const punch = useCallback(
    (peak: number) => {
      if (reduceMotion) return;
      scale.stopAnimation();
      Animated.sequence([
        Animated.timing(scale, { toValue: peak, duration: 90, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, friction: 4, tension: 160, useNativeDriver: true }),
      ]).start();
      flash.setValue(0.22);
      Animated.timing(flash, { toValue: 0, duration: 380, useNativeDriver: true }).start();
    },
    [reduceMotion, scale, flash],
  );

  const popChip = useCallback(
    (index: number) => {
      const chip = chipScales[index];
      if (reduceMotion) chip.setValue(1);
      else Animated.spring(chip, { toValue: 1, friction: 5, tension: 180, useNativeDriver: true }).start();
    },
    [reduceMotion, chipScales],
  );

  const showQuestion = useCallback(() => {
    if (!question) return;
    setPhase('question');
    if (reduceMotion) sheet.setValue(1);
    else Animated.spring(sheet, { toValue: 1, friction: 9, tension: 70, useNativeDriver: true }).start();
    // The server measures the answer time from here.
    if (data?.checkinId && !data.preview) markBonusShown(data.checkinId).catch(() => {});
  }, [question, reduceMotion, sheet, data, setPhase]);

  // Tap to skip: stop the timeline, fade out what sounds, land on the total
  // with only its chord and the success haptic.
  const finish = useCallback(() => {
    if (!points) return;
    runs.current.forEach((run) => run.cancel());
    runs.current = [];
    timers.current.forEach(clearTimeout);
    timers.current = [];
    stopAll(30);
    setValue(points.total);
    setStagesShown(points.stages.length);
    chipScales.forEach((chip) => chip.setValue(1));
    setPhase(question ? 'total' : 'done');
    if (withSound.current) play('total_chord', VOLUME.total);
    fireHaptic('success');
    punch(1.25);
    stopDiagnostics();
    schedule(reduceMotion ? 0 : 700, showQuestion);
  }, [
    points,
    question,
    chipScales,
    punch,
    schedule,
    reduceMotion,
    showQuestion,
    stopDiagnostics,
    setPhase,
    setStagesShown,
    setValue,
  ]);

  // Play the timeline once, as soon as the Reduce Motion setting is known (a
  // later change of the setting does not restart the reveal) and the sounds are
  // ready, or READY_TIMEOUT_MS has passed (then without sound). A skip and
  // leaving the screen cancel it.
  const started = useRef(false);
  useEffect(() => {
    if (!points || reduceMotion === null || started.current) return;
    started.current = true;
    const timeline = buildRevealTimeline({
      basePoints: points.base,
      streakWeeks: points.streakWeeks,
      stages: points.stages,
      reduceMotion,
      bonus: !!question,
    });
    const showNumber = (shown: number) => {
      diagnostics?.expect(shown);
      setValue(shown);
    };
    const onEvents = (batch: Event[], lateMs: number) => {
      diagnostics?.late(lateMs);
      for (const event of batch) {
        if (playFeedback(event, withSound.current)) continue;
        if (event.type === 'chipIn') {
          setPhase('playing');
          popChip(0);
        } else if (event.type === 'count') {
          showNumber(event.value);
        } else if (event.type === 'mult') {
          setStagesShown(event.stage);
          popChip(event.stage);
          showNumber(event.total);
          punch(event.peakScale);
        } else if (event.type === 'slam') {
          showNumber(event.to);
          setPhase(question ? 'total' : 'done');
          punch(1.25);
          schedule(600, stopDiagnostics);
        } else if (event.type === 'showBonusQuestion') {
          showQuestion();
        }
        // Shake, flash, hit-stop, heat and particles come with the new reveal screen.
      }
    };
    const waitStarted = performance.now();
    const timeout = new Promise<boolean>((resolve) => schedule(READY_TIMEOUT_MS, () => resolve(false)));
    const soundReady = noSound ? Promise.resolve(false) : Promise.race([initSfx(), timeout]);
    soundReady.then((ready) => {
      if (!mounted.current) return;
      withSound.current = ready;
      if (diagnostics) {
        diagnostics.ready(performance.now() - waitStarted, noSound ? 'off' : ready ? 'on' : 'not ready');
        setHapticProbe(diagnostics.haptic);
        diagnostics.start();
      }
      runs.current.push(runTimeline(timeline, onEvents));
    });
  }, [
    points,
    question,
    reduceMotion,
    noSound,
    diagnostics,
    popChip,
    punch,
    schedule,
    showQuestion,
    stopDiagnostics,
    setPhase,
    setStagesShown,
    setValue,
  ]);

  /** The +5 (or the quiet tock when there are no points) after the bonus question. */
  const playBonus = (bonus: number) => {
    if (!points) return;
    const timeline = buildBonusTimeline({ awarded: bonus > 0, points: bonus, fromTotal: points.total, reduceMotion: !!reduceMotion });
    const onEvents = (batch: Event[]) => {
      for (const event of batch) {
        if (playFeedback(event, withSound.current)) continue;
        if (event.type === 'count') setValue(event.value);
        else if (event.type === 'punch') punch(event.scale);
        else if (event.type === 'badge') setBonusShown(true);
      }
    };
    runs.current.push(runTimeline(timeline, onEvents));
  };

  const answer = async (option: BonusOption) => {
    if (!points || !question || answering.current) return;
    answering.current = true;
    setPhase('answering');
    let bonus = question.points;
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
    setPhase('done');
    playBonus(0);
  };

  if (!data || !points) return <View style={{ flex: 1, backgroundColor: 'black' }} />;

  const playing = phase === 'playing';
  const showDone = phase === 'done' || phase === 'answered';
  const stageCount = points.stages.length;
  const capped = points.streakWeeks > stageCount && stageCount === MAX_STAGES;

  return (
    <Pressable
      style={{ flex: 1, experimental_backgroundImage: 'linear-gradient(180deg, #0E3A24 0%, #050806 65%)' }}
      onPress={playing ? finish : undefined}
      // Not one big VoiceOver element: the answers and buttons inside stay reachable.
      accessible={false}
      onAccessibilityEscape={() => router.back()}>
      <Animated.View
        pointerEvents="none"
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'white', opacity: flash }}
      />
      <SafeAreaView style={{ flex: 1, padding: spacing.xl }}>
        <View style={{ alignItems: 'center', gap: spacing.xs }}>
          <Text style={[type.footnote, { color: 'rgba(255,255,255,0.7)', fontWeight: '700', letterSpacing: 1.5 }]}>
            {data.preview ? 'VOORBEELD · DEV-MODUS' : data.isTest ? 'TESTINWORP · DEV-MODUS' : 'INWORP GEREGISTREERD'}
          </Text>
        </View>

        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg }}>
          <Animated.View style={{ transform: [{ scale }], alignItems: 'center' }}>
            <Host matchContents>
              <SwiftText
                modifiers={[
                  font({ size: 132, weight: 'black', design: 'rounded' }),
                  monospacedDigit(),
                  foregroundStyle('white'),
                  lineLimit(1),
                  minimumScaleFactor(0.4),
                  frame({ maxWidth: 340 }),
                  contentTransition('numericText'),
                  animation(Animation.snappy({ duration: 0.18 }), value),
                ]}>
                {String(value)}
              </SwiftText>
            </Host>
            <Text style={[type.title3, { color: 'rgba(255,255,255,0.75)' }]}>
              {bonusShown ? 'punten met bonus' : 'punten'}
            </Text>
          </Animated.View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm, maxWidth: 340 }}>
            <Animated.View style={{ transform: [{ scale: chipScales[0] }] }}>
              <View style={{ backgroundColor: CHIP_BLUE, borderRadius: 10, borderCurve: 'continuous', paddingHorizontal: 10, paddingVertical: 4 }}>
                <Text style={[type.headline, { color: 'white', fontVariant: ['tabular-nums'] }]}>{`${points.base} basis`}</Text>
              </View>
            </Animated.View>
            {points.stages.map((_, i) => (
              <Animated.View key={i} style={{ transform: [{ scale: chipScales[i + 1] }], opacity: i < stagesShown ? 1 : 0 }}>
                <View style={{ backgroundColor: CHIP_RED, borderRadius: 10, borderCurve: 'continuous', paddingHorizontal: 8 + i, paddingVertical: 4 }}>
                  <Text style={{ color: 'white', fontWeight: '800', fontSize: 15 + i * 1.5 }}>{formatMultiplier(points.multiplier)}</Text>
                </View>
              </Animated.View>
            ))}
          </View>

          {stageCount > 0 ? (
            <Text style={[type.subheadline, { color: 'rgba(255,255,255,0.8)', textAlign: 'center' }]}>
              {`Reeks van ${formatWeeks(points.streakWeeks)}: ${totalMultiplier(stagesShown, points.multiplier)}${capped ? ' (maximum)' : ''}`}
            </Text>
          ) : (
            <Text style={[type.subheadline, { color: 'rgba(255,255,255,0.8)', textAlign: 'center' }]}>
              Check volgende week opnieuw in voor een reeks: ×1,1 per week.
            </Text>
          )}
        </View>

        {playing ? (
          <Text
            onPress={finish}
            accessibilityRole="button"
            accessibilityLabel="Overslaan"
            style={[type.footnote, { color: 'rgba(255,255,255,0.5)', textAlign: 'center' }]}>
            Tik om over te slaan
          </Text>
        ) : null}

        {question && (phase === 'question' || phase === 'answering') ? (
          <Animated.View
            style={{
              opacity: sheet,
              transform: [{ translateY: sheet.interpolate({ inputRange: [0, 1], outputRange: [80, 0] }) }],
            }}>
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
              {data.preview
                ? 'Voorbeeld: er is niets bewaard.'
                : 'Je krijgt de punten zodra een admin je foto goedkeurt.'}
            </Text>
            <Host matchContents={{ vertical: true }} style={{ alignSelf: 'stretch' }}>
              <Button onPress={() => router.back()} modifiers={[buttonStyle('glassProminent'), controlSize('extraLarge'), tint(colors.tint)]}>
                <Label title="Klaar" systemImage="checkmark" modifiers={[frame({ maxWidth: 10000 }), font({ textStyle: 'headline' })]} />
              </Button>
            </Host>
          </View>
        ) : null}
      </SafeAreaView>
    </Pressable>
  );
}
