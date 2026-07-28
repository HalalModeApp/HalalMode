import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { fetchConnections } from '@/api/connections';
import { fetchMyPreferences, fetchMyProfile } from '@/api/profile';
import { BrandHeader } from '@/components/navigation/BrandHeader';
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
  settings: 'Pace, membership and safety.',
};

export default function YouScreen() {
  const [tab, setTab] = useState<Tab>('profile');
  const { live } = useRound();

  const { data: profile } = useQuery({
    queryKey: queryKeys.profile('me'),
    queryFn: fetchMyProfile,
  });

  const { data: preferences } = useQuery({
    queryKey: queryKeys.preferences,
    queryFn: fetchMyPreferences,
  });

  const { data: connections = [] } = useQuery({
    queryKey: queryKeys.connections,
    queryFn: fetchConnections,
  });

  if (!profile || !preferences) {
    return (
      <Screen withTabBar>
        <BrandHeader />
        <View style={styles.centred}>
          <ActivityIndicator color={color.ink} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen withTabBar>
      <BrandHeader />

      <View style={styles.tabsRow}>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'profile', label: 'Profile' },
            { value: 'private', label: 'Private' },
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
  centred: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
