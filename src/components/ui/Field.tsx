import {
  StyleSheet,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';

import { Text } from '@/components/ui/Text';
import { alpha, color, font, radius } from '@/theme/tokens';

export interface FieldProps extends TextInputProps {
  label: string;
  /** Validation message from react-hook-form / zod. */
  error?: string;
  containerStyle?: ViewStyle;
}

export function Field({
  label,
  error,
  containerStyle,
  style,
  multiline,
  ...rest
}: FieldProps) {
  return (
    <View style={[styles.wrap, containerStyle]}>
      <Text variant="micro" style={styles.label}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={color.whisper}
        multiline={multiline}
        style={[styles.input, multiline && styles.multiline, error && styles.inputError, style]}
        {...rest}
      />
      {error ? (
        <Text variant="caption" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6, flex: 1, minWidth: 130 },
  label: { letterSpacing: 2 },
  input: {
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    borderRadius: radius.md,
    paddingVertical: 13,
    paddingHorizontal: 14,
    fontFamily: font.body,
    fontSize: 12.5,
    color: color.ink,
    backgroundColor: color.surface,
  },
  multiline: { minHeight: 104, textAlignVertical: 'top', lineHeight: 21 },
  inputError: { borderColor: 'rgba(163,58,58,0.55)' },
  error: { color: '#A33A3A' },
});
