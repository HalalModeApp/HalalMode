import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { color, space } from '@/theme/tokens';

interface LoadingStateProps {
  label?: string;
}

export function LoadingState({ label = 'Loading' }: LoadingStateProps) {
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={styles.container}
    >
      <ActivityIndicator color={color.ink} />
      <Text variant="bodySmall" center>{label}</Text>
    </View>
  );
}

interface ErrorStateProps {
  title?: string;
  message: string;
  retryLabel?: string;
  onRetry?: () => void;
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  retryLabel = 'Try again',
  onRetry,
}: ErrorStateProps) {
  return (
    <View accessibilityLiveRegion="assertive" style={styles.container}>
      <Text variant="displaySmall" center>{title}</Text>
      <Text variant="bodySmall" center style={styles.copy}>{message}</Text>
      {onRetry ? (
        <Button
          accessibilityHint="Retries loading this screen"
          block={false}
          label={retryLabel}
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
  return (
    <View accessibilityLiveRegion="assertive" style={styles.notice}>
      <Text variant="bodySmall" style={styles.noticeMessage}>{message}</Text>
      {actionLabel && onAction ? (
        <Pressable accessibilityRole="button" onPress={onAction} hitSlop={10}>
          <Text variant="label" tone="gold">{actionLabel}</Text>
        </Pressable>
      ) : null}
      {onDismiss ? (
        <Pressable
          accessibilityLabel="Dismiss message"
          accessibilityRole="button"
          hitSlop={10}
          onPress={onDismiss}
        >
          <Text variant="label">Close</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
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
