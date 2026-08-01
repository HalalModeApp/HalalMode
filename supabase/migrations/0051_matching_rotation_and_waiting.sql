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
-- Durable live-run outcomes and rounds since a member was last served.
--
-- Distinct from exposure need, which is windowed and resets. Waiting time only
-- increases, so it can order a rotation queue without a long-deferred member
-- losing their place when the window turns over. The outcome is stored because
-- a deferred member has no public round from which waiting could be derived;
-- aggregate health fields remain a view.
-- ---------------------------------------------------------------------------

create table if not exists halal_mode_private.matching_member_run_outcomes (
  run_id uuid not null references halal_mode_private.matching_runs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  outcome text not null check (outcome in ('served', 'deferred', 'no_candidate')),
  valid_until timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (run_id, user_id)
);

create index if not exists matching_member_outcomes_user_idx
  on halal_mode_private.matching_member_run_outcomes (user_id, created_at desc);

comment on table halal_mode_private.matching_member_run_outcomes is
  'Private per-live-run service outcome. Durable queue evidence; never written by shadow runs or exposed to clients.';

revoke all on halal_mode_private.matching_member_run_outcomes
  from public, anon, authenticated;

create or replace view halal_mode_private.match_health as
with last_mutual as (
  select p.id as user_id,
         max(c.created_at) as last_mutual_at
  from public.profiles p
  left join public.connections c
    on (c.user_a = p.id or c.user_b = p.id)
  group by p.id
),
live_outcomes as (
  select o.user_id, o.outcome, r.started_at as run_started_at
  from halal_mode_private.matching_member_run_outcomes o
  join halal_mode_private.matching_runs r on r.id = o.run_id
  where r.mode = 'live'
),
last_served as (
  select user_id, max(run_started_at) as last_served_at
  from live_outcomes
  where outcome = 'served'
  group by user_id
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
  lm.last_mutual_at,
  p.updated_at as profile_changed_at,
  least(
    1.0,
    coalesce(s.times_shown, 0)::numeric
      / greatest(1, (halal_mode_private.active_matching_config() ->> 'exposure_full_confidence')::numeric)
  ) as model_confidence,
  -- CREATE OR REPLACE VIEW requires every existing column to retain its
  -- position, name and type. New waiting fields are therefore append-only.
  -- Deferred and no-candidate outcomes both age the queue; shadow runs cannot.
  (
    select count(*)
    from live_outcomes o
    where o.user_id = p.id
      and o.run_started_at > coalesce(ls.last_served_at, '-infinity'::timestamptz)
  ) as rounds_since_last_served,
  ls.last_served_at
from public.profiles p
left join public.selection_scores s on s.user_id = p.id
left join last_mutual lm on lm.user_id = p.id
left join last_served ls on ls.user_id = p.id;

comment on view halal_mode_private.match_health is
  'Private per-member matching signals, derived rather than duplicated. Never exposed to any client role.';

revoke all on halal_mode_private.match_health from public, anon, authenticated;
