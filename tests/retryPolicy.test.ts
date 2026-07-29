import assert from 'node:assert/strict';
import test from 'node:test';

import { retryAllInOrder } from '../src/lib/retryPolicy';

test('retry attempts every queued item after an individual failure', async () => {
  const attempted: string[] = [];
  const result = await retryAllInOrder(['first', 'second', 'third'], async (item) => {
    attempted.push(item);
    if (item === 'second') throw new Error('network unavailable');
    return item.toUpperCase();
  });

  assert.deepEqual(attempted, ['first', 'second', 'third']);
  assert.deepEqual(result, { delivered: ['FIRST', 'THIRD'], failedCount: 1 });
});
