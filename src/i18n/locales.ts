import { ar, en, type TranslationKey } from '@/i18n/catalog';

export type TextDirection = 'ltr' | 'rtl';

/**
 * The locale registry is the single extension point for a new language. Add a
 * complete catalog and metadata here; member-facing screens then inherit its
 * direction, BCP-47 tag, and fallback without scattered language checks.
 */
export const localeRegistry = {
  en: {
    tag: 'en',
    direction: 'ltr',
    catalog: en,
  },
  ar: {
    tag: 'ar-SA-u-ca-gregory',
    direction: 'rtl',
    catalog: ar,
  },
} as const satisfies Record<string, {
  tag: string;
  direction: TextDirection;
  catalog: Record<TranslationKey, string>;
}>;

export type AppLocale = keyof typeof localeRegistry;

export function isSupportedLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && value in localeRegistry;
}

export function getLocale(locale: AppLocale) {
  return localeRegistry[locale];
}
