import { Tabs } from 'expo-router';

import { TabBar } from '@/components/navigation/TabBar';

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="daily" options={{ title: 'Daily' }} />
      <Tabs.Screen name="connections" options={{ title: 'Connections' }} />
      <Tabs.Screen name="you" options={{ title: 'You' }} />
    </Tabs>
  );
}
