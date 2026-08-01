import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { updateMyPreferences } from '@/api/profile';
import { Button } from '@/components/ui/Button';
import { InlineNotice } from '@/components/ui/AsyncState';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RangeSlider } from '@/components/ui/RangeSlider';
import { Segmented } from '@/components/ui/Segmented';
import { Slider } from '@/components/ui/Slider';
import { Text } from '@/components/ui/Text';
import { MustHaveToggle } from '@/components/you/MustHaveToggle';
import { CountrySheet } from '@/components/you/CountrySheet';
import { useI18n, type Translate } from '@/i18n';
import type { TranslationKey } from '@/i18n/catalog';
import {
  BUILD_OPTIONS,
  DISTANCE_RANGE,
  HEIGHT_RANGE,
  AGE_RANGE,
  FAMILY_GOAL_LABELS,
  PRACTICE_LABELS,
  RADIUS_PRESETS,
  TIMELINE_LABELS,
  formatHeightImperial,
} from '@/data/preferences';
import { alpha, color, font, radius } from '@/theme/tokens';
import { queryKeys } from '@/lib/queryClient';
import type {
  FamilyGoals,
  MarriageTimeline,
  MustHaveCriterion,
  PrivatePreferences,
  ReligiousPractice,
  Sect,
} from '@/types';

type SubTab = 'them' | 'you';

/**
 * The private preference editor.
 *
 * Two halves: what you are looking for, and your own figures. Neither is ever
 * rendered on a profile or sent to another member — the copy says so twice
 * because this is the part of the product that most needs to be trusted.
 */
