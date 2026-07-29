import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { z } from 'zod';

import { updateMyProfile } from '@/api/profile';
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
import { Field } from '@/components/ui/Field';
import { Text } from '@/components/ui/Text';
import { queryKeys } from '@/lib/queryClient';
import { getProfileReadiness, type ProfileReadinessIssue } from '@/lib/profileReadiness';
import { useI18n, type Translate } from '@/i18n';
import { USE_MOCKS } from '@/lib/supabase';
import { alpha, color, font, radius } from '@/theme/tokens';
import type { Profile } from '@/types';

function profileSchema(t: Translate) {
  return z.object({
    name: z.string().min(2, t('profile.validation.name')),
    firstName: z.string().min(1, t('profile.validation.firstName')),
    city: z.string().min(2, t('profile.validation.city')),
    country: z.string().min(2, t('profile.validation.country')),
    occupation: z.string().min(2, t('profile.validation.occupation')),
    education: z.string().max(120, t('profile.validation.education')),
    bio: z.string().min(80, t('profile.validation.bioShort')).max(600, t('profile.validation.bioLong')),
  });
}

type FormValues = z.infer<ReturnType<typeof profileSchema>>;

export function ProfileTab({ profile }: { profile: Profile }) {
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
  const loadedProfileId = useRef<string | null>(null);
  const finishingRecording = useRef(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 250);

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
      city: profile.city,
      country: profile.country,
      occupation: profile.occupation,
      education: profile.education ?? '',
      bio: profile.bio,
    },
  });
  const draft = useWatch({ control });
  const readiness = useMemo(
    () => getProfileReadiness({
      firstName: draft.firstName,
      city: draft.city,
      country: draft.country,
      bio: draft.bio,
      photoCount: photos.length,
    }),
    [draft.bio, draft.city, draft.country, draft.firstName, photos.length]
  );

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
      city: profile.city,
      country: profile.country,
      occupation: profile.occupation,
      education: profile.education ?? '',
      bio: profile.bio,
    });
  }, [profile, reset]);

  const startVoiceRecording = useCallback(async () => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
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
        city: values.city.trim(),
        country: values.country.trim(),
        occupation: values.occupation.trim(),
        // The server converts an empty string to NULL, so members can clear it.
        education: values.education.trim(),
        bio: values.bio.trim(),
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
      };
      queryClient.setQueryData(queryKeys.profile('me'), saved);
      reset(values);
      setPhotosDirty(false);
    },
  });

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
      Alert.alert(
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
      </Card>
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
          <Controller
            control={control}
            name="city"
            render={({ field }) => (
              <Field
                label={t('profile.city')}
                value={field.value}
                onChangeText={field.onChange}
                error={errors.city?.message}
              />
            )}
          />
        </View>

        <Controller
          control={control}
          name="country"
          render={({ field }) => (
            <Field
              label={t('profile.country')}
              value={field.value}
              onChangeText={field.onChange}
              error={errors.country?.message}
            />
          )}
        />

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

const readinessKey: Record<ProfileReadinessIssue, 'profile.readinessName' | 'profile.readinessLocation' | 'profile.readinessBio' | 'profile.readinessPhoto'> = {
  name: 'profile.readinessName',
  location: 'profile.readinessLocation',
  bio: 'profile.readinessBio',
  photo: 'profile.readinessPhoto',
};

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  rowRTL: { flexDirection: 'row-reverse' },
  wrap: { gap: 12, paddingBottom: 24 },
  readinessCard: { gap: 5 },
  readinessBody: { color: color.inkSoft },

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
  voiceNote: { marginTop: 10 },

  formCard: { gap: 14 },
  formRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  saveError: { color: color.inkSoft, textAlign: 'center' },
});
