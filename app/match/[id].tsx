import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import * as Haptics from 'expo-haptics';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { Confetti } from '@/components/introductions/Confetti';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { MOCK_PROFILES, MOCK_SELF } from '@/data/mock';
import { color, font, radius, space } from '@/theme/tokens';

/**
 * The mutual-interest reveal.
 *
 * Note what is *not* here: no count of how many people chose them, no hint of
 * whether they were someone's only pick. The reference is strict that this
 * moment carries no ranking information, and that restraint is the product.
 */
export default function MatchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const profile = MOCK_PROFILES.find((item) => item.id === id) ?? MOCK_PROFILES[0]!;

  useEffect(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, []);

  return (
    <Screen>
      {/* A takeover, not a drill-down — so it dismisses rather than reverses. */}
      <ScreenHeader
        action="close"
        onAction={() => router.replace('/(tabs)/connections')}
      />
      <Confetti />

      <Animated.View entering={FadeIn.duration(400)} style={styles.body}>
        <Text variant="micro">Halal Mode</Text>
        <Text variant="display" center style={styles.title}>
          It’s a mutual match.
        </Text>

        <Animated.View
          entering={FadeInDown.delay(150).duration(420)}
          style={styles.pair}
        >
          <View style={[styles.plate, styles.plateLeft]}>
            <Image
              source={MOCK_SELF.photos[0]}
              style={styles.avatar}
              contentFit="cover"
              accessibilityIgnoresInvertColors
            />
            <Text style={styles.plateName}>You</Text>
          </View>

          <View style={styles.heart}>
            <Text style={styles.heartGlyph}>♥</Text>
          </View>

          <View style={[styles.plate, styles.plateRight]}>
            <Image
              source={profile.photos[0]}
              style={styles.avatar}
              contentFit="cover"
              accessibilityIgnoresInvertColors
            />
            <Text style={styles.plateName}>{profile.firstName}</Text>
          </View>
        </Animated.View>

        <Text variant="bodySmall" center style={styles.explainer}>
          No messaging yet. First you both choose five questions that matter,
          answer them honestly, and read each other’s words before hello.
        </Text>

        <Button
          label="Choose questions"
          onPress={() => router.replace('/connection/conn-1/questions')}
          style={styles.cta}
        />
        <Button
          label="Later tonight"
          variant="quiet"
          onPress={() => router.replace('/(tabs)/connections')}
        />
      </Animated.View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
    gap: space.lg,
  },
  title: { marginTop: 4 },
  pair: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    marginTop: 10,
  },
  plate: {
    width: 118,
    height: 150,
    borderRadius: radius.panel,
    alignItems: 'center',
    paddingTop: 22,
    shadowColor: '#0A0A0A',
    shadowOpacity: 0.18,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 12 },
    elevation: 5,
  },
  plateLeft: { backgroundColor: color.sandDeep, marginRight: -14 },
  plateRight: { backgroundColor: '#FBF3D9', marginLeft: -14 },
  avatar: {
    width: 66,
    height: 66,
    borderRadius: 33,
    borderWidth: 2,
    borderColor: color.white,
  },
  plateName: {
    marginTop: 12,
    fontFamily: font.bodySemi,
    fontSize: 12,
    color: color.ink,
  },
  heart: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: color.ink,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
    marginBottom: 58,
  },
  heartGlyph: { color: color.white, fontSize: 13, fontFamily: font.body },
  explainer: { maxWidth: 280, marginTop: 6 },
  cta: { marginTop: 4, alignSelf: 'stretch' },
});
