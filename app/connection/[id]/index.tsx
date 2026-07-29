import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';

import { fetchConnection } from '@/api/connections';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { SafetyControl } from '@/components/safety/SafetyControl';
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
  return (
    <ConnectionRedirect
      id={id}
      destination={destination}
      memberName={connection.profile.firstName}
      loadingLabel={t('connection.opening')}
    />
  );
}

function ConnectionRedirect({
  id,
  destination,
  memberName,
  loadingLabel,
}: {
  id: string;
  destination: string;
  memberName: string;
  loadingLabel: string;
}) {
  useEffect(() => {
    router.replace(`/connection/${id}/${destination}`);
  }, [destination, id]);

  return (
    <Screen>
      <ScreenHeader
        trailing={<SafetyControl scope={{ kind: 'connection', id }} memberName={memberName} />}
      />
      <LoadingState label={loadingLabel} />
    </Screen>
  );
}
