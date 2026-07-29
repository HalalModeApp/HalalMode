import { useQuery } from '@tanstack/react-query';
import { Redirect, useLocalSearchParams } from 'expo-router';

import { fetchConnection } from '@/api/connections';
import { ErrorState, LoadingState } from '@/components/ui/AsyncState';
import { Screen } from '@/components/ui/Screen';
import { useI18n } from '@/i18n';
import { queryKeys } from '@/lib/queryClient';

/** Bare links resolve from server state instead of assuming chat is open. */
export default function ConnectionIndex() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  const connectionQuery = useQuery({
    queryKey: queryKeys.connection(id),
    queryFn: () => fetchConnection(id),
  });

  if (connectionQuery.isPending) {
    return <Screen><LoadingState label={t('connection.opening')} /></Screen>;
  }
  if (connectionQuery.isError || !connectionQuery.data) {
    return (
      <Screen>
        <ErrorState
          title={t('connection.errorTitle')}
          message={t('connection.errorBody')}
          onRetry={() => void connectionQuery.refetch()}
        />
      </Screen>
    );
  }

  const connection = connectionQuery.data;
  const destination = connection.stage === 'choosing_questions'
    ? connection.myQuestionPicksSubmitted ? 'waiting' : 'questions'
    : connection.stage === 'answering'
      ? 'answers'
      : connection.stage === 'recap'
        ? 'recap'
        : 'chat';
  return <Redirect href={`/connection/${id}/${destination}`} />;
}
