import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { fetchReleaseFlags } from '@/api/releaseFlags';
import { defaultFeatureFlags, type FeatureFlags } from '@/lib/featureFlags';
import { USE_MOCKS } from '@/lib/supabase';
import { useAuth } from '@/state/auth';

const FeatureFlagsContext = createContext<FeatureFlags>(defaultFeatureFlags);

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  const [flags, setFlags] = useState<FeatureFlags>(defaultFeatureFlags);

  useEffect(() => {
    if (USE_MOCKS || !userId) {
      setFlags(defaultFeatureFlags);
      return;
    }
    let cancelled = false;
    void fetchReleaseFlags()
      .then((next) => { if (!cancelled) setFlags(next); })
      .catch(() => { if (!cancelled) setFlags(defaultFeatureFlags); });
    return () => { cancelled = true; };
  }, [userId]);

  const value = useMemo(() => flags, [flags]);
  return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>;
}

export function useFeatureFlags(): FeatureFlags {
  return useContext(FeatureFlagsContext);
}