export function PrivateTab({ preferences }: { preferences: PrivatePreferences }) {
  const { t, isRTL } = useI18n();
  const [tab, setTab] = useState<SubTab>('them');
  const [draft, setDraft] = useState(preferences);
  const [countrySheet, setCountrySheet] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const queryClient = useQueryClient();

  const save = useMutation({
    mutationFn: () => updateMyPreferences(draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.profileReadiness });
      void queryClient.invalidateQueries({ queryKey: queryKeys.preferences });
    },
  });

  const setMustHave = (criterion: MustHaveCriterion, next: boolean) =>
    setDraft((current) => ({
      ...current,
      mustHave: { ...current.mustHave, [criterion]: next },
    }));

  const mustHaveFor = (criterion: MustHaveCriterion) => (
    <MustHaveToggle
      criterion={criterion}
      value={draft.mustHave?.[criterion] ?? false}
      onChange={(next) => setMustHave(criterion, next)}
    />
  );

  const patch = <K extends keyof PrivatePreferences>(
    key: K,
    value: PrivatePreferences[K]
  ) => setDraft((current) => ({ ...current, [key]: value }));

  const toggleBuild = (build: string) => {
    patch(
      'preferredBuilds',
      draft.preferredBuilds.includes(build)
        ? draft.preferredBuilds.filter((item) => item !== build)
        : [...draft.preferredBuilds, build]
    );
  };

  const toggleListValue = <T extends string>(
    key: 'preferredPractice' | 'desiredTimeline' | 'desiredFamilyGoals' | 'preferredSects',
    value: T
  ) => {
    const current = (draft[key] ?? []) as T[];
    patch(key, (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]) as never);
  };

  const clearMatchingChoices = () => {
    setDraft((current) => ({
      ...current,
      minAge: AGE_RANGE.min,
      maxAge: AGE_RANGE.max,
      minHeightCm: HEIGHT_RANGE.min,
      maxHeightCm: HEIGHT_RANGE.max,
      preferredBuilds: [],
      preferredCountries: [],
      maxDistanceKm: DISTANCE_RANGE.max,
      preferredPractice: [],
      desiredTimeline: [],
    }));
    setClearConfirm(false);
  };

  return (
    <View style={[styles.wrap, isRTL && styles.rtl]}>
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'them', label: t('filters.tab.partner') },
          { value: 'you', label: t('filters.tab.you') },
        ]}
      />

      {tab === 'them' ? (
        <Card style={styles.card}>
          <View>
            <Text variant="microAccent">{t('filters.partnerStep')}</Text>
            <Text variant="displaySmall" style={styles.sectionTitle}>
              {t('filters.partnerTitle')}
            </Text>
            <Text variant="caption" style={styles.sectionBody}>
              {t('filters.partnerBody')}
            </Text>
          </View>

          <View style={styles.section}>
            <View style={[styles.sectionHead, isRTL && styles.rowReverse]}>
              <Text variant="micro">{t('filters.ageRange')}</Text>
              <Text variant="caption">
                {t('filters.yearsRange', { min: draft.minAge, max: draft.maxAge })}
              </Text>
            </View>
            <RangeSlider
              min={AGE_RANGE.min}
              max={AGE_RANGE.max}
              value={[draft.minAge, draft.maxAge]}
              onChange={([low, high]) => {
                patch('minAge', low);
                patch('maxAge', high);
              }}
              lowAccessibilityLabel={t('filters.minimumAge')}
              highAccessibilityLabel={t('filters.maximumAge')}
            />
            {mustHaveFor('age')}
          </View>

          <View style={styles.section}>
            <View style={[styles.sectionHead, isRTL && styles.rowReverse]}>
              <Text variant="micro">
                {t('filters.heightRange', { min: draft.minHeightCm, max: draft.maxHeightCm })}
              </Text>
              <Text variant="label" style={styles.sectionValue}>
                {formatHeightImperial(draft.minHeightCm)} –{' '}
                {formatHeightImperial(draft.maxHeightCm)}
              </Text>
            </View>
            <RangeSlider
              min={HEIGHT_RANGE.min}
              max={HEIGHT_RANGE.max}
              value={[draft.minHeightCm, draft.maxHeightCm]}
              onChange={([low, high]) => {
                patch('minHeightCm', low);
                patch('maxHeightCm', high);
              }}
              lowAccessibilityLabel={t('filters.minimumHeight')}
              highAccessibilityLabel={t('filters.maximumHeight')}
            />
            {mustHaveFor('height')}
          </View>

          <View style={styles.section}>
            <View style={[styles.sectionHead, isRTL && styles.rowReverse]}>
              <Text variant="micro">{t('filters.bodyTypes')}</Text>
              <Text variant="caption">
                {t('filters.selected', { count: draft.preferredBuilds.length })}
              </Text>
            </View>
            <View style={styles.chips}>
              {BUILD_OPTIONS.map((build) => (
                <Chip
                  key={build}
                  label={buildLabel(build, t)}
                  selected={draft.preferredBuilds.includes(build)}
                  onPress={() => toggleBuild(build)}
                  showMark
                />
              ))}
            </View>
            {mustHaveFor('build')}
          </View>

          <View style={styles.section}>
            <Text variant="micro">{t('filters.locationDistance')}</Text>
            <View style={styles.radiusPanel}>
              <View style={[styles.radiusHead, isRTL && styles.rowReverse]}>
                <View style={styles.radiusText}>
                  <Text variant="label" style={styles.radiusTitle}>
                    {t('filters.searchDistance')}
                  </Text>
                  <Text variant="caption">{t('filters.searchDistanceBody')}</Text>
                </View>
                <View style={styles.radiusPill}>
                  <Text style={styles.radiusPillLabel}>
                    {t('filters.distanceKm', { count: draft.maxDistanceKm })}
                  </Text>
                </View>
              </View>

              <Slider
                accessibilityLabel={t('filters.maxDistanceA11y')}
                min={DISTANCE_RANGE.min}
                max={DISTANCE_RANGE.max}
                step={5}
                value={draft.maxDistanceKm}
                onChange={(value) => patch('maxDistanceKm', value)}
              />

              <View style={styles.chips}>
                {RADIUS_PRESETS.map((preset) => (
                  <Chip
                    key={preset}
                    label={t('filters.distanceKm', { count: preset })}
                    selected={draft.maxDistanceKm === preset}
                    onPress={() => patch('maxDistanceKm', preset)}
                  />
                ))}
              </View>
              {mustHaveFor('distance')}
            </View>
          </View>

          <View style={styles.section}>
            <View style={[styles.sectionHead, isRTL && styles.rowReverse]}>
              <Text variant="micro">{t('filters.countries')}</Text>
              <Text variant="caption">
                {t('filters.selected', { count: draft.preferredCountries.length })}
              </Text>
            </View>
            <View style={styles.chips}>
              {draft.preferredCountries.slice(0, 6).map((country) => (
                <Chip
                  key={country}
                  label={country}
                  selected
                  showMark
                  onPress={() =>
                    patch(
                      'preferredCountries',
                      draft.preferredCountries.filter((item) => item !== country)
                    )
                  }
                />
              ))}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('filters.chooseCountries')}
              onPress={() => setCountrySheet(true)}
              style={[styles.sheetTrigger, isRTL && styles.rowReverse]}
            >
              <Text variant="label" style={styles.sheetTriggerLabel}>
                {t('filters.chooseCountries')}
              </Text>
              <Text style={styles.sheetTriggerArrow}>→</Text>
            </Pressable>
          </View>

          <View style={styles.section}>
            <Text variant="micro">{t('filters.marriageTiming')}</Text>
            <Text variant="caption" style={styles.filterNote}>
              {t('filters.marriageTimingBody')}
            </Text>
            <View style={styles.checkList}>
              {(Object.entries(TIMELINE_LABELS) as [MarriageTimeline, string][]).map(
                ([value]) => (
                  <FilterCheck
                    key={value}
                    label={timelineLabel(value, t)}
                    checked={draft.desiredTimeline.includes(value)}
                    onPress={() => toggleListValue('desiredTimeline', value)}
                  />
                )
              )}
            </View>
            {mustHaveFor('timeline')}
          </View>

          <View style={styles.section}>
            <Text variant="micro">{t('filters.practice')}</Text>
            <Text variant="caption" style={styles.filterNote}>
              {t('filters.practiceBody')}
            </Text>
            <View style={styles.checkList}>
              {(Object.entries(PRACTICE_LABELS) as [ReligiousPractice, string][]).map(
                ([value]) => (
                  <FilterCheck
                    key={value}
                    label={practiceLabel(value, t)}
                    checked={draft.preferredPractice.includes(value)}
                    onPress={() => toggleListValue('preferredPractice', value)}
                  />
                )
              )}
            </View>
            {mustHaveFor('practice')}
          </View>

          <View style={styles.section}>
            <Text variant="micro">{t('filters.children')}</Text>
            <Text variant="caption" style={styles.filterNote}>
              {t('filters.childrenBody')}
            </Text>
            <View style={styles.checkList}>
              {(Object.entries(FAMILY_GOAL_LABELS) as [FamilyGoals, string][]).map(
                ([value]) => (
                  <FilterCheck
                    key={value}
                    label={familyGoalLabel(value, t)}
                    checked={(draft.desiredFamilyGoals ?? []).includes(value)}
                    onPress={() => toggleListValue('desiredFamilyGoals', value)}
                  />
                )
              )}
            </View>
            {mustHaveFor('children')}
          </View>

          <View style={styles.section}>
            <Text variant="micro">{t('filters.sect')}</Text>
            <Text variant="caption" style={styles.filterNote}>
              {t('filters.sectBody')}
            </Text>
            <View style={styles.checkList}>
              {SELECTABLE_SECTS.map((value) => (
                <FilterCheck
                  key={value}
                  label={sectLabel(value, t)}
                  checked={(draft.preferredSects ?? []).includes(value)}
                  onPress={() => toggleListValue('preferredSects', value)}
                />
              ))}
            </View>
            {mustHaveFor('sect')}
          </View>

          <Button
            label={t('filters.clear')}
            variant="secondary"
            onPress={() => setClearConfirm(true)}
          />

          <Button
            label={save.isSuccess ? t('filters.saved') : t('filters.savePartner')}
            loading={save.isPending}
            onPress={() => save.mutate()}
          />
          {save.isError ? <InlineNotice message={t('filters.saveError')} /> : null}
        </Card>
      ) : (
        <Card style={styles.card}>
          <View>
            <Text variant="microAccent">{t('filters.yourStep')}</Text>
            <Text variant="displaySmall" style={styles.sectionTitle}>
              {t('filters.yourTitle')}
            </Text>
            <Text variant="caption" style={styles.sectionBody}>
              {t('filters.yourBody')}
            </Text>
          </View>

          <Card tone="accent">
            <Text style={styles.confidentialTitle}>{t('filters.privateTitle')}</Text>
            <Text variant="caption" style={styles.confidentialBody}>
              {t('filters.privateBody')}
            </Text>
          </Card>

          <View style={[styles.metricRow, isRTL && styles.rowReverse]}>
            <View style={styles.metric}>
              <Text variant="micro">{t('filters.yourHeight')}</Text>
              <TextInput
                accessibilityLabel={t('filters.yourHeightA11y')}
                keyboardType="number-pad"
                value={String(draft.ownHeightCm)}
                onChangeText={(text) =>
                  patch('ownHeightCm', Number(text.replace(/\D/g, '')) || 0)
                }
                style={[styles.metricInput, isRTL && styles.inputRTL]}
              />
            </View>
            <View style={styles.metric}>
              <Text variant="micro">{t('filters.yourWeight')}</Text>
              <TextInput
                accessibilityLabel={t('filters.yourWeightA11y')}
                keyboardType="number-pad"
                value={String(draft.ownWeightKg ?? '')}
                onChangeText={(text) =>
                  patch('ownWeightKg', Number(text.replace(/\D/g, '')) || 0)
                }
                style={[styles.metricInput, isRTL && styles.inputRTL]}
              />
            </View>
          </View>

          <View style={styles.section}>
            <Text variant="micro">{t('filters.yourBodyType')}</Text>
            <View style={styles.chips}>
              {BUILD_OPTIONS.map((build) => (
                <Chip
                  key={build}
                  label={buildLabel(build, t)}
                  selected={draft.ownBuild === build}
                  onPress={() => patch('ownBuild', build)}
                />
              ))}
            </View>
          </View>

          <Button
            label={save.isSuccess ? t('filters.saved') : t('filters.saveYour')}
            loading={save.isPending}
            onPress={() => save.mutate()}
          />
          {save.isError ? <InlineNotice message={t('filters.saveError')} /> : null}
        </Card>
      )}

      <CountrySheet
        visible={countrySheet}
        selected={draft.preferredCountries}
        onChange={(next) => patch('preferredCountries', next)}
        onClose={() => setCountrySheet(false)}
      />

      <ConfirmDialog
        visible={clearConfirm}
        title={t('filters.clearTitle')}
        body={t('filters.clearBody')}
        confirmLabel={t('filters.clearConfirm')}
        cancelLabel={t('filters.clearCancel')}
        onConfirm={clearMatchingChoices}
        onCancel={() => setClearConfirm(false)}
      />
    </View>
  );
}

