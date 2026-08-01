import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, View } from 'react-native';
import { z } from 'zod';

import { fetchMyProfileReadiness, updateMyLocation, updateMyProfile } from '@/api/profile';
import {
  createProfileMediaSignedUrl,
  deleteProfilePhoto,
  PROFILE_PHOTO_BUCKET,
  VOICE_INTRODUCTION_BUCKET,
  type ProfilePhotoMimeType,
  uploadProfilePhoto,
  uploadVoiceIntroduction,
} from '@/api/profileMedia';
import { AudioGreeting } from '@/components/introductions/AudioGreeting';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Field } from '@/components/ui/Field';
import { Text } from '@/components/ui/Text';
import { queryKeys } from '@/lib/queryClient';
import { testIds } from '@/lib/testIds';
import { PRACTICE_LABELS, TIMELINE_LABELS } from '@/data/preferences';
import { getProfileReadiness, type ProfileReadinessIssue } from '@/lib/profileReadiness';
import { deviceLocationFromReverseGeocode } from '@/lib/deviceLocation';
import { useI18n, type Translate } from '@/i18n';
import type { TranslationKey } from '@/i18n/catalog';
import { USE_MOCKS } from '@/lib/supabase';
import { alpha, color, font, radius } from '@/theme/tokens';
import type { MarriageTimeline, Profile, ReligiousPractice, Sect } from '@/types';

function profileSchema(t: Translate) {
  return z.object({
    name: z.string().min(2, t('profile.validation.name')),
    firstName: z.string().min(1, t('profile.validation.firstName')),
    occupation: z.string().min(2, t('profile.validation.occupation')),
    education: z.string().max(120, t('profile.validation.education')),
    bio: z.string().min(80, t('profile.validation.bioShort')).max(600, t('profile.validation.bioLong')),
    values: z.string().max(180, t('profile.validation.values')),
    languages: z.string().max(120, t('profile.validation.languages')),
    religiousPractice: z.enum(['very_practicing', 'practicing', 'moderate', 'learning']),
    sect: z.enum(['sunni', 'shia', 'other', 'prefer_not_to_say']),
    timeline: z.enum(['within_3_months', 'within_6_months', 'within_1_year', '1_to_2_years']),
  });
}

type FormValues = z.infer<ReturnType<typeof profileSchema>>;

