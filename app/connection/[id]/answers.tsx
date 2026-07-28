import { useMutation, useQuery } from '@tanstack/react-query';
import { BlurView } from 'expo-blur';
import { router, useLocalSearchParams } from 'expo-router';
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
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { QUESTION_LIBRARY } from '@/data/questions';
import { queryKeys } from '@/lib/queryClient';
import { alpha, color, radius, space } from '@/theme/tokens';
import type { QuestionAnswer } from '@/types';

const ORIGIN_LABEL: Record<QuestionAnswer['origin'], (name: string) => string> = {
  both: () => 'Chosen by both of you',
  me: () => 'Chosen by you',
  them: (name) => `Chosen by ${name}`,
};

/**
 * Step 2 of 3 — answer, then reveal.
 *
 * The rule the whole screen enforces: their words stay sealed until yours are
 * committed, and yours cannot be edited afterwards. That asymmetry is what
 * makes the answers worth reading.
 */
export default function AnswersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, QuestionAnswer>>({});

  const { data: connection } = useQuery({
    queryKey: queryKeys.connection(id),
    queryFn: () => fetchConnection(id),
  });

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

  if (!connection || !current || !question) {
    return (
      <Screen>
        <View style={styles.centred}>
          <Text variant="bodySmall">Loading your questions…</Text>
        </View>
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
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScreenHeader action="back" />
        <View style={styles.header}>
          <Text variant="micro">
            Step 2 of 3 · question {index + 1} of {answers.length}
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
            {ORIGIN_LABEL[current.origin](firstName)}
          </Text>
          <Text variant="display" style={styles.question}>
            {question.text}
          </Text>

          <View style={[styles.answerBox, committed && styles.answerBoxLocked]}>
            <Text variant="micro">Your answer</Text>
            <TextInput
              accessibilityLabel="Your answer"
              multiline
              editable={!committed}
              value={draft}
              onChangeText={(text) =>
                setDrafts((state) => ({ ...state, [current.questionId]: text }))
              }
              placeholder="Say it the way you would say it out loud."
              placeholderTextColor={color.whisper}
              style={styles.input}
            />
          </View>

          {committed && reveal.theirAnswer ? (
            <Animated.View
              entering={FadeInUp.duration(350)}
              style={styles.theirBox}
            >
              <Text variant="microAccent">{firstName}’s answer</Text>
              <Text style={styles.theirText}>{reveal.theirAnswer}</Text>
            </Animated.View>
          ) : (
            <View style={styles.theirBox}>
              <Text variant="micro">{firstName}’s answer</Text>
              <View style={styles.lockedWrap}>
                <Text style={styles.lockedText}>
                  She has answered already. Her words unlock the moment you
                  commit to yours — no editing after reading.
                </Text>
                <BlurView
                  intensity={22}
                  tint="light"
                  style={StyleSheet.absoluteFill}
                />
              </View>
              <Text variant="bodySmall">Hidden until you submit.</Text>
            </View>
          )}
        </ScrollView>

        <View style={styles.footer}>
          <Button
            label="Back"
            variant="quiet"
            disabled={index === 0}
            onPress={() => setIndex((i) => Math.max(0, i - 1))}
          />
          <Button
            label={
              committed
                ? isLast
                  ? 'See the recap'
                  : 'Next question'
                : 'Submit and reveal'
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
  flex: { flex: 1 },
  centred: { flex: 1, alignItems: 'center', justifyContent: 'center' },

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
    fontSize: 13,
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
    fontSize: 12.5,
    lineHeight: 21,
    color: color.faintest,
  },
  theirText: {
    fontFamily: 'Beiruti_400Regular',
    fontSize: 13,
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
