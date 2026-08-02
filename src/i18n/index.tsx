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
    // Guarded because these are native-only. react-native-web ships an
    // I18nManager with `isRTL` and nothing else, so calling the rest throws at
    // startup and takes the whole tree with it — the app rendered nothing at
    // all in a browser until this check existed. On a device every one of them
    // is present and this costs a typeof.
    I18nManager.allowRTL?.(true);
    I18nManager.swapLeftAndRightInRTL?.(true);
    if (!nativeRestartRequired) return;
    // React Native applies forceRTL on the next cold start. Deliberately do not
    // reload here: automatic reloads can loop while persisted language state is
    // still hydrating. The settings UI asks for one restart only on a change.
    I18nManager.forceRTL?.(desiredRTL);
  }, [desiredRTL, nativeRestartRequired]);

  const value = useMemo<I18nValue>(() => {
    const catalog = locale.catalog;
    const t: Translate = (key, params) => {
      let message: string = catalog[key];
      for (const [name, replacement] of Object.entries(params ?? {})) {
        message = message.replaceAll(`{{${name}}}`, String(replacement));
      }
      if (__DEV__ && message.includes('{{')) {
        // Shipped once: copy gained a {{name}} and the call site was never given
        // the parameter, so a confirmation dialog asked "Stop seeing {{name}}?".
        // Nothing failed — every test checked that keys exist, not that they
        // were filled in. Loud in development, silent for members either way.
        console.error(
          `i18n: "${key}" still contains a placeholder after substitution: ${message}`
        );
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