export function ProfileTab({ profile, onOpenPreferences }: { profile: Profile; onOpenPreferences?: () => void }) {
  const { localeTag, isRTL, t } = useI18n();
  const schema = useMemo(() => profileSchema(t), [t]);
  const queryClient = useQueryClient();
  const [photos, setPhotos] = useState(profile.photos);
  const [voiceUrl, setVoiceUrl] = useState(profile.audioGreetingUrl);
  const [voiceDuration, setVoiceDuration] = useState(
    profile.audioDurationSeconds ?? 30
  );
  const [savingVoice, setSavingVoice] = useState(false);
  const [photosDirty, setPhotosDirty] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [deletingPhoto, setDeletingPhoto] = useState<string | null>(null);
  const [updatingLocation, setUpdatingLocation] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const loadedProfileId = useRef<string | null>(null);
  const finishingRecording = useRef(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 250);
  const currentLocation = [profile.city, profile.country].filter(Boolean).join(', ')
    || t('profile.locationNotSet');

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: profile.name,
      firstName: profile.firstName,
      occupation: profile.occupation,
      education: profile.education ?? '',
      bio: profile.bio,
      values: profile.chips.join(', '),
      languages: profile.languagesSpoken.join(', '),
      religiousPractice: profile.religiousPractice,
      sect: profile.sect,
      timeline: profile.timeline,
    },
  });
  const draft = useWatch({ control });
  const draftReadiness = useMemo(
    () => getProfileReadiness({
      firstName: draft.firstName,
      city: profile.city,
      country: profile.country,
      bio: draft.bio,
      photoCount: photos.length,
    }),
    [draft.bio, draft.firstName, photos.length, profile.city, profile.country]
  );
  const serverReadinessQuery = useQuery({
    queryKey: queryKeys.profileReadiness,
    queryFn: fetchMyProfileReadiness,
    enabled: !USE_MOCKS,
  });
  // Drafts should react immediately. Once saved, the server contract is the
  // source of truth so an older app cannot show a conflicting status.
  const readiness = (!isDirty && !photosDirty && serverReadinessQuery.data)
    ? serverReadinessQuery.data
    : draftReadiness;

  useEffect(() => {
    setPhotos(profile.photos);
    setVoiceUrl(profile.audioGreetingUrl);
    setVoiceDuration(profile.audioDurationSeconds ?? 30);
    setPhotosDirty(false);
    if (loadedProfileId.current === profile.id) return;
    loadedProfileId.current = profile.id;
    reset({
      name: profile.name,
      firstName: profile.firstName,
      occupation: profile.occupation,
      education: profile.education ?? '',
      bio: profile.bio,
      values: profile.chips.join(', '),
      languages: profile.languagesSpoken.join(', '),
      religiousPractice: profile.religiousPractice,
      sect: profile.sect,
      timeline: profile.timeline,
    });
  }, [profile, reset]);

  const startVoiceRecording = useCallback(async () => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      showPermissionRecovery(
        permission.canAskAgain,
        t,
        t('profile.micTitle'),
        t('profile.micBody')
      );
      return;
    }
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch {
      Alert.alert(
        t('profile.recordStartError'),
        t('profile.connectionError')
      );
      await setAudioModeAsync({ allowsRecording: false });
    }
  }, [recorder, t]);

  const finishVoiceRecording = useCallback(async () => {
    if (finishingRecording.current || !recorder.isRecording) return;
    finishingRecording.current = true;
    setSavingVoice(true);
    try {
      const durationSeconds = Math.max(1, Math.round(recorder.currentTime));
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      if (!recorder.uri) throw new Error(t('profile.recordFileError'));

      if (USE_MOCKS) {
        setVoiceUrl(recorder.uri);
        setVoiceDuration(durationSeconds);
        return;
      }

      const uploaded = await uploadVoiceIntroduction(
        { uri: recorder.uri, mimeType: 'audio/mp4' },
        durationSeconds
      );
      const displayUrl = await createProfileMediaSignedUrl(
        VOICE_INTRODUCTION_BUCKET,
        uploaded.path
      );
      setVoiceUrl(displayUrl);
      setVoiceDuration(durationSeconds);
      queryClient.setQueryData<Profile>(queryKeys.profile('me'), (current) =>
        current
          ? {
              ...current,
              audioGreetingUrl: displayUrl,
              audioGreetingStoragePath: uploaded.path,
              audioDurationSeconds: durationSeconds,
            }
          : current
      );
      if (uploaded.cleanupPendingPath) {
        Alert.alert(
          t('profile.voiceSaved'),
          t('profile.voiceCleanup')
        );
      }
    } catch {
      Alert.alert(
        t('profile.voiceSaveError'),
        t('profile.connectionError')
      );
    } finally {
      finishingRecording.current = false;
      setSavingVoice(false);
    }
  }, [queryClient, recorder, t]);

  useEffect(() => {
    if (recorderState.isRecording && recorderState.durationMillis >= 29_750) {
      void finishVoiceRecording();
    }
  }, [finishVoiceRecording, recorderState.durationMillis, recorderState.isRecording]);

  const save = useMutation({
    mutationFn: (values: FormValues) => {
      const patch: Partial<Profile> = {
        name: values.name.trim(),
        firstName: values.firstName.trim(),
        occupation: values.occupation.trim(),
        // The server converts an empty string to NULL, so members can clear it.
        education: values.education.trim(),
        bio: values.bio.trim(),
        chips: splitProfileList(values.values),
        languagesSpoken: splitProfileList(values.languages),
        religiousPractice: values.religiousPractice,
        sect: values.sect,
        timeline: values.timeline,
      };
      if (USE_MOCKS && photosDirty) patch.photos = photos;
      return updateMyProfile(patch);
    },
    onSuccess: (_data, values) => {
      const saved: Profile = {
        ...profile,
        ...values,
        education: values.education.trim() || undefined,
        photos,
        chips: splitProfileList(values.values),
        languagesSpoken: splitProfileList(values.languages),
        religiousPractice: values.religiousPractice,
        sect: values.sect,
        timeline: values.timeline,
      };
      queryClient.setQueryData(queryKeys.profile('me'), saved);
      void queryClient.invalidateQueries({ queryKey: queryKeys.profileReadiness });
      reset(values);
      setPhotosDirty(false);
    },
  });

  const refreshDeviceLocation = useCallback(async () => {
    if (updatingLocation) return;
    setUpdatingLocation(true);
    setLocationError(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setLocationError(t('profile.locationPermissionRequired'));
        if (!permission.canAskAgain) {
          showPermissionRecovery(
            false,
            t,
            t('profile.locationPermissionTitle'),
            t('profile.locationPermissionRequired')
          );
        }
        return;
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const [place] = await Location.reverseGeocodeAsync(position.coords);
      const resolved = deviceLocationFromReverseGeocode(place, position.coords);
      if (!resolved) {
        setLocationError(t('profile.locationUnavailable'));
        return;
      }

      await updateMyLocation(resolved);
      queryClient.setQueryData<Profile>(queryKeys.profile('me'), (current) =>
        current ? { ...current, city: resolved.city, country: resolved.country } : current
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.profileReadiness });
      void queryClient.invalidateQueries({ queryKey: queryKeys.round });
    } catch {
      setLocationError(t('profile.locationUpdateError'));
    } finally {
      setUpdatingLocation(false);
    }
  }, [queryClient, t, updatingLocation]);

  const addPhoto = async (source: 'camera' | 'library') => {
    if (photos.length >= 6) {
      Alert.alert(t('profile.photoLimitTitle'), t('profile.photoLimitBody'));
      return;
    }
    const permission =
      source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      showPermissionRecovery(
        permission.canAskAgain,
        t,
        t('profile.permissionTitle'),
        t('profile.permissionBody')
      );
      return;
    }

    const result =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync({ quality: 0.9, aspect: [3, 4] })
        : await ImagePicker.launchImageLibraryAsync({
            quality: 0.9,
            mediaTypes: ['images'],
          });

    const asset = result.canceled ? null : result.assets[0];
    if (asset) {
      if (USE_MOCKS) {
        setPhotos((current) => [...current, asset.uri]);
        setPhotosDirty(true);
        return;
      }

      const supportedTypes: ProfilePhotoMimeType[] = [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/heic',
        'image/heif',
      ];
      const mimeType = supportedTypes.find((type) => type === asset.mimeType);
      if (!mimeType) {
        Alert.alert(
          t('profile.formatTitle'),
          t('profile.formatBody')
        );
        return;
      }

      setUploadingPhoto(true);
      try {
        const uploaded = await uploadProfilePhoto({ uri: asset.uri, mimeType });
        const displayUrl = await createProfileMediaSignedUrl(
          PROFILE_PHOTO_BUCKET,
          uploaded.path
        );
        const nextPhotos = [...photos, displayUrl];
        setPhotos(nextPhotos);
        queryClient.setQueryData<Profile>(queryKeys.profile('me'), (current) =>
          current
            ? {
                ...current,
                photos: nextPhotos,
                photoMedia: [
                  ...(current.photoMedia ?? current.photos.map((url) => ({ displayUrl: url }))),
                  { displayUrl, storagePath: uploaded.path },
                ],
              }
            : current
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.profileReadiness });
      } catch {
        Alert.alert(
          t('profile.uploadError'),
          t('profile.connectionError')
        );
      } finally {
        setUploadingPhoto(false);
      }
    }
  };

  const removePhoto = (index: number) => {
    if (photos.length <= 1) {
      Alert.alert(t('profile.keepOneTitle'), t('profile.keepOneBody'));
      return;
    }

    const removeLocally = () => {
      const nextPhotos = photos.filter((_, photoIndex) => photoIndex !== index);
      setPhotos(nextPhotos);
      if (USE_MOCKS) {
        setPhotosDirty(true);
        return;
      }
      queryClient.setQueryData<Profile>(queryKeys.profile('me'), (current) =>
        current
          ? {
              ...current,
              photos: nextPhotos,
              photoMedia: current.photoMedia?.filter(
                (_, photoIndex) => photoIndex !== index
              ),
            }
          : current
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.profileReadiness });
    };

    if (USE_MOCKS) {
      removeLocally();
      return;
    }

    const storagePath = profile.photoMedia?.[index]?.storagePath;
    if (!storagePath) {
      Alert.alert(
        t('profile.removeLegacyTitle'),
        t('profile.removeLegacyBody')
      );
      return;
    }

    Alert.alert(t('profile.removeTitle'), t('profile.removeBody'), [
      { text: t('profile.keepPhoto'), style: 'cancel' },
      {
        text: t('profile.removePhoto'),
        style: 'destructive',
        onPress: () => {
          setDeletingPhoto(storagePath);
          void deleteProfilePhoto(storagePath)
            .then(removeLocally)
            .catch(() => {
              Alert.alert(
                t('profile.removeError'),
                t('profile.connectionError')
              );
            })
            .finally(() => setDeletingPhoto(null));
        },
      },
    ]);
  };

  return (
    <View style={[styles.wrap, isRTL && styles.rtl]}>
      <Card tone="filled" style={styles.readinessCard}>
        <Text variant="label">{readiness.ready ? t('profile.readinessReadyTitle') : t('profile.readinessTitle')}</Text>
        <Text variant="caption" style={styles.readinessBody}>
          {readiness.ready
            ? t('profile.readinessReadyBody')
            : t('profile.readinessBody', { items: readiness.missing.map((item) => t(readinessKey[item])).join(', ') })}
        </Text>
        {!readiness.ready && readiness.missing.includes('preferences') && onOpenPreferences ? (
          <Button
            label={t('profile.openMatchingPreferences')}
            variant="quiet"
            onPress={onOpenPreferences}
          />
        ) : null}
      </Card>
      {photos.length === 0 ? (
        <Card testID={testIds.you.photoGuide} tone="filled" style={styles.photoGuide}>
          <Text variant="micro">{t('profile.photoGuideTitle')}</Text>
          <Text variant="caption" style={styles.photoGuideBody}>
            {t('profile.photoGuideBody')}
          </Text>
          <View style={styles.photoGuideRules}>
            {[
              'profile.photoGuideFace',
              'profile.photoGuideSelf',
              'profile.photoGuideFilter',
            ].map((key) => (
              <View key={key} style={[styles.photoGuideRule, isRTL && styles.rowRTL]}>
                <View style={styles.photoGuideMark} />
                <Text variant="caption" style={styles.photoGuideRuleText}>
                  {t(key as 'profile.photoGuideFace' | 'profile.photoGuideSelf' | 'profile.photoGuideFilter')}
                </Text>
              </View>
            ))}
          </View>
          <View style={[styles.photoActions, isRTL && styles.rowRTL]}>
            <Button
              label={t('profile.photoGuideCamera')}
              variant="secondary"
              disabled={uploadingPhoto}
              onPress={() => void addPhoto('camera')}
              style={styles.photoGuideAction}
            />
            <Button
              label={t('profile.photoGuideLibrary')}
              disabled={uploadingPhoto}
              loading={uploadingPhoto}
              onPress={() => void addPhoto('library')}
              style={styles.photoGuideAction}
            />
          </View>
        </Card>
      ) : null}
      <Card>
        <View style={[styles.cardHead, isRTL && styles.rowRTL]}>
          <Text variant="micro">{t('profile.gallery')}</Text>
          <View style={styles.tagPill}>
            <Text style={styles.tagPillLabel}>{t('profile.noFilters')}</Text>
          </View>
        </View>

        <View style={styles.grid}>
          {photos.slice(0, 6).map((photo, index) => (
            <View key={`${photo}-${index}`} style={styles.gridCell}>
              <Image
                source={photo}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                accessibilityIgnoresInvertColors
              />
              {index === 0 ? (
                <View style={styles.mainBadge}>
                  <Text style={styles.mainBadgeLabel}>{t('profile.main')}</Text>
                </View>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('profile.removePhotoA11y', { count: index + 1 })}
                accessibilityState={{ busy: deletingPhoto !== null }}
                disabled={deletingPhoto !== null}
                hitSlop={8}
                onPress={() => removePhoto(index)}
                style={styles.removePhoto}
              >
                <Text style={styles.removePhotoLabel}>×</Text>
              </Pressable>
            </View>
          ))}
        </View>

        <Text variant="caption" style={styles.photoNote}>
          {t('profile.photoNote')}
        </Text>

        <View style={[styles.photoActions, isRTL && styles.rowRTL]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('profile.camera')}
            accessibilityState={{ busy: uploadingPhoto, disabled: uploadingPhoto }}
            disabled={uploadingPhoto}
            onPress={() => void addPhoto('camera')}
            style={styles.photoButton}
          >
            <Text style={styles.photoButtonLabel}>
              {uploadingPhoto ? t('profile.uploading') : t('profile.camera')}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('profile.files')}
            accessibilityState={{ busy: uploadingPhoto, disabled: uploadingPhoto }}
            disabled={uploadingPhoto}
            onPress={() => void addPhoto('library')}
            style={styles.photoButton}
          >
            <Text style={styles.photoButtonLabel}>{t('profile.files')}</Text>
          </Pressable>
        </View>
      </Card>

      <Card>
        <Text variant="micro">{t('profile.voice')}</Text>
        {voiceUrl && !recorderState.isRecording ? (
          <View style={styles.voicePlayer}>
            <AudioGreeting durationSeconds={voiceDuration} url={voiceUrl} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('profile.recordAgain')}
              accessibilityState={{ busy: savingVoice, disabled: savingVoice }}
              disabled={savingVoice}
              onPress={() => void startVoiceRecording()}
              style={styles.recordAgain}
            >
              <Text style={styles.recordAgainLabel}>{t('profile.recordAgain')}</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              recorderState.isRecording
                ? t('profile.stopA11y')
                : t('profile.recordA11y')
            }
            accessibilityState={{ busy: savingVoice }}
            disabled={savingVoice}
            onPress={() =>
              void (recorderState.isRecording
                ? finishVoiceRecording()
                : startVoiceRecording())
            }
            style={[styles.recordZone, recorderState.isRecording && styles.recordZoneActive]}
          >
            <View style={styles.recordDot}>
              <Text style={styles.recordGlyph}>
                {recorderState.isRecording ? '■' : '●'}
              </Text>
            </View>
            <Text variant="label" style={styles.recordLabel}>
              {savingVoice
                ? t('profile.savingVoice')
                : recorderState.isRecording
                  ? t('profile.stopSave', { seconds: new Intl.NumberFormat(localeTag).format(Math.min(30, Math.round(recorderState.durationMillis / 1000))) })
                  : t('profile.recordIntro')}
            </Text>
          </Pressable>
        )}
        <Text variant="caption" style={styles.voiceNote}>
          {t('profile.voicePrivacy')}
        </Text>
      </Card>

      <Card style={styles.formCard}>
        <View style={styles.formRow}>
          <Controller
            control={control}
            name="name"
            render={({ field }) => (
              <Field
                label={t('profile.displayName')}
                value={field.value}
                onChangeText={field.onChange}
                error={errors.name?.message}
              />
            )}
          />
          <Controller
            control={control}
            name="firstName"
            render={({ field }) => (
              <Field
                label={t('profile.firstName')}
                value={field.value}
                onChangeText={field.onChange}
                error={errors.firstName?.message}
              />
            )}
          />
        </View>

        <View style={styles.locationBlock}>
          <Text variant="micro">{t('profile.locationCurrent')}</Text>
          <Text
            accessibilityLabel={`${t('profile.locationCurrent')}: ${currentLocation}`}
            variant="label"
          >
            {currentLocation}
          </Text>
          <Text variant="caption" style={styles.locationPrivacy}>
            {t('profile.locationPrivacy')}
          </Text>
          <Button
            testID={testIds.you.updateLocation}
            label={t('profile.updateLocation')}
            variant="secondary"
            loading={updatingLocation}
            onPress={() => void refreshDeviceLocation()}
          />
          {locationError ? (
            <Text accessibilityRole="alert" variant="caption" style={styles.locationError}>
              {locationError}
            </Text>
          ) : null}
        </View>

        <Controller
          control={control}
          name="occupation"
          render={({ field }) => (
            <Field
              label={t('profile.profession')}
              value={field.value}
              onChangeText={field.onChange}
              error={errors.occupation?.message}
            />
          )}
        />

        <Controller
          control={control}
          name="education"
          render={({ field }) => (
            <Field
              label={t('profile.education')}
              value={field.value}
              onChangeText={field.onChange}
              error={errors.education?.message}
            />
          )}
        />

        <Controller
          control={control}
          name="bio"
          render={({ field }) => (
            <Field
              label={t('profile.bio')}
              value={field.value}
              onChangeText={field.onChange}
              error={errors.bio?.message}
              multiline
            />
          )}
        />

        <Controller
          control={control}
          name="values"
          render={({ field }) => (
            <Field
              label={t('profile.values')}
              placeholder={t('profile.valuesPlaceholder')}
              value={field.value}
              onChangeText={field.onChange}
              error={errors.values?.message}
            />
          )}
        />

        <Controller
          control={control}
          name="languages"
          render={({ field }) => (
            <Field
              label={t('profile.languages')}
              placeholder={t('profile.languagesPlaceholder')}
              value={field.value}
              onChangeText={field.onChange}
              error={errors.languages?.message}
            />
          )}
        />

        <View style={styles.profileChoice}>
          <Text variant="micro">{t('profile.practice')}</Text>
          <Controller
            control={control}
            name="religiousPractice"
            render={({ field }) => (
              <View style={styles.choiceChips}>
                {(Object.keys(PRACTICE_LABELS) as ReligiousPractice[]).map((value) => (
                  <Chip
                    key={value}
                    label={practiceLabel(value, t)}
                    selected={field.value === value}
                    onPress={() => field.onChange(value)}
                  />
                ))}
              </View>
            )}
          />
        </View>

        <View style={styles.profileChoice}>
          <Text variant="micro">{t('profile.sect')}</Text>
          <Text variant="caption" style={styles.choiceNote}>
            {t('profile.sectBody')}
          </Text>
          <Controller
            control={control}
            name="sect"
            render={({ field }) => (
              <View style={styles.choiceChips}>
                {PROFILE_SECTS.map((value) => (
                  <Chip
                    key={value}
                    label={sectLabel(value, t)}
                    selected={field.value === value}
                    onPress={() => field.onChange(value)}
                  />
                ))}
              </View>
            )}
          />
        </View>

        <View style={styles.profileChoice}>
          <Text variant="micro">{t('profile.timing')}</Text>
          <Controller
            control={control}
            name="timeline"
            render={({ field }) => (
              <View style={styles.choiceChips}>
                {(Object.keys(TIMELINE_LABELS) as MarriageTimeline[]).map((value) => (
                  <Chip
                    key={value}
                    label={timelineLabel(value, t)}
                    selected={field.value === value}
                    onPress={() => field.onChange(value)}
                  />
                ))}
              </View>
            )}
          />
        </View>
      </Card>

      <Button
        label={save.isSuccess && !isDirty && !photosDirty ? t('filters.saved') : t('profile.save')}
        loading={save.isPending}
        disabled={!isDirty && !photosDirty}
        onPress={handleSubmit((values) => save.mutate(values))}
      />
      {save.isError ? (
        <Text accessibilityRole="alert" variant="caption" style={styles.saveError}>
          {t('profile.saveError')}
        </Text>
      ) : null}
    </View>
  );
}

