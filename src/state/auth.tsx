import { useQuery } from '@tanstack/react-query';
import * as Linking from 'expo-linking';
import { useRouter, useSegments, type Href } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { User } from '@supabase/supabase-js';

import { fetchMyLegalConsentStatus } from '@/api/legalConsent';
import {
  canApplyProfileStatus,
  hasAuthPrincipalChanged,
  MEMBER_SIGN_OUT_SCOPE,
} from '@/lib/authSessionScope';
import { clearOnboardingDraft } from '@/lib/onboardingDraftStorage';
import { clearPrivateMediaCache } from '@/lib/privateMediaCache';
import { shouldClearPrivateMediaCache } from '@/lib/privateMediaCachePolicy';
import { queryClient, queryKeys } from '@/lib/queryClient';
import { requireSupabase, supabase, USE_MOCKS } from '@/lib/supabase';

interface AuthValue {
  user: User | null;
  ready: boolean;
  onboardingComplete: boolean;
  profileStatusReady: boolean;
  authError: 'invalid_link' | null;
  clearAuthError: () => void;
  refreshProfileStatus: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(USE_MOCKS);
  const [onboardingComplete, setOnboardingComplete] = useState(USE_MOCKS);
  const [profileStatusReady, setProfileStatusReady] = useState(USE_MOCKS);
  const [authError, setAuthError] = useState<'invalid_link' | null>(null);

  const activeUserId = useRef<string | null>(null);
  const profileStatusRequest = useRef(0);

  const adoptUser = useCallback((nextUser: User | null) => {
    const nextUserId = nextUser?.id ?? null;
    const previousUserId = activeUserId.current;

    if (hasAuthPrincipalChanged(previousUserId, nextUserId)) {
      // Query keys intentionally do not contain an account ID.
      // Clear all cached results before another member can render them.
      queryClient.clear();
      setOnboardingComplete(false);
      setProfileStatusReady(nextUserId === null);

      if (previousUserId) {
        void clearOnboardingDraft(previousUserId);
      }
    }

    if (shouldClearPrivateMediaCache(previousUserId, nextUserId)) {
      void clearPrivateMediaCache();
    }

    activeUserId.current = nextUserId;
    setUser(nextUser);
  }, []);

  const refreshProfileStatus = useCallback(async () => {
    if (USE_MOCKS) return;

    const client = requireSupabase();
    const { data: current } = await client.auth.getUser();
    const requestId = ++profileStatusRequest.current;

    if (!current.user) {
      if (requestId === profileStatusRequest.current) {
        setOnboardingComplete(false);
        setProfileStatusReady(true);
      }

      return;
    }

    const { data, error } = await client
      .from('profiles')
      .select('onboarding_complete')
      .eq('id', current.user.id)
      .maybeSingle();

    if (error) throw error;

    // A late response for a signed-out or replaced account must not alter
    // the next member's route gate.
    if (
      !canApplyProfileStatus(
        requestId,
        profileStatusRequest.current,
        current.user.id,
        activeUserId.current,
      )
    ) {
      return;
    }

    setOnboardingComplete(data?.onboarding_complete === true);
    setProfileStatusReady(true);
  }, []);

  useEffect(() => {
    if (USE_MOCKS || !supabase) return;

    const client = supabase;
    let active = true;

    const exchangeCode = async (url: string) => {
      let code: string | null = null;

      try {
        code = new URL(url).searchParams.get('code');
      } catch {
        return;
      }

      if (!code) return;

      const { error } = await client.auth.exchangeCodeForSession(code);

      if (!active) return;

      setAuthError(error ? 'invalid_link' : null);
    };

    const load = async () => {
      const initialUrl = await Linking.getInitialURL();

      if (initialUrl) {
        await exchangeCode(initialUrl);
      }

      const { data } = await client.auth.getUser();

      if (active) {
        adoptUser(data.user);
        setReady(true);
      }
    };

    void load().catch(() => {
      if (active) {
        setReady(true);
      }
    });

    const subscription = client.auth.onAuthStateChange((_event, session) => {
      if (!active) return;

      adoptUser(session?.user ?? null);

      if (session?.user) {
        setAuthError(null);
      }

      setReady(true);
    });

    const linking = Linking.addEventListener('url', ({ url }) => {
      void exchangeCode(url);
    });

    return () => {
      active = false;
      subscription.data.subscription.unsubscribe();
      linking.remove();
    };
  }, [adoptUser]);

