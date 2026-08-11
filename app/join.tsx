import { router } from 'expo-router';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { AGE_RANGES, joinWaitlist, type AgeRange } from '@/api/waitlist';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { nextSupportedLocale } from '@/i18n/locales';
import { testIds } from '@/lib/testIds';
import { useSession } from '@/state/session';
import { alpha, color, radius, space } from '@/theme/tokens';

/**
 * The public landing page behind halalmo.de.
 *
 * Deliberately separate from the app's own sign-in splash. That one greets
 * somebody who already knows what this is; this one has to explain the product
 * to a stranger and ask for three things. It is also the only screen reachable
 * without an account, so it assumes nothing about session state.
 *
 * Temporary by design: once signups open, this route retires and the domain
 * points at the app itself.
 */
export default function JoinScreen() {
  const { t, isRTL, localeTag } = useI18n();
  const { language, setLanguage } = useSession();

  const [email, setEmail] = useState('');
  const [city, setCity] = useState('');
  const [ageRange, setAgeRange] = useState<AgeRange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [joined, setJoined] = useState(false);

  const submit = async () => {
    if (sending) return;
    const cleanEmail = email.trim().toLowerCase();
    const cleanCity = city.trim();

    // Checked here so the answer is immediate and in the member's language; the
    // server checks all of it again, because this page is open to anyone.
    if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) return setError(t('join.invalidEmail'));
    if (cleanCity.length < 2) return setError(t('join.invalidCity'));
    if (!ageRange) return setError(t('join.invalidAge'));

    setError(null);
    setSending(true);
    try {
      await joinWaitlist({ email: cleanEmail, city: cleanCity, ageRange, locale: localeTag });
      setJoined(true);
    } catch {
      setError(t('join.errorBody'));
    } finally {
      setSending(false);
    }
  };

  if (joined) {
    return (
      <Screen>
        <View testID={testIds.join.success} style={[styles.success, isRTL && styles.rtl]}>
          <Text variant="microAccent">{t('join.eyebrow')}</Text>
          <Text variant="display" style={styles.title}>{t('join.successTitle')}</Text>
          <Text variant="body" style={styles.copy}>{t('join.successBody')}</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={[styles.content, isRTL && styles.rtl]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('auth.switchLanguageLabel')}
            onPress={() => setLanguage(nextSupportedLocale(language))}
            style={[styles.language, isRTL && styles.languageRTL]}
          >
            <Text style={styles.languageLabel}>
              {language === 'en' ? t('auth.switchArabic') : t('auth.switchEnglish')}
            </Text>
          </Pressable>

          <Text variant="microAccent">{t('join.eyebrow')}</Text>
          <Text variant="display" style={styles.title}>{t('join.title')}</Text>
          <Text variant="body" style={styles.copy}>{t('join.body')}</Text>

          <View style={styles.points}>
            {(['join.point1', 'join.point2', 'join.point3'] as const).map((key) => (
              <View key={key} style={[styles.point, isRTL && styles.rowReverse]}>
                <Text style={styles.bullet}>✦</Text>
                <Text variant="bodySmall" style={styles.pointText}>{t(key)}</Text>
              </View>
            ))}
          </View>

          <View style={styles.form}>
            <Text variant="label">{t('join.formTitle')}</Text>

            <Text variant="caption" style={styles.fieldLabel}>{t('join.email')}</Text>
            <TextInput
              testID={testIds.join.email}
              accessibilityLabel={t('join.email')}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              placeholder={t('join.emailPlaceholder')}
              placeholderTextColor={color.faintest}
              value={email}
              onChangeText={setEmail}
              style={[styles.input, isRTL && styles.inputRTL]}
            />

            <Text variant="caption" style={styles.fieldLabel}>{t('join.city')}</Text>
            <TextInput
              testID={testIds.join.city}
              accessibilityLabel={t('join.city')}
              autoComplete="postal-address-locality"
              placeholder={t('join.cityPlaceholder')}
              placeholderTextColor={color.faintest}
              value={city}
              onChangeText={setCity}
              style={[styles.input, isRTL && styles.inputRTL]}
            />

            <Text variant="caption" style={styles.fieldLabel}>{t('join.ageRange')}</Text>
            <View style={[styles.ages, isRTL && styles.rowReverse]}>
              {AGE_RANGES.map((range) => {
                const selected = ageRange === range;
                return (
                  <Pressable
                    key={range}
                    testID={testIds.join.age(range)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={range}
                    onPress={() => setAgeRange(range)}
                    style={[styles.age, selected && styles.ageSelected]}
                  >
                    <Text style={[styles.ageLabel, selected && styles.ageLabelSelected]}>
                      {range}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {error ? (
              <Text accessibilityRole="alert" variant="caption" style={styles.error}>
                {error}
              </Text>
            ) : null}

            <Text variant="caption" style={styles.privacyNote}>{t('join.privacyNote')}</Text>

            <Button
              testID={testIds.join.submit}
              label={t('join.submit')}
              loading={sending}
              onPress={() => void submit()}
            />

            <Pressable
              accessibilityRole="button"
              onPress={() => router.replace('/auth')}
              style={styles.signIn}
            >
              <Text variant="caption" style={styles.signInLabel}>{t('join.haveAccount')}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  rtl: { direction: 'rtl' },
  rowReverse: { flexDirection: 'row-reverse' },
  content: { padding: space.gutterWide, paddingBottom: space.xxl, gap: space.sm },
  language: { alignSelf: 'flex-start', paddingVertical: space.xs, paddingHorizontal: space.sm },
  languageRTL: { alignSelf: 'flex-end' },
  languageLabel: { color: color.inkSoft },
  title: { marginTop: space.xs },
  copy: { marginTop: space.sm, color: color.inkSoft },
  points: { marginTop: space.lg, gap: space.sm },
  point: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  bullet: { color: color.gold },
  pointText: { flex: 1, color: color.inkSoft },
  form: { marginTop: space.xl, gap: space.sm },
  fieldLabel: { marginTop: space.sm, color: color.inkSoft },
  input: {
    borderWidth: 1,
    borderColor: alpha.line,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    color: color.ink,
  },
  inputRTL: { textAlign: 'right' },
  ages: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs },
  age: {
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: alpha.line,
  },
  ageSelected: { backgroundColor: color.ink, borderColor: color.ink },
  ageLabel: { color: color.ink },
  ageLabelSelected: { color: color.white },
  error: { color: '#9C2F2F' },
  privacyNote: { color: color.inkSoft },
  signIn: { alignSelf: 'center', paddingVertical: space.md },
  signInLabel: { color: color.inkSoft, textDecorationLine: 'underline' },
  success: { flex: 1, justifyContent: 'center', padding: space.gutterWide, gap: space.sm },
});
