import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { color, space } from '@/theme/tokens';

interface BoundaryProps {
  children: ReactNode;
  title: string;
  message: string;
  retryLabel: string;
  retryHint: string;
}

interface BoundaryState {
  hasError: boolean;
}

/**
 * Keeps an unexpected rendering failure recoverable without exposing error
 * details, account data, or a raw native exception to the member.
 */
class RecoveryBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { hasError: false };

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Deliberately do not log private state here. A future observability client
    // must redact account and profile data before receiving this signal.
  }

  private recover = () => {
    this.setState({ hasError: false });
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <View
        accessible
        accessibilityLiveRegion="assertive"
        accessibilityLabel={`${this.props.title}. ${this.props.message}`}
        style={styles.container}
        testID="app-recovery"
      >
        <Text variant="displaySmall" center>{this.props.title}</Text>
        <Text variant="bodySmall" center style={styles.message}>{this.props.message}</Text>
        <Button
          accessibilityHint={this.props.retryHint}
          label={this.props.retryLabel}
          onPress={this.recover}
          testID="app-recovery-retry"
        />
      </View>
    );
  }
}

export function AppRecoveryBoundary({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <RecoveryBoundary
      message={t('connections.errorBody')}
      retryHint={t('common.retryHint')}
      retryLabel={t('common.tryAgain')}
      title={t('common.errorTitle')}
    >
      {children}
    </RecoveryBoundary>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: 32,
    backgroundColor: color.surface,
  },
  message: { maxWidth: 320 },
});
