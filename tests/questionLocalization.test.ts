import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

test('the client question library and the server catalogue cannot drift apart', () => {
  // The prompts ship with the app; the server keeps its own catalogue and
  // validates picked ids against it. A question in one and not the other is a
  // button that fails on submit, so the two lists are compared here — the same
  // guard the matching config and the waitlist age ranges already have.
  const library = readFileSync(resolve(process.cwd(), 'src/data/questions.ts'), 'utf8');
  const clientIds = [...library.matchAll(/id:\s*'([a-z0-9_-]+)'/gu)]
    .map((m) => m[1] ?? '')
    .filter(Boolean)
    .sort();

  const seed = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/0020_question_catalog.sql'),
    'utf8'
  );
  const seeded = [...seed.matchAll(/\(\s*'([a-z0-9_-]+)'\s*,/gu)].map((m) => m[1] ?? '').filter(Boolean);
  const seededIds = [...new Set(seeded.filter((id) => clientIds.includes(id) || /^q\d+$/u.test(id)))].sort();

  assert.ok(clientIds.length >= 10, `expected a full library, found ${clientIds.length}`);
  assert.deepEqual(
    clientIds,
    seededIds,
    'every question the app offers must exist in the catalogue the server checks against'
  );
});
