import assert from 'node:assert/strict';
import test from 'node:test';

import { conductAcknowledgementKey } from '../src/lib/conductAcknowledgement';

test('conduct acknowledgement is versioned and isolated to the signed-in member', () => {
  assert.equal(
    conductAcknowledgementKey('member/a'),
    'halal-mode:conduct:v1:member%2Fa'
  );
  assert.notEqual(conductAcknowledgementKey('member-a'), conductAcknowledgementKey('member-b'));
});