function FilterCheck({
  label,
  checked,
  onPress,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
}) {
  const { isRTL } = useI18n();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.checkRow, isRTL && styles.rowReverse, checked && styles.checkRowSelected]}
    >
      <View style={[styles.checkBox, checked && styles.checkBoxSelected]}>
        {checked ? <Text style={styles.checkMark}>✓</Text> : null}
      </View>
      <Text style={styles.checkLabel}>{label}</Text>
    </Pressable>
  );
}

const BUILD_KEYS: Record<(typeof BUILD_OPTIONS)[number], TranslationKey> = {
  Petite: 'filters.build.petite',
  Slim: 'filters.build.slim',
  Slender: 'filters.build.slender',
  Lean: 'filters.build.lean',
  'Tall & Lean': 'filters.build.tallLean',
  Average: 'filters.build.average',
  'Fit / Active': 'filters.build.fit',
  Athletic: 'filters.build.athletic',
  Toned: 'filters.build.toned',
  Muscular: 'filters.build.muscular',
  'Medium / Solid': 'filters.build.solid',
  Curvy: 'filters.build.curvy',
  'Full-Figured': 'filters.build.full',
  'Plus Size': 'filters.build.plus',
  Broad: 'filters.build.broad',
  Stocky: 'filters.build.stocky',
  'Robust / Sturdy': 'filters.build.sturdy',
};

