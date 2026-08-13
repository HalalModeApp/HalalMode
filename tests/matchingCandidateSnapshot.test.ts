import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeCandidateSnapshot,
  parseBooleanMarker,
  parseCountPayload,
  prepareCandidateSnapshot,
  type MatchingSnapshotRpcClient,
} from '../supabase/functions/generate-round/candidateSnapshot.ts';

function clientWith(
  replies: { data: unknown; error: { message: string } | null }[]
): MatchingSnapshotRpcClient & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, ...args });
      const reply = replies.shift();
      if (!reply) throw new Error('Unexpected scoring call');
      return reply;
    },
  };
}

test('candidate scoring completes a large snapshot in bounded batches', async () => {
  const client = clientWith([
    { data: { scored_rows: 500, remaining_rows: 543, complete: false }, error: null },
    { data: { scored_rows: 500, remaining_rows: 43, complete: false }, error: null },
    { data: { scored_rows: 43, remaining_rows: 0, complete: true }, error: null },
  ]);

  await completeCandidateSnapshot(client, 'run-1', 1043, false);

  assert.equal(client.calls.length, 3);
  assert.deepEqual(client.calls[0], {
    name: 'matching_candidate_snapshot_score_batch_service',
    p_run_id: 'run-1',
    p_batch_size: 500,
  });
});

test('candidate preparation advances member batches before returning final counts', async () => {
  const client = clientWith([
    {
      data: {
        candidate_edge_count: 300,
        potential_edge_count: 2400,
        shortlist_members_processed: 80,
        shortlist_complete: false,
        scoring_complete: false,
      },
      error: null,
    },
    {
      data: {
        candidate_edge_count: 720,
        potential_edge_count: 2400,
        shortlist_members_processed: 100,
        shortlist_complete: true,
        scoring_complete: false,
      },
      error: null,
    },
  ]);

  const result = await prepareCandidateSnapshot(client, 'run-p', 5000, 100);

  assert.deepEqual(result, {
    candidate_edge_count: 720,
    potential_edge_count: 2400,
    scoring_complete: false,
  });
  assert.equal(client.calls.length, 2);
});

test('candidate preparation rejects stalled or contradictory state', async () => {
  await assert.rejects(
    prepareCandidateSnapshot(clientWith([
      {
        data: {
          candidate_edge_count: 10,
          potential_edge_count: 100,
          shortlist_members_processed: 0,
          shortlist_complete: false,
          scoring_complete: false,
        },
        error: null,
      },
      {
        data: {
          candidate_edge_count: 10,
          potential_edge_count: 100,
          shortlist_members_processed: 0,
          shortlist_complete: false,
          scoring_complete: false,
        },
        error: null,
      },
    ]), 'run-stalled', 500, 80),
    /did not make progress/
  );
  await assert.rejects(
    prepareCandidateSnapshot(clientWith([
      {
        data: {
          candidate_edge_count: 10,
          potential_edge_count: 100,
          shortlist_members_processed: 40,
          shortlist_complete: false,
          scoring_complete: true,
        },
        error: null,
      },
    ]), 'run-contradictory', 500, 80),
    /completed before its shortlist/
  );
});

test('a completed preparation makes no scoring call', async () => {
  const client = clientWith([]);
  await completeCandidateSnapshot(client, 'run-2', 1043, true);
  assert.equal(client.calls.length, 0);
});

test('candidate scoring rejects stalled or contradictory progress', async () => {
  await assert.rejects(
    completeCandidateSnapshot(clientWith([
      { data: { scored_rows: 0, remaining_rows: 600, complete: false }, error: null },
    ]), 'run-3', 600, false),
    /did not make progress/
  );
  await assert.rejects(
    completeCandidateSnapshot(clientWith([
      { data: { scored_rows: 500, remaining_rows: 100, complete: true }, error: null },
    ]), 'run-4', 600, false),
    /completion marker contradicted/
  );
  await assert.rejects(
    completeCandidateSnapshot(clientWith([
      { data: { scored_rows: 501, remaining_rows: 99, complete: false }, error: null },
    ]), 'run-5', 600, false),
    /exceeded its bounded batch size/
  );
});

test('candidate scoring rejects malformed counts and server errors', async () => {
  await assert.rejects(
    completeCandidateSnapshot(clientWith([
      { data: null, error: { message: 'database unavailable' } },
    ]), 'run-6', 1, false),
    /database unavailable/
  );
  assert.throws(
    () => parseCountPayload({ count: 1.5 }, ['count']),
    /count is invalid/
  );
  assert.throws(
    () => parseBooleanMarker({ complete: 'yes' }, 'complete'),
    /complete is invalid/
  );
});
