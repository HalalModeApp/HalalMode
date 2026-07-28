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
import { queryKeys } from '@/lib/queryClient';
import { useRound } from '@/state/round';
import { color, radius, space } from '@/theme/tokens';

type Tab = 'profile' | 'private' | 'settings';

const SUBTITLES: Record<Tab, string> = {
  profile: 'What everyone in your set can see.',
  private: 'Only ever used to choose who you meet.',
  settings: 'Preferences, membership and safety.',
};

export default function YouScreen() {
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
      <Screen withTabBar>
        <BrandHeader />
        <LoadingState label="Loading your profile" />
      </Screen>
    );
  }

  if (profileQuery.isError || preferencesQuery.isError || !profileQuery.data || !preferencesQuery.data) {
    return (
      <Screen withTabBar>
        <BrandHeader />
        <ErrorState
          title="Profile unavailable"
          message="We couldn't load your profile or matching preferences."
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
    <Screen withTabBar>
      <BrandHeader />

      <View style={styles.tabsRow}>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'profile', label: 'Profile' },
            { value: 'private', label: 'Matching' },
            { value: 'settings', label: 'Settings' },
          ]}
        />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.identity}>
          <View style={styles.mark} />
          <View style={styles.identityText}>
            <Text variant="displaySmall" style={styles.name}>
              {profile.name}
            </Text>
            <Text variant="caption">{SUBTITLES[tab]}</Text>
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
