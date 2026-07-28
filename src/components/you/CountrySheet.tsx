import { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { COUNTRIES } from '@/data/preferences';
import { alpha, color, font, radius, space } from '@/theme/tokens';

export interface CountrySheetProps {
  visible: boolean;
  selected: string[];
  onChange: (next: string[]) => void;
  onClose: () => void;
}

/** Normalises accents so "Cote d'Ivoire" finds "Côte d’Ivoire". */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '');
}

export function CountrySheet({
  visible,
  selected,
  onChange,
  onClose,
}: CountrySheetProps) {
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');

  const results = useMemo(() => {
    const query = normalise(search.trim());
    if (!query) return COUNTRIES as readonly string[];
    return COUNTRIES.filter((country) => normalise(country).includes(query));
  }, [search]);

  const toggle = (country: string) => {
    onChange(
      selected.includes(country)
        ? selected.filter((item) => item !== country)
        : [...selected, country]
    );
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />

        <Animated.View entering={FadeInDown.duration(280)} style={styles.sheet}>
          <View style={styles.head}>
            <View style={styles.headTop}>
              <View>
                <Text variant="microAccent">Geographic filter</Text>
                <Text variant="displaySmall" style={styles.headTitle}>
                  Preferred countries
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close country filter"
                onPress={onClose}
                style={styles.close}
              >
                <Text style={styles.closeGlyph}>✕</Text>
              </Pressable>
            </View>

            <TextInput
              accessibilityLabel="Search countries"
              value={search}
              onChangeText={setSearch}
              placeholder="Search countries…"
              placeholderTextColor={color.whisper}
              style={styles.search}
            />

            <View style={styles.headMeta}>
              <View style={styles.countPill}>
                <Text style={styles.countLabel}>{selected.length}</Text>
              </View>
              <Text variant="caption" style={styles.resultLabel} numberOfLines={1}>
                {results.length} shown
              </Text>
              <View style={styles.bulkActions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onChange([...results])}
                >
                  <Text style={styles.bulkPrimary}>Select all</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => onChange([])}>
                  <Text style={styles.bulkQuiet}>Clear all</Text>
                </Pressable>
              </View>
            </View>
          </View>

          <ScrollView
            contentContainerStyle={styles.rows}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {results.map((country) => {
              const isSelected = selected.includes(country);
              return (
                <Pressable
                  key={country}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                  onPress={() => toggle(country)}
                  style={[styles.row, isSelected && styles.rowSelected]}
                >
                  <Text style={[styles.rowLabel, isSelected && styles.rowLabelSelected]}>
                    {country}
                  </Text>
                  <View style={[styles.dot, isSelected && styles.dotSelected]}>
                    {isSelected ? <Text style={styles.tick}>✓</Text> : null}
                  </View>
                </Pressable>
              );
            })}

            {results.length === 0 ? (
              <Text variant="bodySmall" center style={styles.noResults}>
                No country matches that spelling.
              </Text>
            ) : null}
          </ScrollView>

          <View style={[styles.foot, { paddingBottom: insets.bottom + 20 }]}>
            <Button
              label={
                selected.length === 0
                  ? 'Anywhere is fine'
                  : `Use these ${selected.length}`
              }
              onPress={onClose}
            />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: alpha.scrim, justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '88%',
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    overflow: 'hidden',
  },

  head: {
    padding: space.gutter,
    borderBottomWidth: 1,
    borderBottomColor: alpha.lineFaint,
  },
  headTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  headTitle: { marginTop: 7 },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: color.sand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeGlyph: { fontFamily: font.body, fontSize: 13, color: color.inkSoft },

  search: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: 'rgba(10,10,10,0.12)',
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontFamily: font.body,
    fontSize: 12.5,
    color: color.ink,
    backgroundColor: color.sandLight,
  },

  headMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginTop: 12,
  },
  countPill: {
    backgroundColor: color.ink,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 11,
  },
  countLabel: { fontFamily: font.bodyBold, fontSize: 10, color: color.white },
  resultLabel: { flex: 1 },
  bulkActions: { flexDirection: 'row', gap: 14 },
  bulkPrimary: { fontFamily: font.bodySemi, fontSize: 11, color: color.gold },
  bulkQuiet: { fontFamily: font.bodySemi, fontSize: 11, color: color.faintest },

  rows: { padding: space.gutter, gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: alpha.line,
    borderRadius: radius.md,
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  rowSelected: { borderColor: color.ink, backgroundColor: color.sand },
  rowLabel: { fontFamily: font.body, fontSize: 12.5, color: color.inkSoft },
  rowLabelSelected: { fontFamily: font.bodySemi, color: color.ink },
  dot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotSelected: { backgroundColor: color.ink, borderColor: color.ink },
  tick: { color: color.white, fontSize: 10, fontFamily: font.body },
  noResults: { paddingVertical: 30 },

  foot: {
    paddingHorizontal: space.gutter,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: alpha.lineFaint,
  },
});
