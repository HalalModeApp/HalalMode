import { QueryClient } from '@tanstack/react-query';

/**
 * A round changes at most once a day, and the product's whole point is that
 * there is nothing new to pull down. Stale data is refreshed when the app
 * returns to the foreground so private signed media URLs are rotated safely.
 * Chat overrides this per-query where realtime matters.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

export const queryKeys = {
  session: ['session'] as const,
  profile: (id: string) => ['profile', id] as const,
  profileReadiness: ['profile-readiness'] as const,
  legalConsent: ['legal-consent'] as const,
  preferences: ['preferences'] as const,
  round: ['round'] as const,
  connections: ['connections'] as const,
  connection: (id: string) => ['connection', id] as const,
  messages: (connectionId: string) => ['messages', connectionId] as const,
};
