import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import * as Location from 'expo-location';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useI18n, type Translate } from '@/i18n';
import { requireSupabase } from '@/lib/supabase';
import { fetchMyLegalConsentStatus } from '@/api/legalConsent';
import { documentFromStatus, type LegalConsentStatus } from '@/lib/legalConsent';
import { queryKeys } from '@/lib/queryClient';
import {
  clearOnboardingDraft,
  clearLegacyOnboardingDraft,
  loadOnboardingDraft,
  saveOnboardingDraft,
} from '@/lib/onboardingDraftStorage';
import { useAuth } from '@/state/auth';
import {
  birthDateValidationIssue,
  ageForBirthDateParts,
  formatBirthDate,
  normaliseDecimalDigits,
} from '@/lib/birthDate';
import { alpha, color, font, radius, space } from '@/theme/tokens';
import { testIds } from '@/lib/testIds';

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
  latitude?: number;
  longitude?: number;
}

type DraftField = keyof OnboardingDraft;
type ValidationErrors = Partial<Record<DraftField | 'birthDate' | 'legal', string>>;

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

export default function OnboardingScreen() {
  const { t, isRTL } = useI18n();
  const { user, refreshProfileStatus } = useAuth();
  const draftMemberId = user?.id ?? 'current';
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<OnboardingDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [restoring, setRestoring] = useState(true);
  const [saved, setSaved] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [ageConfirmationOpen, setAgeConfirmationOpen] = useState(false);
  const [legalAccepted, setLegalAccepted] = useState(false);
  const legalStatusQuery = useQuery({
    queryKey: queryKeys.legalConsent,
    queryFn: fetchMyLegalConsentStatus,
  });

  useEffect(() => {
    let active = true;
    void Promise.all([
      loadOnboardingDraft(draftMemberId),
      // The v2 draft contained PII in plaintext. Remove it even if the member
      // never reaches the completion step in this app version.
      clearLegacyOnboardingDraft(draftMemberId),
    ])
      .then(([stored]) => {
        if (!active || !stored) return;
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
  }, [draftMemberId]);

  useEffect(() => {
    if (restoring || completed) return;
    setSaved(false);
    const timer = setTimeout(() => {
      void saveOnboardingDraft(draftMemberId, step, draft)
        .then(() => setSaved(true))
        .catch(() => setSaved(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [completed, draft, draftMemberId, restoring, step]);

  const birthDate = useMemo(() => formatBirthDate(draft), [draft]);
  const derivedAge = useMemo(() => ageForBirthDateParts(draft), [draft]);

  const patch = <K extends DraftField>(field: K, value: OnboardingDraft[K]) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined, birthDate: undefined }));
    setSubmitError(null);
  };

  const goNext = async () => {
    if (step === 3 && (draft.latitude === undefined || draft.longitude === undefined)) {
      setLocating(true);
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status !== 'granted') {
          setErrors({ city: t('onboarding.locationPermissionRequired') });
          return;
        }
        const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const [place] = await Location.reverseGeocodeAsync(position.coords);
        const city = place?.city ?? place?.subregion ?? place?.region ?? '';
        const country = place?.country ?? '';
        if (city.length < 2 || country.length < 2) {
          setErrors({ city: t('onboarding.locationUnavailable') });
          return;
        }
        setDraft((current) => ({ ...current, city, country, latitude: position.coords.latitude, longitude: position.coords.longitude }));
        setErrors({});
        setStep((current) => Math.min(LAST_STEP, current + 1));
      } catch {
        setErrors({ city: t('onboarding.locationUnavailable') });
      } finally {
        setLocating(false);
      }
      return;
    }
    const nextErrors = validateStep(step, draft, t);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (step === 2 && derivedAge !== null) {
      setAgeConfirmationOpen(true);
      return;
    }
    setStep((current) => Math.min(LAST_STEP, current + 1));
  };

  const goBack = () => {
    setErrors({});
    setSubmitError(null);
    setStep((current) => Math.max(0, current - 1));
  };

  const complete = async () => {
    const terms = documentFromStatus(legalStatusQuery.data, 'terms');
    const privacy = documentFromStatus(legalStatusQuery.data, 'privacy');
    const allErrors = [1, 2, 3].reduce<ValidationErrors>(
      (current, currentStep) => ({
        ...current,
        ...validateStep(currentStep, draft, t),
      }),
      {}
    );
    if (!legalAccepted) allErrors.legal = t('onboarding.error.legal');
    if (!terms || !privacy) allErrors.legal = t('onboarding.legalUnavailable');
    if (Object.keys(allErrors).length > 0 || !birthDate || !draft.gender || !legalAccepted || !terms || !privacy) {
      setErrors(allErrors);
      setSubmitError(t('onboarding.submitCheck'));
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
        p_latitude: draft.latitude,
        p_longitude: draft.longitude,
        p_terms_version: terms.version,
        p_privacy_version: privacy.version,
      });
      if (error) throw error;
      await clearOnboardingDraft(draftMemberId);
      setCompleted(true);
      await refreshProfileStatus();
    } catch {
      setSubmitError(
        t('onboarding.submitGeneric')
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
          <Text variant="bodySmall">{t('onboarding.restoring')}</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.flex, isRTL && styles.rtl]}
      >
        <View style={styles.progressHeader}>
          <View style={[styles.progressTop, isRTL && styles.rowReverse]}>
            <Text variant="microAccent">
              {t('onboarding.step', {
                current: step + 1,
                total: LAST_STEP + 1,
                name: t(
                  [
                    'onboarding.step.welcome',
                    'onboarding.step.name',
                    'onboarding.step.details',
                    'onboarding.step.location',
                    'onboarding.step.review',
                  ][step] as Parameters<Translate>[0]
                ),
              })}
            </Text>
            <Text variant="caption" accessibilityLiveRegion="polite">
              {saved ? t('onboarding.saved') : t('common.saving')}
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
            <LocationStep draft={draft} errors={errors} locating={locating} />
          ) : null}
          {step === 4 ? (
            <ReviewStep
              draft={draft}
              birthDate={birthDate}
              legalAccepted={legalAccepted}
              onLegalAcceptedChange={setLegalAccepted}
              legalError={errors.legal}
              legalStatus={legalStatusQuery.data}
              legalStatusError={legalStatusQuery.isError}
              onRetryLegal={() => void legalStatusQuery.refetch()}
            />
          ) : null}

          {submitError ? (
            <View
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={styles.submitError}
            >
              <Text style={styles.submitErrorTitle}>{t('onboarding.submitTitle')}</Text>
              <Text variant="bodySmall">{submitError}</Text>
            </View>
          ) : null}
        </ScrollView>

        <View style={[styles.footer, isRTL && styles.rowReverse]}>
          {step > 0 ? (
            <Button label={t('common.back')} variant="secondary" onPress={goBack} style={styles.back} />
          ) : null}
          <Button
            label={
              step === LAST_STEP
                ? submitError
                  ? t('common.tryAgain')
                  : t('onboarding.finish')
                : step === 0
                  ? t('onboarding.start')
                  : t('common.continue')
            }
            loading={saving}
            onPress={step === LAST_STEP ? () => void complete() : goNext}
            style={styles.next}
          />
        </View>
        <ConfirmDialog
          testID={testIds.onboarding.ageConfirm}
          visible={ageConfirmationOpen}
          title={t('onboarding.ageConfirmTitle', { age: derivedAge ?? '' })}
          body={t('onboarding.ageConfirmBody')}
          confirmLabel={t('onboarding.ageConfirmAccept')}
          cancelLabel={t('onboarding.ageConfirmChange')}
          onConfirm={() => {
            setAgeConfirmationOpen(false);
            setStep(3);
          }}
          onCancel={() => setAgeConfirmationOpen(false)}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

