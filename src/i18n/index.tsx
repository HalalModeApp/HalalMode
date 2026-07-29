import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { I18nManager } from 'react-native';

import { type TranslationKey } from '@/i18n/catalog';
import { getLocale, type AppLocale } from '@/i18n/locales';
import { useSession } from '@/state/session';

export type TranslationParams = Record<string, string | number>;
export type Translate = (key: TranslationKey, params?: TranslationParams) => string;

interface I18nValue {
  language: AppLocale;
  localeTag: string;
  isRTL: boolean;
  t: Translate;
  nativeRestartRequired: boolean;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { language } = useSession();
  const locale = getLocale(language);
  const desiredRTL = locale.direction === 'rtl';
  const nativeRestartRequired = I18nManager.isRTL !== desiredRTL;

  useEffect(() => {
    I18nManager.allowRTL(true);
    I18nManager.swapLeftAndRightInRTL(true);
    if (!nativeRestartRequired) return;
    // React Native applies forceRTL on the next cold start. Deliberately do not
    // reload here: automatic reloads can loop while persisted language state is
    // still hydrating. The settings UI asks for one restart only on a change.
    I18nManager.forceRTL(desiredRTL);
  }, [desiredRTL, nativeRestartRequired]);

  const value = useMemo<I18nValue>(() => {
    const catalog = locale.catalog;
    const t: Translate = (key, params) => {
      let message: string = catalog[key];
      for (const [name, replacement] of Object.entries(params ?? {})) {
        message = message.replaceAll(`{{${name}}}`, String(replacement));
      }
      return message;
    };
    return {
      language,
      localeTag: locale.tag,
      isRTL: desiredRTL,
      t,
      nativeRestartRequired,
    };
  }, [desiredRTL, language, locale, nativeRestartRequired]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
