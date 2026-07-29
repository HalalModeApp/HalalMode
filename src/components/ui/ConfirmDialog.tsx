import { Modal, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInUp } from 'react-native-reanimated';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useI18n } from '@/i18n';
import { alpha, color, radius, shadow, space } from '@/theme/tokens';

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The "Send interest to Amina?" confirmation. Deliberately modal — this is the
 * one irreversible tap in the round, and the reference stops the user cold here.
 */
export function ConfirmDialog({
  visible,
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const reducedMotion = useReducedMotion();
  const { isRTL } = useI18n();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onCancel}
    >
      <Animated.View
        accessibilityViewIsModal
        entering={reducedMotion ? undefined : FadeIn.duration(160)}
        style={styles.scrim}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onCancel}
          accessibilityLabel={cancelLabel}
        />
        <Animated.View
          accessible
          accessibilityRole="alert"
          entering={reducedMotion ? undefined : FadeInUp.duration(200)}
          style={[styles.card, isRTL && styles.rtl]}
        >
          <Text variant="displaySmall" center>
            {title}
          </Text>
          {body ? (
            <Text variant="bodySmall" center style={styles.body}>
              {body}
            </Text>
          ) : null}
          <View style={[styles.row, isRTL && styles.rowReverse]}>
            <Button
              label={cancelLabel}
              variant="secondary"
              onPress={onCancel}
              style={styles.action}
            />
            <Button
              label={confirmLabel}
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
  rtl: { direction: 'rtl' },
  rowReverse: { flexDirection: 'row-reverse' },
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(10,10,10,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 30,
  },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.xl,
    paddingVertical: space.xxl,
    paddingHorizontal: space.gutterWide,
    maxWidth: 290,
    width: '100%',
    ...shadow.modal,
  },
  body: { marginTop: space.sm, marginBottom: space.xl, color: color.muted },
  row: { flexDirection: 'row', gap: 10, marginTop: space.md },
  action: { flex: 1, paddingHorizontal: 8, borderColor: alpha.lineStrong },
});
