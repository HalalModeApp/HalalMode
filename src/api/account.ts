import { requireSupabase, USE_MOCKS } from '@/lib/supabase';

/** Changes matching eligibility through a constrained server RPC. */
export async function setProfilePaused(paused: boolean): Promise<void> {
  if (USE_MOCKS) return;
  const { error } = await requireSupabase().rpc('set_my_profile_paused', {
    p_paused: paused,
  });
  if (error) throw error;
}
