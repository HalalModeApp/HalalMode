import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { requireSupabase } from '@/lib/supabase';
import { color, radius, space } from '@/theme/tokens';

export default function AuthScreen() {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);

  const sendLink = async () => {
    const cleanEmail = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) {
      Alert.alert('Enter a valid email address');
      return;
    }
    setSending(true);
    try {
      const { error } = await requireSupabase().auth.signInWithOtp({
        email: cleanEmail,
        options: { emailRedirectTo: 'halalmode://auth' },
      });
      if (error) throw error;
      Alert.alert('Check your email', 'We sent you a secure sign-in link.');
    } catch (error) {
      Alert.alert('Could not send the link', error instanceof Error ? error.message : 'Try again shortly.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.content}
      >
        <View>
          <Text variant="microAccent">Welcome</Text>
          <Text variant="display" style={styles.title}>A considered way to meet.</Text>
          <Text variant="body" style={styles.copy}>
            Enter your email and we’ll send a secure link to sign in or create your account.
          </Text>
        </View>
        <View style={styles.form}>
          <Text variant="label">Email address</Text>
          <TextInput
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            placeholder="you@example.com"
            placeholderTextColor={color.faintest}
            value={email}
            onChangeText={setEmail}
            style={styles.input}
          />
          <Button label="Send secure sign-in link" loading={sending} onPress={() => void sendLink()} />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, justifyContent: 'space-between', padding: space.gutterWide, paddingBottom: 48 },
  title: { marginTop: 10, fontSize: 32, lineHeight: 38 },
  copy: { marginTop: 12, maxWidth: 310 },
  form: { gap: 10 },
  input: {
    borderWidth: 1, borderColor: '#D9D6CE', borderRadius: radius.lg,
    paddingHorizontal: 15, height: 52, color: color.ink, fontFamily: 'Beiruti_400Regular', fontSize: 16,
  },
});
