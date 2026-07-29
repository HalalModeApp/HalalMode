import { useEffect, useMemo, useState } from 'react';
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
import { useI18n } from '@/i18n';
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
  const { t, isRTL } = useI18n();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState(selected);

  useEffect(() => {
    if (visible) {
      setPending(selected);
      setSearch('');
    }
  }, [selected, visible]);

  const results = useMemo(() => {
    const query = normalise(search.trim());
    if (!query) return COUNTRIES as readonly string[];
    return COUNTRIES.filter((country) => normalise(country).includes(query));
  }, [search]);

  const toggle = (country: string) => {
    setPending(
      pending.includes(country)
        ? pending.filter((item) => item !== country)
        : [...pending, country]
    );
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={[styles.scrim, isRTL && styles.rtl]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={t('country.close')} />

        <Animated.View entering={FadeInDown.duration(280)} style={styles.sheet}>
          <View style={styles.head}>
            <View style={[styles.headTop, isRTL && styles.rowReverse]}>
              <View>
                <Text variant="microAccent">{t('country.eyebrow')}</Text>
                <Text variant="displaySmall" style={styles.headTitle}>
                  {t('country.title')}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('country.close')}
                onPress={onClose}
                style={styles.close}
              >
                <Text style={styles.closeGlyph}>✕</Text>
              </Pressable>
            </View>

            <TextInput
              accessibilityLabel={t('country.search')}
              value={search}
              onChangeText={setSearch}
              placeholder={t('country.search')}
              placeholderTextColor={color.whisper}
              style={[styles.search, isRTL && styles.searchRTL]}
            />

            <View style={[styles.headMeta, isRTL && styles.rowReverse]}>
              <View style={styles.countPill}>
                <Text style={styles.countLabel}>{pending.length}</Text>
              </View>
              <Text variant="caption" style={styles.resultLabel} numberOfLines={1}>
                {t('country.shown', { count: results.length })}
              </Text>
              <View style={[styles.bulkActions, isRTL && styles.rowReverse]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('country.selectAll')}
                  onPress={() => setPending((current) => [...new Set([...current, ...results])])}
                  style={styles.bulkTarget}
                >
                  <Text style={styles.bulkPrimary}>{t('country.selectAll')}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={t('country.clearAll')} onPress={() => setPending([])} style={styles.bulkTarget}>
                  <Text style={styles.bulkQuiet}>{t('country.clearAll')}</Text>
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
              const isSelected = pending.includes(country);
              return (
                <Pressable
                  key={country}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                  accessibilityLabel={country}
                  onPress={() => toggle(country)}
                  style={[styles.row, isRTL && styles.rowReverse, isSelected && styles.rowSelected]}
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
                {t('country.noResults')}
              </Text>
            ) : null}
          </ScrollView>

          <View style={[styles.foot, { paddingBottom: insets.bottom + 20 }]}>
            <Button
              label={
                pending.length === 0
                  ? t('country.anywhere')
                  : t('country.useSelected', { count: pending.length })
              }
              onPress={() => {
                onChange(pending);
                onClose();
              }}
            />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  rowReverse: { flexDirection: 'row-reverse' },
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
    width: 44,
    height: 44,
    borderRadius: 22,
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
  searchRTL: { textAlign: 'right', writingDirection: 'rtl' },

  headMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
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
  resultLabel: { flexGrow: 1, flexShrink: 1, minWidth: 72 },
  bulkActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  bulkTarget: { minHeight: 44, justifyContent: 'center' },
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
