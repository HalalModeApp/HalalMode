/** Creates the daily introduction round at the planned Madinah Fajr time. */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import { resolveStoredConfig, type MatchingConfig } from '../../../src/matching/config.ts';
import {
  ALGORITHM_VERSION,
  liveFinalizationArgs,
  planRound,
  shadowFinalizationArgs,
  type CandidateEdgeRow,
  type MemberSignalRow,
} from './matching.ts';
import {
  matchingPlanContext,
  matchingSeedForCycleDate,
  isExplicitDatabaseRollback,
  parseMatchingRunContext,
  shouldRetryExactFinalization,
  shouldRetryMatchingRun,
  shouldReleaseCycleClaim,
} from './runContext.ts';

const MADINAH_TIME_ZONE = 'Asia/Riyadh';

class MatchingRunError extends Error {
  constructor(
    message: string,
    readonly preserveCycleClaim: boolean,
    readonly retryCause: unknown = null
  ) {
    super(message);
    this.name = 'MatchingRunError';
  }
}

class MatchingFinalizationRpcError extends Error {
  constructor(readonly rpcError: unknown) {
    super(
      rpcError && typeof rpcError === 'object'
        ? String((rpcError as Record<string, unknown>)['message'] ?? 'Matching finalization failed')
        : 'Matching finalization failed'
    );
    this.name = 'MatchingFinalizationRpcError';
  }
}

async function finalizeWithExactRetry<T>(
  request: () => PromiseLike<{ data: T; error: unknown }>
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await request();
      if (!result.error) return result.data;
      if (shouldRetryExactFinalization(result.error, attempt)) continue;
      throw new MatchingFinalizationRpcError(result.error);
    } catch (error) {
      if (error instanceof MatchingFinalizationRpcError) throw error;
      if (shouldRetryExactFinalization(error, attempt)) continue;
      throw new MatchingFinalizationRpcError(error);
    }
  }
  throw new MatchingFinalizationRpcError(new TypeError('Finalization transport failed twice'));
}

function madinahParts(date = new Date()) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: MADINAH_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => values.find((part) => part.type === type)?.value ?? '';
  return { date: `${read('year')}-${read('month')}-${read('day')}`, hour: Number(read('hour')), minute: Number(read('minute')) };
}

async function fajrForMadinahDate(cycleDate: string) {
  const response = await fetch(
    `https://api.aladhan.com/v1/timingsByCity/${cycleDate}?city=Medina&country=Saudi%20Arabia&method=4`
  );
  if (!response.ok) throw new Error('Could not retrieve Madinah prayer times');
  const payload = await response.json() as { data?: { timings?: { Fajr?: string } } };
  const pieces = (payload.data?.timings?.Fajr ?? '').match(/\d{1,2}/g)?.map(Number) ?? [];
  const hour = pieces[0];
  const minute = pieces[1];
  if (hour === undefined || minute === undefined) throw new Error('Madinah Fajr time was unavailable');
  return { hour, minute };
}

async function madinahFajrWindow(now = new Date()) {
  const current = madinahParts(now);
  const { hour, minute } = await fajrForMadinahDate(current.date);
  const currentMinutes = current.hour * 60 + current.minute;
  const fajrMinutes = hour * 60 + minute;
  return {
    cycleDate: current.date,
    startsAt: madinahInstant(current.date, hour, minute).toISOString(),
    due: currentMinutes >= fajrMinutes && currentMinutes < fajrMinutes + 15,
  };
}