function WelcomeStep() {
  const { t } = useI18n();
  return (
    <View>
      <Text variant="display" style={styles.title}>{t('onboarding.welcomeTitle')}</Text>
      <Text variant="body" style={styles.copy}>{t('onboarding.welcomeBody')}</Text>
      <View style={styles.infoCard}>
        <InfoRow
          title={t('onboarding.peopleSeeTitle')}
          body={t('onboarding.peopleSeeBody')}
        />
        <InfoRow
          title={t('onboarding.privateTitle')}
          body={t('onboarding.privateBody')}
        />
        <InfoRow
          title={t('onboarding.savedTitle')}
          body={t('onboarding.savedBody')}
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
  const { t } = useI18n();
  return (
    <View>
      <StepHeading
        title={t('onboarding.nameTitle')}
        body={t('onboarding.nameBody')}
      />
      <View style={styles.form}>
        <Field
          label={t('onboarding.firstName')}
          value={draft.firstName}
          onChangeText={(value) => patch('firstName', value)}
          autoCapitalize="words"
          autoComplete="name-given"
          error={errors.firstName}
        />
        <Field
          label={t('onboarding.fullName')}
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
  const { t, isRTL } = useI18n();
  return (
    <View>
      <StepHeading
        title={t('onboarding.detailsTitle')}
        body={t('onboarding.detailsBody')}
      />
      <View style={styles.form}>
        <View style={styles.datePanel}>
          <Text variant="label">{t('onboarding.birthDate')}</Text>
          <Text variant="caption" style={styles.dateHint}>{t('onboarding.birthDateHint')}</Text>
          <View style={[styles.dateRow, isRTL && styles.rowReverse]}>
            <DatePart
              kind="day"
              label={t('onboarding.day')}
              value={draft.birthDay}
              maxLength={2}
              onChangeText={(value) => patch('birthDay', normaliseDecimalDigits(value))}
            />
            <DatePart
              kind="month"
              label={t('onboarding.month')}
              value={draft.birthMonth}
              maxLength={2}
              onChangeText={(value) => patch('birthMonth', normaliseDecimalDigits(value))}
            />
            <DatePart
              kind="year"
              label={t('onboarding.year')}
              value={draft.birthYear}
              maxLength={4}
              onChangeText={(value) => patch('birthYear', normaliseDecimalDigits(value))}
            />
          </View>
        </View>
        {errors.birthDate ? <InlineError message={errors.birthDate} /> : null}

        <View style={styles.genderBlock}>
          <Text variant="label">{t('onboarding.gender')}</Text>
          <Text variant="caption">{t('onboarding.genderBody')}</Text>
          <View style={[styles.genderRow, isRTL && styles.rowReverse]}>
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
                    {option === 'female' ? t('onboarding.woman') : t('onboarding.man')}
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

function LocationStep({ draft, errors, locating }: Pick<StepProps, 'draft' | 'errors'> & { locating: boolean }) {
  const { t } = useI18n();
  return (
    <View>
      <StepHeading
        title={t('onboarding.locationTitle')}
        body={t('onboarding.locationBody')}
      />
      <View style={styles.form}>
        <View style={styles.locationPanel}>
          <Text variant="label">{draft.city && draft.country ? `${draft.city}, ${draft.country}` : locating ? t('onboarding.locationFinding') : t('onboarding.locationPermissionBody')}</Text>
          {errors.city ? <InlineError message={errors.city} /> : null}
        </View>
      </View>
    </View>
  );
}

function ReviewStep({
  draft,
  birthDate,
  legalAccepted,
  onLegalAcceptedChange,
  legalError,
  legalStatus,
  legalStatusError,
  onRetryLegal,
}: {
  draft: OnboardingDraft;
  birthDate: string | null;
  legalAccepted: boolean;
  onLegalAcceptedChange: (value: boolean) => void;
  legalError?: string;
  legalStatus?: LegalConsentStatus;
  legalStatusError: boolean;
  onRetryLegal: () => void;
}) {
  const { t, localeTag, isRTL } = useI18n();
  const terms = documentFromStatus(legalStatus, 'terms');
  const privacy = documentFromStatus(legalStatus, 'privacy');
  const legalDocumentsReady = !!terms && !!privacy;
  return (
    <View>
      <StepHeading
        title={t('onboarding.reviewTitle')}
        body={t('onboarding.reviewBody')}
      />
      <View style={styles.reviewCard}>
        <ReviewRow label={t('onboarding.profileName')} value={draft.firstName.trim()} />
        <ReviewRow label={t('onboarding.fullNameShort')} value={draft.fullName.trim()} note={t('onboarding.private')} />
        <ReviewRow label={t('onboarding.birthDate')} value={birthDate ? readableDate(birthDate, localeTag) : t('onboarding.notEntered')} note={t('onboarding.private')} />
        <ReviewRow label={t('onboarding.gender')} value={draft.gender === 'female' ? t('onboarding.woman') : t('onboarding.man')} />
        <ReviewRow
          label={t('onboarding.location')}
          value={`${draft.city.trim()}${isRTL ? '،' : ','} ${draft.country.trim()}`}
        />
      </View>
      <Text variant="caption" style={styles.reviewNote}>
        {t('onboarding.reviewNote')}
      </Text>
      <Pressable
        testID={testIds.onboarding.legalConsent}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: legalAccepted, disabled: !legalDocumentsReady }}
        accessibilityLabel={t('onboarding.legalConsent')}
        disabled={!legalDocumentsReady}
        onPress={() => onLegalAcceptedChange(!legalAccepted)}
        style={[styles.legalConsent, isRTL && styles.rowReverse, legalAccepted && styles.legalConsentSelected]}
      >
        <View style={[styles.legalCheck, legalAccepted && styles.legalCheckSelected]}>
          {legalAccepted ? <Text style={styles.legalCheckMark}>✓</Text> : null}
        </View>
        <Text variant="caption" style={styles.legalConsentText}>{t('onboarding.legalConsent')}</Text>
      </Pressable>
      <View style={[styles.legalLinks, isRTL && styles.rowReverse]}>
        <Pressable disabled={!terms} accessibilityRole="link" accessibilityLabel={t('onboarding.termsLink')} onPress={() => terms && void Linking.openURL(terms.url)}>
          <Text style={styles.legalLink}>{t('onboarding.termsLink')}</Text>
        </Pressable>
        <Text variant="caption">{t('onboarding.legalAnd')}</Text>
        <Pressable disabled={!privacy} accessibilityRole="link" accessibilityLabel={t('onboarding.privacyLink')} onPress={() => privacy && void Linking.openURL(privacy.url)}>
          <Text style={styles.legalLink}>{t('onboarding.privacyLink')}</Text>
        </Pressable>
      </View>
      {legalError ? <InlineError message={legalError} /> : null}
      {!legalDocumentsReady ? (
        <View style={styles.legalLoadError}>
          <InlineError message={legalStatusError ? t('onboarding.legalUnavailable') : t('onboarding.legalLoading')} />
          {legalStatusError ? <Button label={t('common.tryAgain')} variant="quiet" onPress={onRetryLegal} /> : null}
        </View>
      ) : null}
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
  const { isRTL } = useI18n();
  return (
    <View style={styles.field}>
      <Text variant="label">{label}</Text>
      <TextInput
        {...props}
        accessibilityLabel={label}
        accessibilityHint={error}
        placeholderTextColor={color.faintest}
        style={[styles.input, isRTL && styles.inputRTL, error && styles.inputError]}
      />
      {error ? <InlineError message={error} /> : null}
    </View>
  );
}

function DatePart(
  props: ComponentProps<typeof TextInput> & { label: string; kind: 'day' | 'month' | 'year' }
) {
  const { t, isRTL } = useI18n();
  const { label, kind, ...inputProps } = props;
  return (
    <View style={styles.datePart}>
      <Text variant="caption">{label}</Text>
      <TextInput
        {...inputProps}
        accessibilityLabel={t('onboarding.birthPartLabel', { part: label })}
        keyboardType="number-pad"
        placeholder={kind === 'year' ? 'YYYY' : kind === 'month' ? 'MM' : 'DD'}
        placeholderTextColor={color.faintest}
        style={[styles.input, styles.dateInput, isRTL && styles.inputRTL]}
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

function validateStep(step: number, draft: OnboardingDraft, t: Translate): ValidationErrors {
  if (step === 1) {
    const errors: ValidationErrors = {};
    if (draft.firstName.trim().length < 2) {
      errors.firstName = t('onboarding.error.firstName');
    }
    if (draft.fullName.trim().length < 3 || !draft.fullName.trim().includes(' ')) {
      errors.fullName = t('onboarding.error.fullName');
    }
    return errors;
  }

  if (step === 2) {
    const errors: ValidationErrors = {};
    const dateError = validateBirthDate(draft, t);
    if (dateError) errors.birthDate = dateError;
    if (!draft.gender) errors.gender = t('onboarding.error.gender');
    return errors;
  }

  if (step === 3) {
    const errors: ValidationErrors = {};
    if (draft.city.trim().length < 2) errors.city = t('onboarding.error.city');
    if (draft.country.trim().length < 2) errors.country = t('onboarding.error.country');
    return errors;
  }

  return {};
}

function validateBirthDate(draft: OnboardingDraft, t: Translate): string | null {
  const issue = birthDateValidationIssue(draft);
  if (issue === 'incomplete') return t('onboarding.error.birthIncomplete');
  if (issue === 'invalid') return t('onboarding.error.birthInvalid');
  if (issue === 'too_young') return t('onboarding.error.tooYoung');
  if (issue === 'too_old') return t('onboarding.error.birthYear');
  return null;
}

function readableDate(value: string, localeTag: string): string {
  return new Intl.DateTimeFormat(localeTag, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
}


const styles = StyleSheet.create({
  flex: { flex: 1 },
  rtl: { direction: 'rtl' },
  rowReverse: { flexDirection: 'row-reverse' },
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
  countryPicker: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    borderRadius: radius.lg,
    paddingHorizontal: 15,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: color.surface,
  },
  countryPickerLabel: { fontFamily: font.body, fontSize: 16, color: color.ink },
  countryPickerPlaceholder: { color: color.faintest },
  countryPickerArrow: { fontFamily: font.body, fontSize: 22, color: color.inkSoft },
  locationPanel: { minHeight: 88, padding: 16, borderRadius: radius.lg, backgroundColor: color.sandLight, justifyContent: 'center', gap: 8 },
  inputRTL: { textAlign: 'right', writingDirection: 'rtl' },
  errorText: { fontFamily: font.bodyMedium, fontSize: 12, lineHeight: 18, color: '#A33A3A' },
  dateRow: { flexDirection: 'row', gap: 9 },
  datePanel: {
    gap: 9,
    padding: 15,
    borderRadius: radius.lg,
    backgroundColor: color.sandLight,
  },
  dateHint: { color: color.inkSoft },
  datePart: { flex: 1, gap: 6 },
  dateInput: { textAlign: 'center', paddingHorizontal: 8, fontFamily: font.bodySemi },
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
  legalConsent: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 18, padding: 13, borderRadius: radius.lg, borderWidth: 1, borderColor: alpha.lineStrong },
  legalConsentSelected: { borderColor: color.ink, backgroundColor: color.sandLight },
  legalCheck: { width: 20, height: 20, borderRadius: radius.sm, borderWidth: 1, borderColor: alpha.lineButton, alignItems: 'center', justifyContent: 'center' },
  legalCheckSelected: { backgroundColor: color.ink, borderColor: color.ink },
  legalCheckMark: { fontFamily: font.bodyBold, fontSize: 12, color: color.white },
  legalConsentText: { flex: 1, color: color.ink },
  legalLinks: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  legalLink: { fontFamily: font.bodySemi, fontSize: 12, color: color.ink, textDecorationLine: 'underline' },
  legalLoadError: { marginTop: 8 },
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