  useEffect(() => {
    if (!ready || USE_MOCKS) return;

    if (!user) {
      setOnboardingComplete(false);
      return;
    }

    void refreshProfileStatus().catch(() => {
      setOnboardingComplete(false);
      setProfileStatusReady(true);
    });
  }, [ready, refreshProfileStatus, user]);

  const signOut = useCallback(async () => {
    if (!USE_MOCKS) {
      const { error } = await requireSupabase().auth.signOut({
        scope: MEMBER_SIGN_OUT_SCOPE,
      });

      if (error) throw error;
    }

    queryClient.clear();
    void clearPrivateMediaCache();

    if (activeUserId.current) {
      void clearOnboardingDraft(activeUserId.current);
    }

    activeUserId.current = null;
    setUser(null);

    // Keep mock mode ready to enter the demo again.
    setOnboardingComplete(USE_MOCKS);
    setProfileStatusReady(true);
  }, []);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      ready,
      onboardingComplete,
      profileStatusReady,
      authError,
      clearAuthError,
      refreshProfileStatus,
      signOut,
    }),
    [
      user,
      ready,
      onboardingComplete,
      profileStatusReady,
      authError,
      clearAuthError,
      refreshProfileStatus,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Redirects unauthenticated and incomplete real sessions before app content
 * renders. In mock mode, authentication and onboarding are skipped.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { ready, user, onboardingComplete, profileStatusReady } = useAuth();
  const router = useRouter();
  const segments = useSegments();

  const legalConsentQuery = useQuery({
    queryKey: queryKeys.legalConsent,
    queryFn: fetchMyLegalConsentStatus,
    enabled:
      !USE_MOCKS &&
      ready &&
      !!user &&
      profileStatusReady &&
      onboardingComplete,
  });

  useEffect(() => {
    if (!ready) return;

    const rootSegment = segments[0] as string | undefined;
    const inAuth = rootSegment === 'auth';
    const inOnboarding = rootSegment === 'onboarding';
    const inLegalConsent = rootSegment === 'legal-consent';
    // The public waitlist landing. Reachable by anyone, signed in or not, and
    // never redirected away from — it is the page halalmo.de points at.
    const inJoin = rootSegment === 'join';

    // Demo/mock mode must never require email or Supabase authentication.
    // Redirect only from entry gates so normal demo navigation still works.
    if (USE_MOCKS) {
      if (
        (!rootSegment ||
          inAuth ||
          inOnboarding ||
          inLegalConsent) &&
        !inJoin
      ) {
        router.replace('/(tabs)/daily');
      }

      return;
    }

    if (inJoin) return;

    if (!user && !inAuth) {
      router.replace('/auth');
      return;
    }

    if (
      user &&
      profileStatusReady &&
      !onboardingComplete &&
      !inOnboarding
    ) {
      router.replace('/onboarding');
      return;
    }

    if (
      user &&
      profileStatusReady &&
      onboardingComplete &&
      !legalConsentQuery.isPending
    ) {
      if (
        (legalConsentQuery.isError ||
          legalConsentQuery.data?.required) &&
        !inLegalConsent
      ) {
        router.replace('/legal-consent' as Href);
        return;
      }

      if (
        !legalConsentQuery.isError &&
        legalConsentQuery.data &&
        !legalConsentQuery.data.required &&
        (inAuth || inOnboarding || inLegalConsent)
      ) {
        router.replace('/(tabs)/daily');
      }
    }
  }, [
    legalConsentQuery.data,
    legalConsentQuery.isError,
    legalConsentQuery.isPending,
    onboardingComplete,
    profileStatusReady,
    ready,
    router,
    segments,
    user,
  ]);

  if (!ready) return null;

  if (!USE_MOCKS && user && !profileStatusReady) {
    return null;
  }

  if (
    !USE_MOCKS &&
    user &&
    onboardingComplete &&
    legalConsentQuery.isPending
  ) {
    return null;
  }

  return <>{children}</>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);

  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider');
  }

  return value;
}