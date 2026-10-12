import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { SUPABASE_URL } from '@/lib/env';
import { authErrorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginScreen() {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const sendCode = async () => {
    const address = email.trim().toLowerCase();
    if (!EMAIL.test(address)) {
      setError('Vul een geldig e-mailadres in.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: address,
      options: { shouldCreateUser: true },
    });
    setBusy(false);
    if (otpError) {
      setError(authErrorMessage(otpError));
      return;
    }
    setEmail(address);
    setCode('');
    setStep('code');
    setInfo(`We hebben een code van 6 cijfers gestuurd naar ${address}.`);
  };

  const verify = async () => {
    if (!/^\d{6}$/.test(code)) {
      setError('De code bestaat uit 6 cijfers.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' });
    setBusy(false);
    // On success the auth listener switches to the map.
    if (verifyError) setError(authErrorMessage(verifyError));
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
        <Text style={styles.title}>Zwerfvuil Gent</Text>
        <Text style={styles.subtitle}>Raap zwerfvuil op, gooi het in een openbare vuilbak en verdien punten.</Text>

        {step === 'email' ? (
          <View style={styles.form}>
            <Text style={styles.label}>E-mailadres</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={(text) => {
                setEmail(text);
                setError(null);
              }}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
              placeholder="jij@voorbeeld.be"
              returnKeyType="send"
              onSubmitEditing={sendCode}
            />
            <Button title="Stuur mij een code" onPress={sendCode} loading={busy} />
          </View>
        ) : (
          <View style={styles.form}>
            {info ? <Text style={styles.info}>{info}</Text> : null}
            <Text style={styles.label}>Code</Text>
            <TextInput
              style={[styles.input, styles.code]}
              value={code}
              onChangeText={(text) => {
                setCode(text.replace(/\D/g, '').slice(0, 6));
                setError(null);
              }}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              autoFocus
              onSubmitEditing={verify}
            />
            <Button title="Aanmelden" onPress={verify} loading={busy} disabled={code.length !== 6} />
            <View style={styles.links}>
              <Pressable onPress={sendCode} disabled={busy} hitSlop={8}>
                <Text style={styles.link}>Stuur een nieuwe code</Text>
              </Pressable>
              <Pressable onPress={() => setStep('email')} hitSlop={8}>
                <Text style={styles.link}>Ander e-mailadres</Text>
              </Pressable>
            </View>
            {__DEV__ ? (
              <Text style={styles.devHint}>
                Lokaal: de e-mail staat in Mailpit op {SUPABASE_URL.replace(/:54321$/, ':54324')}
              </Text>
            ) : null}
          </View>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  title: { fontSize: 32, fontWeight: '800', color: colors.primary },
  subtitle: { fontSize: 16, color: colors.muted, marginBottom: spacing.lg },
  form: { gap: spacing.md },
  label: { fontSize: 14, fontWeight: '600', color: colors.text },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: 17,
  },
  code: { fontSize: 28, letterSpacing: 8, textAlign: 'center' },
  info: { fontSize: 15, color: colors.text },
  links: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  link: { color: colors.primary, fontSize: 15, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 15 },
  devHint: { color: colors.muted, fontSize: 12, marginTop: spacing.md },
});
