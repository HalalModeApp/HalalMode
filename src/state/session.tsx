import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { Language, MembershipTier } from '@/types';
import { isSupportedLocale } from '@/i18n/locales';
import { normalizeMembershipTier } from '@/lib/membership';

const STORAGE_KEY = 'halalmode.session.v1';

interface SessionValue {
  tier: MembershipTier;
  language: Language;
  setTier: (tier: MembershipTier) => void;
  setLanguage: (language: Language) => void;
  ready: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Lightweight local session preferences — tier and language.
 *
 * Tier is mirrored here for instant UI response, but it is not the source of
 * truth: every limit that matters (round size, keeps, open connections) is
 * re-checked server-side. Flipping this value locally buys nothing.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [tier, setTierState] = useState<MembershipTier>('free');
  const [language, setLanguageState] = useState<Language>('en');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (cancelled || !raw) return;
        const parsed = JSON.parse(raw) as Partial<SessionValue>;
        const savedTier = normalizeMembershipTier(parsed.tier);
        if (savedTier) {
          setTierState(savedTier);
          if (savedTier !== parsed.tier) {
            void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({
              tier: savedTier,
              language: isSupportedLocale(parsed.language) ? parsed.language : 'en',
            })).catch(() => {});
          }
        }
        if (isSupportedLocale(parsed.language)) {
          setLanguageState(parsed.language);
        }
      })
      .catch(() => {
        // A corrupt preferences blob should never block launch.
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback((next: { tier: MembershipTier; language: Language }) => {
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  const setTier = useCallback(
    (next: MembershipTier) => {
      setTierState(next);
      persist({ tier: next, language });
    },
    [language, persist]
  );

  const setLanguage = useCallback(
    (next: Language) => {
      setLanguageState(next);
      persist({ tier, language: next });
    },
    [tier, persist]
  );

  const value = useMemo(
    () => ({ tier, language, setTier, setLanguage, ready }),
    [tier, language, setTier, setLanguage, ready]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
