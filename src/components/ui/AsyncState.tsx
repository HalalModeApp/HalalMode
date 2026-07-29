import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { color, space } from '@/theme/tokens';

interface LoadingStateProps {
  label?: string;
  testID?: string;
}

export function LoadingState({ label, testID = 'loading-state' }: LoadingStateProps) {
  const { t } = useI18n();
  const resolvedLabel = label ?? t('common.loading');
  return (
    <View
      accessible
      testID={testID}
      accessibilityLabel={resolvedLabel}
      accessibilityLiveRegion="polite"
      style={styles.container}
    >
      <ActivityIndicator color={color.ink} />
      <Text variant="bodySmall" center>{resolvedLabel}</Text>
    </View>
  );
}

interface ErrorStateProps {
  title?: string;
  message: string;
  retryLabel?: string;
  onRetry?: () => void;
  testID?: string;
}

export function ErrorState({
  title,
  message,
  retryLabel,
  onRetry,
  testID = 'error-state',
}: ErrorStateProps) {
  const { t } = useI18n();
  const resolvedTitle = title ?? t('common.errorTitle');
  return (
    <View
      accessible
      accessibilityRole="alert"
      accessibilityLabel={`${resolvedTitle}. ${message}`}
      accessibilityLiveRegion="assertive"
      testID={testID}
      style={styles.container}
    >
      <Text variant="displaySmall" center>{resolvedTitle}</Text>
      <Text variant="bodySmall" center style={styles.copy}>{message}</Text>
      {onRetry ? (
        <Button
          testID={`${testID}-retry`}
          accessibilityHint={t('common.retryHint')}
          block={false}
          label={retryLabel ?? t('common.tryAgain')}
          onPress={onRetry}
          style={styles.action}
        />
      ) : null}
    </View>
  );
}

interface EmptyStateProps {
  title: string;
  message: string;
}

export function EmptyState({ title, message }: EmptyStateProps) {
  return (
    <View style={styles.container}>
      <Text variant="displaySmall" center>{title}</Text>
      <Text variant="bodySmall" center style={styles.copy}>{message}</Text>
    </View>
  );
}

interface InlineNoticeProps {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}

export function InlineNotice({
  message,
  actionLabel,
  onAction,
  onDismiss,
}: InlineNoticeProps) {
  const { t, isRTL } = useI18n();
  return (
    <View accessibilityLiveRegion="assertive" style={[styles.notice, isRTL && styles.rowReverse]}>
      <Text variant="bodySmall" style={styles.noticeMessage}>{message}</Text>
      {actionLabel && onAction ? (
        <Pressable accessibilityRole="button" onPress={onAction} hitSlop={10}>
          <Text variant="label" tone="gold">{actionLabel}</Text>
        </Pressable>
      ) : null}
      {onDismiss ? (
        <Pressable
          accessibilityLabel={t('common.dismiss')}
          accessibilityRole="button"
          hitSlop={10}
          onPress={onDismiss}
        >
          <Text variant="label">{t('common.close')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  rowReverse: { flexDirection: 'row-reverse' },
  container: {
    flex: 1,
    minHeight: 220,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: 32,
    paddingVertical: 36,
  },
  copy: { maxWidth: 300 },
  action: { minWidth: 152, marginTop: space.xs },
  notice: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.gutterWide,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: 14,
    backgroundColor: color.sand,
  },
  noticeMessage: { flex: 1, color: color.inkSoft },
});
