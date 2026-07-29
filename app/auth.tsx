import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { requireSupabase } from '@/lib/supabase';
import { testIds } from '@/lib/testIds';
import { useSession } from '@/state/session';
import { color, radius, space } from '@/theme/tokens';

export default function AuthScreen() {
  const { t, isRTL } = useI18n();
  const { language, setLanguage } = useSession();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [secondsUntilResend, setSecondsUntilResend] = useState(0);

  useEffect(() => {
    if (secondsUntilResend <= 0) return;
    const timer = setInterval(() => {
      setSecondsUntilResend((remaining) => Math.max(0, remaining - 1));
    }, 1_000);
    return () => clearInterval(timer);
  }, [secondsUntilResend]);

  const sendLink = async () => {
    if (sending || secondsUntilResend > 0) return;
    const cleanEmail = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) {
      Alert.alert(t('auth.invalidEmail'));
      return;
    }
    setSending(true);
    try {
      const { error } = await requireSupabase().auth.signInWithOtp({
        email: cleanEmail,
        options: { emailRedirectTo: 'halalmode://auth' },
      });
      if (error) throw error;
      // Supabase remains the authority for rate limits. This short local pause
      // protects people from accidentally requesting several identical links.
      setSecondsUntilResend(60);
      Alert.alert(t('auth.checkEmail'), t('auth.linkSent'));
    } catch {
      Alert.alert(t('auth.sendFailed'), t('auth.sendFailedBody'));
    } finally {
      setSending(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.content, isRTL && styles.rtl]}
      >
        <View>
          <Pressable
            testID={testIds.auth.language}
            accessibilityRole="button"
            accessibilityLabel={t('auth.switchLanguageLabel')}
            onPress={() => setLanguage(language === 'en' ? 'ar' : 'en')}
            style={[styles.language, isRTL && styles.languageRTL]}
          >
            <Text style={styles.languageLabel}>
              {language === 'en' ? t('auth.switchArabic') : t('auth.switchEnglish')}
            </Text>
          </Pressable>
          <Text variant="microAccent" style={isRTL ? styles.rtlText : undefined}>{t('auth.welcome')}</Text>
          <Text variant="display" style={[styles.title, isRTL && styles.rtlText]}>{t('auth.title')}</Text>
          <Text variant="body" style={[styles.copy, isRTL && styles.rtlText]}>{t('auth.body')}</Text>
        </View>
        <View style={styles.form}>
          <Text variant="label" style={isRTL ? styles.rtlText : undefined}>{t('auth.email')}</Text>
          <TextInput
            testID={testIds.auth.email}
            accessibilityLabel={t('auth.email')}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            placeholder={t('auth.emailPlaceholder')}
            placeholderTextColor={color.faintest}
            value={email}
            onChangeText={setEmail}
            style={[styles.input, isRTL && styles.inputRTL]}
          />
          <Button
            testID={testIds.auth.submit}
            label={secondsUntilResend > 0 ? t('auth.waitToResend', { seconds: secondsUntilResend }) : t('auth.send')}
            loading={sending}
            disabled={secondsUntilResend > 0}
            onPress={() => void sendLink()}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, justifyContent: 'space-between', padding: space.gutterWide, paddingBottom: 48 },
  rtl: { direction: 'rtl' },
  language: {
    alignSelf: 'flex-end', borderWidth: 1, borderColor: '#D9D6CE', borderRadius: radius.pill,
    paddingVertical: 7, paddingHorizontal: 12, marginBottom: 28,
  },
  languageRTL: { alignSelf: 'auto', marginRight: 'auto', marginLeft: 0 },
  languageLabel: { fontFamily: 'Beiruti_600SemiBold', fontSize: 13, color: color.ink },
  title: { marginTop: 10, fontSize: 32, lineHeight: 38 },
  copy: { marginTop: 12, maxWidth: 310 },
  form: { gap: 10 },
  input: {
    borderWidth: 1, borderColor: '#D9D6CE', borderRadius: radius.lg,
    paddingHorizontal: 15, height: 52, color: color.ink, fontFamily: 'Beiruti_400Regular', fontSize: 16,
  },
  inputRTL: { textAlign: 'right', writingDirection: 'rtl' },
  rtlText: { alignSelf: 'stretch', textAlign: 'right', writingDirection: 'rtl' },
});
