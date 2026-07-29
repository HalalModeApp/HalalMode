import assert from 'node:assert/strict';
import test from 'node:test';

import { documentFromStatus, normalizeLegalConsentStatus } from '../src/lib/legalConsent';

const documents = [
  { type: 'terms', version: 'v2', title: 'Terms of Service', effectiveDate: '2026-08-01', url: 'https://halalmo.de/terms' },
  { type: 'privacy', version: 'v3', title: 'Privacy Notice', effectiveDate: '2026-08-01', url: 'https://halalmo.de/privacy' },
];

test('legal status accepts one current Terms and Privacy document', () => {
  const status = normalizeLegalConsentStatus({ required: false, currentDocuments: documents });
  assert.equal(status.required, false);
  assert.equal(documentFromStatus(status, 'terms')?.version, 'v2');
});

test('legal status fails closed on missing, duplicated, or malformed documents', () => {
  assert.throws(() => normalizeLegalConsentStatus({ required: false, currentDocuments: documents.slice(0, 1) }));
  assert.throws(() => normalizeLegalConsentStatus({ required: false, currentDocuments: [documents[0], documents[0]] }));
  assert.throws(() => normalizeLegalConsentStatus({ required: false, currentDocuments: [{ ...documents[0], url: 'http://example.test' }, documents[1]] }));
});

test('anything except an explicit current response requires consent', () => {
  assert.equal(normalizeLegalConsentStatus({ currentDocuments: documents }).required, true);
  assert.equal(normalizeLegalConsentStatus({ required: 'false', currentDocuments: documents }).required, true);
});
