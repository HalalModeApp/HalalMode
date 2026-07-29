import assert from 'node:assert/strict';
import test from 'node:test';

import {
  birthDateValidationIssue,
  formatBirthDate,
  normaliseDecimalDigits,
} from '../src/lib/birthDate';

test('birth date input accepts Arabic and Persian decimal digits', () => {
  assert.equal(normaliseDecimalDigits('١٨'), '18');
  assert.equal(normaliseDecimalDigits('۱۳۸۰'), '1380');
  assert.equal(normaliseDecimalDigits(' ٢٠٠٠-٠٢-٠٩ '), '20000209');
});

test('birth dates are canonicalized and validated at age boundaries', () => {
  const today = new Date('2026-07-29T00:00:00Z');
  assert.equal(
    formatBirthDate({ birthYear: '2008', birthMonth: '07', birthDay: '29' }),
    '2008-07-29'
  );
  assert.equal(
    birthDateValidationIssue({ birthYear: '2008', birthMonth: '07', birthDay: '29' }, today),
    null
  );
  assert.equal(
    birthDateValidationIssue({ birthYear: '2008', birthMonth: '07', birthDay: '30' }, today),
    'too_young'
  );
  assert.equal(
    birthDateValidationIssue({ birthYear: '2000', birthMonth: '02', birthDay: '30' }, today),
    'invalid'
  );
});
