import { requireSupabase, USE_MOCKS } from '@/lib/supabase';
import { defaultFeatureFlags, type FeatureFlags } from '@/lib/featureFlags';
import { mapServerReleaseFlags } from '@/lib/releaseFlagMapping';

export { mapServerReleaseFlags } from '@/lib/releaseFlagMapping';

export async function fetchReleaseFlags(): Promise<FeatureFlags> {
  if (USE_MOCKS) return { ...defaultFeatureFlags };
  const { data, error } = await requireSupabase().rpc('get_my_release_flags');
  if (error) throw error;
  return mapServerReleaseFlags(data);
}
