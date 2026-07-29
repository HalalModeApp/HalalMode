import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui/Text';
import { alpha, color, font, radius } from '@/theme/tokens';

export interface ChipProps {
  label: string;
  /** Selected chips invert to near-black, matching the preference editor. */
  selected?: boolean;
  onPress?: () => void;
  /** Renders a trailing check when selected. */
  showMark?: boolean;
}

/**
 * The pill that carries profile traits, build preferences and country filters.
 * Static when no `onPress` is given — the profile-detail chips are read-only.
 */
export function Chip({ label, selected = false, onPress, showMark }: ChipProps) {
  const body = (
    <View style={[styles.chip, selected && styles.chipSelected]}>
      <Text style={[styles.label, selected && styles.labelSelected]}>{label}</Text>
      {showMark && selected ? (
        <Text style={[styles.label, styles.labelSelected, styles.mark]}>✓</Text>
      ) : null}
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => (pressed ? styles.pressed : undefined)}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    borderRadius: radius.pill,
    paddingVertical: 7,
    paddingHorizontal: 13,
    minHeight: 44,
  },
  chipSelected: { backgroundColor: color.ink, borderColor: color.ink },
  label: { fontFamily: font.body, fontSize: 11.5, color: color.inkSoft },
  labelSelected: { color: color.white, fontFamily: font.bodyMedium },
  mark: { fontSize: 10 },
  pressed: { opacity: 0.65 },
});
