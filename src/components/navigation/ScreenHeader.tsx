import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { alpha, color, space } from '@/theme/tokens';

export interface ScreenHeaderProps {
  /**
   * `back` for drilling down and returning — a profile, a step in a flow.
   * `close` for full-screen takeovers that are dismissed rather than reversed —
   * the gallery, the match reveal.
   */
  action?: 'back' | 'close';
  /** Where the button goes. Defaults to `router.back()`. */
  onAction?: () => void;
  /** Wide-tracked micro-label on the right, e.g. "Introduction 1 of 5". */
  trailingLabel?: string;
  /** `dark` for use over photography and the near-black screens. */
  tone?: 'light' | 'dark';
  /** Optional semantic control rendered opposite the leading navigation action. */
  trailing?: ReactNode;
}

/**
 * The leading control for any screen deeper than a tab.
 *
 * The bottom rail only exists on the three tab screens; everywhere below them
 * this is the way out, and it sits top-left so it stays in thumb reach on the
 * hand most people hold a phone with.
 */
export function ScreenHeader({
  action = 'back',
  onAction,
  trailingLabel,
  tone = 'light',
  trailing,
}: ScreenHeaderProps) {
  const dark = tone === 'dark';
  const { isRTL, t } = useI18n();

  return (
    <View style={[styles.row, isRTL && styles.rowRTL]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={action === 'back' ? t('header.back') : t('header.close')}
        onPress={onAction ?? (() => router.back())}
        hitSlop={12}
        style={({ pressed }) => [
          styles.button,
          dark ? styles.buttonDark : styles.buttonLight,
          pressed && styles.pressed,
        ]}
      >
        <Ionicons
          name={
            action === 'close'
              ? 'close'
              : isRTL
                ? 'chevron-forward'
                : 'chevron-back'
          }
          color={dark ? color.white : color.inkSoft}
          size={20}
        />
      </Pressable>

      {trailing || trailingLabel ? (
        <View style={[styles.trailing, isRTL && styles.trailingRTL]}>
          {trailingLabel ? (
            <Text variant="micro" style={dark ? styles.labelDark : undefined}>
              {trailingLabel}
            </Text>
          ) : null}
          {trailing}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: space.gutter,
    paddingVertical: 8,
    minHeight: 50,
  },
  rowRTL: { flexDirection: 'row-reverse' },
  button: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLight: {
    backgroundColor: color.sandDeep,
    borderWidth: 1,
    borderColor: alpha.line,
  },
  buttonDark: {
    backgroundColor: 'rgba(252,252,251,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(252,252,251,0.18)',
  },
  pressed: { opacity: 0.6, transform: [{ scale: 0.94 }] },
  labelDark: { color: 'rgba(252,252,251,0.6)' },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  trailingRTL: { flexDirection: 'row-reverse' },
});
