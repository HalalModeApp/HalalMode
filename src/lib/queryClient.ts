import { QueryClient } from '@tanstack/react-query';

/**
 * A round changes at most once a day, and the product's whole point is that
 * there is nothing new to pull down. So: long stale times, no refetch on focus.
 * Chat overrides this per-query where realtime matters.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export const queryKeys = {
  session: ['session'] as const,
  profile: (id: string) => ['profile', id] as const,
  preferences: ['preferences'] as const,
  round: ['round'] as const,
  connections: ['connections'] as const,
  connection: (id: string) => ['connection', id] as const,
  messages: (connectionId: string) => ['messages', connectionId] as const,
};
