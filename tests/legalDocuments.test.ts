import assert from 'node:assert/strict';
import test from 'node:test';
import { LEGAL_DOCUMENTS } from '../src/lib/legalDocuments';

test('legal consent documents have explicit versions and HTTPS locations', () => {
  for (const document of Object.values(LEGAL_DOCUMENTS)) {
    assert.match(document.version, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(document.url, /^https:\/\//);
  }
});