function splitProfileList(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))].slice(0, 8);
}

/** Includes 'prefer_not_to_say', because here it is a real answer. */
const PROFILE_SECTS: Sect[] = ['sunni', 'shia', 'other', 'prefer_not_to_say'];

const SECT_KEYS: Record<Sect, TranslationKey> = {
  sunni: 'filters.sect.sunni',
  shia: 'filters.sect.shia',
  other: 'filters.sect.other',
  prefer_not_to_say: 'filters.sect.unstated',
};

function sectLabel(value: Sect, t: Translate): string {
  return t(SECT_KEYS[value]);
}

function practiceLabel(value: ReligiousPractice, t: Translate): string {
  const keys: Record<ReligiousPractice, 'filters.practice.very' | 'filters.practice.practicing' | 'filters.practice.moderate' | 'filters.practice.learning'> = {
    very_practicing: 'filters.practice.very',
    practicing: 'filters.practice.practicing',
    moderate: 'filters.practice.moderate',
    learning: 'filters.practice.learning',
  };
  return t(keys[value]);
}

function timelineLabel(value: MarriageTimeline, t: Translate): string {
  const keys: Record<MarriageTimeline, 'filters.timeline.3m' | 'filters.timeline.6m' | 'filters.timeline.1y' | 'filters.timeline.2y'> = {
    within_3_months: 'filters.timeline.3m',
    within_6_months: 'filters.timeline.6m',
    within_1_year: 'filters.timeline.1y',
    '1_to_2_years': 'filters.timeline.2y',
  };
  return t(keys[value]);
}