function nextMadinahDate(cycleDate: string) {
  const tomorrow = new Date(`${cycleDate}T00:00:00+03:00`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return madinahParts(tomorrow).date;
}

function madinahInstant(cycleDate: string, hour: number, minute: number) {
  return new Date(`${cycleDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+03:00`);
}

async function planTomorrowFajr(now = new Date()) {
  const today = madinahParts(now).date;
  const cycleDate = nextMadinahDate(today);
  const { hour, minute } = await fajrForMadinahDate(cycleDate);
  // fajrForMadinahDate validates the upstream response and parsed time.
  // Madinah is permanently UTC+3. pg_cron schedules in UTC on Supabase.
  return {
    cycleDate,
    schedule: `${minute} ${(hour + 21) % 24} * * *`,
    startsAt: madinahInstant(cycleDate, hour, minute).toISOString(),
  };
}

/**
 * Runs the v1 pipeline.
 *
 * A shadow run computes the identical round and writes it to
 * `shadow_round_edges` only. Its finalizer has no outcomes, expiry or
 * retirement parameter, so it cannot create introductions, matches,
 * notifications, limits, cooldowns or durable retirement state.
 */
async function runMatchingV1Attempt(
  client: SupabaseClient,
  mode: 'live' | 'shadow',
  cycleDate: string,
  evaluatedAt: string,
  expiresAt: string | null
) {
  const config = await client.rpc('matching_run_config');
  if (config.error || !config.data || typeof config.data !== 'object' || Array.isArray(config.data)) {
    throw new Error(`Matching configuration unavailable: ${config.error?.message ?? 'invalid payload'}`);
  }
  const payload = { ...(config.data as Record<string, unknown>) };
  const configVersion = Number(payload['__version']);
  delete payload['__version'];
  if (!Number.isInteger(configVersion) || configVersion < 1) {
    throw new Error('Matching configuration version is invalid');
  }
  const params: MatchingConfig = resolveStoredConfig(payload);

  // The seed only breaks ties. Fairness-window position comes from the
  // database-bound Asia/Riyadh run context below, never from seed arithmetic.
  const seed = matchingSeedForCycleDate(cycleDate);

  const run = await client.rpc('matching_run_start_service', {
    p_algorithm_version: ALGORITHM_VERSION,
    p_config_version: configVersion,
    p_seed: seed,
    p_mode: mode,
    p_cycle_date: cycleDate,
    p_evaluated_at: evaluatedAt,
  });
  if (run.error) throw new Error(run.error.message);
  const runContext = parseMatchingRunContext(run.data, cycleDate);
  if (runContext.seed !== seed) {
    throw new Error('Matching run context returned the wrong seed');
  }
  if (Date.parse(runContext.evaluatedAt) !== Date.parse(evaluatedAt)) {
    throw new Error('Matching run context returned the wrong canonical cycle instant');
  }
  const runId = runContext.runId;
  let finalizationAttempted = false;

  try {
    const started = Date.now();
    const snapshot = await client.rpc('matching_candidate_snapshot_prepare_service', {
      p_run_id: runId,
      p_fail_limit: params.fail_edges_after_filter,
    });
    if (snapshot.error) throw new Error(snapshot.error.message);
    const snapshotMetrics = parseCountPayload(snapshot.data, [
      'candidate_edge_count',
      'potential_edge_count',
    ]);
    const [edgeRows, members] = await Promise.all([
      fetchCandidateEdges(client, runId, snapshotMetrics.candidate_edge_count),
      client.rpc('matching_member_signals_service', { p_run_id: runId }),
    ]);
    if (members.error) throw new Error(members.error.message);
    const memberRows = (members.data ?? []) as MemberSignalRow[];
    if (memberRows.length !== runContext.poolMemberCount) {
      throw new Error('Matching member snapshot count changed inside one run');
    }
    const fetchMs = Date.now() - started;

    const plan = planRound(
      edgeRows,
      memberRows,
      params,
      matchingPlanContext(runContext),
      () => Date.now(),
      { fetch: fetchMs }
    );

    let finalized;
    if (mode === 'live') {
      if (!expiresAt) throw new Error('A live matching run requires an expiry');
      finalizationAttempted = true;
      const persisted = await finalizeWithExactRetry(() => client.rpc(
        'matching_live_finalize_service',
        liveFinalizationArgs(runId, plan, expiresAt)
      ));
      finalized = parseFinalizationResult(persisted);
    } else {
      finalizationAttempted = true;
      const shadow = await finalizeWithExactRetry(() => client.rpc(
        'matching_shadow_finalize_service',
        shadowFinalizationArgs(runId, plan)
      ));
      finalized = parseFinalizationResult(shadow);
    }

    if (finalized.pairs_created !== plan.edges.length
        || finalized.rounds_created !== plan.memberOutcomes.filter((item) => item.outcome === 'served').length
        || finalized.eligible_members !== runContext.poolMemberCount
        || finalized.edges_after_filter !== snapshotMetrics.candidate_edge_count) {
      throw new Error('Matching finalizer metrics contradicted the immutable run snapshot');
    }

    return {
      runId,
      mode,
      pairsCreated: finalized.pairs_created,
      deferred: plan.deferredMembers,
      breaches: plan.thresholdBreaches,
      idempotent: finalized.idempotent,
    };
  } catch (error) {
    try {
      await client.rpc('matching_run_finish', {
        p_run_id: runId,
        p_eligible_members: null,
        p_edges_after_filter: null,
        p_pairs_created: null,
        p_rounds_created: null,
        p_stage_latencies: {},
        p_peak_memory_bytes: null,
        p_threshold_breaches: [],
        p_error: String(error),
      });
    } catch {
      // Preserve the original failure classification even if recording it is
      // impossible; this is critical after an ambiguous finalization attempt.
    }
    const rpcError = error instanceof MatchingFinalizationRpcError ? error.rpcError : null;
    const explicitRollback = isExplicitDatabaseRollback(rpcError);
    throw new MatchingRunError(
      String(error),
      mode === 'live' && !shouldReleaseCycleClaim(finalizationAttempted, explicitRollback),
      rpcError
    );
  }
}

async function runMatchingV1(
  client: SupabaseClient,
  mode: 'live' | 'shadow',
  cycleDate: string,
  evaluatedAt: string,
  expiresAt: string | null
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await runMatchingV1Attempt(client, mode, cycleDate, evaluatedAt, expiresAt);
    } catch (error) {
      if (mode === 'live'
          && error instanceof MatchingRunError
          && shouldRetryMatchingRun(error.retryCause, attempt)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('Matching retry loop exhausted unexpectedly');
}

async function fetchCandidateEdges(
  client: SupabaseClient,
  runId: string,
  expectedCount: number
): Promise<CandidateEdgeRow[]> {
  const pageSize = 1000;
  const rows: CandidateEdgeRow[] = [];
  let afterLow: string | null = null;
  let afterHigh: string | null = null;

  while (rows.length < expectedCount) {
    const page = await client.rpc('matching_candidate_edges_service', {
      p_run_id: runId,
      p_after_low: afterLow,
      p_after_high: afterHigh,
      p_page_size: pageSize,
    });
    if (page.error) throw new Error(page.error.message);
    const batch = (page.data ?? []) as CandidateEdgeRow[];
    rows.push(...batch);
    if (rows.length > expectedCount) {
      throw new Error('Candidate snapshot returned more rows than it recorded');
    }
    if (batch.length === 0) {
      throw new Error('Candidate snapshot ended before its recorded count');
    }
    if (batch.length < pageSize && rows.length !== expectedCount) {
      throw new Error('Candidate snapshot page count contradicted its recorded count');
    }
    const last = batch[batch.length - 1];
    if (!last || (last.user_low === afterLow && last.user_high === afterHigh)) {
      throw new Error('Candidate pagination did not advance');
    }
    afterLow = last.user_low;
    afterHigh = last.user_high;
  }
  return rows;
}

function parseCountPayload<T extends readonly string[]>(
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

interface FinalizationResult {
  pairs_created: number;
  rounds_created: number;
  eligible_members: number;
  edges_after_filter: number;
  idempotent: boolean;
}

function parseFinalizationResult(payload: unknown): FinalizationResult {
  const counts = parseCountPayload(payload, [
    'pairs_created',
    'rounds_created',
    'eligible_members',
    'edges_after_filter',
  ] as const);
  const idempotent = (payload as Record<string, unknown>)['idempotent'];
  if (typeof idempotent !== 'boolean') {
    throw new Error('Matching finalizer idempotent marker is invalid');
  }
  return { ...counts, idempotent };
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  const suppliedSecret = request.headers.get('x-cron-secret') ?? '';
  const verified = await client.rpc('verify_round_scheduler_secret', {
    p_secret: suppliedSecret,
  });
  if (verified.error || verified.data !== true) {
    return new Response('Forbidden', { status: 403 });
  }
  const requestedMode = new URL(request.url).searchParams.get('mode');

  // Shadow runs are on demand and deliberately outside the Fajr window check:
  // they touch nothing a member can see, so they can be run whenever a change
  // needs comparing against live.
  if (requestedMode === 'shadow') {
    try {
      const requestedCycle = new URL(request.url).searchParams.get('cycleDate');
      const cycleDate = requestedCycle ?? madinahParts().date;
      const fajr = await fajrForMadinahDate(cycleDate);
      const evaluatedAt = madinahInstant(cycleDate, fajr.hour, fajr.minute).toISOString();
      const result = await runMatchingV1(client, 'shadow', cycleDate, evaluatedAt, null);
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  }

  if (requestedMode === 'plan') {
    const plan = await planTomorrowFajr();
    const result = await client.rpc('set_madinah_fajr_cron', { p_schedule: plan.schedule });
    if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
    return Response.json({ plannedFor: plan.cycleDate, scheduleUtc: plan.schedule });
  }
  const timing = await madinahFajrWindow();
  if (!timing.due) {
    return Response.json({ skipped: 'Outside the Madinah Fajr window', cycleDate: timing.cycleDate });
  }

  // A second cron attempt or retry cannot generate another daily cycle.
  const cycle = await client.from('round_generation_runs').insert({ cycle_date: timing.cycleDate });
  if (cycle.error?.code === '23505') {
    return Response.json({ skipped: 'Madinah Fajr cycle already ran', cycleDate: timing.cycleDate });
  }
  if (cycle.error) return Response.json({ error: cycle.error.message }, { status: 500 });

  // Keep the round live until the next daily Madinah Fajr reset.
  const nextFajr = await planTomorrowFajr();
  const expiresAt = nextFajr.startsAt;
  const expired = await client.rpc('expire_stale_rounds');
  if (expired.error) {
    await client.from('round_generation_runs').delete().eq('cycle_date', timing.cycleDate);
    return Response.json({ error: expired.error.message }, { status: 500 });
  }

  // Before the config is read, so a version the tuner inserts cannot appear
  // between that read and the run start — which the run start would reject for
  // not using the active version. Deliberately not fatal: adjusting weights is
  // an improvement to tomorrow, and failing it must not cost anyone their round.
  const tuned = await client.rpc('tune_matching_weights_service');
  if (tuned.error) {
    console.error('weight tuning skipped:', tuned.error.message);
  }

  // A pass holds for a few months and then stops holding. Without this the
  // cooldown would be a number in a config table that nothing ever read, and
  // every pass would be permanent — which is the behaviour it replaced.
  // Idempotent, and must run before candidates are built so a pass that expired
  // overnight is available to today's round.
  const passes = await client.rpc('expire_explicit_passes_service');
  if (passes.error) {
    await client.from('round_generation_runs').delete().eq('cycle_date', timing.cycleDate);
    return Response.json({ error: passes.error.message }, { status: 500 });
  }
  // The v1 pipeline is behind a release flag so the cohort can be widened
  // deliberately. Until it is enabled the previous generator still runs.
  const flag = await client.rpc('release_flag_active', { p_key: 'reciprocal_matching_v1' });
  const useV1 = !flag.error && flag.data === true;

  try {
    if (useV1) {
      const result = await runMatchingV1(
        client,
        'live',
        timing.cycleDate,
        timing.startsAt,
        expiresAt
      );
      return Response.json({
        expiredSelections: expired.data,
        pairsCreated: result.pairsCreated,
        deferredMembers: result.deferred,
        thresholdBreaches: result.breaches,
        algorithm: ALGORITHM_VERSION,
        expiresAt,
        cycleDate: timing.cycleDate,
      });
    }

    const generated = await client.rpc('generate_round_for_pairs', { p_expires_at: expiresAt });
    if (generated.error) throw new Error(generated.error.message);
    return Response.json({ expiredSelections: expired.data, pairsCreated: generated.data, expiresAt, cycleDate: timing.cycleDate });
  } catch (error) {
    if (!(error instanceof MatchingRunError) || !error.preserveCycleClaim) {
      await client.from('round_generation_runs').delete().eq('cycle_date', timing.cycleDate);
    }
    return Response.json({ error: String(error) }, { status: 500 });
  }
});
