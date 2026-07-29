import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OUTBOX_BODY_CHUNK_SIZE,
  joinOutboxBody,
  shouldSecureOutboxBodies,
  splitOutboxBody,
} from '../src/lib/messageOutboxPolicy';

test('native outbox bodies use protected storage while web stays origin scoped', () => {
  assert.equal(shouldSecureOutboxBodies('ios'), true);
  assert.equal(shouldSecureOutboxBodies('android'), true);
  assert.equal(shouldSecureOutboxBodies('web'), false);
});

test('outbox body chunks preserve Unicode text under the SecureStore value limit', () => {
  const body = `${'🙂'.repeat(OUTBOX_BODY_CHUNK_SIZE)}${'a'.repeat(OUTBOX_BODY_CHUNK_SIZE + 1)}`;
  const chunks = splitOutboxBody(body);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= OUTBOX_BODY_CHUNK_SIZE));
  assert.equal(joinOutboxBody(chunks), body);
});

test('outbox body hydration rejects missing secure chunks', () => {
  assert.equal(joinOutboxBody([]), null);
  assert.equal(joinOutboxBody(['first', '']), null);
});
