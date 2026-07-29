/** Advances a compact locale chooser through its ordered registry. */
export function nextLocale<Locale extends string>(
  locales: readonly Locale[],
  locale: Locale
): Locale {
  const index = locales.indexOf(locale);
  return locales[(index + 1) % locales.length] ?? locales[0] ?? locale;
}
