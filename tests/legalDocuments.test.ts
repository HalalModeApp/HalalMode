import assert from 'node:assert/strict';
import test from 'node:test';
import { LEGAL_DOCUMENT_FALLBACKS } from '../src/lib/legalDocuments';

test('legal consent documents have explicit versions and HTTPS locations', () => {
  for (const document of Object.values(LEGAL_DOCUMENT_FALLBACKS)) {
    assert.match(document.version, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(document.url, /^https:\/\//);
  }
});
