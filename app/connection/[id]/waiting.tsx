import { useQuery } from '@tanstack/react-query';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { fetchConnection } from '@/api/connections';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { ErrorState, LoadingState } from '@/components/ui/AsyncState';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { queryKeys } from '@/lib/queryClient';
import { useI18n } from '@/i18n';
import { color, space } from '@/theme/tokens';

export default function WaitingForQuestionsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isRTL, t } = useI18n();
  const connectionQuery = useQuery({
    queryKey: queryKeys.connection(id),
    queryFn: () => fetchConnection(id),
    refetchInterval: 15_000,
  });

  if (connectionQuery.isPending) {
    return <Screen><LoadingState label={t('waiting.loading')} /></Screen>;
  }
  if (connectionQuery.isError || !connectionQuery.data) {
    return (
      <Screen>
        <ScreenHeader />
        <ErrorState
          title={t('waiting.errorTitle')}
          message={t('waiting.errorBody')}
          onRetry={() => void connectionQuery.refetch()}
        />
      </Screen>
    );
  }

  const connection = connectionQuery.data;
  if (connection.stage === 'answering') return <Redirect href={`/connection/${id}/answers`} />;
  if (connection.stage === 'recap') return <Redirect href={`/connection/${id}/recap`} />;
  if (connection.stage === 'open') return <Redirect href={`/connection/${id}/chat`} />;
  if (!connection.myQuestionPicksSubmitted) return <Redirect href={`/connection/${id}/questions`} />;

  return (
    <Screen style={isRTL ? styles.rtl : undefined}>
      <ScreenHeader onAction={() => router.replace('/(tabs)/connections')} />
      <View style={styles.content} accessibilityLiveRegion="polite">
        <View style={styles.mark}><Text style={styles.markLabel}>5</Text></View>
        <Text variant="microAccent">{t('waiting.saved')}</Text>
        <Text variant="display" center style={styles.title}>
          {t('waiting.title', { name: connection.profile.firstName })}
        </Text>
        <Text variant="body" center style={styles.copy}>
          {t('waiting.body')}
        </Text>
        <Button
          block={false}
          label={t('waiting.check')}
          loading={connectionQuery.isFetching}
          onPress={() => void connectionQuery.refetch()}
          style={styles.action}
        />
        <Button
          block={false}
          label={t('waiting.back')}
          variant="quiet"
          onPress={() => router.replace('/(tabs)/connections')}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 36,
    paddingBottom: 48,
  },
  mark: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xl,
    backgroundColor: color.ink,
  },
  markLabel: { color: color.white, fontSize: 18 },
  title: { marginTop: space.md },
  copy: { maxWidth: 310, marginTop: space.lg },
  action: { minWidth: 164, marginTop: space.xxl },
});
