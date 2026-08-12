-- See what a matching run actually saw.
--
-- The shadow endpoint answers with pairs created and little else, so a run that
-- produced nothing is indistinguishable from a run that had nothing to work
-- with. Comparing v1 against the live matcher before enabling it needs the
-- counts either side of the filtering: how many members were in the pool, how
-- many pairings were possible, and how many survived.
--
-- Read-only, service role, and no member identifiers — counts and timings only.

create or replace function public.recent_matching_runs_service(p_limit integer default 5)
returns table (
  id uuid,
  mode text,
  cycle_date date,
  pool_member_count integer,
  eligible_members integer,
  potential_edge_count bigint,
  candidate_edge_count bigint,
  edges_after_filter integer,
  pairs_created integer,
  threshold_breaches jsonb,
  error text,
  started_at timestamptz
)
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  select r.id, r.mode, r.cycle_date, r.pool_member_count, r.eligible_members,
         r.potential_edge_count, r.candidate_edge_count, r.edges_after_filter,
         r.pairs_created, r.threshold_breaches, r.error, r.started_at
  from halal_mode_private.matching_runs r
  order by r.started_at desc
  limit greatest(1, least(p_limit, 50));
$$;

revoke all on function public.recent_matching_runs_service(integer) from public, anon, authenticated;
grant execute on function public.recent_matching_runs_service(integer) to service_role;
