export type CountrySelectionMode = 'single' | 'multiple';

/** Keeps country selection deterministic for both onboarding and matching filters. */
export function toggleCountrySelection(
  current: readonly string[],
  country: string,
  mode: CountrySelectionMode
): string[] {
  if (mode === 'single') return [country];
  return current.includes(country)
    ? current.filter((item) => item !== country)
    : [...current, country];
}
