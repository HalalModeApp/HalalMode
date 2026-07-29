import { useMutation, useQuery } from '@tanstack/react-query';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { fetchConnection, submitQuestionPicks } from '@/api/connections';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { SafetyControl } from '@/components/safety/SafetyControl';
import { Button } from '@/components/ui/Button';
import { ErrorState, InlineNotice, LoadingState } from '@/components/ui/AsyncState';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { questionText, QUESTIONS_TO_PICK, QUESTION_LIBRARY } from '@/data/questions';
import { useI18n } from '@/i18n';
import { queryClient, queryKeys } from '@/lib/queryClient';
import { alpha, color, radius, space } from '@/theme/tokens';

export default function QuestionSelectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { language, isRTL, t } = useI18n();
  const [picked, setPicked] = useState<string[]>([]);

  const connectionQuery = useQuery({
    queryKey: queryKeys.connection(id),
    queryFn: () => fetchConnection(id),
  });

  const mutation = useMutation({
    mutationFn: () => submitQuestionPicks(id, picked),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.connection(id) });
      router.replace(`/connection/${id}/waiting`);
    },
  });

  const toggle = (questionId: string) => {
    setPicked((current) => {
      if (current.includes(questionId)) {
        return current.filter((item) => item !== questionId);
      }
      if (current.length >= QUESTIONS_TO_PICK) return current;
      return [...current, questionId];
    });
  };

  const complete = picked.length === QUESTIONS_TO_PICK;
  if (connectionQuery.isPending) {
    return <Screen><LoadingState label={t('questions.loading')} /></Screen>;
  }
  if (connectionQuery.isError || !connectionQuery.data) {
    return (
      <Screen>
        <ScreenHeader />
        <ErrorState
          title={t('questions.errorTitle')}
          message={t('questions.errorBody')}
          onRetry={() => void connectionQuery.refetch()}
        />
      </Screen>
    );
  }

  const connection = connectionQuery.data;
  if (connection.stage === 'answering') return <Redirect href={`/connection/${id}/answers`} />;
  if (connection.stage === 'recap') return <Redirect href={`/connection/${id}/recap`} />;
  if (connection.stage === 'open') return <Redirect href={`/connection/${id}/chat`} />;
  if (connection.myQuestionPicksSubmitted) return <Redirect href={`/connection/${id}/waiting`} />;

  const firstName = connection.profile.firstName;

  return (
    <Screen style={isRTL ? styles.rtl : undefined}>
      <ScreenHeader
        action="back"
        trailing={<SafetyControl scope={{ kind: 'connection', id }} memberName={firstName} />}
      />
      <View style={styles.header}>
        <Text variant="micro">
          {t('questions.step', { name: firstName ? t('questions.withName', { name: firstName }) : '' })}
        </Text>
        <Text variant="display" style={styles.title}>{t('questions.title')}</Text>
        <Text variant="bodySmall" style={styles.subtitle}>
          {firstName ? t('questions.bodyName', { name: firstName }) : t('questions.bodyFallback')}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
      >
        {QUESTION_LIBRARY.map((question) => {
          const selected = picked.includes(question.id);
          const blocked = !selected && complete;

          return (
            <Pressable
              key={question.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: selected, disabled: blocked }}
              accessibilityLabel={questionText(question, language)}
              disabled={blocked}
              onPress={() => toggle(question.id)}
              style={[
                styles.option,
                isRTL && styles.optionRTL,
                selected && styles.optionSelected,
                blocked && styles.optionBlocked,
              ]}
            >
              <View style={styles.optionText}>
                <Text variant="micro">{t(`questions.category.${question.category}`)}</Text>
                <Text style={styles.questionText}>{questionText(question, language)}</Text>
              </View>
              <View style={[styles.dot, selected && styles.dotSelected]} />
            </Pressable>
          );
        })}
      </ScrollView>

      {mutation.isError ? (
        <InlineNotice message={t('questions.savedError')} />
      ) : null}
      <View style={styles.footer}>
        <Text variant="bodySmall">
          {t('questions.chosen', { count: picked.length, total: QUESTIONS_TO_PICK })}
        </Text>
        <Button
          label={t('questions.answer')}
          disabled={!complete}
          loading={mutation.isPending}
          onPress={() => mutation.mutate()}
          style={styles.cta}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  header: { paddingHorizontal: space.gutterWide, paddingTop: 8 },
  title: { marginTop: 8 },
  subtitle: { marginTop: 10 },

  list: {
    paddingHorizontal: space.gutterWide,
    paddingTop: 16,
    paddingBottom: 10,
    gap: 8,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderWidth: 1,
    borderColor: alpha.line,
    borderRadius: radius.lg,
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: color.surface,
  },
  optionSelected: { borderColor: color.ink, backgroundColor: color.sand },
  optionRTL: { flexDirection: 'row-reverse' },
  optionBlocked: { opacity: 0.4 },
  optionText: { flex: 1, gap: 5 },
  questionText: {
    fontFamily: 'Beiruti_500Medium',
    fontSize: 14,
    lineHeight: 18,
    color: color.ink,
  },
  dot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: alpha.lineStrong,
  },
  dotSelected: { backgroundColor: color.ink, borderColor: color.ink },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: space.gutterWide,
    paddingTop: 14,
    paddingBottom: 26,
    borderTopWidth: 1,
    borderTopColor: alpha.lineFaint,
  },
  cta: { flex: 1 },
});