const readinessKey: Record<ProfileReadinessIssue, 'profile.readinessName' | 'profile.readinessLocation' | 'profile.readinessBio' | 'profile.readinessPhoto' | 'profile.readinessPreferences'> = {
  name: 'profile.readinessName',
  location: 'profile.readinessLocation',
  bio: 'profile.readinessBio',
  photo: 'profile.readinessPhoto',
  preferences: 'profile.readinessPreferences',
};

function showPermissionRecovery(
  canAskAgain: boolean,
  t: Translate,
  title: string,
  body: string
) {
  if (canAskAgain) {
    Alert.alert(title, body);
    return;
  }
  Alert.alert(title, body, [
    { text: t('settings.notNow'), style: 'cancel' },
    {
      text: t('common.openSettings'),
      onPress: () => { void Linking.openSettings().catch(() => {}); },
    },
  ]);
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  rowRTL: { flexDirection: 'row-reverse' },
  wrap: { gap: 12, paddingBottom: 24 },
  readinessCard: { gap: 5 },
  readinessBody: { color: color.inkSoft },
  photoGuide: { gap: 10 },
  photoGuideBody: { color: color.inkSoft },
  photoGuideRules: { gap: 8, marginTop: 2 },
  photoGuideRule: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  photoGuideMark: { width: 7, height: 7, borderRadius: 4, backgroundColor: color.gold },
  photoGuideRuleText: { flex: 1, color: color.ink },
  photoGuideAction: { flex: 1, paddingHorizontal: 8 },

  cardHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  tagPill: {
    borderWidth: 1,
    borderColor: 'rgba(10,10,10,0.12)',
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  tagPillLabel: {
    fontFamily: font.bodySemi,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: color.inkSoft,
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  gridCell: {
    width: '31%',
    aspectRatio: 3 / 4,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: color.clay,
  },
  mainBadge: {
    position: 'absolute',
    top: 7,
    left: 7,
    backgroundColor: color.ink,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  mainBadgeLabel: {
    fontFamily: font.bodyBold,
    fontSize: 8,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: color.white,
  },
  removePhoto: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(10,10,10,0.72)',
  },
  removePhotoLabel: {
    color: color.white,
    fontFamily: font.body,
    fontSize: 20,
    lineHeight: 22,
  },
  photoNote: { marginTop: 12 },
  photoActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  unavailableNote: { marginTop: 12, color: color.inkSoft },
  photoButton: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: 'center',
  },
  photoButtonLabel: {
    fontFamily: font.bodySemi,
    fontSize: 13,
    color: color.ink,
  },

  recordZone: {
    minHeight: 56,
    marginTop: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(10,10,10,0.2)',
    borderRadius: radius.lg,
    backgroundColor: color.sandLight,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 11,
  },
  recordZoneActive: { borderColor: color.gold, backgroundColor: color.sand },
  recordDot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: color.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordGlyph: { color: color.white, fontSize: 11, fontFamily: font.body },
  recordLabel: { fontSize: 14 },
  voicePlayer: { marginTop: 12 },
  recordAgain: {
    minHeight: 44,
    marginTop: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordAgainLabel: {
    fontFamily: font.bodySemi,
    fontSize: 12,
    color: color.inkSoft,
  },
  choiceNote: { marginTop: -2 },
  voiceNote: { marginTop: 10 },

  formCard: { gap: 14 },
  locationBlock: { gap: 8 },
  locationPrivacy: { color: color.inkSoft },
  locationError: { color: color.inkSoft },
  profileChoice: { gap: 9 },
  choiceChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  formRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  saveError: { color: color.inkSoft, textAlign: 'center' },
});
