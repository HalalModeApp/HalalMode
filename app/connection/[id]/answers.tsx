import { useMutation, useQuery } from '@tanstack/react-query';
import { BlurView } from 'expo-blur';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeInUp } from 'react-native-reanimated';

import { fetchConnection, submitAnswer } from '@/api/connections';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { ErrorState, InlineNotice, LoadingState } from '@/components/ui/AsyncState';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { QUESTION_LIBRARY } from '@/data/questions';
import { queryKeys } from '@/lib/queryClient';
import { useI18n } from '@/i18n';
import { alpha, color, radius, space } from '@/theme/tokens';
import type { QuestionAnswer } from '@/types';

/**
 * Step 2 of 3 — answer, then reveal.
 *
 * The rule the whole screen enforces: their words stay sealed until yours are
 * committed, and yours cannot be edited afterwards. That asymmetry is what
 * makes the answers worth reading.
 */
export default function AnswersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { language, isRTL, t } = useI18n();
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, QuestionAnswer>>({});

  const connectionQuery = useQuery({
    queryKey: queryKeys.connection(id),
    queryFn: () => fetchConnection(id),
  });

  const connection = connectionQuery.data;
  const answers = connection?.questions ?? [];
  const current = answers[index];

  const question = useMemo(
    () => QUESTION_LIBRARY.find((item) => item.id === current?.questionId),
    [current]
  );

  const mutation = useMutation({
    mutationFn: (text: string) => submitAnswer(id, current!.questionId, text),
    onSuccess: (result) => {
      setRevealed((state) => ({ ...state, [result.questionId]: result }));
    },
  });

  if (connectionQuery.isPending) {
    return <Screen><LoadingState label={t('answers.loading')} /></Screen>;
  }
  if (connectionQuery.isError || !connection) {
    return (
      <Screen>
        <ScreenHeader />
        <ErrorState
          title={t('answers.errorTitle')}
          message={t('answers.errorBody')}
          onRetry={() => void connectionQuery.refetch()}
        />
      </Screen>
    );
  }
  if (connection.stage === 'choosing_questions') {
    return <Redirect href={`/connection/${id}/${connection.myQuestionPicksSubmitted ? 'waiting' : 'questions'}`} />;
  }
  if (connection.stage === 'recap') return <Redirect href={`/connection/${id}/recap`} />;
  if (connection.stage === 'open') return <Redirect href={`/connection/${id}/chat`} />;
  if (!current || !question) {
    return (
      <Screen>
        <ScreenHeader />
        <ErrorState
          title={t('answers.notReadyTitle')}
          message={t('answers.notReadyBody')}
          onRetry={() => void connectionQuery.refetch()}
        />
      </Screen>
    );
  }

  const firstName = connection.profile.firstName;
  const draft = drafts[current.questionId] ?? '';
  const reveal = revealed[current.questionId];
  const committed = !!reveal;
  const isLast = index === answers.length - 1;

  const onPrimary = () => {
    if (!committed) {
      mutation.mutate(draft.trim());
      return;
    }
    if (isLast) router.replace(`/connection/${id}/recap`);
    else setIndex((i) => i + 1);
  };

  return (
    <Screen style={isRTL ? styles.rtl : undefined}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScreenHeader action="back" />
        <View style={styles.header}>
          <Text variant="micro">
            {t('answers.step', { current: index + 1, total: answers.length })}
          </Text>
          <View style={styles.progress}>
            {answers.map((answer, i) => (
              <View
                key={answer.questionId}
                style={[
                  styles.progressTick,
                  i <= index && styles.progressTickFilled,
                ]}
              />
            ))}
          </View>
        </View>

        <ScrollView
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text variant="microAccent">
            {t(`answers.origin.${current.origin}`, { name: firstName })}
          </Text>
          <Text variant="display" style={styles.question}>
            {language === 'ar' ? question.textAr : question.text}
          </Text>

          <View style={[styles.answerBox, committed && styles.answerBoxLocked]}>
            <Text variant="micro">{t('answers.yours')}</Text>
            <TextInput
              accessibilityLabel={t('answers.yours')}
              multiline
              editable={!committed}
              value={draft}
              onChangeText={(text) =>
                setDrafts((state) => ({ ...state, [current.questionId]: text }))
              }
              placeholder={t('answers.placeholder')}
              placeholderTextColor={color.whisper}
              style={styles.input}
            />
          </View>

          {committed && reveal.theirAnswer ? (
            <Animated.View
              entering={FadeInUp.duration(350)}
              style={styles.theirBox}
            >
              <Text variant="microAccent">{t('answers.theirs', { name: firstName })}</Text>
              <Text style={styles.theirText}>{reveal.theirAnswer}</Text>
            </Animated.View>
          ) : (
            <View style={styles.theirBox}>
              <Text variant="micro">{t('answers.theirs', { name: firstName })}</Text>
              <View style={styles.lockedWrap}>
                <Text style={styles.lockedText}>
                  {t('answers.locked', { name: firstName })}
                </Text>
                <BlurView
                  intensity={22}
                  tint="light"
                  style={StyleSheet.absoluteFill}
                />
              </View>
              <Text variant="bodySmall">{t('answers.hidden')}</Text>
            </View>
          )}
        </ScrollView>

        {mutation.isError ? (
          <InlineNotice message={t('answers.saveError')} />
        ) : null}

        <View style={styles.footer}>
          <Button
            label={t('common.back')}
            variant="quiet"
            disabled={index === 0}
            onPress={() => setIndex((i) => Math.max(0, i - 1))}
          />
          <Button
            label={
              committed
                ? isLast
                  ? t('answers.recap')
                  : t('answers.next')
                : t('answers.submit')
            }
            disabled={!committed && draft.trim().length < 10}
            loading={mutation.isPending}
            onPress={onPrimary}
            style={styles.cta}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  flex: { flex: 1 },
  header: { paddingHorizontal: space.gutterWide, paddingTop: 8 },
  progress: { flexDirection: 'row', gap: 5, marginTop: 12 },
  progressTick: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(10,10,10,0.08)',
  },
  progressTickFilled: { backgroundColor: color.ink },

  body: { paddingHorizontal: space.gutterWide, paddingTop: 20, paddingBottom: 20 },
  question: { marginTop: 10, fontSize: 24, lineHeight: 31 },

  answerBox: {
    marginTop: 20,
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    borderRadius: radius.card,
    padding: 16,
    backgroundColor: color.surface,
  },
  answerBoxLocked: { backgroundColor: color.sandLight, opacity: 0.85 },
  input: {
    marginTop: 10,
    minHeight: 110,
    textAlignVertical: 'top',
    fontFamily: 'Beiruti_400Regular',
    fontSize: 15,
    lineHeight: 22,
    color: color.ink,
  },

  theirBox: {
    marginTop: 14,
    borderRadius: radius.card,
    padding: 18,
    backgroundColor: color.sand,
    gap: 8,
  },
  lockedWrap: { overflow: 'hidden', borderRadius: radius.sm },
  lockedText: {
    fontFamily: 'Beiruti_400Regular',
    fontSize: 14,
    lineHeight: 21,
    color: color.faintest,
  },
  theirText: {
    fontFamily: 'Beiruti_400Regular',
    fontSize: 14,
    lineHeight: 23,
    color: color.inkSoft,
  },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: space.gutterWide,
    paddingTop: 16,
    paddingBottom: 26,
  },
  cta: { flex: 1 },
});
