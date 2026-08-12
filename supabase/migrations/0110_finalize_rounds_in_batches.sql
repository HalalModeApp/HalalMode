-- Write a round in batches instead of one enormous transaction.
--
-- Finalization sends the whole round as a single call: validate everything,
-- write everything, mark it done. At the sizes tested that is about three
-- seconds of actual work, and it is correct. It is also the wrong shape, and
-- it fails in two ways that both get worse with growth.
--
-- The gateway between the scheduler and the code gives up at 125 seconds. That
-- ceiling is not ours to raise, so any round large enough to take longer can
-- never complete, however fast the code is.
--
-- And a single transaction holds its locks for its whole life. When one is
-- killed part-way — which is exactly what happened here once the pg_net
-- timeout cut a run off mid-write — it leaves the run row locked behind it,
-- and every later run queues behind a predecessor that is never coming back.
-- Each failure manufactures the next one.
--
-- Batching fixes both by construction rather than by being quick enough.
-- Every batch is its own short transaction that commits and releases. Nothing
-- is held across the network. A failure costs one batch, and because each
-- batch is idempotent, a retry re-sends it safely.
--
-- Three steps: open declares what is coming, batch writes a chunk, close
-- checks that what arrived matches what was declared. A run that is opened and
-- never closed is visibly incomplete rather than silently half-written — the
-- count is checked before anything is marked finished.

alter table halal_mode_private.matching_runs
  add column if not exists expected_pairs integer,
  add column if not exists finalize_opened_at timestamptz;

