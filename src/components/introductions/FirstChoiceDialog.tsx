import { Image } from 'expo-image';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInUp } from 'react-native-reanimated';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { alpha, color, radius, shadow, space } from '@/theme/tokens';
import type { Introduction } from '@/types';

export interface FirstChoiceDialogProps {
  visible: boolean;
  /** The keeps this member is about to send interest to. */
  introductions: Introduction[];
  selectedId: string | null;
  onSelect: (introductionId: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Asks a Premium member which of their keeps comes first.
 *
 * Free members never see this: keeping one of five makes their pick their first
 * choice by definition. Premium keeps up to three, and without an order their
 * actual first choice is unknowable — which leaves mutual first choice, the
 * measure this whole system is judged against, blind for exactly the members
 * who have the most say.
 *
 * The answer is never disclosed. Being told you were someone's third choice is
 * precisely the comparison this product exists to avoid, so the order lives
 * server-side and reaches nobody.
 */
export function FirstChoiceDialog({
  visible,
  introductions,
  selectedId,
  onSelect,
  onConfirm,
  onCancel,
}: FirstChoiceDialogProps) {
  const { t, isRTL } = useI18n();

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onCancel}>
      <Animated.View entering={FadeIn.duration(160)} style={styles.scrim}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onCancel}
          accessibilityLabel={t('daily.notYet')}
        />
        <Animated.View entering={FadeInUp.duration(200)} style={styles.card}>
          <Text variant="displaySmall" center>
            {t('daily.firstChoiceTitle')}
          </Text>
          <Text variant="bodySmall" center style={styles.body}>
            {t('daily.firstChoiceBody')}
          </Text>

          <View style={styles.options}>
            {introductions.map((introduction) => {
              const selected = introduction.id === selectedId;
              return (
                <Pressable
                  key={introduction.id}
                  testID={`first-choice-${introduction.id}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={introduction.profile.firstName}
                  onPress={() => onSelect(introduction.id)}
                  style={[
                    styles.option,
                    isRTL && styles.rowReverse,
                    selected && styles.optionSelected,
                  ]}
                >
                  <Image
                    source={introduction.profile.photos[0]}
                    style={styles.avatar}
                    contentFit="cover"
                    accessibilityIgnoresInvertColors
                  />
                  <Text variant="label" style={styles.name}>
                    {introduction.profile.firstName}
                  </Text>
                  <View style={[styles.dot, selected && styles.dotSelected]} />
                </Pressable>
              );
            })}
          </View>

          <View style={styles.actions}>
            <Button
              label={t('daily.notYet')}
              variant="secondary"
              onPress={onCancel}
              style={styles.action}
            />
            <Button
              label={t('daily.yesSend')}
              variant="gold"
              disabled={selectedId === null}
              onPress={onConfirm}
              style={styles.action}
            />
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(10,10,10,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 26,
  },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.xl,
    paddingVertical: space.xxl,
    paddingHorizontal: space.gutterWide,
    maxWidth: 320,
    width: '100%',
    ...shadow.modal,
  },
  body: { marginTop: space.sm, color: color.muted },
  options: { marginTop: space.xl, gap: 8 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: alpha.line,
    borderRadius: radius.card,
    padding: 10,
  },
  rowReverse: { flexDirection: 'row-reverse' },
  optionSelected: { borderColor: color.goldGlow, backgroundColor: 'rgba(197,160,84,0.07)' },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  name: { flex: 1, fontSize: 13 },
  dot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: alpha.lineStrong,
  },
  dotSelected: { backgroundColor: color.goldGlow, borderColor: color.goldGlow },
  actions: { flexDirection: 'row', gap: 10, marginTop: space.xl },
  action: { flex: 1, paddingHorizontal: 8 },
});