const PRACTICE_KEYS: Record<ReligiousPractice, TranslationKey> = {
  very_practicing: 'filters.practice.very',
  practicing: 'filters.practice.practicing',
  moderate: 'filters.practice.moderate',
  learning: 'filters.practice.learning',
};

const FAMILY_GOAL_KEYS: Record<FamilyGoals, TranslationKey> = {
  wants_children_soon: 'filters.children.soon',
  wants_children_later: 'filters.children.later',
  open_to_children: 'filters.children.open',
  no_children: 'filters.children.none',
};

/**
 * 'prefer_not_to_say' is intentionally absent: it is what someone declares
 * about themselves, not something anyone can require of a partner. In matching
 * it is compatible with every preference.
 */
const SELECTABLE_SECTS: Sect[] = ['sunni', 'shia', 'other'];

const SECT_KEYS: Record<Sect, TranslationKey> = {
  sunni: 'filters.sect.sunni',
  shia: 'filters.sect.shia',
  other: 'filters.sect.other',
  prefer_not_to_say: 'filters.sect.unstated',
};

const TIMELINE_KEYS: Record<MarriageTimeline, TranslationKey> = {
  within_3_months: 'filters.timeline.3m',
  within_6_months: 'filters.timeline.6m',
  within_1_year: 'filters.timeline.1y',
  '1_to_2_years': 'filters.timeline.2y',
};

