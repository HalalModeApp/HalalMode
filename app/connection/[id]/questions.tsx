import { useMutation, useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { fetchConnection, submitQuestionPicks } from '@/api/connections';
import { ScreenHeader } from '@/components/navigation/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { CATEGORY_LABELS, QUESTIONS_TO_PICK, QUESTION_LIBRARY } from '@/data/questions';
import { queryKeys } from '@/lib/queryClient';
import { alpha, color, radius, space } from '@/theme/tokens';

export default function QuestionSelectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [picked, setPicked] = useState<string[]>([]);

  const { data: connection } = useQuery({
    queryKey: queryKeys.connection(id),
    queryFn: () => fetchConnection(id),
  });

  const mutation = useMutation({
    mutationFn: () => submitQuestionPicks(id, picked),
    onSuccess: () => router.push(`/connection/${id}/answers`),
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
  const firstName = connection?.profile.firstName ?? '';

  return (
    <Screen>
      <ScreenHeader action="back" />
      <View style={styles.header}>
        <Text variant="micro">
          Step 1 of 3{firstName ? ` · with ${firstName}` : ''}
        </Text>
        <Text variant="display" style={styles.title}>
          Pick the five that would change your answer.
        </Text>
        <Text variant="bodySmall" style={styles.subtitle}>
          {firstName ? `${firstName}’s five` : 'Their five'} are chosen
          separately. Overlaps are marked when you meet in the middle.
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
              accessibilityLabel={question.text}
              disabled={blocked}
              onPress={() => toggle(question.id)}
              style={[
                styles.option,
                selected && styles.optionSelected,
                blocked && styles.optionBlocked,
              ]}
            >
              <View style={styles.optionText}>
                <Text variant="micro">{CATEGORY_LABELS[question.category]}</Text>
                <Text style={styles.questionText}>{question.text}</Text>
              </View>
              <View style={[styles.dot, selected && styles.dotSelected]} />
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.footer}>
        <Text variant="bodySmall">
          {picked.length} of {QUESTIONS_TO_PICK} chosen
        </Text>
        <Button
          label="Answer them"
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
  optionBlocked: { opacity: 0.4 },
  optionText: { flex: 1, gap: 5 },
  questionText: {
    fontFamily: 'Beiruti_500Medium',
    fontSize: 12.5,
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
