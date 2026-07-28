import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Switch, View } from 'react-native';

import { setProfilePaused } from '@/api/account';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Text } from '@/components/ui/Text';
import { useSession } from '@/state/session';
import { USE_MOCKS } from '@/lib/supabase';
import { alpha, color, font, radius, space } from '@/theme/tokens';
import { TIER_LIMITS } from '@/types';

const SETTINGS_KEY = 'halalmode.preferences.v1';

const PLUS_FEATURES = [
  'Receive 10 reciprocal introductions',
  'Choose up to 3 people',
  'A match opens with anyone who also selected you',
  'Keep up to 5 conversations open',
  'Priority matching when an area is busy',
];

interface LocalSettings {
  quietActivity: boolean;
  contactShield: boolean;
  gentleReminders: boolean;
  paused: boolean;
}

const DEFAULT_SETTINGS: LocalSettings = {
  quietActivity: true,
  contactShield: false,
  gentleReminders: true,
  paused: false,
};

export function SettingsTab({
  liveCount,
  openConnections,
}: {
  liveCount: number;
  openConnections: number;
}) {
  const { tier, setTier, language, setLanguage } = useSession();
  const [settings, setSettings] = useState<LocalSettings>(DEFAULT_SETTINGS);
  const [pauseConfirm, setPauseConfirm] = useState(false);
  const [plusConfirm, setPlusConfirm] = useState(false);
  const limits = TIER_LIMITS[tier];
  const isPlus = tier === 'plus';

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(SETTINGS_KEY)
      .then((raw) => {
        if (!active || !raw) return;
        const saved = JSON.parse(raw) as Partial<LocalSettings>;
        setSettings((current) => ({ ...current, ...saved }));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const patch = (key: keyof LocalSettings, value: boolean) => {
    setSettings((current) => {
      const next = { ...current, [key]: value };
      void AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  };

  const confirmPause = async () => {
    const next = !settings.paused;
    try {
      await setProfilePaused(next);
      patch('paused', next);
      setPauseConfirm(false);
    } catch (error) {
      Alert.alert('Could not update matching', error instanceof Error ? error.message : 'Please try again.');
    }
  };

  return (
    <View style={styles.wrap}>
      <Section
        eyebrow="Privacy"
        title="Your profile is intentional by default."
      >
        <SettingRow
          title="Introduction-only visibility"
          subtitle="Your profile is only shown inside reciprocal introductions and open connections."
          badge="Always on"
        />
        <SettingRow
          title="Keep activity quiet"
          subtitle="Do not surface read receipts, online status, or attention signals."
          value={settings.quietActivity}
          onValueChange={(value) => patch('quietActivity', value)}
        />
        <SettingRow
          title="Photo boundaries"
          subtitle="Photos stay inside a live introduction or a mutual connection."
          trailing={<Text style={styles.lockGlyph}>○</Text>}
        />
      </Section>

      <Section eyebrow="Safety" title="Controls that keep the space calm.">
        <SettingRow
          title="Contact shielding"
          subtitle="Keep people from an imported contact list out of future introductions."
          value={settings.contactShield}
          onValueChange={(value) => patch('contactShield', value)}
        />
        <SettingRow
          title="People you have blocked"
          subtitle="Review blocked members without revealing anything to them."
          trailing={<Text style={styles.arrow}>→</Text>}
        />
        <SettingRow
          title="Safety & reporting"
          subtitle="Report concerns or revisit how moderation works."
          trailing={<Text style={styles.arrow}>→</Text>}
        />
      </Section>

      <Section eyebrow="Preferences" title="How Halal Mode reaches you.">
        <SettingRow
          title="Language"
          subtitle={language === 'en' ? 'English' : 'Ø§Ù„Ø¹Ø±Ø¨ÙŠØ©'}
          trailing={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Switch language"
              onPress={() => setLanguage(language === 'en' ? 'ar' : 'en')}
              style={styles.languagePill}
            >
              <Text style={styles.languagePillLabel}>{language.toUpperCase()}</Text>
            </Pressable>
          }
        />
        <SettingRow
          title="Gentle reminders"
          subtitle="A quiet nudge when a round is ready or a connection needs your reply."
          value={settings.gentleReminders}
          onValueChange={(value) => patch('gentleReminders', value)}
        />
      </Section>

      <Card tone="dark" style={styles.plusCard}>
        <View>
          <Text style={styles.plusLabel}>Membership</Text>
          <Text style={styles.plusTitle}>Halal Mode Plus</Text>
        </View>
        <View style={styles.featureList}>
          {PLUS_FEATURES.map((feature) => (
            <View key={feature} style={styles.featureRow}>
              <Text style={styles.featureMark}>✦</Text>
              <Text style={styles.featureText}>{feature}</Text>
            </View>
          ))}
        </View>
        <Button
          label={isPlus ? 'Manage Plus' : 'Explore Plus'}
          variant="onDark"
          onPress={() => setPlusConfirm(true)}
        />
      </Card>

      <Card tone="filled" style={styles.plusDetails}>
        <View style={styles.plusDetailsHead}>
          <View>
            <Text variant="microAccent">Plus membership</Text>
            <Text variant="displaySmall" style={styles.plusDetailsTitle}>
              More room for intentional choices.
            </Text>
          </View>
          <View style={[styles.planBadge, isPlus && styles.planBadgeActive]}>
            <Text style={[styles.planBadgeLabel, isPlus && styles.planBadgeLabelActive]}>
              {isPlus ? 'Active' : 'Preview'}
            </Text>
          </View>
        </View>

        <View style={styles.benefitGrid}>
          <PremiumBenefit
            mark="10"
            title="A fuller round"
            detail="Ten reciprocal introductions, still selected with the same mutual criteria."
          />
          <PremiumBenefit
            mark="3"
            title="More people to keep"
            detail="Keep up to three introductions when you feel genuinely interested."
          />
          <PremiumBenefit
            mark="5"
            title="More open conversations"
            detail="Keep up to five mutual connections moving at a thoughtful pace."
          />
          <PremiumBenefit
            mark="↗"
            title="Priority matching"
            detail="Your eligible profile is considered earlier when local demand is high."
          />
        </View>

        <View style={styles.plusRule}>
          <Text style={styles.plusRuleMark}>◌</Text>
          <Text variant="caption" style={styles.plusRuleText}>
            Plus never exposes private preferences, selection scores, or who passed on you.
          </Text>
        </View>
      </Card>

      <Section eyebrow="Account" title="Manage your account.">
        <SettingRow
          title={settings.paused ? 'Matching is paused' : 'Pause matching'}
          subtitle={
            settings.paused
              ? 'No new rounds will be prepared in this local demo state.'
              : 'Take a break from new introductions. Existing connections remain available.'
          }
          value={settings.paused}
          onValueChange={() => setPauseConfirm(true)}
        />
        <View style={styles.paceCard}>
          <Text variant="micro">Today’s introductions</Text>
          <Text variant="body" style={styles.paceBody}>
            {liveCount} of {limits.introductions} introductions remain open ·{' '}
            {openConnections} of {limits.openConnections} connections are in progress.
            Nothing renews until Fajr.
          </Text>
        </View>
        <SettingRow
          title="Account support"
          subtitle="Help with your data, a fresh start, or closing your account."
          trailing={<Text style={styles.arrow}>→</Text>}
        />
      </Section>

      <Text variant="caption" center style={styles.version}>
        Halal Mode · version 1.0.0
      </Text>

      <ConfirmDialog
        visible={pauseConfirm}
        title={settings.paused ? 'Resume matching?' : 'Pause matching?'}
        body={
          settings.paused
            ? 'New rounds can be prepared again when you are ready.'
            : 'Your existing conversations remain available. You can resume whenever you choose.'
        }
        confirmLabel={settings.paused ? 'Resume' : 'Pause for now'}
        cancelLabel="Not now"
        onConfirm={() => void confirmPause()}
        onCancel={() => setPauseConfirm(false)}
      />

      <ConfirmDialog
        visible={plusConfirm}
        title={isPlus ? 'Leave Plus?' : 'Try Halal Mode Plus?'}
        body={USE_MOCKS
          ? (isPlus
            ? 'This demo will return to the free limits for future rounds and connections.'
            : 'This demo will unlock the Plus limits for introductions, keeps, and connections.')
          : 'Membership changes are confirmed by the payment service, then applied by the server.'}
        confirmLabel={USE_MOCKS ? (isPlus ? 'Use free plan' : 'Activate Plus') : 'Okay'}
        cancelLabel="Not now"
        onConfirm={() => {
          if (USE_MOCKS) setTier(isPlus ? 'free' : 'plus');
          setPlusConfirm(false);
        }}
        onCancel={() => setPlusConfirm(false)}
      />
    </View>
  );
}

function PremiumBenefit({
  mark,
  title,
  detail,
}: {
  mark: string;
  title: string;
  detail: string;
}) {
  return (
    <View style={styles.benefit}>
      <View style={styles.benefitMark}>
        <Text style={styles.benefitMarkLabel}>{mark}</Text>
      </View>
      <View style={styles.benefitText}>
        <Text style={styles.benefitTitle}>{title}</Text>
        <Text variant="caption" style={styles.benefitDetail}>
          {detail}
        </Text>
      </View>
    </View>
  );
}

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text variant="microAccent">{eyebrow}</Text>
        <Text variant="displaySmall" style={styles.sectionTitle}>
          {title}
        </Text>
      </View>
      <Card style={styles.group}>{children}</Card>
    </View>
  );
}

function SettingRow({
  title,
  subtitle,
  value,
  onValueChange,
  badge,
  trailing,
}: {
  title: string;
  subtitle: string;
  value?: boolean;
  onValueChange?: (next: boolean) => void;
  badge?: string;
  trailing?: React.ReactNode;
}) {
  const control =
    typeof value === 'boolean' ? (
      <Switch
        accessibilityLabel={title}
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: color.sandDeep, true: color.ink }}
        thumbColor={color.white}
      />
    ) : (
      trailing
    );

  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle}>{title}</Text>
          {badge ? <Text style={styles.badge}>{badge}</Text> : null}
        </View>
        <Text variant="caption" style={styles.rowSubtitle}>
          {subtitle}
        </Text>
      </View>
      {control ? <View style={styles.rowControl}>{control}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 22, paddingBottom: 30 },
  section: { gap: 10 },
  sectionHead: { gap: 5, paddingHorizontal: 2 },
  sectionTitle: { fontSize: 21, lineHeight: 27 },
  group: { paddingVertical: 0, paddingHorizontal: space.lg + 2 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 17,
    borderBottomWidth: 1,
    borderBottomColor: alpha.lineFaint,
  },
  rowText: { flex: 1, gap: 5 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 },
  rowTitle: { fontFamily: font.bodyBold, fontSize: 13.5, color: color.ink },
  rowSubtitle: { lineHeight: 19, color: color.muted },
  rowControl: { alignItems: 'flex-end', justifyContent: 'center' },
  badge: {
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: 'rgba(138,106,52,0.12)',
    color: color.gold,
    fontFamily: font.bodyBold,
    fontSize: 8.5,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  arrow: { fontFamily: font.body, fontSize: 16, color: color.faint },
  lockGlyph: { fontFamily: font.body, fontSize: 20, color: color.green },
  languagePill: {
    borderWidth: 1,
    borderColor: alpha.lineStrong,
    borderRadius: radius.pill,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  languagePillLabel: { fontFamily: font.bodyBold, fontSize: 10, letterSpacing: 1, color: color.ink },

  plusCard: { gap: 14, borderRadius: radius.panel },
  plusLabel: {
    fontFamily: font.bodyBold,
    fontSize: 9,
    letterSpacing: 2.4,
    textTransform: 'uppercase',
    color: color.goldOnDark,
  },
  plusTitle: { marginTop: 8, fontFamily: font.display, fontSize: 20, color: color.white },
  featureList: { gap: 9 },
  featureRow: { flexDirection: 'row', gap: 9, alignItems: 'flex-start' },
  featureMark: { color: color.goldOnDark, fontSize: 11, marginTop: 3 },
  featureText: {
    flex: 1,
    fontFamily: font.body,
    fontSize: 12.5,
    lineHeight: 19,
    color: 'rgba(252,252,251,0.88)',
  },
  plusDetails: { gap: 16, borderRadius: radius.panel, padding: 18 },
  plusDetailsHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  plusDetailsTitle: { marginTop: 6, fontSize: 20, lineHeight: 26, maxWidth: 205 },
  planBadge: {
    marginLeft: 'auto',
    borderWidth: 1,
    borderColor: 'rgba(138,106,52,0.28)',
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 9,
  },
  planBadgeActive: { backgroundColor: color.ink, borderColor: color.ink },
  planBadgeLabel: {
    color: color.gold,
    fontFamily: font.bodyBold,
    fontSize: 8.5,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  planBadgeLabelActive: { color: color.goldOnDark },
  benefitGrid: { gap: 9 },
  benefit: {
    flexDirection: 'row',
    gap: 11,
    alignItems: 'flex-start',
    padding: 13,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
  },
  benefitMark: {
    width: 31,
    height: 31,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(138,106,52,0.12)',
  },
  benefitMarkLabel: { fontFamily: font.bodyBold, fontSize: 10, color: color.gold },
  benefitText: { flex: 1, gap: 3 },
  benefitTitle: { fontFamily: font.bodyBold, fontSize: 12.5, color: color.ink },
  benefitDetail: { lineHeight: 18, color: color.muted },
  plusRule: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingTop: 2,
  },
  plusRuleMark: { color: color.gold, fontFamily: font.bodyBold, fontSize: 14 },
  plusRuleText: { flex: 1, lineHeight: 18, color: color.muted },
  paceCard: { backgroundColor: color.sand, borderRadius: radius.lg, padding: 14, gap: 7 },
  paceBody: { fontSize: 11.5, lineHeight: 19 },
  version: { color: color.faint, marginTop: -4 },
});
