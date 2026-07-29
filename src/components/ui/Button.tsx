import * as Haptics from 'expo-haptics';
import { useCallback } from 'react';
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';

import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { alpha, color, font, microLabel, radius } from '@/theme/tokens';

export type ButtonVariant =
  /** Near-black pill. One per screen — the single forward action. */
  | 'primary'
  /** Outlined pill. "Let go", "Not yet", "Pause my profile". */
  | 'secondary'
  /** Text only. "Later tonight", "Close politely instead". */
  | 'quiet'
  /** Inverted primary, for use inside the near-black panels. */
  | 'onDark'
  /**
   * The chosen-one call to action. Gold is reserved for this single moment —
   * it should never appear anywhere a decision is still open.
   */
  | 'gold';

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  label: string;
  variant?: ButtonVariant;
  loading?: boolean;
  /** Fill the row. Defaults to true for primary/secondary. */
  block?: boolean;
  /** Small leading dot, as on the release action. */
  dotColor?: string;
  style?: ViewStyle;
}

export function Button({
  label,
  variant = 'primary',
  loading = false,
  block,
  dotColor,
  disabled,
  onPress,
  style,
  ...rest
}: ButtonProps) {
  const { isRTL } = useI18n();
  const isDisabled = disabled || loading;
  const fills = block ?? variant !== 'quiet';

  const handlePress = useCallback<NonNullable<PressableProps['onPress']>>(
    (event) => {
      // Every committing tap gets a light tick. The reference's whole pitch is
      // deliberate choices, so the feedback should feel considered, not buzzy.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onPress?.(event);
    },
    [onPress]
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        fills ? styles.block : null,
        pressed && !isDisabled ? pressedStyles[variant] : null,
        isDisabled ? styles.disabled : null,
        style,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'primary' ? color.white : color.ink}
        />
      ) : (
        <View style={styles.labelWrap}>
          {dotColor ? (
            <View style={[styles.dot, { backgroundColor: dotColor }]} />
          ) : null}
          <Text style={[styles.label, labelStyles[variant], isRTL && styles.labelRTL]}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.pill,
    paddingVertical: 15,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  block: { alignSelf: 'stretch' },
  labelWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: {
    fontFamily: font.bodyBold,
    ...microLabel.medium,
    letterSpacing: 1.2,
  },
  labelRTL: { letterSpacing: 0, textTransform: 'none' },
  primary: { backgroundColor: color.ink },
  secondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: alpha.lineButton,
  },
  quiet: { paddingVertical: 12, paddingHorizontal: 0, minHeight: 0 },
  onDark: { backgroundColor: color.white },
  gold: { backgroundColor: color.goldGlow },
  disabled: { opacity: 0.35 },
});

const pressedStyles = StyleSheet.create({
  primary: { backgroundColor: color.inkPressed },
  secondary: { borderColor: color.ink },
  quiet: { opacity: 0.6 },
  onDark: { opacity: 0.85 },
  gold: { backgroundColor: '#B08E44' },
});

const labelStyles = StyleSheet.create({
  primary: { color: color.white },
  secondary: { color: color.inkSoft },
  quiet: {
    color: color.faintest,
    fontFamily: font.body,
    letterSpacing: 0.8,
    textTransform: 'none',
    fontSize: 11.5,
  },
  onDark: { color: color.ink },
  gold: { color: '#3A2C10' },
});
