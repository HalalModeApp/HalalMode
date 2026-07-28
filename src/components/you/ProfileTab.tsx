import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Controller, useForm } from 'react-hook-form';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { z } from 'zod';

import { updateMyProfile } from '@/api/profile';
import { AudioGreeting } from '@/components/introductions/AudioGreeting';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Text } from '@/components/ui/Text';
import { alpha, color, font, radius } from '@/theme/tokens';
import type { Profile } from '@/types';

const schema = z.object({
  name: z.string().min(2, 'Please give your full name.'),
  city: z.string().min(2, 'Where are you based?'),
  occupation: z.string().min(2, 'What do you do?'),
  bio: z
    .string()
    .min(80, 'Give this a few honest sentences — at least 80 characters.')
    .max(600, 'Keep it under 600 characters.'),
});

type FormValues = z.infer<typeof schema>;

export function ProfileTab({ profile }: { profile: Profile }) {
  const [photos, setPhotos] = useState(profile.photos);
  const [recorded, setRecorded] = useState(false);

  const {
    control,
    handleSubmit,
    formState: { errors, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: profile.name,
      city: `${profile.city}, ${profile.country}`,
      occupation: profile.education
        ? `${profile.occupation} · ${profile.education}`
        : profile.occupation,
      bio: profile.bio,
    },
  });

  const save = useMutation({
    mutationFn: (values: FormValues) =>
      updateMyProfile({ id: profile.id, ...values, photos }),
  });

  const addPhoto = async (source: 'camera' | 'library') => {
    const permission =
      source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      Alert.alert(
        'Permission needed',
        'Halal Mode needs access to add a photo to your profile.'
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
    if (asset) setPhotos((current) => [...current, asset.uri]);
  };

  return (
    <View style={styles.wrap}>
      <Card>
        <View style={styles.cardHead}>
          <Text variant="micro">Photo gallery</Text>
          <View style={styles.tagPill}>
            <Text style={styles.tagPillLabel}>No beauty filters</Text>
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
                  <Text style={styles.mainBadgeLabel}>Main</Text>
                </View>
              ) : null}
            </View>
          ))}
        </View>

        <Text variant="caption" style={styles.photoNote}>
          Clear, recent and unedited. Filters that change your face are not
          allowed — they only cost you a real introduction later.
        </Text>

        <View style={styles.photoActions}>
          <Pressable
            accessibilityRole="button"
            onPress={() => void addPhoto('camera')}
            style={styles.photoButton}
          >
            <Text style={styles.photoButtonLabel}>Camera</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => void addPhoto('library')}
            style={styles.photoButton}
          >
            <Text style={styles.photoButtonLabel}>Device files</Text>
          </Pressable>
        </View>
      </Card>

      <Card>
        <Text variant="micro">Voice introduction</Text>
        {recorded ? (
          <View style={styles.voicePlayer}>
            <AudioGreeting durationSeconds={28} />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Record a 30 second introduction"
            onPress={() => setRecorded(true)}
            style={styles.recordZone}
          >
            <View style={styles.recordDot}>
              <Text style={styles.recordGlyph}>●</Text>
            </View>
            <Text variant="label" style={styles.recordLabel}>
              Record a 30-second intro
            </Text>
          </Pressable>
        )}
        <Text variant="caption" style={styles.voiceNote}>
          Only shared once you have both sent interest.
        </Text>
      </Card>

      <Card style={styles.formCard}>
        <View style={styles.formRow}>
          <Controller
            control={control}
            name="name"
            render={({ field }) => (
              <Field
                label="Full name"
                value={field.value}
                onChangeText={field.onChange}
                error={errors.name?.message}
              />
            )}
          />
          <Controller
            control={control}
            name="city"
            render={({ field }) => (
              <Field
                label="City, country"
                value={field.value}
                onChangeText={field.onChange}
                error={errors.city?.message}
              />
            )}
          />
        </View>

        <Controller
          control={control}
          name="occupation"
          render={({ field }) => (
            <Field
              label="Profession & education"
              value={field.value}
              onChangeText={field.onChange}
              error={errors.occupation?.message}
            />
          )}
        />

        <Controller
          control={control}
          name="bio"
          render={({ field }) => (
            <Field
              label="Biography & values"
              value={field.value}
              onChangeText={field.onChange}
              error={errors.bio?.message}
              multiline
            />
          )}
        />
      </Card>

      <Button
        label={save.isSuccess && !isDirty ? 'Saved' : 'Save profile changes'}
        loading={save.isPending}
        onPress={handleSubmit((values) => save.mutate(values))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12, paddingBottom: 24 },

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
    fontSize: 9.5,
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
  photoNote: { marginTop: 12 },
  photoActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  photoButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: 'center',
  },
  photoButtonLabel: {
    fontFamily: font.bodySemi,
    fontSize: 11,
    color: color.ink,
  },

  recordZone: {
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
  recordDot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: color.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordGlyph: { color: color.white, fontSize: 11, fontFamily: font.body },
  recordLabel: { fontSize: 12 },
  voicePlayer: { marginTop: 12 },
  voiceNote: { marginTop: 10 },

  formCard: { gap: 14 },
  formRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
});
