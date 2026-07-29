import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import * as Linking from 'expo-linking';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import {
  acceptCurrentLegalDocuments,
  fetchMyLegalConsentStatus,
} from '@/api/legalConsent';
import { BrandHeader } from '@/components/navigation/BrandHeader';
import { ErrorState, LoadingState } from '@/components/ui/AsyncState';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useI18n } from '@/i18n';
import { documentFromStatus } from '@/lib/legalConsent';
import { queryKeys } from '@/lib/queryClient';
import { testIds } from '@/lib/testIds';
import { alpha, color, radius, space } from '@/theme/tokens';

export default function LegalConsentScreen() {
  const { t, isRTL, localeTag } = useI18n();
  const queryClient = useQueryClient();
  const [accepted, setAccepted] = useState(false);
  const statusQuery = useQuery({
    queryKey: queryKeys.legalConsent,
    queryFn: fetchMyLegalConsentStatus,
  });
  const acceptance = useMutation({
    mutationFn: acceptCurrentLegalDocuments,
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.legalConsent, status);
      void queryClient.invalidateQueries({ queryKey: queryKeys.round });
      router.replace('/(tabs)/daily');
    },
  });

  useEffect(() => {
    if (statusQuery.data && !statusQuery.data.required) router.replace('/(tabs)/daily');
  }, [statusQuery.data]);

  if (statusQuery.isPending) {
    return <Screen><LoadingState label={t('legal.loading')} /></Screen>;
  }
  if (statusQuery.isError || !statusQuery.data) {
    return (
      <Screen>
        <BrandHeader />
        <ErrorState
          title={t('legal.errorTitle')}
          message={t('legal.errorBody')}
          onRetry={() => void statusQuery.refetch()}
        />
      </Screen>
    );
  }

  const terms = documentFromStatus(statusQuery.data, 'terms');
  const privacy = documentFromStatus(statusQuery.data, 'privacy');
  if (!terms || !privacy) {
    return <Screen><ErrorState title={t('legal.errorTitle')} message={t('legal.errorBody')} onRetry={() => void statusQuery.refetch()} /></Screen>;
  }

  const openDocument = async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert(t('legal.linkErrorTitle'), t('legal.linkErrorBody'));
    }
  };

  return (
    <Screen style={isRTL ? styles.rtl : undefined}>
      <BrandHeader />
      <ScrollView contentContainerStyle={styles.content}>
        <Text variant="microAccent">{t('legal.eyebrow')}</Text>
        <Text variant="display" style={styles.title}>{t('legal.title')}</Text>
        <Text variant="body" style={styles.body}>{t('legal.body')}</Text>

        {[terms, privacy].map((document) => (
          <Card key={document.type} style={styles.documentCard}>
            <Text variant="label">
              {document.type === 'terms' ? t('onboarding.termsLink') : t('onboarding.privacyLink')}
            </Text>
            <Text variant="caption">
              {t('legal.effective', {
                date: new Intl.DateTimeFormat(localeTag, { dateStyle: 'medium' })
                  .format(new Date(`${document.effectiveDate}T00:00:00`)),
              })}
            </Text>
            <Pressable
              testID={document.type === 'terms' ? testIds.legal.terms : testIds.legal.privacy}
              accessibilityRole="link"
              accessibilityLabel={document.type === 'terms' ? t('onboarding.termsLink') : t('onboarding.privacyLink')}
              onPress={() => void openDocument(document.url)}
              style={styles.link}
            >
              <Text variant="label" style={styles.linkText}>{t('legal.openDocument')}</Text>
            </Pressable>
          </Card>
        ))}

        <Pressable
          testID={testIds.legal.consent}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: accepted, disabled: acceptance.isPending }}
          accessibilityLabel={t('legal.consent')}
          disabled={acceptance.isPending}
          onPress={() => setAccepted((current) => !current)}
          style={[styles.consent, isRTL && styles.rowReverse, accepted && styles.consentSelected]}
        >
          <View style={[styles.check, accepted && styles.checkSelected]}>
            {accepted ? <Text style={styles.checkMark}>✓</Text> : null}
          </View>
          <Text variant="bodySmall" style={styles.consentText}>{t('legal.consent')}</Text>
        </Pressable>

        <Button
          testID={testIds.legal.submit}
          label={t('legal.accept')}
          disabled={!accepted}
          loading={acceptance.isPending}
          onPress={() => acceptance.mutate()}
        />
        {acceptance.isError ? (
          <Text accessibilityRole="alert" variant="caption" style={styles.submitError}>
            {t('legal.submitError')}
          </Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  rowReverse: { flexDirection: 'row-reverse' },
  content: { paddingHorizontal: space.xl, paddingBottom: space.xxl, gap: space.md },
  title: { marginTop: space.xs },
  body: { color: color.inkSoft, marginBottom: space.sm },
  documentCard: { gap: space.sm },
  link: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  linkText: { textDecorationLine: 'underline' },
  consent: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.md, padding: space.lg,
    borderWidth: 1, borderColor: alpha.lineStrong, borderRadius: radius.lg,
  },
  consentSelected: { borderColor: color.ink, backgroundColor: color.sandLight },
  check: { width: 22, height: 22, borderWidth: 1, borderColor: alpha.lineButton, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  checkSelected: { backgroundColor: color.ink, borderColor: color.ink },
  checkMark: { color: color.white, fontSize: 13 },
  consentText: { flex: 1, color: color.ink },
  submitError: { color: color.inkSoft, textAlign: 'center' },
});
