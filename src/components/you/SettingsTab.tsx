import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Switch, View } from 'react-native';

import { setProfilePaused } from '@/api/account';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { useSession } from '@/state/session';
import { USE_MOCKS } from '@/lib/supabase';
import { alpha, color, font, radius, space } from '@/theme/tokens';
import { TIER_LIMITS } from '@/types';

const SETTINGS_KEY = 'halalmode.preferences.v1';

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
  const { t, isRTL, nativeRestartRequired } = useI18n();
  const { tier, setTier, language, setLanguage } = useSession();
  const [settings, setSettings] = useState<LocalSettings>(DEFAULT_SETTINGS);
  const [pauseConfirm, setPauseConfirm] = useState(false);
  const [plusConfirm, setPlusConfirm] = useState(false);
  const limits = TIER_LIMITS[tier];
  const isPlus = tier === 'plus';
  const plusFeatures = [
    t('settings.plus.f1'),
    t('settings.plus.f2'),
    t('settings.plus.f4'),
  ];

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
    } catch {
      Alert.alert(t('settings.pauseErrorTitle'), t('settings.pauseErrorBody'));
    }
  };

  return (
    <View style={[styles.wrap, isRTL && styles.rtl]}>
      <Section
        eyebrow={t('settings.privacy')}
        title={t('settings.privacyTitle')}
      >
        <SettingRow
          title={t('settings.visibility')}
          subtitle={t('settings.visibilityBody')}
          badge={t('settings.alwaysOn')}
        />
        <SettingRow
          title={t('settings.activity')}
          subtitle={t('settings.activityBody')}
          badge={t('settings.comingLater')}
        />
        <SettingRow
          title={t('settings.photos')}
          subtitle={t('settings.photosBody')}
          trailing={<Text style={styles.lockGlyph}>○</Text>}
        />
      </Section>

      <Section eyebrow={t('settings.safety')} title={t('settings.safetyTitle')}>
        <SettingRow
          title={t('settings.contacts')}
          subtitle={t('settings.contactsBody')}
          badge={t('settings.comingLater')}
        />
        <SettingRow
          title={t('settings.blocked')}
          subtitle={t('settings.blockedBody')}
          badge={t('settings.comingLater')}
        />
        <SettingRow
          title={t('settings.reporting')}
          subtitle={t('settings.reportingBody')}
          badge={t('settings.comingLater')}
        />
      </Section>

      <Section eyebrow={t('settings.preferences')} title={t('settings.preferencesTitle')}>
        <SettingRow
          title={t('settings.language')}
          subtitle={language === 'en' ? t('auth.switchEnglish') : t('auth.switchArabic')}
          trailing={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('settings.switchLanguage')}
              onPress={() => setLanguage(language === 'en' ? 'ar' : 'en')}
              style={styles.languagePill}
            >
              <Text style={styles.languagePillLabel}>{language.toUpperCase()}</Text>
            </Pressable>
          }
        />
        {nativeRestartRequired ? (
          <Text accessibilityRole="alert" variant="caption" style={styles.restartNotice}>
            {t('settings.restartRequired')}
          </Text>
        ) : null}
        <SettingRow
          title={t('settings.notifications')}
          subtitle={t('settings.notificationsBody')}
          badge={t('settings.comingLater')}
        />
      </Section>

      <Card tone="dark" style={styles.plusCard}>
        <View>
          <Text style={styles.plusLabel}>{t('settings.membership')}</Text>
          <Text style={styles.plusTitle}>{t('settings.plus')}</Text>
        </View>
        <View style={styles.featureList}>
          {plusFeatures.map((feature) => (
            <View key={feature} style={[styles.featureRow, isRTL && styles.rowReverse]}>
              <Text style={styles.featureMark}>✦</Text>
              <Text style={styles.featureText}>{feature}</Text>
            </View>
          ))}
        </View>
        <Button
          label={isPlus ? t('settings.managePlus') : t('settings.explorePlus')}
          variant="onDark"
          onPress={() => setPlusConfirm(true)}
        />
      </Card>

      <Card tone="filled" style={styles.plusDetails}>
        <View style={[styles.plusDetailsHead, isRTL && styles.rowReverse]}>
          <View>
            <Text variant="microAccent">{t('settings.plus')}</Text>
            <Text variant="displaySmall" style={styles.plusDetailsTitle}>
              {t('settings.plusTitle')}
            </Text>
          </View>
          <View style={[styles.planBadge, isPlus && styles.planBadgeActive]}>
            <Text style={[styles.planBadgeLabel, isPlus && styles.planBadgeLabelActive]}>
              {isPlus ? t('settings.active') : t('settings.preview')}
            </Text>
          </View>
        </View>

        <View style={styles.benefitGrid}>
          <PremiumBenefit
            mark="10"
            title={t('settings.fullerRound')}
            detail={t('settings.fullerRoundBody')}
          />
          <PremiumBenefit
            mark="3"
            title={t('settings.moreKeeps')}
            detail={t('settings.moreKeepsBody')}
          />
          <PremiumBenefit
            mark="10"
            title={t('settings.moreChats')}
            detail={t('settings.moreChatsBody')}
          />
        </View>

        <View style={[styles.plusRule, isRTL && styles.rowReverse]}>
          <Text style={styles.plusRuleMark}>◌</Text>
          <Text variant="caption" style={styles.plusRuleText}>
            {t('settings.plusPrivacy')}
          </Text>
        </View>
      </Card>

      <Section eyebrow={t('settings.account')} title={t('settings.accountTitle')}>
        <SettingRow
          title={settings.paused ? t('settings.paused') : t('settings.pause')}
          subtitle={
            settings.paused
              ? t('settings.pausedBody')
              : t('settings.pauseBody')
          }
          value={settings.paused}
          onValueChange={() => setPauseConfirm(true)}
        />
        <View style={styles.paceCard}>
          <Text variant="micro">{t('settings.today')}</Text>
          <Text variant="body" style={styles.paceBody}>
            {t('settings.activityCount', {
              live: liveCount,
              introLimit: limits.introductions,
              open: openConnections,
              connectionLimit: limits.openConnections,
            })}
          </Text>
        </View>
        <SettingRow
          title={t('settings.support')}
          subtitle={t('settings.supportBody')}
          badge={t('settings.comingLater')}
        />
      </Section>

      <Text variant="caption" center style={styles.version}>
        {t('settings.version')}
      </Text>

      <ConfirmDialog
        visible={pauseConfirm}
        title={settings.paused ? t('settings.resumeTitle') : t('settings.pauseTitle')}
        body={
          settings.paused
            ? t('settings.resumeBody')
            : t('settings.pauseConfirmBody')
        }
        confirmLabel={settings.paused ? t('settings.resume') : t('settings.pauseNow')}
        cancelLabel={t('settings.notNow')}
        onConfirm={() => void confirmPause()}
        onCancel={() => setPauseConfirm(false)}
      />

      <ConfirmDialog
        visible={plusConfirm}
        title={isPlus ? t('settings.leavePlus') : t('settings.tryPlus')}
        body={USE_MOCKS
          ? (isPlus
            ? t('settings.demoFree')
            : t('settings.demoPlus'))
          : t('settings.purchaseUnavailable')}
        confirmLabel={USE_MOCKS ? (isPlus ? t('settings.useFree') : t('settings.activatePlus')) : t('settings.okay')}
        cancelLabel={t('settings.notNow')}
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
  const { isRTL } = useI18n();
  return (
    <View style={[styles.benefit, isRTL && styles.rowReverse]}>
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
  const { isRTL } = useI18n();
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
    <View style={[styles.row, isRTL && styles.rowReverse]}>
      <View style={styles.rowText}>
        <View style={[styles.rowTitleLine, isRTL && styles.rowReverse]}>
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
  rtl: { direction: 'rtl' },
  rowReverse: { flexDirection: 'row-reverse' },
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
    minHeight: 44,
    justifyContent: 'center',
  },
  languagePillLabel: { fontFamily: font.bodyBold, fontSize: 10, letterSpacing: 1, color: color.ink },
  restartNotice: { color: color.gold, marginTop: 8 },

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
  plusDetailsHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  plusDetailsTitle: { marginTop: 6, fontSize: 20, lineHeight: 26, flexShrink: 1 },
  planBadge: {
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
