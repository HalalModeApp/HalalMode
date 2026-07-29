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
import { useI18n } from '@/i18n';
import { useRound } from '@/state/round';
import { alpha, color, radius, space } from '@/theme/tokens';

export default function IntroductionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { language, isRTL, t } = useI18n();
  const { round, live, release, keepLimit, submit } = useRound();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const introduction =
    round?.introductions.find((item) => item.id === id) ?? null;

  if (!introduction) {
    return (
      <Screen style={isRTL ? styles.rtl : undefined}>
        <View style={styles.missing}>
          <Text variant="bodySmall">{t('intro.missing')}</Text>
          <Button label={t('common.back')} variant="quiet" onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  const { profile, agreements } = introduction;
  const position = (round?.introductions.indexOf(introduction) ?? 0) + 1;
  const total = round?.introductions.length ?? 0;
  const number = (value: number) => new Intl.NumberFormat(language === 'ar' ? 'ar-SA' : 'en').format(value);

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
    <Screen style={isRTL ? styles.rtl : undefined}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <ScreenHeader
          action="back"
          trailingLabel={t('intro.position', { current: number(position), total: number(total) })}
        />

        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={t('intro.photosA11y', { name: profile.firstName })}
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
          <View style={[styles.photoBadge, isRTL && styles.rowRTL]}>
            <View style={styles.photoBadgeIcon} />
            <Text style={styles.photoBadgeLabel}>
              {t('intro.photoCount', { count: number(profile.photos.length) })}
            </Text>
          </View>
          <LinearGradient
            colors={['transparent', 'rgba(10,10,10,0.72)']}
            style={styles.heroGradient}
          >
            <Text style={styles.heroName}>{profile.name}</Text>
            <Text style={styles.heroLine}>
              {number(profile.age)} · {profile.city} · {profile.occupation}
            </Text>
          </LinearGradient>
        </Pressable>

        <View style={[styles.chips, isRTL && styles.rowRTL]}>
          {profile.chips.map((chip) => (
            <Chip key={chip} label={chip} />
          ))}
        </View>

        <Text style={styles.bio}>{profile.bio}</Text>

        {profile.audioDurationSeconds ? (
          <View style={styles.section}>
            <Text variant="label" style={styles.sectionHeading}>
              {t('intro.audio')}
            </Text>
            <AudioGreeting
              durationSeconds={profile.audioDurationSeconds}
              url={profile.audioGreetingUrl}
            />
          </View>
        ) : null}

        <View style={styles.agreementBlock}>
          <Text variant="micro">{t('intro.agreements')}</Text>
          <View style={styles.agreementList}>
            {agreements.map((item) => (
              <View key={item.label} style={[styles.agreementRow, isRTL && styles.rowRTL]}>
                <Text variant="bodySmall">{item.label}</Text>
                <Text variant="label" style={styles.agreementValue}>
                  {item.value}
                </Text>
              </View>
            ))}
          </View>
          <Text variant="caption" style={styles.privacyNote}>
            {t('intro.privacy')}
          </Text>
        </View>

        <View style={[styles.actions, isRTL && styles.rowRTL]}>
          <Button
            label={t('daily.letGo')}
            variant="secondary"
            onPress={() => {
              release(introduction.id);
              router.back();
            }}
            style={styles.letGo}
          />
          <Button
            label={t('daily.sendInterest')}
            onPress={() => setConfirmOpen(true)}
            style={styles.sendInterest}
          />
        </View>
      </ScrollView>

      <ConfirmDialog
        visible={confirmOpen}
        title={t('daily.sendToName', { name: profile.firstName })}
        body={t('daily.mutualOnly')}
        confirmLabel={t('daily.yesSend')}
        cancelLabel={t('daily.notYet')}
        onConfirm={() => void handleSendInterest()}
        onCancel={() => setConfirmOpen(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  rowRTL: { flexDirection: 'row-reverse' },
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
    fontSize: 12,
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
    fontSize: 15,
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
  agreementValue: { flexShrink: 1, textAlign: 'right', fontSize: 14 },
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
