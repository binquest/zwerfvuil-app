// The points reveal after a check-in. The POINTS chip counts up to the base,
// the MULT badge climbs with every streak week (bigger, faster, hotter), the
// total slams in, then an optional bonus question with its +5. Tap to skip.
// Respects the silent switch (sounds) and Reduce Motion (same sounds and
// haptics, no movement). The numbers come from the server; the Dev mode
// preview computes them locally and sends nothing.
//
// The beats are a timeline (src/feedback/reveal/timeline.ts). playTimeline
// plays its mixed soundtrack and runs the visual and haptic events on the
// audio clock; this screen turns visual events into Reanimated motion
// (useRevealMotion) and the numbers into state.
import { Host } from '@expo/ui';
import { Button, Label, Text as SwiftText } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, disabled, font, frame, tint } from '@expo/ui/swift-ui/modifiers';
import { router } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassPanel } from '@/components/GlassPanel';
import { fireHaptic, setHapticProbe } from '@/feedback/haptics';
import { createDiagnostics, describeMeasurements, type RevealMeasurements } from '@/feedback/reveal/diagnostics';
import { playFeedback } from '@/feedback/reveal/feedback';
import { FrameProbe } from '@/feedback/reveal/FrameProbe';
import { BADGE_OFFSET, multiplierLabel } from '@/feedback/reveal/motion';
import { playTimeline, preloadTimeline, type Playback, type PlaybackStart } from '@/feedback/reveal/playback';
import { buildBonusTimeline, buildRevealTimeline, type Event } from '@/feedback/reveal/timeline';
import { VOLUME } from '@/feedback/reveal/tuning';
import { MAX_PARTICLES, useParticleStyle, useRevealMotion } from '@/feedback/reveal/useRevealMotion';
import { play, stopAll } from '@/feedback/sfx/engine';
import { bonusSoundtrack, revealSoundtrack, warmUpSounds } from '@/feedback/sfx/soundtrack';
import { answerBonus, markBonusShown } from '@/lib/api';
import { formatWeeks } from '@/lib/format';
import { MAX_STAGES, type BonusOption } from '@/lib/points';
import { setPendingReveal, takePendingReveal, type RevealData } from '@/lib/reveal';
import { useSyncState } from '@/lib/useSyncState';
import { colors, spacing, type } from '@/theme';

// total: the total has landed and the bonus question is about to appear.
type Phase = 'loading' | 'playing' | 'total' | 'question' | 'answering' | 'answered' | 'done';

const CHIP_BLUE = '#2E7CF6';
const BONUS_GREEN = '#30D158';
const PARTICLE_COLORS = ['#FFD60A', '#FF9F0A', '#FFFFFF'];

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

/** The big number shrinks with its digits (the Dev preview goes up to four), so it always fits next to its badge. */
function totalFontSize(value: number): number {
  return value >= 1000 ? 84 : value >= 100 ? 104 : 120;
}

function BonusPill({ points }: { points: number }) {
  return (
    <View style={{ backgroundColor: BONUS_GREEN, borderRadius: 14, borderCurve: 'continuous', paddingHorizontal: 12, paddingVertical: 5 }}>
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
        { position: 'absolute', width: 10, height: 10, marginLeft: -5, marginTop: -5, borderRadius: 5, backgroundColor: PARTICLE_COLORS[index % 3] },
        style,
      ]}
    />
  );
}

