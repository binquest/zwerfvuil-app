// The avatar picker (docs/GAMIFICATION.md, chapter 5), a sheet from the
// profile: every avatar in a grid, locked ones as silhouettes with a lock. A
// tap shows it on top with how to unlock it ("Hoe ontgrendel je dit? Bereik
// level 5"); an unlocked one is put on with the button.
import { router, Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { track } from '@/analytics';
import { Avatar, AvatarGrid, ChunkyButton, PendingTag } from '@/components/game';
import { choiceLine, RARITY_LABEL, type AvatarChoice } from '@/game/avatars';
import { fetchMyAvatars, setMyAvatar } from '@/lib/api';
import { genericErrorMessage, identityErrorMessage } from '@/lib/errors';
import { useAuth } from '@/providers/AuthProvider';
import { colors, spacing, type } from '@/theme';
import { playType } from '@/theme/game';

export default function AvatarPickerScreen() {
  const { updateProfile } = useAuth();
  const [choices, setChoices] = useState<AvatarChoice[] | null>(null);
  const [focused, setFocused] = useState<AvatarChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    fetchMyAvatars()
      .then((all) => {
        if (!active) return;
        setChoices(all);
        setFocused(all.find((c) => c.current) ?? all[0] ?? null);
      })
      .catch((e) => active && setError(genericErrorMessage(e as Error)));
    return () => {
      active = false;
    };
  }, []);

  const wear = async () => {
    if (!focused || focused.status !== 'unlocked' || focused.current || saving) return;
    setSaving(true);
    setError(null);
    try {
      await setMyAvatar(focused.key);
      track('avatar_changed', { avatar_key: focused.key, from: 'profile' });
      updateProfile({ avatarKey: focused.key });
      router.back();
    } catch (e) {
      setError(identityErrorMessage(e as { code?: string }));
      setSaving(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Avatar' }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Sluiten" onPress={() => router.back()} />
      </Stack.Toolbar>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.xl }}>
        {focused ? (
          <View style={{ alignItems: 'center', gap: spacing.sm }}>
            <Avatar avatarKey={focused.key} size={96} locked={focused.status !== 'unlocked'} />
            <Text style={[type.title3, { color: colors.label }]}>{focused.name}</Text>
            {focused.status === 'locked' ? (
              <View style={{ alignItems: 'center', gap: spacing.xs }}>
                <Text style={[playType.label, { color: colors.secondaryLabel }]}>Hoe ontgrendel je dit?</Text>
                <Text style={[type.body, { color: colors.label, textAlign: 'center' }]}>{focused.hint ?? 'Nog vergrendeld'}</Text>
              </View>
            ) : focused.status === 'pending' ? (
              <View style={{ alignItems: 'center', gap: spacing.xs }}>
                <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{RARITY_LABEL[focused.rarity]}</Text>
                <PendingTag />
              </View>
            ) : (
              <Text style={[type.footnote, { color: colors.secondaryLabel }]}>{choiceLine(focused)}</Text>
            )}
          </View>
        ) : null}

        {choices ? (
          <AvatarGrid choices={choices} selected={focused?.key ?? null} onSelect={setFocused} />
        ) : error ? null : (
          <Text style={[type.body, { color: colors.secondaryLabel, textAlign: 'center' }]}>Avatars laden…</Text>
        )}

        {error ? <Text style={[type.footnote, { color: colors.red, textAlign: 'center' }]}>{error}</Text> : null}

        {focused && focused.status === 'unlocked' && !focused.current ? (
          <ChunkyButton title={saving ? 'Bewaren…' : `Kies ${focused.name}`} onPress={wear} disabled={saving} />
        ) : null}
      </ScrollView>
    </>
  );
}
