import assert from 'node:assert/strict';
import test from 'node:test';

import { DwellLedger, inferPassCandidate, type DwellRecord } from '../src/lib/dwell';

const record = (introductionId: string, totalMs: number, opens = 1): DwellRecord => ({
  introductionId,
  totalMs,
  opens,
});

/** A full free-tier set. */
const FIVE = ['a', 'b', 'c', 'd', 'e'];

// --- Shape one: everyone read, one read least -------------------------------

test('all five read and one read least is a pass', () => {
  const records = [
    record('a', 30_000),
    record('b', 28_000),
    record('c', 26_000),
    record('d', 24_000),
    record('e', 4_000),
  ];
  assert.equal(inferPassCandidate(records, FIVE, ['b', 'c', 'd', 'e']), 'e');
});

test('least is least — the margin does not have to be large', () => {
  // The rule is structural, not a judgement about how much less. A member who
  // read everyone closely and one person slightly less is still asked; they can
  // simply answer no, which is what the confirmation is for.
  const records = [
    record('a', 30_000),
    record('b', 29_000),
    record('c', 28_000),
    record('d', 27_000),
    record('e', 26_000),
  ];
  assert.equal(inferPassCandidate(records, FIVE, ['e']), 'e');
});

test('a tie at the bottom singles nobody out', () => {
  const records = [
    record('a', 30_000),
    record('b', 28_000),
    record('c', 26_000),
    record('d', 5_000),
    record('e', 5_000),
  ];
  assert.equal(inferPassCandidate(records, FIVE, ['d', 'e']), null);
});

// --- Shape two: everyone but one read, that one never opened ----------------

test('four read and the fifth never opened is a pass', () => {
  const records = [
    record('a', 30_000),
    record('b', 28_000),
    record('c', 26_000),
    record('d', 24_000),
  ];
  assert.equal(inferPassCandidate(records, FIVE, ['b', 'c', 'd', 'e']), 'e');
});

test('a mis-tap counts as never opened, not as the shortest read', () => {
  const records = [
    record('a', 30_000),
    record('b', 28_000),
    record('c', 26_000),
    record('d', 24_000),
    record('e', 300),
  ];
  // Backing straight out is not a reading. It resolves as the second shape,
  // which reaches the same answer by the more honest route.
  assert.equal(inferPassCandidate(records, FIVE, ['e']), 'e');
});

// --- Everything else ---------------------------------------------------------

test('two left unopened is not a judgement about either', () => {
  const records = [record('a', 30_000), record('b', 28_000), record('c', 26_000)];
  assert.equal(
    inferPassCandidate(records, FIVE, ['d', 'e']),
    null,
    'the member did not work through the set, so nobody was left at the bottom of it'
  );
});

test('a barely-read set tells you nothing', () => {
  const records = [record('a', 30_000)];
  assert.equal(inferPassCandidate(records, FIVE, ['b', 'c', 'd', 'e']), null);
});

test('someone kept is never a candidate, however briefly they were read', () => {
  const records = [
    record('a', 30_000),
    record('b', 28_000),
    record('c', 26_000),
    record('d', 24_000),
    record('e', 2_000),
  ];
  assert.equal(
    inferPassCandidate(records, FIVE, ['b', 'c', 'd']),
    null,
    'e was read least but kept, so there is no no to strengthen'
  );
});

test('a set too small to have a bottom is not judged', () => {
  const two = ['a', 'b'];
  assert.equal(inferPassCandidate([record('a', 20_000)], two, ['b']), null);
  assert.equal(
    inferPassCandidate([record('a', 20_000), record('b', 2_000)], two, ['b']),
    null
  );
});

test('the rule scales to a premium set of ten', () => {
  const ten = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const records = ten.slice(0, 9).map((id, i) => record(id, 30_000 - i * 1_000));
  assert.equal(inferPassCandidate(records, ten, ['j']), 'j', 'nine read, the tenth never opened');
});

test('duplicate ids in the set do not create a phantom unread profile', () => {
  const records = [
    record('a', 30_000),
    record('b', 28_000),
    record('c', 26_000),
    record('d', 4_000),
  ];
  assert.equal(inferPassCandidate(records, ['a', 'b', 'c', 'd', 'a'], ['d']), 'd');
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
