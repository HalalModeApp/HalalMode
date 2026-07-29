import assert from 'node:assert/strict';
import test from 'node:test';

import { nextLocale } from '../src/lib/localePolicy';

test('compact language controls cycle through any ordered locale registry', () => {
  const locales = ['en', 'ar', 'tr'] as const;
  for (const [index, locale] of locales.entries()) {
    assert.equal(
      nextLocale(locales, locale),
      locales[(index + 1) % locales.length]
    );
  }
});
