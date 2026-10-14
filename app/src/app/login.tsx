// Sign in with a 6-digit code by email, as a native form.
import { Host } from '@expo/ui';
import { Button, Form, Image, Label, Section, Text, TextField, useNativeState, VStack } from '@expo/ui/swift-ui';
import {
  autocorrectionDisabled,
  buttonStyle,
  controlSize,
  disabled,
  font,
  foregroundStyle,
  frame,
  keyboardType,
  listRowBackground,
  multilineTextAlignment,
  onSubmit,
  padding,
  submitLabel,
  textContentType,
  textInputAutocapitalization,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import { useState } from 'react';
import { Linking } from 'react-native';

import { SUPABASE_URL } from '@/lib/env';
import { authErrorMessage } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { colors } from '@/theme';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

function PrimaryButton({ title, busy, onPress, enabled = true }: { title: string; busy: boolean; onPress: () => void; enabled?: boolean }) {
  return (
    <Button
      onPress={onPress}
      modifiers={[
        buttonStyle('borderedProminent'),
        controlSize('large'),
        tint(colors.tint),
        disabled(busy || !enabled),
        listRowBackground('clear'),
      ]}>
      <Text modifiers={[frame({ maxWidth: 10000 }), font({ textStyle: 'headline' })]}>{busy ? 'Even geduld…' : title}</Text>
    </Button>
  );
}

export default function LoginScreen() {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  // Changes on every code request, so the code field starts empty again.
  const [codeRound, setCodeRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keeps the typed address when going back from the code step.
  const emailText = useNativeState('');

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
    setCodeRound((n) => n + 1);
    setStep('code');
  };

  const verify = async () => {
    const digits = code.replace(/\D/g, '');
    if (!/^\d{6}$/.test(digits)) {
      setError('De code bestaat uit 6 cijfers.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.verifyOtp({ email, token: digits, type: 'email' });
    setBusy(false);
    // On success the auth listener switches to the map.
    if (verifyError) setError(authErrorMessage(verifyError));
  };

  return (
    <Host style={{ flex: 1 }}>
      <Form>
        <Section>
          <VStack spacing={10} modifiers={[frame({ maxWidth: 10000 }), padding({ vertical: 16 }), listRowBackground('clear')]}>
            <Image systemName="trash.circle.fill" size={72} color={colors.tint} />
            <Text modifiers={[font({ textStyle: 'largeTitle', weight: 'bold' })]}>Zwerfvuil Gent</Text>
            <Text modifiers={[font({ textStyle: 'subheadline' }), secondary, multilineTextAlignment('center')]}>
              Raap zwerfvuil op, gooi het in een openbare vuilbak en verdien punten.
            </Text>
          </VStack>
        </Section>

        {step === 'email' ? (
          <>
            <Section title="E-mailadres" footer={<Text>We sturen je een code van 6 cijfers. Je hebt geen wachtwoord nodig.</Text>}>
              <TextField
                text={emailText}
                placeholder="jij@voorbeeld.be"
                onTextChange={(text) => {
                  setEmail(text);
                  setError(null);
                }}
                modifiers={[
                  keyboardType('email-address'),
                  textContentType('emailAddress'),
                  textInputAutocapitalization('never'),
                  autocorrectionDisabled(),
                  submitLabel('send'),
                  onSubmit(sendCode),
                ]}
              />
            </Section>
            <Section>
              <PrimaryButton title="Stuur mij een code" busy={busy} onPress={sendCode} />
            </Section>
          </>
        ) : (
          <>
            <Section title="Code" footer={<Text>{`We hebben een code van 6 cijfers gestuurd naar ${email}.`}</Text>}>
              <TextField
                key={`code-${codeRound}`}
                placeholder="123456"
                autoFocus
                maxLength={6}
                onTextChange={(text) => {
                  setCode(text);
                  setError(null);
                }}
                modifiers={[
                  keyboardType('numeric'),
                  textContentType('oneTimeCode'),
                  submitLabel('done'),
                  onSubmit(verify),
                  font({ textStyle: 'title2', design: 'monospaced' }),
                ]}
              />
            </Section>
            <Section>
              <PrimaryButton
                title="Aanmelden"
                busy={busy}
                enabled={code.replace(/\D/g, '').length === 6}
                onPress={verify}
              />
            </Section>
            <Section>
              <Button label="Open Mail" systemImage="envelope" onPress={() => Linking.openURL('message://')} />
              <Button label="Stuur een nieuwe code" systemImage="arrow.clockwise" onPress={sendCode} modifiers={[disabled(busy)]} />
              <Button
                label="Ander e-mailadres"
                systemImage="pencil"
                onPress={() => {
                  setError(null);
                  setStep('email');
                }}
              />
            </Section>
            {__DEV__ ? (
              <Section>
                <Text modifiers={[font({ textStyle: 'footnote' }), secondary]}>
                  {`Lokaal: de e-mail staat in Mailpit op ${SUPABASE_URL.replace(/:54321$/, ':54324')}`}
                </Text>
              </Section>
            ) : null}
          </>
        )}

        {error ? (
          <Section>
            <Label title={error} systemImage="exclamationmark.triangle.fill" color={colors.red} />
          </Section>
        ) : null}
      </Form>
    </Host>
  );
}
