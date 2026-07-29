import type { ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { alpha, color, radius, space } from '@/theme/tokens';

export interface CardProps {
  children: ReactNode;
  /** `dark` is the inverted panel used for Premium and the "Start here" prompt. */
  tone?: 'outlined' | 'filled' | 'dark' | 'accent';
  style?: ViewStyle;
}

export function Card({ children, tone = 'outlined', style }: CardProps) {
  return <View style={[styles.base, styles[tone], style]}>{children}</View>;
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.panel, padding: space.lg + 2 },
  outlined: {
    borderWidth: 1,
    borderColor: alpha.line,
    backgroundColor: color.surface,
  },
  filled: { backgroundColor: color.sand },
  dark: { backgroundColor: color.ink },
  /** The "Confidential by design" note — gold at low opacity. */
  accent: {
    backgroundColor: 'rgba(138,106,52,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(138,106,52,0.2)',
    borderRadius: radius.lg,
  },
});
