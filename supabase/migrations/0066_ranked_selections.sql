-- Rank the selections, so a first choice is knowable.
--
-- Mutual first choice is the metric this work is ultimately judged against:
-- how often the person someone most wants, most wants them back. It is
-- rank-blind by construction — a quiet widower and a much-sought-after
-- twenty-four-year-old can both score perfectly on it, independently — which is
-- why it beats any count of total matches.
--
-- Free members already answer it for free: they keep exactly one of five, so
-- their pick *is* their first choice. Premium members keep up to three, and
-- `submit_round_selections` took an unordered uuid[], so their actual first
-- choice was never recorded. The metric was therefore measurable for most of
-- the membership and blind for the rest.
--
-- The array order now carries the rank. A free member's single keep is rank 1
-- by definition; a Premium member is asked which of their three comes first.

alter table public.introduction_selections
  add column if not exists rank smallint check (rank is null or rank between 1 and 3);

comment on column public.introduction_selections.rank is
  'Order of preference among this round''s keeps: 1 is the first choice. Null for released, passed and expired rows. Never disclosed to the other member — knowing you were someone''s third choice is exactly the comparison this product refuses to surface.';

-- One first choice per round, and no ties anywhere in the order.
create unique index if not exists introduction_selections_rank_idx
  on public.introduction_selections (viewer_id, rank)
  where rank is not null and decision = 'kept';

/**
 * Records the ranked keeps for a round.
 *
 * Ordering is taken from the array rather than a separate argument, so the
 * caller cannot submit a rank that disagrees with the selection it belongs to.
 *
 * Called from inside the existing submission transaction, after the selection
 * rows exist. Kept separate from `submit_round_selections` so that function's
 * reviewed capacity and mutual-detection logic is not restated to add a column.
 */
create or replace function halal_mode_private.record_selection_ranks(
  p_viewer uuid,
  p_round_id uuid,
  p_ordered_ids uuid[]
) returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_ids uuid[] := coalesce(p_ordered_ids, '{}'::uuid[]);
begin
  if array_length(v_ids, 1) is null then return; end if;

  update introduction_selections s
  set rank = ordered.position
  from (
    select id, ordinality::smallint as position
    from unnest(v_ids) with ordinality as t(id, ordinality)
  ) ordered
  where s.introduction_id = ordered.id
    and s.viewer_id = p_viewer
    and s.decision = 'kept'
    and exists (
      select 1 from introductions i
      where i.id = s.introduction_id and i.round_id = p_round_id
    );
end;
$$;

revoke all on function halal_mode_private.record_selection_ranks(uuid, uuid, uuid[])
  from public, anon, authenticated;

/**
 * Mutual first choice.
 *
 * True only when each named the other as rank 1. Two members who both kept each
 * other third are a match, and a good one — but they are not this.
 *
 * A view rather than a stored flag: it is derived from rows that already exist,
 * and a second copy could disagree with them.
 */
create or replace view halal_mode_private.mutual_first_choices as
select
  least(mine.viewer_id, mine.subject_id)    as user_low,
  greatest(mine.viewer_id, mine.subject_id) as user_high,
  greatest(mine.decided_at, theirs.decided_at) as matched_at
from public.introduction_selections mine
join public.introduction_selections theirs
  on theirs.viewer_id = mine.subject_id
 and theirs.subject_id = mine.viewer_id
where mine.decision = 'kept' and mine.rank = 1
  and theirs.decision = 'kept' and theirs.rank = 1
  and mine.viewer_id < mine.subject_id;

comment on view halal_mode_private.mutual_first_choices is
  'Pairs who each ranked the other first. The primary measure of whether matching is working; never exposed to any client role.';

revoke all on halal_mode_private.mutual_first_choices from public, anon, authenticated;

/**
 * Outcome rates for a window, for offline review.
 *
 * Deliberately aggregate. Per-member detail is available to the matcher and to
 * nobody else, and a metric surface is exactly the place a private score leaks
 * by accident.
 */
create or replace function halal_mode_private.matching_outcome_metrics(
  p_since timestamptz default now() - interval '30 days'
) returns jsonb
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  select jsonb_build_object(
    'since', p_since,
    'rounds_submitted', (
      select count(*) from public.rounds where submitted_at >= p_since
    ),
    'keeps', (
      select count(*) from public.introduction_selections
      where decision = 'kept' and decided_at >= p_since
    ),
    'first_choices_made', (
      select count(*) from public.introduction_selections
      where decision = 'kept' and rank = 1 and decided_at >= p_since
    ),
    'mutual_first_choices', (
      select count(*) from halal_mode_private.mutual_first_choices
      where matched_at >= p_since
    ),
    'connections_created', (
      select count(*) from public.connections where created_at >= p_since
    ),
    'contact_exchanged', (
      select count(*) from public.connections
      where contact_shared_at is not null and contact_shared_at >= p_since
    )
  );
$$;

revoke all on function halal_mode_private.matching_outcome_metrics(timestamptz)
  from public, anon, authenticated;
grant execute on function halal_mode_private.matching_outcome_metrics(timestamptz)
  to service_role;

/**
 * Submission that also records the order.
 *
 * Wraps the reviewed function rather than restating it. `submit_round_selections`
 * carries the capacity accounting, advisory locking and mutual detection, all of
 * which have their own database tests; copying that here to add one column would
 * mean two versions of the most safety-critical function in the schema.
 *
 * A single RPC is one transaction, so the ranks land with the selections or not
 * at all.
 */
create or replace function public.submit_round_selections_ranked(
  p_round_id uuid,
  p_ordered_introduction_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_ids uuid[] := coalesce(p_ordered_introduction_ids, '{}'::uuid[]);
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  -- The set semantics and every limit are unchanged; only the order is new.
  v_result := public.submit_round_selections(p_round_id, v_ids);
  perform halal_mode_private.record_selection_ranks(auth.uid(), p_round_id, v_ids);
  return v_result;
end;
$$;

revoke all on function public.submit_round_selections_ranked(uuid, uuid[]) from public, anon;
grant execute on function public.submit_round_selections_ranked(uuid, uuid[]) to authenticated;