export default function RevealScreen() {
  const [data] = useState<RevealData | null>(() => takePendingReveal());
  const systemReduceMotion = useReduceMotion();
  // The Dev mode preview can force Reduce Motion, whatever the system setting.
  const forceReduceMotion = data?.forceReduceMotion ?? false;
  const reduceMotion = forceReduceMotion || systemReduceMotion;
  const motion = useRevealMotion(forceReduceMotion);
  // Everything the timeline changes renders in the same JS task as its event
  // (see useSyncState); with plain useState the screen lagged behind the sounds.
  const [phase, setPhase] = useSyncState<Phase>('loading');
  const [value, setValue] = useSyncState(0);
  const [stage, setStage] = useSyncState(0);
  const [maxShown, setMaxShown] = useSyncState(false);
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

  const points = data?.points ?? null;
  const question = data?.question ?? null;

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

  // Diagnostics: when React has committed the number an event set.
  useLayoutEffect(() => {
    diagnostics?.committed(value);
  }, [diagnostics, value]);

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

  const bonusTimeline = useCallback(
    (bonus: number) => buildBonusTimeline({ awarded: bonus > 0, points: bonus, fromTotal: points?.total ?? 0, reduceMotion: !!reduceMotion }),
    [points, reduceMotion],
  );

  const showQuestion = useCallback(() => {
    if (!question) return;
    setPhase('question');
    motion.showSheet();
    // The server measures the answer time from here.
    if (data?.checkinId && !data.preview) markBonusShown(data.checkinId).catch(() => {});
    // Mix and load the +5 now, so it plays at once after the answer.
    if (!noSound) preloadTimeline(bonusTimeline(question.points), bonusSoundtrack);
  }, [question, motion, data, setPhase, noSound, bonusTimeline]);

  // Tap to skip: stop the timeline, fade out the soundtrack, stand still on the
  // end state with only the chord and the success haptic.
  const finish = useCallback(() => {
    if (!points) return;
    playbacks.current.forEach((playback) => playback.cancel(30));
    playbacks.current = [];
    timers.current.forEach(clearTimeout);
    timers.current = [];
    motion.settle(points.stages.length);
    setValue(points.total);
    setStage(points.stages.length);
    setMaxShown(points.streakWeeks > MAX_STAGES);
    setPhase(question ? 'total' : 'done');
    if (withSound.current) play('total_chord', VOLUME.total);
    fireHaptic('success');
    stopDiagnostics();
    schedule(reduceMotion ? 0 : 500, showQuestion);
  }, [points, question, motion, schedule, reduceMotion, showQuestion, stopDiagnostics, setPhase, setStage, setMaxShown, setValue]);

  // Play the timeline once, as soon as the Reduce Motion setting is known (a
  // later change of the setting does not restart the reveal): with its mixed
  // soundtrack, or without sound when that is not ready in time. A skip and
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
        if (playFeedback(event)) continue;
        // Motion first (UI thread), then the numbers (one sync render per batch).
        motion.apply(event);
        if (event.type === 'chipIn') {
          setPhase('playing');
        } else if (event.type === 'count') {
          showNumber(event.value);
        } else if (event.type === 'mult') {
          setStage(event.stage);
          if (event.max) setMaxShown(true);
          showNumber(event.total);
        } else if (event.type === 'slam') {
          showNumber(event.to);
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
    points,
    question,
    reduceMotion,
    noSound,
    diagnostics,
    motion,
    schedule,
    showQuestion,
    startDiagnostics,
    stopDiagnostics,
    setPhase,
    setStage,
    setMaxShown,
    setValue,
  ]);

  /** The +5 with its own soundtrack, or one quiet tock when there are no points. */
  const playBonus = (bonus: number) => {
    if (!points) return;
    if (bonus <= 0) {
      if (!noSound) play('neutral_tock', VOLUME.tock);
      return;
    }
    const onEvents = (batch: Event[]) => {
      for (const event of batch) {
        if (playFeedback(event)) continue;
        motion.apply(event);
        if (event.type === 'count') setValue(event.value);
        else if (event.type === 'badge') setBonusShown(true);
      }
    };
    playbacks.current.push(playTimeline(bonusTimeline(bonus), noSound ? null : bonusSoundtrack, onEvents));
  };

  const answer = async (option: BonusOption) => {
    if (!points || !question || answering.current) return;
    answering.current = true;
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
    setPhase('done');
    playBonus(0);
  };

  /** Dev mode preview: the same reveal once more, on a fresh screen. */
  const replay = () => {
    if (!data) return;
    setPendingReveal(data);
    router.replace('/reveal');
  };

  if (!data || !points) return <View style={{ flex: 1, backgroundColor: 'black' }} />;

  const playing = phase === 'playing';
  const showDone = phase === 'done' || phase === 'answered';
  const chipValue = Math.min(value, points.base);
  const { styles } = motion;

  return (
    <Pressable
      style={{ flex: 1, experimental_backgroundImage: 'linear-gradient(180deg, #0E3A24 0%, #050806 65%)' }}
      onPress={playing ? finish : undefined}
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
                { backgroundColor: CHIP_BLUE, borderRadius: 18, borderCurve: 'continuous', paddingHorizontal: 18, paddingVertical: 10, alignItems: 'center', minWidth: 112 },
                styles.chipStyle,
              ]}>
              <Text style={[type.footnote, { color: 'rgba(255,255,255,0.85)', fontWeight: '800', letterSpacing: 1 }]}>PUNTEN</Text>
              <Text style={{ color: 'white', fontSize: 34, fontWeight: '900', fontFamily: 'ui-rounded', fontVariant: ['tabular-nums'] }}>
                {chipValue}
              </Text>
            </Animated.View>
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 28, fontWeight: '800' }}>×</Text>
            <View>
              <Animated.View
                pointerEvents="none"
                style={[
                  { position: 'absolute', top: -10, right: -10, bottom: -10, left: -10, borderRadius: 28, backgroundColor: '#FF2D95', boxShadow: '0 0 24px #FF2D95' },
                  styles.glowStyle,
                ]}
              />
              <Animated.View
                style={[{ borderRadius: 18, borderCurve: 'continuous', paddingHorizontal: 18, paddingVertical: 10, alignItems: 'center', minWidth: 112 }, styles.multStyle]}>
                <Text style={[type.footnote, { color: 'rgba(255,255,255,0.9)', fontWeight: '800', letterSpacing: 1 }]}>
                  {maxShown ? 'MULT · MAX' : 'MULT'}
                </Text>
                <Text style={{ color: 'white', fontSize: 34, fontWeight: '900', fontFamily: 'ui-rounded', fontVariant: ['tabular-nums'] }}>
                  {multiplierLabel(stage, points.multiplier)}
                </Text>
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
                style={[{ position: 'absolute', width: 180, height: 180, borderRadius: 90, borderWidth: 4, borderColor: BONUS_GREEN }, styles.ringStyle]}
              />
              <Animated.View style={styles.totalStyle}>
                <Text
                  numberOfLines={1}
                  style={{ color: 'white', fontSize: totalFontSize(value), lineHeight: 132, fontWeight: '900', fontFamily: 'ui-rounded', fontVariant: ['tabular-nums'] }}>
                  {value}
                </Text>
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

          <Text style={[type.subheadline, { color: 'rgba(255,255,255,0.8)', textAlign: 'center' }]}>
            {points.stages.length > 0
              ? `Reeks van ${formatWeeks(points.streakWeeks)}${maxShown ? ' · maximum' : ''}`
              : 'Check volgende week opnieuw in voor een reeks: ×1,1 per week.'}
          </Text>
        </Animated.View>

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
      {/* The flash covers everything, on top. */}
      <Animated.View
        pointerEvents="none"
        style={[{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'white' }, styles.flashStyle]}
      />
    </Pressable>
  );
}