function buildLabel(value: (typeof BUILD_OPTIONS)[number], t: Translate): string {
  return t(BUILD_KEYS[value]);
}

function practiceLabel(value: ReligiousPractice, t: Translate): string {
  return t(PRACTICE_KEYS[value]);
}

function familyGoalLabel(value: FamilyGoals, t: Translate): string {
  return t(FAMILY_GOAL_KEYS[value]);
}

function sectLabel(value: Sect, t: Translate): string {
  return t(SECT_KEYS[value]);
}

function timelineLabel(value: MarriageTimeline, t: Translate): string {
  return t(TIMELINE_KEYS[value]);
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  rowReverse: { flexDirection: 'row-reverse' },
  wrap: { gap: 12, paddingBottom: 24 },
  card: { gap: 18 },

  sectionTitle: { marginTop: 8 },
  sectionBody: { marginTop: 6 },

  section: {
    borderTopWidth: 1,
    borderTopColor: alpha.lineFaint,
    paddingTop: 16,
    gap: 12,
  },
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 10,
  },
  sectionValue: { fontSize: 11 },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  filterNote: { marginTop: -5 },
  checkList: { gap: 8 },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    minHeight: 46,
    paddingHorizontal: 13,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    backgroundColor: color.surface,
  },
  checkRowSelected: { borderColor: color.ink, backgroundColor: color.sandLight },
  checkBox: {
    width: 19,
    height: 19,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: alpha.lineButton,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxSelected: { backgroundColor: color.ink, borderColor: color.ink },
  checkMark: { fontFamily: font.bodyBold, fontSize: 12, color: color.white },
  checkLabel: { flex: 1, fontFamily: font.bodyMedium, fontSize: 12.5, color: color.ink },

  radiusPanel: {
    backgroundColor: color.sandLight,
    borderRadius: radius.xl,
    padding: 16,
    gap: 10,
  },
  radiusHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  radiusText: { gap: 3, flex: 1 },
  radiusTitle: { fontSize: 12 },
  radiusPill: {
    backgroundColor: color.ink,
    borderRadius: radius.pill,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  radiusPillLabel: { fontFamily: font.bodyBold, fontSize: 10, color: color.white },

  sheetTrigger: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    borderRadius: radius.lg,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  sheetTriggerLabel: { fontSize: 12 },
  sheetTriggerArrow: { fontFamily: font.body, color: color.faint },

  confidentialTitle: {
    fontFamily: font.bodyBold,
    fontSize: 11.5,
    color: color.gold,
  },
  confidentialBody: { marginTop: 6, color: color.muted },

  metricRow: { flexDirection: 'row', gap: 10 },
  metric: { flex: 1, gap: 6 },
  metricInput: {
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
  inputRTL: { textAlign: 'right', writingDirection: 'rtl' },
});
