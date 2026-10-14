// The points reveal after a check-in: the number counts up to the base, then
// every streak week lands as its own beat (bigger, faster, higher), then the
// total, then an optional bonus question. Tap to skip. Respects the silent
// switch (sounds) and Reduce Motion (no movement, straight to the result).
// The numbers come from the server; the Dev mode preview computes them locally
// and sends nothing.
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassPanel } from '@/components/GlassPanel';
import { answerBonus, markBonusShown } from '@/lib/api';
import { haptic, SoundBoard } from '@/lib/feedback';
import { formatWeeks } from '@/lib/format';
import { formatMultiplier, MAX_STAGES, totalMultiplier, type BonusOption } from '@/lib/points';
import { bonusBeat, revealBeats, takePendingReveal, type Beat, type RevealData } from '@/lib/reveal';
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
  const [phase, setPhase] = useState<Phase>('loading');
  const [value, setValue] = useState(0);
  const [stagesShown, setStagesShown] = useState(0);
  const [bonusShown, setBonusShown] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const sounds = useRef<SoundBoard | null>(null);
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
    const board = new SoundBoard();
    sounds.current = board;
    board.load();
    return () => {
      timers.current.forEach(clearTimeout);
      board.dispose();
    };
  }, []);

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
  }, [question, reduceMotion, sheet, data]);

  const finish = useCallback(() => {
    if (!points) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setValue(points.total);
    setStagesShown(points.stages.length);
    chipScales.forEach((chip) => chip.setValue(1));
    setPhase(question ? 'total' : 'done');
    sounds.current?.play('total');
    haptic.success();
    punch(1.25);
    schedule(reduceMotion ? 0 : 700, showQuestion);
  }, [points, question, chipScales, punch, schedule, reduceMotion, showQuestion]);

  // Play the beats once the Reduce Motion setting is known. All state changes
  // run from timers, which a skip (or leaving the screen) cancels.
  const started = useRef(false);
  useEffect(() => {
    if (!points || reduceMotion === null || started.current) return;
    started.current = true;
    const pending = timers.current;
    const stop = () => {
      pending.forEach(clearTimeout);
      timers.current = [];
      started.current = false;
    };
    if (reduceMotion) {
      schedule(0, finish);
      return stop;
    }
    schedule(0, () => {
      setPhase('playing');
      popChip(0);
    });
    let t = 350;
    for (const beat of revealBeats(points) as Beat[]) {
      if (beat.kind === 'count') {
        const stepMs = beat.durationMs / beat.steps.length;
        beat.steps.forEach((v, i) => {
          schedule(t + i * stepMs, () => {
            setValue(v);
            sounds.current?.play('tick');
            haptic.tick();
          });
        });
        t += beat.durationMs + 280;
      } else if (beat.kind === 'stage') {
        schedule(t, () => {
          setStagesShown(beat.stage);
          popChip(beat.stage);
          setValue(beat.to);
          sounds.current?.stage(beat.stage);
          haptic.stage(beat.stage);
          punch(beat.scale);
        });
        t += beat.durationMs;
      } else {
        schedule(t, finish);
      }
    }
    return stop;
  }, [points, reduceMotion, finish, popChip, punch, schedule]);

  const answer = async (option: BonusOption) => {
    if (!points || !question) return;
    setPhase('answering');
    if (data?.checkinId && !data.preview) {
      try {
        await answerBonus(data.checkinId, option.key);
      } catch (error) {
        setMessage(bonusErrorMessage(error as { code?: string }));
        setPhase('answered');
        return;
      }
    }
    setPhase('answered');
    setBonusShown(true);
    const beat = bonusBeat(points.total, question.points);
    if (beat.kind !== 'count' || reduceMotion) {
      setValue(points.total + question.points);
      sounds.current?.play('bonus');
      haptic.success();
      return;
    }
    const stepMs = beat.durationMs / beat.steps.length;
    beat.steps.forEach((v, i) =>
      schedule(i * stepMs, () => {
        setValue(v);
        sounds.current?.play('tick');
        haptic.tick();
      }),
    );
    schedule(beat.durationMs, () => {
      sounds.current?.play('bonus');
      haptic.success();
      punch(1.18);
    });
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
      accessibilityLabel={playing ? 'Tik om over te slaan' : undefined}>
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
          <Text style={[type.footnote, { color: 'rgba(255,255,255,0.5)', textAlign: 'center' }]}>Tik om over te slaan</Text>
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
              <Text
                onPress={() => setPhase('done')}
                style={[type.subheadline, { color: 'rgba(255,255,255,0.7)', textAlign: 'center', paddingTop: spacing.xs }]}>
                Overslaan
              </Text>
            </GlassPanel>
          </Animated.View>
        ) : null}

        {showDone ? (
          <View style={{ gap: spacing.md }}>
            {message ? <Text style={[type.subheadline, { color: colors.orange, textAlign: 'center' }]}>{message}</Text> : null}
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
