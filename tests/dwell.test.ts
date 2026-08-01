import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DWELL_THRESHOLDS,
  DwellLedger,
  inferPassCandidate,
  median,
  type DwellRecord,
} from '../src/lib/dwell';

const record = (introductionId: string, totalMs: number, opens = 1): DwellRecord => ({
  introductionId,
  totalMs,
  opens,
});

test('median handles both odd and even counts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), 0);
});

test('no candidate before enough profiles have actually been read', () => {
  const two = [record('a', 1_000), record('b', 30_000)];
  assert.equal(inferPassCandidate(two, ['a']), null);
});

test('a mis-tap counts neither toward the minimum nor as a candidate', () => {
  // Three entries, but one is a 200ms bounce: only two profiles were read, so
  // there is no basis for comparison and nothing should be asked.
  const records = [record('a', 200), record('b', 30_000), record('c', 28_000)];
  assert.equal(inferPassCandidate(records, ['a', 'b', 'c']), null);

  // With a fourth genuine read the bounce still cannot be the candidate.
  const withFourth = [...records, record('d', 26_000), record('e', 4_000)];
  assert.equal(inferPassCandidate(withFourth, ['a', 'd', 'e']), 'e');
});

test('the shortest read among released profiles is the candidate', () => {
  const records = [
    record('a', 40_000),
    record('b', 36_000),
    record('c', 38_000),
    record('d', 3_000),
  ];
  assert.equal(inferPassCandidate(records, ['b', 'd']), 'd');
});

test('someone kept is never a candidate, however briefly they were read', () => {
  const records = [
    record('kept', 2_000),
    record('a', 40_000),
    record('b', 36_000),
    record('c', 38_000),
  ];
  // 'kept' is the shortest read by far but was not let go, so there is no no to
  // strengthen. The next shortest is nowhere near the threshold.
  assert.equal(inferPassCandidate(records, ['a', 'b', 'c']), null);
});

test('a member who reads everything closely is not asked about anyone', () => {
  const records = [
    record('a', 50_000),
    record('b', 44_000),
    record('c', 40_000),
    record('d', 38_000),
  ];
  // The shortest is still well past a fair look, even though it is the least.
  assert.ok(38_000 >= DWELL_THRESHOLDS.fairLookMs);
  assert.equal(inferPassCandidate(records, ['a', 'b', 'c', 'd']), null);
});

test('an evenly skimmed set singles nobody out', () => {
  // Everyone got roughly the same short look. Nobody was dismissed; the member
  // was simply quick, and should not be asked to condemn whoever came last.
  const records = [record('a', 6_000), record('b', 5_500), record('c', 5_000)];
  assert.equal(inferPassCandidate(records, ['a', 'b', 'c']), null);
});

test('a tie is not a singling-out', () => {
  const records = [
    record('a', 40_000),
    record('b', 36_000),
    record('c', 2_000),
    record('d', 2_000),
  ];
  assert.equal(
    inferPassCandidate(records, ['c', 'd']),
    null,
    'two equally brief reads make neither of them the one'
  );
});

test('the candidate must be well below the member own pace, not merely last', () => {
  const records = [record('a', 12_000), record('b', 11_000), record('c', 7_000)];
  // 7s against a median of 11s is 0.64 — the least, but not a dismissal.
  assert.equal(inferPassCandidate(records, ['a', 'b', 'c']), null);

  const clearer = [record('a', 12_000), record('b', 11_000), record('c', 4_000)];
  assert.equal(inferPassCandidate(clearer, ['a', 'b', 'c']), 'c');
});

// --- The ledger -------------------------------------------------------------

test('the ledger accumulates time across repeat visits', () => {
  let clock = 0;
  const ledger = new DwellLedger(() => clock);

  ledger.opened('a');
  clock += 5_000;
  ledger.closed('a');

  ledger.opened('b');
  clock += 1_000;
  ledger.closed('b');

  ledger.opened('a');
  clock += 3_000;
  ledger.closed('a');

  const byId = new Map(ledger.records().map((r) => [r.introductionId, r]));
  assert.equal(byId.get('a')?.totalMs, 8_000, 'a second look adds to the first');
  assert.equal(byId.get('a')?.opens, 2);
  assert.equal(byId.get('b')?.totalMs, 1_000);
});

test('opening a second profile closes the first', () => {
  let clock = 0;
  const ledger = new DwellLedger(() => clock);

  ledger.opened('a');
  clock += 4_000;
  ledger.opened('b');
  clock += 2_000;

  const byId = new Map(ledger.records().map((r) => [r.introductionId, r]));
  assert.equal(byId.get('a')?.totalMs, 4_000);
  assert.equal(byId.get('b')?.totalMs, 2_000, 'reading in progress is counted, not lost');
});

test('closing a profile that is not open changes nothing', () => {
  let clock = 0;
  const ledger = new DwellLedger(() => clock);
  ledger.opened('a');
  clock += 1_000;
  ledger.closed('b');
  clock += 1_000;
  ledger.closed('a');

  assert.deepEqual(ledger.records(), [{ introductionId: 'a', totalMs: 2_000, opens: 1 }]);
});

test('records are idempotent — reading them twice does not double-count', () => {
  let clock = 0;
  const ledger = new DwellLedger(() => clock);
  ledger.opened('a');
  clock += 3_000;

  assert.deepEqual(ledger.records(), [{ introductionId: 'a', totalMs: 3_000, opens: 1 }]);
  clock += 5_000;
  assert.deepEqual(
    ledger.records(),
    [{ introductionId: 'a', totalMs: 3_000, opens: 1 }],
    'the open profile was already closed by the first read'
  );
});
