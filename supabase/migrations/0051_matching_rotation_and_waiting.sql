-- Serving rotation for imbalanced pools.
--
-- Reciprocity forces both sides to consume the same number of introductions, so
-- when one side has surplus capacity its members cannot all receive full sets.
-- Rather than let a greedy allocator concentrate those sets on whoever scores
-- highest, each round serves a cohort ordered by who has waited longest.
--
-- Simulation decided the shape. Serving fewer members with full sets is worse
-- than it looks: a free member keeps one person per round however many they are
-- shown, so selection opportunities scale with rounds served, not set size.
-- Full-set rotation halved rounds served and pushed the share of members who
-- never matched from 42% to 54%. Capping served sets at three instead beats
-- both alternatives on set size and on match outcomes at once.
--
-- This is configuration, not a code path: `rotation_min_set_size` can be tuned
-- as the real ratio moves, in either direction, without a deploy.

-- ---------------------------------------------------------------------------
-- Rounds since a member last received any introductions.
--
-- Distinct from exposure need, which is windowed and resets. Waiting time only
-- increases, so it can order a rotation queue without a long-deferred member
-- losing their place when the window turns over. Derived, not stored.
-- ---------------------------------------------------------------------------

create or replace view halal_mode_private.match_health as
with last_mutual as (
  select p.id as user_id,
         max(c.created_at) as last_mutual_at
  from public.profiles p
  left join public.connections c
    on (c.user_a = p.id or c.user_b = p.id)
  group by p.id
),
last_served as (
  select r.user_id, max(r.opens_at) as last_served_at
  from public.rounds r
  where exists (
    select 1 from public.introductions i
    where i.round_id = r.id and i.viewer_id = r.user_id
  )
  group by r.user_id
)
select
  p.id as user_id,
  coalesce(s.times_shown, 0) as qualified_exposures,
  coalesce(s.times_kept, 0)  as times_picked_by_others,
  (
    select count(*)
    from public.introduction_selections sel
    where sel.viewer_id = p.id
      and sel.decision = 'kept'
      and not exists (
        select 1 from public.introduction_selections back
        where back.viewer_id = sel.subject_id
          and back.subject_id = sel.viewer_id
          and back.decision = 'kept'
      )
  ) as one_sided_picks_made,
  (
    select count(*)
    from public.connections c
    where c.closed_at is null and (c.user_a = p.id or c.user_b = p.id)
  ) as active_match_count,
  (
    select count(*)
    from public.rounds r
    where r.user_id = p.id
      and r.submitted_at is not null
      and r.submitted_at > coalesce(lm.last_mutual_at, '-infinity'::timestamptz)
  ) as rounds_since_last_mutual,
  -- Rounds opened for this member since the last one that actually contained
  -- introductions. Zero for a member served in their most recent round.
  (
    select count(*)
    from public.rounds r
    where r.user_id = p.id
      and r.opens_at > coalesce(ls.last_served_at, '-infinity'::timestamptz)
  ) as rounds_since_last_served,
  lm.last_mutual_at,
  ls.last_served_at,
  p.updated_at as profile_changed_at,
  least(
    1.0,
    coalesce(s.times_shown, 0)::numeric
      / greatest(1, (halal_mode_private.active_matching_config() ->> 'exposure_full_confidence')::numeric)
  ) as model_confidence
from public.profiles p
left join public.selection_scores s on s.user_id = p.id
left join last_mutual lm on lm.user_id = p.id
left join last_served ls on ls.user_id = p.id;

comment on view halal_mode_private.match_health is
  'Private per-member matching signals, derived rather than duplicated. Never exposed to any client role.';

revoke all on halal_mode_private.match_health from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Configuration version 2 — adds the rotation parameters.
--
-- Uses the versioning mechanism rather than editing version 1 in place, so the
-- change is auditable and every run records which version produced it.
-- ---------------------------------------------------------------------------

insert into halal_mode_private.matching_config (version, params, notes, activated_at)
select
  2,
  params
    || jsonb_build_object(
      -- Whether an imbalanced pool serves a rotating cohort instead of
      -- spreading thin. Gender-agnostic: the constrained side is whichever has
      -- surplus capacity that round, so the same code serves a pool with more
      -- men today and more women later.
      'rotation_enabled', true,
      -- Smallest set worth showing. Above this, mild imbalance is absorbed by
      -- everyone getting a slightly smaller set; below it members are deferred
      -- so those served still have a real choice. Three measured best on both
      -- set size and match outcomes; two produced more matches but sets too
      -- thin to choose from.
      'rotation_min_set_size', 3
    ),
  'Adds serving rotation for imbalanced pools.',
  now()
from halal_mode_private.matching_config
where version = 1;
