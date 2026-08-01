import assert from 'node:assert/strict';
import test from 'node:test';

import {
  matchingPlanContext,
  matchingSeedForCycleDate,
  isExplicitDatabaseRollback,
  isRetriableLateMatchingVeto,
  parseMatchingRunContext,
  shouldRetryExactFinalization,
  shouldRetryMatchingRun,
  shouldReleaseCycleClaim,
} from '../supabase/functions/generate-round/runContext.ts';

function payload(runId: string) {
  return {
    run_id: runId,
    seed: 20260801,
    cycle_date: '2026-08-01',
    time_zone: 'Asia/Riyadh',
    window_starts_on: '2026-07-26',
    window_ends_on: '2026-08-01',
    rounds_elapsed_in_window: 7,
    evaluated_at: '2026-08-01T03:00:00.000Z',
    pool_member_count: 2,
  };
}

test('live and shadow runs for one cycle receive identical calendar window inputs', () => {
  const live = parseMatchingRunContext(
    payload('00000000-0000-4000-8000-000000000001'),
    '2026-08-01'
  );
  const shadow = parseMatchingRunContext(
    payload('00000000-0000-4000-8000-000000000002'),
    '2026-08-01'
  );

  assert.notEqual(live.runId, shadow.runId);
  assert.deepEqual(matchingPlanContext(live), matchingPlanContext(shadow));
  assert.equal(live.roundsElapsedInWindow, 7);
});

test('daily cycle claim is released only before finalization is attempted', () => {
  assert.equal(shouldReleaseCycleClaim(false), true, 'planning failure is safe to retry');
  assert.equal(
    shouldReleaseCycleClaim(true),
    false,
    'an ambiguous post-finalize response must fail closed against duplicates'
  );
  assert.equal(
    shouldReleaseCycleClaim(true, true),
    true,
    'an explicit Postgres rollback is safe to retry'
  );
});

test('only a classifiable database rollback can trigger one late-veto replan', () => {
  const lateVeto = {
    code: '40001',
    message: 'MATCHING_LATE_VETO: a member withdrew consent',
  };
  assert.equal(isExplicitDatabaseRollback(lateVeto), true);
  assert.equal(isRetriableLateMatchingVeto(lateVeto), true);
  assert.equal(shouldRetryMatchingRun(lateVeto, 0), true);
  assert.equal(shouldRetryMatchingRun(lateVeto, 1), false, 'retry is bounded');
  assert.equal(
    shouldRetryMatchingRun({ code: '40001', message: 'unclassified serialization failure' }, 0),
    false
  );
  assert.equal(
    shouldRetryMatchingRun(new TypeError('fetch failed'), 0),
    false,
    'transport ambiguity must not be treated as rollback'
  );
  assert.equal(isExplicitDatabaseRollback({ message: 'gateway timeout' }), false);
});

test('an ambiguous finalizer response gets one exact idempotent retry', () => {
  const transport = new TypeError('fetch failed');
  assert.equal(shouldRetryExactFinalization(transport, 0), true);
  assert.equal(shouldRetryExactFinalization(transport, 1), false, 'retry is bounded');
  assert.equal(
    shouldRetryExactFinalization({ code: '40001', message: 'rolled back' }, 0),
    false,
    'a definite database rollback must replan instead of replaying stale arguments'
  );
});

test('calendar phase is accepted only from the Asia/Riyadh run context', () => {
  assert.throws(
    () => parseMatchingRunContext(
      { ...payload('00000000-0000-4000-8000-000000000001'), time_zone: 'UTC' },
      '2026-08-01'
    ),
    /Asia\/Riyadh/
  );
  assert.throws(
    () => parseMatchingRunContext(
      { ...payload('00000000-0000-4000-8000-000000000001'), cycle_date: '2026-08-02' },
      '2026-08-01'
    ),
    /wrong cycle/
  );
});

test('tie-break seed is stable for a cycle and independent of window position', () => {
  assert.equal(matchingSeedForCycleDate('2026-08-01'), 20260801);
  assert.equal(matchingSeedForCycleDate('2026-08-01'), 20260801);
  assert.throws(() => matchingSeedForCycleDate('2026-8-1'), /cycle_date/);
  assert.throws(() => matchingSeedForCycleDate('2026-02-31'), /cycle_date/);
});
