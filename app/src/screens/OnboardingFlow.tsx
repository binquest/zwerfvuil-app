// The onboarding (docs/GAMIFICATION.md, chapter 5): name, then avatar, then
// the map. Texts from the prototype of the cofounder; style from theme/game.ts
// (three sizes: label, body, title; one button). Shown by the guard in the
// root layout until onboarded_at is set (also once for existing accounts),
// and in Dev mode as a preview that saves nothing.
//
// Live: "Op ontdekking" saves name and avatar (complete_onboarding), the
// profile gets onboarded_at and the guard opens the map. Preview: it closes.
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { track } from '@/analytics';
import { Avatar, AvatarGrid, ChunkyButton } from '@/components/game';
import { companionLine, MASCOT, type AvatarChoice } from '@/game/avatars';
import { cleanName, nameError, NAME_MAX } from '@/game/onboarding';
import { useGameCatalog } from '@/game/useGameCatalog';
import { completeOnboarding, fetchMyAvatars } from '@/lib/api';
import { identityErrorMessage } from '@/lib/errors';
import { useAuth } from '@/providers/AuthProvider';
import { colors, radius, spacing, type } from '@/theme';
import { playType } from '@/theme/game';

type Step = 'name' | 'avatar';

const styles = StyleSheet.create({
  kicker: { ...playType.label, color: colors.secondaryLabel },
  title: { fontSize: playType.value.fontSize, lineHeight: playType.value.lineHeight, fontWeight: '800', color: colors.label },
  body: { ...type.body, color: colors.secondaryLabel },
  label: { ...type.headline, color: colors.label },
  hint: { ...type.footnote, color: colors.secondaryLabel },
  error: { ...type.footnote, color: colors.red },
});

export function OnboardingFlow({ preview = false }: { preview?: boolean }) {
  const { profile, updateProfile } = useAuth();
  const catalog = useGameCatalog();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState(profile?.displayName ?? '');
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [choices, setChoices] = useState<AvatarChoice[] | null>(null);
  const [picked, setPicked] = useState<AvatarChoice | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    track('onboarding_step', { step }, { isTest: preview });
  }, [step, preview]);

  // The unlocked avatars (the default set for a new account). Offline: the
  // defaults of the catalog, so the step still shows; saving then says why not.
  useEffect(() => {
    let active = true;
    fetchMyAvatars()
      .then((all) => active && setChoices(all.filter((c) => c.status === 'unlocked')))
      .catch(() => active && setChoices(null));
    return () => {
      active = false;
    };
  }, []);
  const shown = useMemo<AvatarChoice[]>(
    () =>
      choices ??
      (catalog?.avatars ?? [])
        .filter((a) => a.unlockType === 'default')
        .map((a) => ({ ...a, status: 'unlocked' as const, hint: null, current: false })),
    [choices, catalog],
  );

  const toAvatar = () => {
    const problem = nameError(name);
    setNameProblem(problem);
    if (problem) return;
    setName(cleanName(name));
    setStep('avatar');
  };

  const finish = async () => {
    if (!picked || saving) return;
    if (preview) {
      router.back();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await completeOnboarding(cleanName(name), picked.key);
      track('avatar_changed', { avatar_key: picked.key, from: 'onboarding' });
      track('onboarding_completed', {});
      // The guard sees onboardedAt and opens the map.
      updateProfile(saved);
    } catch (e) {
      const error = e as { code?: string };
      setSaveError(identityErrorMessage(error));
      if (error.code === '22023') {
        setNameProblem(identityErrorMessage(error));
        setStep('name');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + spacing.xl,
          paddingBottom: insets.bottom + spacing.xl,
          paddingHorizontal: spacing.xl,
          gap: spacing.xl,
        }}>
        {preview ? (
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            style={{ position: 'absolute', top: insets.top + spacing.sm, right: spacing.lg, padding: spacing.sm }}>
            <Text style={[type.body, { color: colors.tint }]}>Sluiten</Text>
          </Pressable>
        ) : null}

        {step === 'name' ? (
          <Animated.View key="name" entering={FadeIn.duration(250)} style={{ flex: 1, gap: spacing.xl }}>
            <View style={{ alignItems: 'center', gap: spacing.lg }}>
              <Avatar avatarKey={MASCOT.key} size={96} />
              <Text style={styles.kicker} accessibilityRole="header">
                Welkom buiten
              </Text>
            </View>
            <View style={{ gap: spacing.md }}>
              <Text style={styles.title}>Een schonere buurt. Begint bij jou.</Text>
              <Text style={styles.body}>Raap zwerfvuil op, vind een vuilbak en maak van elke inworp een ontdekking.</Text>
            </View>
            <View style={{ gap: spacing.sm }}>
              <Text style={styles.label}>Hoe mogen we je noemen?</Text>
              <TextInput
                value={name}
                onChangeText={(text) => {
                  setName(text);
                  if (nameProblem) setNameProblem(nameError(text));
                }}
                onSubmitEditing={toAvatar}
                accessibilityLabel="Hoe mogen we je noemen?"
                placeholder="Je naam"
                placeholderTextColor={colors.tertiaryLabel}
                autoCapitalize="words"
                autoCorrect={false}
                textContentType="nickname"
                returnKeyType="next"
                maxLength={NAME_MAX * 2}
                style={[
                  type.body,
                  {
                    color: colors.label,
                    backgroundColor: colors.fill,
                    borderRadius: radius.control,
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.md,
                    minHeight: 52,
                  },
                ]}
              />
              <Text style={nameProblem ? styles.error : styles.hint}>
                {nameProblem ?? 'Deze naam is zichtbaar voor andere spelers. Je kunt hem later wijzigen.'}
              </Text>
            </View>
            <View style={{ flex: 1 }} />
            <ChunkyButton title="Kies je avatar →" onPress={toAvatar} />
          </Animated.View>
        ) : (
          <Animated.View key="avatar" entering={FadeIn.duration(250)} style={{ flex: 1, gap: spacing.xl }}>
            <View style={{ gap: spacing.md }}>
              <Text style={styles.title} accessibilityRole="header">
                Kies je reisgenoot.
              </Text>
              <Text style={styles.body}>Een klein gezicht voor jouw grote ontdekkingen. Later kun je altijd wisselen.</Text>
            </View>
            <View style={{ alignItems: 'center', gap: spacing.md }}>
              <Avatar avatarKey={picked?.key ?? shown[0]?.key ?? null} size={112} locked={!picked} />
              <Text style={[type.body, { color: picked ? colors.label : colors.secondaryLabel, fontWeight: '600' }]}>
                {picked ? companionLine(picked.name) : 'Tik op een reisgenoot.'}
              </Text>
            </View>
            <AvatarGrid choices={shown} selected={picked?.key ?? null} onSelect={setPicked} inset={spacing.xl} />
            {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
            <View style={{ flex: 1 }} />
            <View style={{ gap: spacing.md }}>
              <ChunkyButton title={saving ? 'Bewaren…' : 'Op ontdekking →'} onPress={finish} disabled={!picked || saving} />
              <Pressable
                onPress={() => setStep('name')}
                accessibilityRole="button"
                accessibilityLabel="Naam aanpassen"
                style={{ alignSelf: 'center', padding: spacing.sm }}>
                <Text style={[type.body, { color: colors.tint }]}>← Naam aanpassen</Text>
              </Pressable>
            </View>
          </Animated.View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
