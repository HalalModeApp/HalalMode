import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { fetchConnection, openConnection } from '@/api/connections';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { queryKeys } from '@/lib/queryClient';
import { alpha, color, radius, space } from '@/theme/tokens';
import type { RecapItem } from '@/types';

export default function RecapScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();

  const { data: connection } = useQuery({
    queryKey: queryKeys.connection(id),
    queryFn: () => fetchConnection(id),
  });

  const recap = connection?.recap ?? [];
  const alignedCount = recap.filter((item) => item.verdict === 'aligned').length;
  const openMutation = useMutation({
    mutationFn: () => openConnection(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.connection(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.connections }),
      ]);
      router.replace(`/connection/${id}/chat`);
    },
  });

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <ScreenHeader action="back" />
        <View style={styles.header}>
          <Text variant="micro">Step 3 of 3 · alignment</Text>
          <Text variant="display" style={styles.title}>
            You agree on {spellOut(alignedCount)} of {recap.length}.
          </Text>
          <Text variant="bodySmall" style={styles.subtitle}>
            A recap is not a score. It shows where the conversation should start.
          </Text>
        </View>

        <View style={styles.list}>
          {recap.map((item) => (
            <RecapCard key={item.questionId} item={item} />
          ))}
        </View>

        <Card tone="dark" style={styles.startHere}>
          <Text style={styles.startHereLabel}>Start here</Text>
          <Text style={styles.startHereQuote}>
            “Tell me what a Friday evening looks like in the home you imagine.”
          </Text>
        </Card>

        <View style={styles.actions}>
          <Button
            label="Open conversation"
            loading={openMutation.isPending}
            onPress={() => openMutation.mutate()}
          />
          <Button
            label="Close politely instead"
            variant="quiet"
            onPress={() => router.replace('/(tabs)/connections')}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

function RecapCard({ item }: { item: RecapItem }) {
  const aligned = item.verdict === 'aligned';

  return (
    <View style={styles.card}>
      <Text variant="label" style={styles.cardHeading}>
        {item.heading}
      </Text>
      <View style={[styles.tag, aligned ? styles.tagAligned : styles.tagDiscuss]}>
        <Text style={[styles.tagLabel, aligned ? styles.tagLabelAligned : styles.tagLabelDiscuss]}>
          {aligned ? 'Aligned' : 'Talk about this'}
        </Text>
      </View>
      <Text variant="bodySmall">{item.note}</Text>
    </View>
  );
}

/** The reference writes these out in words. It reads calmer than a numeral. */
function spellOut(n: number): string {
  return (
    ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][n] ?? String(n)
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40 },
  header: { paddingHorizontal: space.gutterWide, paddingTop: 8 },
  title: { marginTop: 8 },
  subtitle: { marginTop: 10 },

  list: { paddingHorizontal: space.gutterWide, marginTop: 18, gap: 9 },
  card: {
    borderWidth: 1,
    borderColor: alpha.line,
    borderRadius: radius.xl,
    paddingVertical: 15,
    paddingHorizontal: 16,
    gap: 9,
    alignItems: 'flex-start',
  },
  cardHeading: { fontSize: 12.5 },
  tag: {
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  tagAligned: { backgroundColor: 'rgba(47,93,74,0.09)' },
  tagDiscuss: { backgroundColor: 'rgba(138,106,52,0.1)' },
  tagLabel: {
    fontFamily: 'Beiruti_700Bold',
    fontSize: 9,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  tagLabelAligned: { color: color.green },
  tagLabelDiscuss: { color: color.gold },

  startHere: {
    marginHorizontal: space.gutterWide,
    marginTop: 18,
    borderRadius: radius.panel,
  },
  startHereLabel: {
    fontFamily: 'Beiruti_600SemiBold',
    fontSize: 9,
    letterSpacing: 2.4,
    textTransform: 'uppercase',
    color: '#B79A62',
  },
  startHereQuote: {
    marginTop: 9,
    fontFamily: 'PlayfairDisplay_400Regular',
    fontSize: 17,
    lineHeight: 25,
    color: color.white,
  },

  actions: {
    paddingHorizontal: space.gutterWide,
    marginTop: 22,
    gap: 10,
  },
});
