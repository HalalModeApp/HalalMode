import assert from 'node:assert/strict';
import test from 'node:test';

import { questionText } from '../src/data/questions';
import type { CompatibilityQuestion } from '../src/types';

const sample: CompatibilityQuestion = {
  id: 'q-localized',
  category: 'future',
  text: 'English fallback',
  textAr: 'Arabic legacy',
  translations: { ar: 'Arabic catalogued' },
};

test('question copy uses the locale translation before the legacy field', () => {
  assert.equal(questionText(sample, 'ar'), 'Arabic catalogued');
});

test('question copy falls back safely to English for a future locale', () => {
  assert.equal(questionText(sample, 'en'), 'English fallback');
});
