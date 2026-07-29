import { Modal, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInUp } from 'react-native-reanimated';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useI18n } from '@/i18n';
import { color, font, radius, shadow, space } from '@/theme/tokens';

interface ConductAcknowledgementProps {
  visible: boolean;
  onAccept: () => void;
}

/** A brief, one-time behavioural commitment. It is not a substitute for legal consent. */
export function ConductAcknowledgement({ visible, onAccept }: ConductAcknowledgementProps) {
  const { t, isRTL } = useI18n();
  const reducedMotion = useReducedMotion();
  const commitments = [
    t('conduct.honest'),
    t('conduct.respectful'),
    t('conduct.considerate'),
    t('conduct.safe'),
  ];

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={() => {}}>
      <Animated.View
        accessibilityViewIsModal
        entering={reducedMotion ? undefined : FadeIn.duration(150)}
        style={styles.scrim}
      >
        <Animated.View
          accessible
          accessibilityRole="alert"
          entering={reducedMotion ? undefined : FadeInUp.duration(200)}
          style={[styles.card, isRTL && styles.rtl]}
        >
          <Text variant="microAccent">{t('conduct.eyebrow')}</Text>
          <Text variant="displaySmall" style={styles.title}>{t('conduct.title')}</Text>
          <Text variant="bodySmall" style={styles.body}>{t('conduct.body')}</Text>
          <View style={styles.commitments}>
            {commitments.map((commitment) => (
              <View key={commitment} style={[styles.commitment, isRTL && styles.rowReverse]}>
                <View accessibilityElementsHidden style={styles.check}><Text style={styles.checkLabel}>✓</Text></View>
                <Text variant="bodySmall" style={styles.commitmentText}>{commitment}</Text>
              </View>
            ))}
          </View>
          <Button label={t('conduct.accept')} onPress={onAccept} style={styles.action} />
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  rowReverse: { flexDirection: 'row-reverse' },
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(10,10,10,0.48)' },
  card: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: space.gutterWide,
    paddingTop: space.xxl,
    paddingBottom: space.xxl,
    backgroundColor: color.surface,
    ...shadow.modal,
  },
  title: { marginTop: 8 },
  body: { marginTop: 10, color: color.inkSoft },
  commitments: { gap: 11, marginTop: space.xl },
  commitment: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  check: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: color.sandDeep },
  checkLabel: { fontFamily: font.bodyBold, fontSize: 12, color: color.ink },
  commitmentText: { flex: 1, color: color.ink },
  action: { marginTop: space.xxl },
});
