/** Creates the daily introduction round at the planned Madinah Fajr time. */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import { resolveStoredConfig, type MatchingConfig } from '../../../src/matching/config.ts';
import {
  ALGORITHM_VERSION,
  planRound,
  type CandidateEdgeRow,
  type MemberSignalRow,
} from './matching.ts';

const MADINAH_TIME_ZONE = 'Asia/Riyadh';

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
  return { cycleDate: current.date, due: currentMinutes >= fajrMinutes && currentMinutes < fajrMinutes + 15 };
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
 * `shadow_round_edges` only. It never calls `persist_matching_round`, so it
 * cannot create introductions, matches, notifications, limits or cooldowns —
 * the isolation is structural rather than a flag checked in several places.
 */
async function runMatchingV1(
  client: SupabaseClient,
  mode: 'live' | 'shadow',
  expiresAt: string
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

  // Seeded from the cycle so a run is reproducible, and so a shadow run and the
  // live run it shadows make identical choices.
  const seed = Math.floor(Date.now() / 86_400_000);

  const run = await client.rpc('matching_run_start', {
    p_algorithm_version: ALGORITHM_VERSION,
    p_config_version: configVersion,
    p_seed: seed,
    p_mode: mode,
  });
  if (run.error) throw new Error(run.error.message);
  const runId = run.data as string;

  try {
    const started = Date.now();
    const [edgeRows, members] = await Promise.all([
      fetchCandidateEdges(client, params.fail_edges_after_filter),
      client.rpc('matching_member_signals_service'),
    ]);
    if (members.error) throw new Error(members.error.message);
    const fetchMs = Date.now() - started;

    const roundsElapsed =
      (seed % Number(params['exposure_window_rounds'] ?? 7)) + 1;

    const plan = planRound(
      edgeRows,
      (members.data ?? []) as MemberSignalRow[],
      params,
      seed,
      roundsElapsed,
      () => Date.now(),
      { fetch: fetchMs }
    );

    let pairsCreated = 0;
    if (mode === 'live') {
      const persisted = await client.rpc('persist_matching_round_service', {
        p_run_id: runId,
        p_edges: plan.edges,
        p_outcomes: plan.memberOutcomes,
        p_expires_at: expiresAt,
      });
      if (persisted.error) throw new Error(persisted.error.message);
      pairsCreated = persisted.data as number;
    } else {
      const shadow = await client.rpc('matching_shadow_round_service', {
        p_run_id: runId,
        p_edges: plan.edges,
      });
      if (shadow.error) throw new Error(shadow.error.message);
      pairsCreated = shadow.data as number;
    }

    const finished = await client.rpc('matching_run_finish', {
      p_run_id: runId,
      p_eligible_members: plan.eligibleMembers,
      p_edges_after_filter: plan.edgesAfterFilter,
      p_pairs_created: pairsCreated,
      p_rounds_created: plan.memberOutcomes.filter((item) => item.outcome === 'served').length,
      p_stage_latencies: plan.stageLatencies,
      p_peak_memory_bytes: plan.peakMemoryBytes,
      p_threshold_breaches: plan.thresholdBreaches,
      p_error: null,
    });
    if (finished.error) throw new Error(finished.error.message);

    return { runId, mode, pairsCreated, deferred: plan.deferredMembers, breaches: plan.thresholdBreaches };
  } catch (error) {
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
    throw error;
  }
}

async function fetchCandidateEdges(
  client: SupabaseClient,
  failEdgeCount: number
): Promise<CandidateEdgeRow[]> {
  const pageSize = 1000;
  const rows: CandidateEdgeRow[] = [];
  let afterLow: string | null = null;
  let afterHigh: string | null = null;

  while (true) {
    const page = await client.rpc('matching_candidate_edges_service', {
      p_after_low: afterLow,
      p_after_high: afterHigh,
      p_page_size: pageSize,
    });
    if (page.error) throw new Error(page.error.message);
    const batch = (page.data ?? []) as CandidateEdgeRow[];
    rows.push(...batch);
    if (rows.length >= failEdgeCount) {
      throw new Error(`Candidate graph reached fail limit (${failEdgeCount})`);
    }
    if (batch.length < pageSize) return rows;
    const last = batch[batch.length - 1];
    if (!last || (last.user_low === afterLow && last.user_high === afterHigh)) {
      throw new Error('Candidate pagination did not advance');
    }
    afterLow = last.user_low;
    afterHigh = last.user_high;
  }
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
      const nextFajr = await planTomorrowFajr();
      const result = await runMatchingV1(client, 'shadow', nextFajr.startsAt);
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
  // The v1 pipeline is behind a release flag so the cohort can be widened
  // deliberately. Until it is enabled the previous generator still runs.
  const flag = await client.rpc('release_flag_active', { p_key: 'reciprocal_matching_v1' });
  const useV1 = !flag.error && flag.data === true;

  try {
    if (useV1) {
      const result = await runMatchingV1(client, 'live', expiresAt);
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
    await client.from('round_generation_runs').delete().eq('cycle_date', timing.cycleDate);
    return Response.json({ error: String(error) }, { status: 500 });
  }
});
