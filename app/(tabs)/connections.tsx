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
import { useSession } from '@/state/session';
import { alpha, color, radius, space } from '@/theme/tokens';
import { TIER_LIMITS, type Connection, type ConnectionStage } from '@/types';

const STAGE_LABEL: Record<ConnectionStage, string> = {
  choosing_questions: 'Choose your five questions',
  answering: 'Answering · double blind',
  recap: 'Recap ready',
  open: 'Conversation open',
};

/** Where a tap on each stage should land. */
const STAGE_ROUTE: Record<ConnectionStage, string> = {
  choosing_questions: 'questions',
  answering: 'answers',
  recap: 'recap',
  open: 'chat',
};

export default function ConnectionsScreen() {
  const { tier } = useSession();
  const limit = TIER_LIMITS[tier].openConnections;

  const connectionsQuery = useQuery({
    queryKey: queryKeys.connections,
    queryFn: fetchConnections,
  });
  const connections = connectionsQuery.data ?? [];

  return (
    <Screen withTabBar>
      <BrandHeader />

      <View style={styles.header}>
        <Text variant="micro">Connections</Text>
        <Text variant="display" style={styles.title}>
          Your connections.
        </Text>
        <Text variant="bodySmall" style={styles.subtitle}>
          You can hold {limit} open conversations at once. Close one to start
          another.
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
      >
        {connectionsQuery.isPending ? <LoadingState label="Loading your connections" /> : null}
        {connectionsQuery.isError ? (
          <ErrorState
            title="Connections unavailable"
            message="We couldn't load your connections. Your conversations are still safe."
            onRetry={() => void connectionsQuery.refetch()}
          />
        ) : null}
        {connections.map((connection) => (
          <ConnectionRow key={connection.id} connection={connection} />
        ))}

        {!connectionsQuery.isPending && !connectionsQuery.isError && connections.length === 0 ? (
          <EmptyState
            title="No connections yet"
            message="When interest is mutual, your new connection will appear here."
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function ConnectionRow({ connection }: { connection: Connection }) {
  const [now, setNow] = useState(0);
  useEffect(() => setNow(Date.now()), []);
  const days = Math.max(
    1,
    Math.round((now - new Date(connection.createdAt).getTime()) / 86400_000)
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open your connection with ${connection.profile.firstName}`}
      onPress={() =>
        router.push(
          `/connection/${connection.id}/${STAGE_ROUTE[connection.stage]}`
        )
      }
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
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
            Day {days}
          </Text>
        </View>
        <Text variant="bodySmall" numberOfLines={1}>
          {connection.lastMessage}
        </Text>
        <Text style={styles.stage}>{STAGE_LABEL[connection.stage]}</Text>
      </View>

      {connection.unread ? <View style={styles.unreadDot} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
    fontSize: 9.5,
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
