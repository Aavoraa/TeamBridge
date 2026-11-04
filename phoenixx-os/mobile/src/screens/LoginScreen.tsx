import { useState } from 'react';
import {
  KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useAuth } from '../auth';
import { ApiError } from '../api';
import { Button, ErrorBanner } from '../components';
import { usePalette, type, spacing, radius, MIN_TOUCH } from '../theme';

export default function LoginScreen() {
  const p = usePalette();
  const { signIn } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError('');
    setLoading(true);
    try {
      await signIn(email.trim(), password, needsTotp ? totp : undefined);
    } catch (err: any) {
      if (err instanceof ApiError && err.code === 'totp_required') {
        setNeedsTotp(true);
        setError('Enter the 6-digit code from your authenticator app.');
      } else {
        setError(err.message || 'Could not sign you in.');
      }
    } finally {
      setLoading(false);
    }
  };

  const input = [styles.input, { backgroundColor: p.raised, borderColor: p.lineStrong, color: p.ink }];

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: p.surface }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={[styles.logo, { backgroundColor: p.brand }]}>
          <Text style={{ color: '#fff', fontSize: 22, fontWeight: '700' }}>P</Text>
        </View>

        <Text style={[type.h1, { color: p.ink, marginTop: spacing.lg }]}>Phoenixx OS</Text>
        <Text style={[type.body, { color: p.subtle, marginTop: 4, marginBottom: spacing.xl }]}>
          Sign in to pick up your day.
        </Text>

        {error ? <ErrorBanner message={error} /> : null}

        <Text style={[type.small, { color: p.muted, marginBottom: 6 }]}>Work email</Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          style={input}
          placeholder="you@agency.com"
          placeholderTextColor={p.subtle}
          autoCapitalize="none"
          autoComplete="username"
          keyboardType="email-address"
          accessibilityLabel="Work email"
        />

        <Text style={[type.small, { color: p.muted, marginBottom: 6, marginTop: spacing.md }]}>Password</Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          style={input}
          placeholder="••••••••"
          placeholderTextColor={p.subtle}
          secureTextEntry
          autoComplete="current-password"
          accessibilityLabel="Password"
          onSubmitEditing={submit}
        />

        {needsTotp ? (
          <>
            <Text style={[type.small, { color: p.muted, marginBottom: 6, marginTop: spacing.md }]}>
              Authenticator code
            </Text>
            <TextInput
              value={totp}
              onChangeText={(t) => setTotp(t.replace(/\D/g, '').slice(0, 6))}
              style={[...input, { letterSpacing: 8, textAlign: 'center', fontSize: 18 }]}
              placeholder="000000"
              placeholderTextColor={p.subtle}
              keyboardType="number-pad"
              accessibilityLabel="Six digit authenticator code"
            />
          </>
        ) : null}

        <Button
          label="Sign in"
          variant="primary"
          onPress={submit}
          loading={loading}
          disabled={!email.trim() || !password}
          style={{ marginTop: spacing.xl }}
          full
        />

        <Text style={[type.tiny, { color: p.subtle, textAlign: 'center', marginTop: spacing.xl }]}>
          Attendance, action items, approvals and follow-ups work offline.
          Anything captured without a signal syncs the moment you reconnect.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  logo: { width: 48, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
});
