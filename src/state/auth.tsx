import * as Linking from 'expo-linking';
import { useRouter, useSegments } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { User } from '@supabase/supabase-js';

import { requireSupabase, supabase, USE_MOCKS } from '@/lib/supabase';

interface AuthValue {
  user: User | null;
  ready: boolean;
  onboardingComplete: boolean;
  refreshProfileStatus: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(USE_MOCKS);
  const [onboardingComplete, setOnboardingComplete] = useState(USE_MOCKS);

  const refreshProfileStatus = useCallback(async () => {
    if (USE_MOCKS) return;
    const client = requireSupabase();
    const { data: current } = await client.auth.getUser();
    if (!current.user) {
      setOnboardingComplete(false);
      return;
    }
    const { data, error } = await client
      .from('profiles')
      .select('onboarding_complete')
      .eq('id', current.user.id)
      .maybeSingle();
    if (error) throw error;
    setOnboardingComplete(data?.onboarding_complete === true);
  }, []);

  useEffect(() => {
    if (USE_MOCKS || !supabase) return;
    const client = supabase;
    let active = true;

    const load = async () => {
      const initialUrl = await Linking.getInitialURL();
      if (initialUrl) {
        const code = new URL(initialUrl).searchParams.get('code');
        if (code) await client.auth.exchangeCodeForSession(code);
      }
      const { data } = await client.auth.getUser();
      if (active) {
        setUser(data.user);
        setReady(true);
      }
    };
    void load().catch(() => active && setReady(true));

    const subscription = client.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setUser(session?.user ?? null);
      setReady(true);
    });
    const linking = Linking.addEventListener('url', ({ url }) => {
      const code = new URL(url).searchParams.get('code');
      if (code) void client.auth.exchangeCodeForSession(code);
    });
    return () => {
      active = false;
      subscription.data.subscription.unsubscribe();
      linking.remove();
    };
  }, []);

  useEffect(() => {
    if (!ready || USE_MOCKS) return;
    if (!user) {
      setOnboardingComplete(false);
      return;
    }
    void refreshProfileStatus().catch(() => setOnboardingComplete(false));
  }, [ready, refreshProfileStatus, user]);

  const signOut = useCallback(async () => {
    if (!USE_MOCKS) await requireSupabase().auth.signOut();
  }, []);

  const value = useMemo(
    () => ({ user, ready, onboardingComplete, refreshProfileStatus, signOut }),
    [user, ready, onboardingComplete, refreshProfileStatus, signOut]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Redirects unauthenticated and incomplete real sessions before app content renders. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { ready, user, onboardingComplete } = useAuth();
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    if (!ready || USE_MOCKS) return;
    const inAuth = segments[0] === 'auth';
    const inOnboarding = segments[0] === 'onboarding';
    if (!user && !inAuth) router.replace('/auth');
    else if (user && !onboardingComplete && !inOnboarding) router.replace('/onboarding');
    else if (user && onboardingComplete && (inAuth || inOnboarding)) router.replace('/(tabs)/daily');
  }, [onboardingComplete, ready, router, segments, user]);

  if (!ready) return null;
  return <>{children}</>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
