import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { fetchConnections } from '@/api/connections';
import { fetchMyPreferences, fetchMyProfile } from '@/api/profile';
import { BrandHeader } from '@/components/navigation/BrandHeader';
import { ErrorState, LoadingState } from '@/components/ui/AsyncState';
import { Screen } from '@/components/ui/Screen';
import { Segmented } from '@/components/ui/Segmented';
import { Text } from '@/components/ui/Text';
import { PrivateTab } from '@/components/you/PrivateTab';
import { ProfileTab } from '@/components/you/ProfileTab';
import { SettingsTab } from '@/components/you/SettingsTab';
import { useI18n } from '@/i18n';
import { queryKeys } from '@/lib/queryClient';
import { useRound } from '@/state/round';
import { color, radius, space } from '@/theme/tokens';

type Tab = 'profile' | 'private' | 'settings';

export default function YouScreen() {
  const { t, isRTL } = useI18n();
  const [tab, setTab] = useState<Tab>('profile');
  const { live } = useRound();

  const profileQuery = useQuery({
    queryKey: queryKeys.profile('me'),
    queryFn: fetchMyProfile,
  });

  const preferencesQuery = useQuery({
    queryKey: queryKeys.preferences,
    queryFn: fetchMyPreferences,
  });

  const connectionsQuery = useQuery({
    queryKey: queryKeys.connections,
    queryFn: fetchConnections,
  });

  if (profileQuery.isPending || preferencesQuery.isPending) {
    return (
      <Screen withTabBar style={isRTL ? styles.rtl : undefined}>
        <BrandHeader />
        <LoadingState label={t('you.loading')} />
      </Screen>
    );
  }

  if (profileQuery.isError || preferencesQuery.isError || !profileQuery.data || !preferencesQuery.data) {
    return (
      <Screen withTabBar style={isRTL ? styles.rtl : undefined}>
        <BrandHeader />
        <ErrorState
          title={t('you.errorTitle')}
          message={t('you.errorBody')}
          onRetry={() => {
            void profileQuery.refetch();
            void preferencesQuery.refetch();
          }}
        />
      </Screen>
    );
  }

  const profile = profileQuery.data;
  const preferences = preferencesQuery.data;
  const connections = connectionsQuery.data ?? [];

  return (
    <Screen withTabBar style={isRTL ? styles.rtl : undefined}>
      <BrandHeader />

      <View style={styles.tabsRow}>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'profile', label: t('you.tab.profile') },
            { value: 'private', label: t('you.tab.matching') },
            { value: 'settings', label: t('you.tab.settings') },
          ]}
        />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.identity, isRTL && styles.rowReverse]}>
          <View style={styles.mark} />
          <View style={styles.identityText}>
            <Text variant="displaySmall" style={styles.name}>
              {profile.name}
            </Text>
            <Text variant="caption">
              {t(
                tab === 'profile'
                  ? 'you.subtitle.profile'
                  : tab === 'private'
                    ? 'you.subtitle.matching'
                    : 'you.subtitle.settings'
              )}
            </Text>
          </View>
        </View>

        {tab === 'profile' ? <ProfileTab profile={profile} /> : null}
        {tab === 'private' ? <PrivateTab preferences={preferences} /> : null}
        {tab === 'settings' ? (
          <SettingsTab
            liveCount={live.length}
            openConnections={connections.length}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  rtl: { direction: 'rtl' },
  rowReverse: { flexDirection: 'row-reverse' },
  tabsRow: { paddingHorizontal: space.xl, paddingTop: 4 },
  content: { paddingHorizontal: space.xl, paddingTop: 20 },

  identity: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 18,
  },
  mark: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    backgroundColor: color.ink,
  },
  identityText: { flex: 1, gap: 5 },
  name: { fontSize: 22 },
});
