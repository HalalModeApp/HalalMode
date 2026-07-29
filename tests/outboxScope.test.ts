import assert from 'node:assert/strict';
import test from 'node:test';

import { outboxStorageKeyForMember } from '../src/lib/outboxScope';

test('outbox storage is isolated per member on a shared device', () => {
  assert.notEqual(
    outboxStorageKeyForMember('member_a'),
    outboxStorageKeyForMember('member_b')
  );
});

test('outbox storage rejects an empty or unsafe member identifier', () => {
  assert.throws(() => outboxStorageKeyForMember(''), /valid member identifier/);
  assert.throws(() => outboxStorageKeyForMember('member/id'), /valid member identifier/);
});
