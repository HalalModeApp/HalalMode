import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import * as Haptics from 'expo-haptics';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';

import { fetchConnections } from '@/api/connections';
import { fetchMyProfile } from '@/api/profile';
import { Confetti } from '@/components/introductions/Confetti';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { color, font, radius, space } from '@/theme/tokens';
import type { ConnectionStage } from '@/types';

const NEXT_ROUTE: Record<ConnectionStage, string> = {
  choosing_questions: 'questions',
  answering: 'answers',
  recap: 'recap',
  open: 'chat',
};

/**
 * The mutual-interest reveal.
 *
 * Note what is *not* here: no count of how many people chose them, no hint of
 * whether they were someone's only pick. The reference is strict that this
 * moment carries no ranking information, and that restraint is the product.
 */
export default function MatchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const matchId = Array.isArray(id) ? id[0] : id;
  const {
    data: match,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ['match-reveal', matchId],
    enabled: !!matchId,
    queryFn: async () => {
      const [connections, self] = await Promise.all([
        fetchConnections(),
        fetchMyProfile(),
      ]);
      const connection = connections.find(
        (item) => item.id === matchId || item.profile.id === matchId
      );
      return connection ? { connection, self } : null;
    },
    staleTime: 0,
  });

  useEffect(() => {
    if (match) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }, [match]);

  if (isLoading) {
    return (
      <MatchStatus
        title="Preparing your match"
        body="We’re opening the connection you both chose."
        loading
      />
    );
  }

  if (isError) {
    return (
      <MatchStatus
        title="We couldn’t open this match"
        body="Your connection is still safe. Check your connection and try again."
        actionLabel="Try again"
        actionLoading={isFetching}
        onAction={() => void refetch()}
      />
    );
  }

  if (!match) {
    return (
      <MatchStatus
        title="This match isn’t available"
        body="It may have expired or already moved to your Connections."
        actionLabel="View connections"
        onAction={() => router.replace('/(tabs)/connections')}
      />
    );
  }

  const { connection, self } = match;
  const profile = connection.profile;

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
              source={self.photos[0]}
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
          label={
            connection.stage === 'choosing_questions'
              ? 'Choose questions'
              : 'Continue connection'
          }
          onPress={() =>
            router.replace(
              `/connection/${connection.id}/${NEXT_ROUTE[connection.stage]}`
            )
          }
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

function MatchStatus({
  title,
  body,
  loading,
  actionLabel,
  actionLoading,
  onAction,
}: {
  title: string;
  body: string;
  loading?: boolean;
  actionLabel?: string;
  actionLoading?: boolean;
  onAction?: () => void;
}) {
  return (
    <Screen>
      <ScreenHeader
        action="close"
        onAction={() => router.replace('/(tabs)/connections')}
      />
      <View style={styles.status}>
        {loading ? <ActivityIndicator color={color.ink} /> : null}
        <Text variant="displaySmall" center>
          {title}
        </Text>
        <Text variant="bodySmall" center style={styles.statusBody}>
          {body}
        </Text>
        {actionLabel && onAction ? (
          <Button
            label={actionLabel}
            loading={actionLoading}
            onPress={onAction}
            style={styles.statusAction}
          />
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  status: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: 36,
  },
  statusBody: { maxWidth: 280 },
  statusAction: { alignSelf: 'stretch', marginTop: space.sm },
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
