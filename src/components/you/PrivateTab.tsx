import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { updateMyPreferences } from '@/api/profile';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RangeSlider } from '@/components/ui/RangeSlider';
import { Segmented } from '@/components/ui/Segmented';
import { Slider } from '@/components/ui/Slider';
import { Text } from '@/components/ui/Text';
import { CountrySheet } from '@/components/you/CountrySheet';
import {
  BUILD_OPTIONS,
  DISTANCE_RANGE,
  HEIGHT_RANGE,
  AGE_RANGE,
  PRACTICE_LABELS,
  RADIUS_PRESETS,
  TIMELINE_LABELS,
  formatHeightImperial,
} from '@/data/preferences';
import { alpha, color, font, radius } from '@/theme/tokens';
import type { MarriageTimeline, PrivatePreferences, ReligiousPractice } from '@/types';

type SubTab = 'them' | 'you';

/**
 * The private preference editor.
 *
 * Two halves: what you are looking for, and your own figures. Neither is ever
 * rendered on a profile or sent to another member — the copy says so twice
 * because this is the part of the product that most needs to be trusted.
 */
export function PrivateTab({ preferences }: { preferences: PrivatePreferences }) {
  const [tab, setTab] = useState<SubTab>('them');
  const [draft, setDraft] = useState(preferences);
  const [countrySheet, setCountrySheet] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);

  const save = useMutation({
    mutationFn: () => updateMyPreferences(draft),
  });

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
    key: 'preferredPractice' | 'desiredTimeline',
    value: T
  ) => {
    const current = draft[key] as T[];
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
    <View style={styles.wrap}>
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'them', label: 'Them' },
          { value: 'you', label: 'You' },
        ]}
      />

      {tab === 'them' ? (
        <Card style={styles.card}>
          <View>
            <Text variant="microAccent">1 of 2 · partner preferences</Text>
            <Text variant="displaySmall" style={styles.sectionTitle}>
              Physical & location
            </Text>
            <Text variant="caption" style={styles.sectionBody}>
              Height, build and how far you are willing to look. We ask because
              attraction matters in a marriage — not to rank anyone.
            </Text>
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Text variant="micro">Matching window</Text>
              <Text variant="caption">
                {draft.minAge}–{draft.maxAge} years
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
            />
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Text variant="micro">
                Height {draft.minHeightCm}–{draft.maxHeightCm} cm
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
            />
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Text variant="micro">Build preferences</Text>
              <Text variant="caption">
                {draft.preferredBuilds.length} selected
              </Text>
            </View>
            <View style={styles.chips}>
              {BUILD_OPTIONS.map((build) => (
                <Chip
                  key={build}
                  label={build}
                  selected={draft.preferredBuilds.includes(build)}
                  onPress={() => toggleBuild(build)}
                  showMark
                />
              ))}
            </View>
          </View>

          <View style={styles.section}>
            <Text variant="micro">Location & distance</Text>
            <View style={styles.radiusPanel}>
              <View style={styles.radiusHead}>
                <View style={styles.radiusText}>
                  <Text variant="label" style={styles.radiusTitle}>
                    Nearby radius
                  </Text>
                  <Text variant="caption">Keep local introductions close</Text>
                </View>
                <View style={styles.radiusPill}>
                  <Text style={styles.radiusPillLabel}>
                    {draft.maxDistanceKm} km
                  </Text>
                </View>
              </View>

              <Slider
                accessibilityLabel="Maximum distance in kilometres"
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
                    label={`${preset} km`}
                    selected={draft.maxDistanceKm === preset}
                    onPress={() => patch('maxDistanceKm', preset)}
                  />
                ))}
              </View>
            </View>
          </View>

          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <Text variant="micro">Preferred countries</Text>
              <Text variant="caption">
                {draft.preferredCountries.length} selected
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
              onPress={() => setCountrySheet(true)}
              style={styles.sheetTrigger}
            >
              <Text variant="label" style={styles.sheetTriggerLabel}>
                Filter preferred countries
              </Text>
              <Text style={styles.sheetTriggerArrow}>→</Text>
            </Pressable>
          </View>

          <View style={styles.section}>
            <Text variant="micro">Marriage timeline</Text>
            <Text variant="caption" style={styles.filterNote}>
              Choose the timelines that feel workable for you.
            </Text>
            <View style={styles.checkList}>
              {(Object.entries(TIMELINE_LABELS) as [MarriageTimeline, string][]).map(
                ([value, label]) => (
                  <FilterCheck
                    key={value}
                    label={label}
                    checked={draft.desiredTimeline.includes(value)}
                    onPress={() => toggleListValue('desiredTimeline', value)}
                  />
                )
              )}
            </View>
          </View>

          <View style={styles.section}>
            <Text variant="micro">Religious practice</Text>
            <Text variant="caption" style={styles.filterNote}>
              These stay private and are only used to make introductions more relevant.
            </Text>
            <View style={styles.checkList}>
              {(Object.entries(PRACTICE_LABELS) as [ReligiousPractice, string][]).map(
                ([value, label]) => (
                  <FilterCheck
                    key={value}
                    label={label}
                    checked={draft.preferredPractice.includes(value)}
                    onPress={() => toggleListValue('preferredPractice', value)}
                  />
                )
              )}
            </View>
          </View>

          <Button
            label="Clear matching choices"
            variant="secondary"
            onPress={() => setClearConfirm(true)}
          />

          <Button
            label={save.isSuccess ? 'Saved' : 'Save matching criteria'}
            loading={save.isPending}
            onPress={() => save.mutate()}
          />
        </Card>
      ) : (
        <Card style={styles.card}>
          <View>
            <Text variant="microAccent">2 of 2 · your private metrics</Text>
            <Text variant="displaySmall" style={styles.sectionTitle}>
              Your own numbers
            </Text>
            <Text variant="caption" style={styles.sectionBody}>
              Stored privately and never shown on your profile.
            </Text>
          </View>

          <Card tone="accent">
            <Text style={styles.confidentialTitle}>Confidential by design</Text>
            <Text variant="caption" style={styles.confidentialBody}>
              Compatibility is calculated without exposing any number or label to
              the other member.
            </Text>
          </Card>

          <View style={styles.metricRow}>
            <View style={styles.metric}>
              <Text variant="micro">Your height (cm)</Text>
              <TextInput
                accessibilityLabel="Your height in centimetres"
                keyboardType="number-pad"
                value={String(draft.ownHeightCm)}
                onChangeText={(text) =>
                  patch('ownHeightCm', Number(text.replace(/\D/g, '')) || 0)
                }
                style={styles.metricInput}
              />
            </View>
            <View style={styles.metric}>
              <Text variant="micro">Your weight (kg)</Text>
              <TextInput
                accessibilityLabel="Your weight in kilograms"
                keyboardType="number-pad"
                value={String(draft.ownWeightKg ?? '')}
                onChangeText={(text) =>
                  patch('ownWeightKg', Number(text.replace(/\D/g, '')) || 0)
                }
                style={styles.metricInput}
              />
            </View>
          </View>

          <View style={styles.section}>
            <Text variant="micro">Your build — pick one</Text>
            <View style={styles.chips}>
              {BUILD_OPTIONS.map((build) => (
                <Chip
                  key={build}
                  label={build}
                  selected={draft.ownBuild === build}
                  onPress={() => patch('ownBuild', build)}
                />
              ))}
            </View>
          </View>

          <Button
            label={save.isSuccess ? 'Saved' : 'Save private criteria'}
            loading={save.isPending}
            onPress={() => save.mutate()}
          />
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
        title="Clear your matching choices?"
        body="This restores open criteria. Your own private details stay unchanged."
        confirmLabel="Clear choices"
        cancelLabel="Keep them"
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
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={[styles.checkRow, checked && styles.checkRowSelected]}
    >
      <View style={[styles.checkBox, checked && styles.checkBoxSelected]}>
        {checked ? <Text style={styles.checkMark}>✓</Text> : null}
      </View>
      <Text style={styles.checkLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
});
