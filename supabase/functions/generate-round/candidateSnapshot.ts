const CANDIDATE_SCORE_BATCH_SIZE = 500;
const SHORTLIST_MEMBER_BATCH_SIZE = 40;

interface RpcError {
  message: string;
}

export interface MatchingSnapshotRpcClient {
  rpc(
    name: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export function parseCountPayload<T extends readonly string[]>(
  payload: unknown,
  keys: T
): { [K in T[number]]: number } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Matching count payload is invalid');
  }
  const record = payload as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const key of keys) {
    const parsed = typeof record[key] === 'number' ? record[key] : Number(record[key]);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`Matching count ${key} is invalid`);
    }
    result[key] = parsed;
  }
  return result as { [K in T[number]]: number };
}

export function parseBooleanMarker(payload: unknown, key: string): boolean {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)[key]
    : undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Matching marker ${key} is invalid`);
  }
  return value;
}

export interface CandidateSnapshotMetrics {
  candidate_edge_count: number;
  potential_edge_count: number;
  scoring_complete: boolean;
}

/** Advances the two directional top-forty sets in bounded member batches. */
export async function prepareCandidateSnapshot(
  client: MatchingSnapshotRpcClient,
  runId: string,
  failLimit: number,
  poolMemberCount: number
): Promise<CandidateSnapshotMetrics> {
  let processed = -1;
  let potentialCount: number | null = null;
  const maxCalls = Math.ceil(poolMemberCount / SHORTLIST_MEMBER_BATCH_SIZE) + 1;

  for (let call = 0; call < maxCalls; call += 1) {
    const prepared = await client.rpc('matching_candidate_snapshot_prepare_service', {
      p_run_id: runId,
      p_fail_limit: failLimit,
    });
    if (prepared.error) throw new Error(prepared.error.message);
    const counts = parseCountPayload(prepared.data, [
      'candidate_edge_count',
      'potential_edge_count',
      'shortlist_members_processed',
    ] as const);
    const shortlistComplete = parseBooleanMarker(prepared.data, 'shortlist_complete');
    const scoringComplete = parseBooleanMarker(prepared.data, 'scoring_complete');

    if (potentialCount !== null && counts.potential_edge_count !== potentialCount) {
      throw new Error('Candidate preparation changed its frozen potential count');
    }
    potentialCount = counts.potential_edge_count;
    if (counts.shortlist_members_processed > poolMemberCount) {
      throw new Error('Candidate preparation processed more members than the run froze');
    }
    if (scoringComplete && !shortlistComplete) {
      throw new Error('Candidate scoring completed before its shortlist');
    }
    if (shortlistComplete) {
      if (counts.shortlist_members_processed !== poolMemberCount) {
        throw new Error('Completed shortlist contradicted its frozen member count');
      }
      return {
        candidate_edge_count: counts.candidate_edge_count,
        potential_edge_count: counts.potential_edge_count,
        scoring_complete: scoringComplete,
      };
    }
    if (counts.shortlist_members_processed <= processed) {
      throw new Error('Candidate preparation did not make progress');
    }
    processed = counts.shortlist_members_processed;
  }
  throw new Error('Candidate preparation exceeded its bounded call count');
}

/** Completes one frozen shortlist in bounded, idempotent transactions. */
export async function completeCandidateSnapshot(
  client: MatchingSnapshotRpcClient,
  runId: string,
  candidateCount: number,
  initiallyComplete: boolean
) {
  if (initiallyComplete) return;
  if (candidateCount === 0) {
    throw new Error('An empty candidate shortlist was not marked complete');
  }

  let remaining = candidateCount;
  const maxCalls = Math.ceil(candidateCount / CANDIDATE_SCORE_BATCH_SIZE) + 1;
  for (let call = 0; call < maxCalls; call += 1) {
    const scored = await client.rpc('matching_candidate_snapshot_score_batch_service', {
      p_run_id: runId,
      p_batch_size: CANDIDATE_SCORE_BATCH_SIZE,
    });
    if (scored.error) throw new Error(scored.error.message);
    const counts = parseCountPayload(
      scored.data,
      ['scored_rows', 'remaining_rows'] as const
    );
    const complete = parseBooleanMarker(scored.data, 'complete');
    if (counts.remaining_rows > remaining) {
      throw new Error('Candidate scoring increased the remaining row count');
    }
    if (counts.scored_rows > CANDIDATE_SCORE_BATCH_SIZE) {
      throw new Error('Candidate scoring exceeded its bounded batch size');
    }
    if (complete !== (counts.remaining_rows === 0)) {
      throw new Error('Candidate scoring completion marker contradicted its row count');
    }
    if (complete) return;
    if (counts.scored_rows === 0 || counts.remaining_rows >= remaining) {
      throw new Error('Candidate scoring did not make progress');
    }
    remaining = counts.remaining_rows;
  }
  throw new Error('Candidate scoring exceeded its bounded call count');
}
