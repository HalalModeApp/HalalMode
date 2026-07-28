import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AudioGreeting } from '@/components/introductions/AudioGreeting';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useRound } from '@/state/round';
import { alpha, color, radius, space } from '@/theme/tokens';

export default function IntroductionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { round, live, release, keepLimit, submit } = useRound();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const introduction =
    round?.introductions.find((item) => item.id === id) ?? null;

  if (!introduction) {
    return (
      <Screen>
        <View style={styles.missing}>
          <Text variant="bodySmall">This introduction is no longer available.</Text>
          <Button label="Back" variant="quiet" onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  const { profile, agreements } = introduction;
  const position = (round?.introductions.indexOf(introduction) ?? 0) + 1;
  const total = round?.introductions.length ?? 0;

  const handleSendInterest = async () => {
    setConfirmOpen(false);
    // With one keep left this is the final commit; otherwise it just marks a
    // keep and returns to the arc so the rest of the set can be resolved.
    if (live.length <= keepLimit) {
      const mutual = await submit();
      if (mutual[0]) {
        router.replace(`/match/${mutual[0]}`);
        return;
      }
    }
    router.back();
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <ScreenHeader
          action="back"
          trailingLabel={`Introduction ${position} of ${total}`}
        />

        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={`Open ${profile.firstName}'s photos`}
          onPress={() => router.push(`/gallery/${introduction.id}`)}
          style={styles.hero}
        >
          <Image
            source={profile.photos[0]}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={220}
            accessibilityIgnoresInvertColors
          />
          <View style={styles.photoBadge}>
            <View style={styles.photoBadgeIcon} />
            <Text style={styles.photoBadgeLabel}>
              {profile.photos.length} photos
            </Text>
          </View>
          <LinearGradient
            colors={['transparent', 'rgba(10,10,10,0.72)']}
            style={styles.heroGradient}
          >
            <Text style={styles.heroName}>{profile.name}</Text>
            <Text style={styles.heroLine}>
              {profile.age} · {profile.city} · {profile.occupation}
            </Text>
          </LinearGradient>
        </Pressable>

        <View style={styles.chips}>
          {profile.chips.map((chip) => (
            <Chip key={chip} label={chip} />
          ))}
        </View>

        <Text style={styles.bio}>{profile.bio}</Text>

        {profile.audioDurationSeconds ? (
          <View style={styles.section}>
            <Text variant="label" style={styles.sectionHeading}>
              Audio greeting
            </Text>
            <AudioGreeting
              durationSeconds={profile.audioDurationSeconds}
              url={profile.audioGreetingUrl}
            />
          </View>
        ) : null}

        <View style={styles.agreementBlock}>
          <Text variant="micro">Where you already agree</Text>
          <View style={styles.agreementList}>
            {agreements.map((item) => (
              <View key={item.label} style={styles.agreementRow}>
                <Text variant="bodySmall">{item.label}</Text>
                <Text variant="label" style={styles.agreementValue}>
                  {item.value}
                </Text>
              </View>
            ))}
          </View>
          <Text variant="caption" style={styles.privacyNote}>
            Your private filters stay private. Neither of you ever sees the
            other’s ranges.
          </Text>
        </View>

        <View style={styles.actions}>
          <Button
            label="Let go"
            variant="secondary"
            onPress={() => {
              release(introduction.id);
              router.back();
            }}
            style={styles.letGo}
          />
          <Button
            label="Send interest"
            onPress={() => setConfirmOpen(true)}
            style={styles.sendInterest}
          />
        </View>
      </ScrollView>

      <ConfirmDialog
        visible={confirmOpen}
        title={`Send interest to ${profile.firstName}?`}
        body="They are only notified if it is mutual."
        confirmLabel="Yes, send"
        cancelLabel="Not yet"
        onConfirm={() => void handleSendInterest()}
        onCancel={() => setConfirmOpen(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40 },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },

  hero: {
    marginHorizontal: space.gutter,
    marginTop: 12,
    height: 330,
    borderRadius: radius.hero,
    overflow: 'hidden',
    backgroundColor: color.clay,
  },
  heroGradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 22,
  },
  heroName: {
    fontFamily: 'PlayfairDisplay_400Regular',
    fontSize: 26,
    color: color.white,
  },
  heroLine: {
    fontFamily: 'Beiruti_400Regular',
    fontSize: 12,
    color: 'rgba(252,252,251,0.85)',
    marginTop: 5,
  },
  photoBadge: {
    position: 'absolute',
    top: 14,
    right: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: 'rgba(10,10,10,0.5)',
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 11,
  },
  photoBadgeIcon: {
    width: 11,
    height: 9,
    borderWidth: 1.5,
    borderColor: color.white,
    borderRadius: 2,
  },
  photoBadgeLabel: {
    fontFamily: 'Beiruti_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    color: color.white,
  },

  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    paddingHorizontal: space.gutter,
    marginTop: 16,
  },
  bio: {
    fontFamily: 'Beiruti_400Regular',
    fontSize: 13,
    lineHeight: 23,
    color: color.inkSoft,
    paddingHorizontal: space.gutter,
    marginTop: 18,
  },

  section: { paddingHorizontal: space.gutter, marginTop: 20, gap: 8 },
  sectionHeading: { fontSize: 11 },

  agreementBlock: {
    marginHorizontal: space.gutter,
    marginTop: 20,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: alpha.line,
  },
  agreementList: { marginTop: 12, gap: 10 },
  agreementRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
  },
  agreementValue: { flexShrink: 1, textAlign: 'right', fontSize: 12 },
  privacyNote: { marginTop: 14, color: color.faintest },

  actions: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: space.gutter,
    marginTop: 26,
  },
  letGo: { flex: 1, paddingHorizontal: 8 },
  sendInterest: { flex: 1.3, paddingHorizontal: 8 },
});
