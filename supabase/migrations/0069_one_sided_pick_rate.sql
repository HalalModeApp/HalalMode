-- How often a member's own picks go unreturned.
--
-- Some members reach almost exclusively for people who will not reach back.
-- Round after round they choose, nothing comes of it, and nothing in the
-- experience tells them why — because it must not. This is the only signal that
-- distinguishes a set that could produce a match from one that reliably will
-- not, and it exists so a few of the most lopsided introductions can be traded
-- for more even ones.
--
-- It is not a judgement about anybody and is never surfaced. It is bounded in
-- effect: `max_reach_edges` is never zero, so nobody is prevented from aiming
-- high, only from spending every slot doing it.
--
-- And it forgets. Picks made before a member last changed their profile are
-- excluded, so someone who adds better photos or rewrites their bio is measured
-- on what they do next rather than held to what last month implied. Without
-- that this would compound into precisely the ranking the product refuses to
-- keep.

-- The signature gains a column, and PostgreSQL will not change a function's
-- return type in place. Nothing in SQL calls this — only the round function
-- does, over the wire — so dropping it first is safe.
drop function if exists halal_mode_private.matching_member_signals();

create function halal_mode_private.matching_member_signals()
returns table (
  user_id uuid,
  gender gender,
  tier membership_tier,
  times_shown integer,
  times_kept integer,
  rounds_since_last_mutual integer,
  rounds_since_last_served integer,
  exposures_in_window integer,
  introductions_per_round integer,
  one_sided_pick_rate numeric
)
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  with cfg as (
    select coalesce((halal_mode_private.active_matching_config() ->> 'exposure_window_rounds')::int, 7)
      as window_rounds
  )
  select
    pool.id,
    pool.gender,
    pool.tier,
    pool.qualified_exposures::int,
    pool.times_picked_by_others::int,
    pool.rounds_since_last_mutual::int,
    pool.rounds_since_last_served::int,
    (
      select count(*)::int
      from public.introductions i
      join public.rounds r on r.id = i.round_id
      where i.viewer_id = pool.id
        and r.opens_at > now() - make_interval(days => (select window_rounds from cfg))
    ),
    pool.introductions_per_round::int,
    (
      -- Keeps made since the profile last changed, and how many were returned.
      -- No history reads as zero, meaning no bias — a member who has never
      -- picked anyone has demonstrated nothing, and the composition pass should
      -- leave them entirely alone.
      select case
        when count(*) = 0 then 0::numeric
        else round(
          1 - (count(*) filter (
            where exists (
              select 1 from public.introduction_selections back
              where back.viewer_id = mine.subject_id
                and back.subject_id = mine.viewer_id
                and back.decision = 'kept'
            )
          ))::numeric / count(*),
          4
        )
      end
      from public.introduction_selections mine
      join public.profiles p on p.id = pool.id
      where mine.viewer_id = pool.id
        and mine.decision = 'kept'
        and mine.decided_at >= coalesce(p.updated_at, '-infinity'::timestamptz)
    )
  from halal_mode_private.matching_pool pool;
$$;

revoke all on function halal_mode_private.matching_member_signals()
  from public, anon, authenticated;
grant execute on function halal_mode_private.matching_member_signals() to service_role;
