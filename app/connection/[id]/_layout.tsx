import { Stack } from 'expo-router';

import { color } from '@/theme/tokens';

/**
 * The post-match flow is its own stack: questions → answers → recap → chat.
 *
 * Without this layout Expo Router flattens these into the root stack, and
 * `connection/[id]` stops being an addressable node at all.
 */
export default function ConnectionLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: color.surface },
        animation: 'slide_from_right',
      }}
    />
  );
}
