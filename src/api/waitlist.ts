import { requireSupabase, USE_MOCKS } from '@/lib/supabase';

/** The ranges the server accepts. Kept in step with the check on the table. */
export const AGE_RANGES = ['18-24', '25-29', '30-34', '35-39', '40-49', '50+'] as const;
export type AgeRange = (typeof AGE_RANGES)[number];

export interface WaitlistEntry {
  email: string;
  city: string;
  ageRange: AgeRange;
  locale?: string;
}

/**
 * Adds someone to the waitlist behind the public landing page.
 *
 * Callable before anyone has an account, which is the whole point, so the
 * server validates everything again rather than trusting this call. It returns
 * nothing on success — deliberately: an endpoint that answered "already on the
 * list" would let anyone test whether a particular person had signed up.
 */
export async function joinWaitlist(entry: WaitlistEntry): Promise<void> {
  if (USE_MOCKS) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return;
  }

  const client = requireSupabase();
  const { error } = await client.rpc('join_waitlist', {
    p_email: entry.email.trim().toLowerCase(),
    p_city: entry.city.trim(),
    p_age_range: entry.ageRange,
    p_locale: entry.locale ?? null,
  });
  if (error) throw error;
}
