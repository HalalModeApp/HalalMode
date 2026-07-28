import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { requireSupabase } from '@/lib/supabase';
import { useAuth } from '@/state/auth';
import { alpha, color, font, radius, space } from '@/theme/tokens';

type Gender = 'male' | 'female';

interface OnboardingDraft {
  fullName: string;
  firstName: string;
  birthDay: string;
  birthMonth: string;
  birthYear: string;
  gender: Gender | null;
  city: string;
  country: string;
}

interface StoredOnboarding {
  step: number;
  draft: OnboardingDraft;
}

type DraftField = keyof OnboardingDraft;
type ValidationErrors = Partial<Record<DraftField | 'birthDate', string>>;

const LAST_STEP = 4;
const EMPTY_DRAFT: OnboardingDraft = {
  fullName: '',
  firstName: '',
  birthDay: '',
  birthMonth: '',
  birthYear: '',
  gender: null,
  city: '',
  country: '',
};

const STEP_NAMES = ['Welcome', 'Your name', 'Basic details', 'Location', 'Review'];

export default function OnboardingScreen() {
  const { user, refreshProfileStatus } = useAuth();
  const storageKey = `halalmode.onboarding.v2.${user?.id ?? 'current'}`;
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<OnboardingDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [restoring, setRestoring] = useState(true);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(storageKey)
      .then((raw) => {
        if (!active || !raw) return;
        const stored = JSON.parse(raw) as Partial<StoredOnboarding>;
        if (stored.draft) setDraft({ ...EMPTY_DRAFT, ...stored.draft });
        if (
          typeof stored.step === 'number' &&
          stored.step >= 0 &&
          stored.step <= LAST_STEP
        ) {
          setStep(stored.step);
        }
        setSaved(true);
      })
      .catch(() => {
        // A damaged local draft should not block account setup.
      })
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
    };
  }, [storageKey]);

  useEffect(() => {
    if (restoring) return;
    setSaved(false);
    const timer = setTimeout(() => {
      void AsyncStorage.setItem(storageKey, JSON.stringify({ step, draft }))
        .then(() => setSaved(true))
        .catch(() => setSaved(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, restoring, step, storageKey]);

  const birthDate = useMemo(() => formatBirthDate(draft), [draft]);

  const patch = <K extends DraftField>(field: K, value: OnboardingDraft[K]) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined, birthDate: undefined }));
    setSubmitError(null);
  };

  const goNext = () => {
    const nextErrors = validateStep(step, draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setStep((current) => Math.min(LAST_STEP, current + 1));
  };

  const goBack = () => {
    setErrors({});
    setSubmitError(null);
    setStep((current) => Math.max(0, current - 1));
  };

  const complete = async () => {
    const allErrors = [1, 2, 3].reduce<ValidationErrors>(
      (current, currentStep) => ({
        ...current,
        ...validateStep(currentStep, draft),
      }),
      {}
    );
    if (Object.keys(allErrors).length > 0 || !birthDate || !draft.gender) {
      setErrors(allErrors);
      setSubmitError('Some details still need your attention. Go back and check them.');
      return;
    }

    setSaving(true);
    setSubmitError(null);
    try {
      const { error } = await requireSupabase().rpc('complete_onboarding', {
        p_name: draft.fullName.trim(),
        p_first_name: draft.firstName.trim(),
        p_birth_date: birthDate,
        p_gender: draft.gender,
        p_city: draft.city.trim(),
        p_country: draft.country.trim(),
      });
      if (error) throw error;
      await AsyncStorage.removeItem(storageKey);
      await refreshProfileStatus();
    } catch {
      setSubmitError(
        'We could not finish your setup. Your answers are saved; please check your connection and try again.'
      );
    } finally {
      setSaving(false);
    }
  };

  if (restoring) {
    return (
      <Screen>
        <View style={styles.loading}>
          <ActivityIndicator color={color.ink} />
          <Text variant="bodySmall">Restoring your saved setup…</Text>
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
        <View style={styles.progressHeader}>
          <View style={styles.progressTop}>
            <Text variant="microAccent">
              Step {step + 1} of {LAST_STEP + 1} · {STEP_NAMES[step]}
            </Text>
            <Text variant="caption" accessibilityLiveRegion="polite">
              {saved ? 'Saved on this device' : 'Saving…'}
            </Text>
          </View>
          <View
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 1, max: LAST_STEP + 1, now: step + 1 }}
            style={styles.progressTrack}
          >
            <View
              style={[
                styles.progressFill,
                { width: `${((step + 1) / (LAST_STEP + 1)) * 100}%` },
              ]}
            />
          </View>
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {step === 0 ? <WelcomeStep /> : null}
          {step === 1 ? (
            <IdentityStep draft={draft} errors={errors} patch={patch} />
          ) : null}
          {step === 2 ? (
            <BasicDetailsStep draft={draft} errors={errors} patch={patch} />
          ) : null}
          {step === 3 ? (
            <LocationStep draft={draft} errors={errors} patch={patch} />
          ) : null}
          {step === 4 ? <ReviewStep draft={draft} birthDate={birthDate} /> : null}

          {submitError ? (
            <View
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={styles.submitError}
            >
              <Text style={styles.submitErrorTitle}>Setup was not completed</Text>
              <Text variant="bodySmall">{submitError}</Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={styles.footer}>
          {step > 0 ? (
            <Button label="Back" variant="secondary" onPress={goBack} style={styles.back} />
          ) : null}
          <Button
            label={
              step === LAST_STEP
                ? submitError
                  ? 'Try again'
                  : 'Finish setup'
                : step === 0
                  ? 'Start setup'
                  : 'Continue'
            }
            loading={saving}
            onPress={step === LAST_STEP ? () => void complete() : goNext}
            style={styles.next}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function WelcomeStep() {
  return (
    <View>
      <Text variant="display" style={styles.title}>
        Meet with clear intentions.
      </Text>
      <Text variant="body" style={styles.copy}>
        We use a few basic details to prepare appropriate, reciprocal introductions.
        You can review everything before finishing.
      </Text>
      <View style={styles.infoCard}>
        <InfoRow
          title="What people see"
          body="Your first name, age, city and the profile details you choose to share."
        />
        <InfoRow
          title="What stays private"
          body="Your full name, date of birth and matching choices are not shown in introductions."
        />
        <InfoRow
          title="Saved as you go"
          body="You can close the app and continue setup on this device later."
        />
      </View>
    </View>
  );
}

function IdentityStep({
  draft,
  errors,
  patch,
}: StepProps) {
  return (
    <View>
      <StepHeading
        title="What should we call you?"
        body="Your first name is shown in introductions. Your full name is collected for account checks and stays private."
      />
      <View style={styles.form}>
        <Field
          label="First name shown on your profile"
          value={draft.firstName}
          onChangeText={(value) => patch('firstName', value)}
          autoCapitalize="words"
          autoComplete="name-given"
          error={errors.firstName}
        />
        <Field
          label="Full name for your account"
          value={draft.fullName}
          onChangeText={(value) => patch('fullName', value)}
          autoCapitalize="words"
          autoComplete="name"
          error={errors.fullName}
        />
      </View>
    </View>
  );
}

function BasicDetailsStep({ draft, errors, patch }: StepProps) {
  return (
    <View>
      <StepHeading
        title="Your basic details"
        body="You must be at least 18. Your exact date of birth stays private; introductions show your age."
      />
      <View style={styles.form}>
        <Text variant="label">Date of birth</Text>
        <View style={styles.dateRow}>
          <DatePart
            label="Day"
            value={draft.birthDay}
            maxLength={2}
            onChangeText={(value) => patch('birthDay', digits(value))}
          />
          <DatePart
            label="Month"
            value={draft.birthMonth}
            maxLength={2}
            onChangeText={(value) => patch('birthMonth', digits(value))}
          />
          <DatePart
            label="Year"
            value={draft.birthYear}
            maxLength={4}
            onChangeText={(value) => patch('birthYear', digits(value))}
          />
        </View>
        {errors.birthDate ? <InlineError message={errors.birthDate} /> : null}

        <View style={styles.genderBlock}>
          <Text variant="label">Gender</Text>
          <Text variant="caption">
            Used to prepare appropriate introductions. Contact support if this needs correcting later.
          </Text>
          <View style={styles.genderRow}>
            {(['female', 'male'] as const).map((option) => {
              const selected = draft.gender === option;
              return (
                <Pressable
                  key={option}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => patch('gender', option)}
                  style={[styles.genderOption, selected && styles.genderOptionSelected]}
                >
                  <Text style={[styles.genderLabel, selected && styles.genderLabelSelected]}>
                    {option === 'female' ? 'Woman' : 'Man'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {errors.gender ? <InlineError message={errors.gender} /> : null}
        </View>
      </View>
    </View>
  );
}

function LocationStep({ draft, errors, patch }: StepProps) {
  return (
    <View>
      <StepHeading
        title="Where are you based?"
        body="Your city helps us find practical introductions. We do not show your precise location."
      />
      <View style={styles.form}>
        <Field
          label="City"
          value={draft.city}
          onChangeText={(value) => patch('city', value)}
          autoCapitalize="words"
          autoComplete="postal-address-locality"
          error={errors.city}
        />
        <Field
          label="Country"
          value={draft.country}
          onChangeText={(value) => patch('country', value)}
          autoCapitalize="words"
          autoComplete="country"
          error={errors.country}
        />
      </View>
    </View>
  );
}

function ReviewStep({ draft, birthDate }: { draft: OnboardingDraft; birthDate: string | null }) {
  return (
    <View>
      <StepHeading
        title="Check your details"
        body="Make sure these are correct before we prepare your profile. You can go back to make changes."
      />
      <View style={styles.reviewCard}>
        <ReviewRow label="Profile name" value={draft.firstName.trim()} />
        <ReviewRow label="Full name" value={draft.fullName.trim()} note="Private" />
        <ReviewRow label="Date of birth" value={birthDate ? readableDate(birthDate) : 'Not entered'} note="Private" />
        <ReviewRow label="Gender" value={draft.gender === 'female' ? 'Woman' : 'Man'} />
        <ReviewRow label="Location" value={`${draft.city.trim()}, ${draft.country.trim()}`} />
      </View>
      <Text variant="caption" style={styles.reviewNote}>
        Finishing creates your profile. You can add photos, a biography and matching preferences next.
      </Text>
    </View>
  );
}

interface StepProps {
  draft: OnboardingDraft;
  errors: ValidationErrors;
  patch: <K extends DraftField>(field: K, value: OnboardingDraft[K]) => void;
}

function StepHeading({ title, body }: { title: string; body: string }) {
  return (
    <View>
      <Text variant="display" style={styles.title}>{title}</Text>
      <Text variant="body" style={styles.copy}>{body}</Text>
    </View>
  );
}

function Field({
  label,
  error,
  ...props
}: { label: string; error?: string } & ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.field}>
      <Text variant="label">{label}</Text>
      <TextInput
        {...props}
        accessibilityLabel={label}
        accessibilityHint={error}
        placeholderTextColor={color.faintest}
        style={[styles.input, error && styles.inputError]}
      />
      {error ? <InlineError message={error} /> : null}
    </View>
  );
}

function DatePart(props: ComponentProps<typeof TextInput> & { label: string }) {
  const { label, ...inputProps } = props;
  return (
    <View style={styles.datePart}>
      <Text variant="caption">{label}</Text>
      <TextInput
        {...inputProps}
        accessibilityLabel={`Birth ${label.toLowerCase()}`}
        keyboardType="number-pad"
        placeholder={label === 'Year' ? 'YYYY' : label === 'Month' ? 'MM' : 'DD'}
        placeholderTextColor={color.faintest}
        style={styles.input}
      />
    </View>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <Text
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={styles.errorText}
    >
      {message}
    </Text>
  );
}

function InfoRow({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.infoRow}>
      <View style={styles.infoMark} />
      <View style={styles.infoText}>
        <Text variant="label">{title}</Text>
        <Text variant="bodySmall">{body}</Text>
      </View>
    </View>
  );
}

function ReviewRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <View style={styles.reviewRow}>
      <View style={styles.reviewLabelRow}>
        <Text variant="caption">{label}</Text>
        {note ? <Text style={styles.privateTag}>{note}</Text> : null}
      </View>
      <Text variant="label" style={styles.reviewValue}>{value}</Text>
    </View>
  );
}

function validateStep(step: number, draft: OnboardingDraft): ValidationErrors {
  if (step === 1) {
    const errors: ValidationErrors = {};
    if (draft.firstName.trim().length < 2) {
      errors.firstName = 'Enter the first name you want shown on your profile.';
    }
    if (draft.fullName.trim().length < 3 || !draft.fullName.trim().includes(' ')) {
      errors.fullName = 'Enter your first and last name.';
    }
    return errors;
  }

  if (step === 2) {
    const errors: ValidationErrors = {};
    const dateError = validateBirthDate(draft);
    if (dateError) errors.birthDate = dateError;
    if (!draft.gender) errors.gender = 'Choose your gender to continue.';
    return errors;
  }

  if (step === 3) {
    const errors: ValidationErrors = {};
    if (draft.city.trim().length < 2) errors.city = 'Enter your city.';
    if (draft.country.trim().length < 2) errors.country = 'Enter your country.';
    return errors;
  }

  return {};
}

function validateBirthDate(draft: OnboardingDraft): string | null {
  const value = formatBirthDate(draft);
  if (!value) return 'Enter a complete date of birth.';
  const date = new Date(`${value}T00:00:00`);
  const [year, month, day] = value.split('-').map(Number);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() + 1 !== month ||
    date.getDate() !== day
  ) {
    return 'Enter a real date of birth.';
  }
  const age = ageOnDate(date, new Date());
  if (age < 18) return 'You must be at least 18 to use Halal Mode.';
  if (age > 100) return 'Check the year you entered.';
  return null;
}

function formatBirthDate(draft: OnboardingDraft): string | null {
  if (!draft.birthYear || !draft.birthMonth || !draft.birthDay) return null;
  return `${draft.birthYear.padStart(4, '0')}-${draft.birthMonth.padStart(2, '0')}-${draft.birthDay.padStart(2, '0')}`;
}

function ageOnDate(birthDate: Date, today: Date): number {
  let age = today.getFullYear() - birthDate.getFullYear();
  if (
    today.getMonth() < birthDate.getMonth() ||
    (today.getMonth() === birthDate.getMonth() && today.getDate() < birthDate.getDate())
  ) {
    age -= 1;
  }
  return age;
}

function readableDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  progressHeader: {
    paddingHorizontal: space.gutterWide,
    paddingTop: 10,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: alpha.lineFaint,
  },
  progressTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  progressTrack: {
    height: 3,
    marginTop: 12,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: color.sandDeep,
  },
  progressFill: { height: '100%', borderRadius: 2, backgroundColor: color.ink },
  content: {
    flexGrow: 1,
    paddingHorizontal: space.gutterWide,
    paddingTop: 28,
    paddingBottom: 28,
  },
  title: { fontSize: 30, lineHeight: 37 },
  copy: { marginTop: 10, maxWidth: 340 },
  form: { marginTop: 26, gap: 17 },
  field: { gap: 7 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    borderRadius: radius.lg,
    paddingHorizontal: 15,
    color: color.ink,
    backgroundColor: color.surface,
    fontFamily: font.body,
    fontSize: 16,
  },
  inputError: { borderColor: '#A33A3A' },
  errorText: { fontFamily: font.bodyMedium, fontSize: 12, lineHeight: 18, color: '#A33A3A' },
  dateRow: { flexDirection: 'row', gap: 9 },
  datePart: { flex: 1, gap: 6 },
  genderBlock: { marginTop: 5, gap: 8 },
  genderRow: { flexDirection: 'row', gap: 10, marginTop: 3 },
  genderOption: {
    flex: 1,
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    borderRadius: radius.pill,
  },
  genderOptionSelected: { backgroundColor: color.ink, borderColor: color.ink },
  genderLabel: { fontFamily: font.bodyBold, fontSize: 13, color: color.ink },
  genderLabelSelected: { color: color.white },
  infoCard: {
    marginTop: 28,
    padding: 18,
    gap: 18,
    borderRadius: radius.panel,
    backgroundColor: color.sand,
  },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  infoMark: { width: 8, height: 8, borderRadius: 4, marginTop: 5, backgroundColor: color.gold },
  infoText: { flex: 1, gap: 4 },
  reviewCard: {
    marginTop: 26,
    paddingHorizontal: 18,
    borderWidth: 1,
    borderColor: alpha.line,
    borderRadius: radius.panel,
    backgroundColor: color.surface,
  },
  reviewRow: { paddingVertical: 16, gap: 5, borderBottomWidth: 1, borderBottomColor: alpha.lineFaint },
  reviewLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  reviewValue: { fontSize: 14 },
  privateTag: {
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
    backgroundColor: color.sand,
    color: color.gold,
    fontFamily: font.bodyBold,
    fontSize: 8,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  reviewNote: { marginTop: 15 },
  submitError: {
    marginTop: 18,
    padding: 14,
    gap: 4,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(163,58,58,0.32)',
    backgroundColor: 'rgba(163,58,58,0.06)',
  },
  submitErrorTitle: { fontFamily: font.bodyBold, fontSize: 13, color: '#843030' },
  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: space.gutterWide,
    paddingTop: 12,
    paddingBottom: 20,
    borderTopWidth: 1,
    borderTopColor: alpha.lineFaint,
    backgroundColor: color.surface,
  },
  back: { flex: 0.7 },
  next: { flex: 1.3 },
});