create or replace function public.matching_shadow_open_service(
  p_run_id uuid,
  p_expected_pairs integer
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private
set lock_timeout = '15s'
as $$
declare
  v_run halal_mode_private.matching_runs%rowtype;
  v_already integer;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Shadow finalization requires service role' using errcode = '42501';
  end if;
  if p_run_id is null or p_expected_pairs is null or p_expected_pairs < 0 then
    raise exception 'A run and a non-negative expected pair count are required'
      using errcode = '22023';
  end if;

  select * into v_run from halal_mode_private.matching_runs where id = p_run_id for update;
  if v_run.id is null or v_run.mode <> 'shadow' or v_run.candidate_snapshot_prepared_at is null then
    raise exception 'A snapshot-capable shadow run is required' using errcode = '22023';
  end if;
  if v_run.finished_at is not null then
    raise exception 'That run is already finished' using errcode = '22023';
  end if;

  -- Reopening with the same count is a retry and is allowed. Reopening with a
  -- different count would mean a different calculation wearing the same run id.
  if v_run.expected_pairs is not null and v_run.expected_pairs <> p_expected_pairs then
    raise exception 'That run was opened for % pairs, not %',
      v_run.expected_pairs, p_expected_pairs using errcode = '22023';
  end if;

  update halal_mode_private.matching_runs
  set expected_pairs = p_expected_pairs,
      finalize_opened_at = coalesce(finalize_opened_at, now())
  where id = p_run_id;

  select count(*)::integer into v_already
  from halal_mode_private.shadow_round_edges where run_id = p_run_id;

  -- Told plainly so a resumed run can skip what already landed.
  return jsonb_build_object('expected_pairs', p_expected_pairs, 'edges_written', v_already);
end;
$$;

create or replace function public.matching_shadow_batch_service(
  p_run_id uuid,
  p_edges jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private
set lock_timeout = '15s'
as $$
declare
  v_run halal_mode_private.matching_runs%rowtype;
  v_written integer;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Shadow finalization requires service role' using errcode = '42501';
  end if;
  if p_run_id is null or jsonb_typeof(p_edges) is distinct from 'array' then
    raise exception 'A run and an edge array are required' using errcode = '22023';
  end if;

  select * into v_run from halal_mode_private.matching_runs where id = p_run_id;
  if v_run.id is null or v_run.mode <> 'shadow' then
    raise exception 'A shadow run is required' using errcode = '22023';
  end if;
  if v_run.finalize_opened_at is null then
    raise exception 'Finalization must be opened before batches are sent' using errcode = '22023';
  end if;
  if v_run.finished_at is not null then
    raise exception 'That run is already finished' using errcode = '22023';
  end if;

  -- Safety state is checked per batch, against the state at the moment the
  -- batch lands. A block or withdrawn consent that arrives mid-round vetoes
  -- the batch carrying that pair rather than the whole round.
  perform halal_mode_private.validate_frozen_matching_edges(p_run_id, p_edges, now());

  insert into halal_mode_private.shadow_round_edges (
    run_id, viewer_id, subject_id, reciprocal_score, adjusted_utility
  )
  select p_run_id, (e ->> 'a')::uuid, (e ->> 'b')::uuid,
         (e ->> 'score')::numeric, (e ->> 'utility')::numeric
  from jsonb_array_elements(p_edges) e
  union all
  select p_run_id, (e ->> 'b')::uuid, (e ->> 'a')::uuid,
         (e ->> 'score')::numeric, (e ->> 'utility')::numeric
  from jsonb_array_elements(p_edges) e
  on conflict (run_id, viewer_id, subject_id) do nothing;

  select count(*)::integer into v_written
  from halal_mode_private.shadow_round_edges where run_id = p_run_id;

  return jsonb_build_object('edges_written', v_written);
end;
$$;

create or replace function public.matching_shadow_close_service(
  p_run_id uuid,
  p_stage_latencies jsonb,
  p_peak_memory_bytes bigint,
  p_threshold_breaches jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, halal_mode_private
set lock_timeout = '15s'
as $$
declare
  v_run halal_mode_private.matching_runs%rowtype;
  v_pairs integer;
  v_rounds integer;
  v_eligible integer;
  v_edges_after_filter integer;
  v_result jsonb;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Shadow finalization requires service role' using errcode = '42501';
  end if;
  if not halal_mode_private.matching_diagnostics_are_valid(p_stage_latencies, p_threshold_breaches)
     or p_peak_memory_bytes is null or p_peak_memory_bytes < 0 then
    raise exception 'Valid finalization diagnostics are required' using errcode = '22023';
  end if;

  select * into v_run from halal_mode_private.matching_runs where id = p_run_id for update;
  if v_run.id is null or v_run.mode <> 'shadow' then
    raise exception 'A shadow run is required' using errcode = '22023';
  end if;
  if v_run.finished_at is not null then
    return coalesce(v_run.finalization_result, '{}'::jsonb) || jsonb_build_object('idempotent', true);
  end if;
  if v_run.finalize_opened_at is null then
    raise exception 'That run was never opened for finalization' using errcode = '22023';
  end if;

  select (count(*) / 2)::integer into v_pairs
  from halal_mode_private.shadow_round_edges where run_id = p_run_id;

  -- The whole point of declaring the count up front. A run that lost a batch
  -- is refused here rather than recorded as a complete round that quietly
  -- introduced fewer people than it planned to.
  if v_pairs is distinct from v_run.expected_pairs then
    raise exception 'Finalization is incomplete: % of % pairs arrived',
      v_pairs, v_run.expected_pairs using errcode = '40001';
  end if;

  select count(distinct viewer_id)::integer into v_rounds
  from halal_mode_private.shadow_round_edges where run_id = p_run_id;
  select count(*)::integer into v_eligible
  from halal_mode_private.matching_run_member_snapshots where run_id = p_run_id;
  select count(*)::integer into v_edges_after_filter
  from halal_mode_private.matching_run_candidate_snapshots where run_id = p_run_id;

  v_result := jsonb_build_object(
    'pairs_created', v_pairs,
    'rounds_created', v_rounds,
    'eligible_members', v_eligible,
    'edges_after_filter', v_edges_after_filter
  );

  update halal_mode_private.matching_runs
  set finished_at = now(),
      eligible_members = v_eligible,
      edges_after_filter = v_edges_after_filter,
      pairs_created = v_pairs,
      rounds_created = v_rounds,
      stage_latencies = p_stage_latencies,
      peak_memory_bytes = p_peak_memory_bytes,
      threshold_breaches = p_threshold_breaches,
      error = null,
      finalization_result = v_result
  where id = p_run_id;

  return v_result || jsonb_build_object('idempotent', false);
end;
$$;

revoke all on function public.matching_shadow_open_service(uuid, integer) from public, anon, authenticated;
revoke all on function public.matching_shadow_batch_service(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.matching_shadow_close_service(uuid, jsonb, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.matching_shadow_open_service(uuid, integer) to service_role;
grant execute on function public.matching_shadow_batch_service(uuid, jsonb) to service_role;
grant execute on function public.matching_shadow_close_service(uuid, jsonb, bigint, jsonb) to service_role;
