import type { MembershipTier } from '@/types';

/**
 * Converts the retired local tier value from pre-Premium builds. Database rows
 * are renamed by migration 0024; this only protects persisted app state while
 * members update the client.
 */
export function normalizeMembershipTier(value: unknown): MembershipTier | null {
  if (value === 'free') return 'free';
  if (value === 'premium' || value === 'plus') return 'premium';
  return null;
}
