import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { alpha, color, radius, shadow, space } from '@/theme/tokens';

interface ToastValue {
  /** Shows a brief message. Replacing a visible one restarts its timer. */
  show: (message: string) => void;
}

const ToastContext = createContext<ToastValue | null>(null);

const VISIBLE_MS = 4_000;

/**
 * A brief message that outlives the screen that asked for it.
 *
 * Mounted above the router on purpose. The messages worth showing this way tend
 * to accompany something that also navigates — hiding somebody closes their
 * profile and returns you to the set — and a notice living inside the screen
 * being left would be unmounted before it could be read.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { isRTL } = useI18n();
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(next);
    // Announced separately: the toast is not focusable and a screen reader
    // moving to the new screen would otherwise pass straight over it.
    AccessibilityInfo.announceForAccessibility(next);
    timer.current = setTimeout(() => setMessage(null), VISIBLE_MS);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const value = useMemo<ToastValue>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {message ? (
        <View
          pointerEvents="none"
          style={[styles.host, { paddingBottom: insets.bottom + space.xxl }]}
        >
          <Animated.View
            entering={FadeInDown.duration(220)}
            exiting={FadeOutDown.duration(180)}
            accessibilityRole="alert"
            style={[styles.toast, isRTL && styles.rtl]}
          >
            <Text variant="bodySmall" style={styles.label}>{message}</Text>
          </Animated.View>
        </View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside <ToastProvider>');
  return value;
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  host: {
    // Spelled out rather than absoluteFillObject, which RN 0.86 removed.
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: space.gutterWide,
  },
  toast: {
    maxWidth: 440,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: alpha.line,
    backgroundColor: color.ink,
    ...shadow.modal,
  },
  label: { color: color.white, textAlign: 'center' },
});
