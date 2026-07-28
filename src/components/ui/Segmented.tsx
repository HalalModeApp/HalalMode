import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui/Text';
import { color, font, radius } from '@/theme/tokens';

export interface SegmentedProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

/** The pill-track tab switcher used on the You screen and its Private sub-tabs. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: SegmentedProps<T>) {
  return (
    <View style={styles.track} accessibilityRole="tablist">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            style={[styles.segment, active && styles.segmentActive]}
          >
            <Text style={[styles.label, active && styles.labelActive]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    gap: 2,
    backgroundColor: color.sand,
    borderRadius: radius.pill,
    padding: 4,
  },
  segment: {
    flex: 1,
    borderRadius: radius.pill,
    paddingVertical: 10,
    alignItems: 'center',
  },
  segmentActive: { backgroundColor: color.surface },
  label: { fontFamily: font.bodyMedium, fontSize: 12, color: color.faint },
  labelActive: { fontFamily: font.bodySemi, color: color.ink },
});
