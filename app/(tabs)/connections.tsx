import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { fetchConnections } from '@/api/connections';
import { BrandHeader } from '@/components/navigation/BrandHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/AsyncState';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { queryKeys } from '@/lib/queryClient';
import { useI18n } from '@/i18n';
import { useSession } from '@/state/session';
import { alpha, color, radius, space } from '@/theme/tokens';
import { TIER_LIMITS, type Connection, type ConnectionStage } from '@/types';

/** Where a tap on each stage should land. */
const STAGE_ROUTE: Record<ConnectionStage, string> = {
  choosing_questions: 'questions',
  answering: 'answers',
  recap: 'recap',
  open: 'chat',
};

export default function ConnectionsScreen() {
  const { tier } = useSession();
  const { isRTL, t } = useI18n();
  const limit = TIER_LIMITS[tier].openConnections;

  const connectionsQuery = useQuery({
    queryKey: queryKeys.connections,
    queryFn: fetchConnections,
  });
  const connections = connectionsQuery.data ?? [];

  return (
    <Screen withTabBar style={isRTL ? styles.rtl : undefined}>
      <BrandHeader />

      <View style={styles.header}>
        <Text variant="micro">{t('connections.eyebrow')}</Text>
        <Text variant="display" style={styles.title}>
          {t('connections.title')}
        </Text>
        <Text variant="bodySmall" style={styles.subtitle}>
          {t('connections.limit', { limit })}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
      >
        {connectionsQuery.isPending ? <LoadingState label={t('connections.loading')} /> : null}
        {connectionsQuery.isError ? (
          <ErrorState
            title={t('connections.errorTitle')}
            message={t('connections.errorBody')}
            onRetry={() => void connectionsQuery.refetch()}
          />
        ) : null}
        {connections.map((connection) => (
          <ConnectionRow key={connection.id} connection={connection} />
        ))}

        {!connectionsQuery.isPending && !connectionsQuery.isError && connections.length === 0 ? (
          <EmptyState
            title={t('connections.emptyTitle')}
            message={t('connections.emptyBody')}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function ConnectionRow({ connection }: { connection: Connection }) {
  const { isRTL, t } = useI18n();
  const [now, setNow] = useState(0);
  useEffect(() => setNow(Date.now()), []);
  const days = Math.max(
    1,
    Math.round((now - new Date(connection.createdAt).getTime()) / 86400_000)
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('connections.openA11y', { name: connection.profile.firstName })}
      onPress={() =>
        router.push(
          `/connection/${connection.id}/${STAGE_ROUTE[connection.stage]}`
        )
      }
      style={({ pressed }) => [styles.row, isRTL && styles.rowRTL, pressed && styles.rowPressed]}
    >
      <Image
        source={connection.profile.photos[0]}
        style={styles.avatar}
        contentFit="cover"
        accessibilityIgnoresInvertColors
      />

      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text variant="label" numberOfLines={1} style={styles.rowName}>
            {connection.profile.firstName}
          </Text>
          <Text variant="caption" tone="label">
            {t('connections.day', { count: days })}
          </Text>
        </View>
        <Text variant="bodySmall" numberOfLines={1}>
          {connection.lastMessage}
        </Text>
        <Text style={styles.stage}>{t(`connections.stage.${stageKey(connection.stage)}`)}</Text>
      </View>

      {connection.unread ? <View style={styles.unreadDot} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  header: { paddingHorizontal: space.gutterWide, paddingTop: 10 },
  title: { marginTop: 8 },
  subtitle: { marginTop: 10 },

  list: {
    paddingHorizontal: space.gutterWide,
    paddingTop: 18,
    paddingBottom: 24,
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    borderWidth: 1,
    borderColor: alpha.line,
    borderRadius: radius.card,
    padding: 14,
    backgroundColor: color.surface,
  },
  rowPressed: { borderColor: 'rgba(10,10,10,0.35)' },
  rowRTL: { flexDirection: 'row-reverse' },
  avatar: { width: 48, height: 48, borderRadius: 24 },
  rowBody: { flex: 1, gap: 4 },
  rowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 8,
  },
  rowName: { flex: 1 },
  stage: {
    fontFamily: 'Beiruti_500Medium',
    fontSize: 11,
    letterSpacing: 1.7,
    textTransform: 'uppercase',
    color: color.gold,
  },
  unreadDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: color.gold,
  },
});

function stageKey(stage: ConnectionStage): 'questions' | 'answers' | 'recap' | 'open' {
  return stage === 'choosing_questions' ? 'questions' : stage === 'answering' ? 'answers' : stage;
}
