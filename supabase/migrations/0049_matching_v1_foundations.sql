-- Reciprocal matching v1 — foundations.
--
-- Instrumentation and configuration land before any change to how members are
-- paired, so the effect of every later step is measurable against a recorded
-- baseline rather than argued from memory.
--
-- Nothing here alters the live pairing path. See docs/RECIPROCAL_MATCHING_V1_DESIGN.md.

-- ---------------------------------------------------------------------------
-- Versioned configuration
--
-- Every formula weight, threshold, ceiling and cooldown lives in one reviewed
-- row rather than scattered through SQL and TypeScript. A tuning change is then
-- an inserted config version, not a migration, and each matching run records
-- the version it ran under.
-- ---------------------------------------------------------------------------

create table if not exists halal_mode_private.matching_config (
  version      integer primary key,
  params       jsonb not null,
  notes        text not null default '',
  created_at   timestamptz not null default now(),
  activated_at timestamptz,
  check (jsonb_typeof(params) = 'object')
);

comment on table halal_mode_private.matching_config is
  'Server-only reviewed matching parameters. Never exposed to members. One active row at a time, selected by the highest activated version.';

insert into halal_mode_private.matching_config (version, params, notes, activated_at)
values (
  1,
  jsonb_build_object(
    -- Estimation ---------------------------------------------------------
    -- Weights of the behavioural estimate; must sum to 1.
    'w_compat', 0.55,
    'w_appeal', 0.30,
    'w_pair',   0.15,
    -- Qualified appearances at which the behavioural estimate is fully
    -- trusted. Below this the estimate blends back toward stated
    -- compatibility so newcomers start neutral rather than penalised.
    'exposure_full_confidence', 15,
    -- Probability clamp; keeps a single direction from zeroing the geometric
    -- mean outright.
    'p_min', 0.02,
    'p_max', 0.98,

    -- Reciprocal score ---------------------------------------------------
    -- 'geometric' is the documented default. Kept configurable so an
    -- alternative can be trialled without a code change.
    'reciprocal_combiner', 'geometric',
    -- Extra penalty for lopsided pairs. The geometric mean already punishes
    -- imbalance, so this ships disabled and is raised only if simulation
    -- shows lopsided pairs still surfacing.
    'imbalance_lambda', 0.00,
    -- No edge is allocated below this score, whatever the exposure need.
    'min_reciprocal_score', 0.15,

    -- Fairness -----------------------------------------------------------
    -- Bounded so fairness can reorder comparable edges but never promote a
    -- weak edge past a strong one.
    'exposure_boost_weight', 0.30,
    'no_match_boost_weight', 0.20,
    'boost_cap', 0.25,
    -- Fair share is a member's own tier entitlement, pro rata through the
    -- window. One flat number cannot serve both tiers: set to the free
    -- allowance it throttles premium below what they pay for; set to the
    -- premium allowance it throttles nobody.
    'exposure_target_multiplier', 1.0,
    'exposure_window_rounds', 7,
    'no_match_rounds_full', 8,

    -- Repeat exposure ----------------------------------------------------
    -- A pair that was not picked is situational, not a refusal. It may return
    -- after a cooldown, with its score decayed each time.
    'repeat_decay', 0.70,
    'repeat_cooldown_days', 14,
    'max_pair_appearances', 3,
    -- Stop resurfacing once the reciprocal estimate has fallen this far from
    -- its first appearance.
    'repeat_abandon_drop', 0.35,

    -- Allocation ---------------------------------------------------------
    'repair_time_budget_ms', 2000,
    'allocator', 'greedy_global_v1',

    -- Performance guards --------------------------------------------------
    'warn_round_latency_ms', 30000,
    'fail_round_latency_ms', 120000,
    'warn_edges_after_filter', 2000000,
    'fail_edges_after_filter', 8000000,
    'warn_peak_memory_bytes', 268435456,
    'fail_peak_memory_bytes', 536870912,

    -- Metrics --------------------------------------------------------------
    -- Segment breakdowns below this many members are recorded but not acted on.
    'min_segment_sample', 30
  ),
  'Initial reviewed configuration for reciprocal matching v1.',
  now()
);

revoke all on table halal_mode_private.matching_config from public, anon, authenticated;

create or replace function halal_mode_private.active_matching_config()
returns jsonb
language sql
stable
security definer
set search_path = halal_mode_private, public as $$
  select params
  from halal_mode_private.matching_config
  where activated_at is not null
  order by version desc
  limit 1;
$$;

create or replace function halal_mode_private.active_matching_config_version()
returns integer
language sql
stable
security definer
set search_path = halal_mode_private, public as $$
  select version
  from halal_mode_private.matching_config
  where activated_at is not null
  order by version desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Run versioning and performance monitoring
-- ---------------------------------------------------------------------------

create table if not exists halal_mode_private.matching_runs (
  id                 uuid primary key default gen_random_uuid(),
  algorithm_version  text not null,
  config_version     integer not null references halal_mode_private.matching_config(version),
  -- Recorded so a run can be replayed exactly. Every tie-break derives from it.
  seed               bigint not null,
  -- A shadow run computes a full round and writes it to shadow_round_edges
  -- only. It never touches introductions, matches, markers or cooldowns.
  mode               text not null default 'live' check (mode in ('live', 'shadow')),
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  eligible_members   integer,
  edges_after_filter integer,
  pairs_created      integer,
  rounds_created     integer,
  -- Milliseconds per named stage, e.g. {"prefilter": 612, "estimate": 98}.
  stage_latencies    jsonb not null default '{}'::jsonb,
  peak_memory_bytes  bigint,
  -- Populated when a configured warning or failure threshold was crossed.
  threshold_breaches jsonb not null default '[]'::jsonb,
  error              text,
  check (jsonb_typeof(stage_latencies) = 'object'),
  check (jsonb_typeof(threshold_breaches) = 'array')
);

create index if not exists matching_runs_started_idx
  on halal_mode_private.matching_runs (started_at desc);

comment on table halal_mode_private.matching_runs is
  'One row per matching run, live or shadow. Carries the algorithm version, config version and seed needed to reproduce it, plus per-stage timings.';

revoke all on table halal_mode_private.matching_runs from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Shadow output
--
-- Deliberately a separate table from `introductions`. Keeping proposed edges
-- physically apart makes "shadow mode has no side effects" something that can
-- be verified by looking at where the writes go, rather than trusted.
-- ---------------------------------------------------------------------------

create table if not exists halal_mode_private.shadow_round_edges (
  run_id            uuid not null references halal_mode_private.matching_runs(id) on delete cascade,
  viewer_id         uuid not null references public.profiles(id) on delete cascade,
  subject_id        uuid not null references public.profiles(id) on delete cascade,
  reciprocal_score  numeric(6,5) not null,
  adjusted_utility  numeric(7,5) not null,
  primary key (run_id, viewer_id, subject_id),
  check (viewer_id <> subject_id)
);

revoke all on table halal_mode_private.shadow_round_edges from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Pair-level exposure
--
-- No existing table records how often a specific pair has been shown, or holds
-- a cooldown. `introductions` can be scanned for the first, but cannot express
-- "not before this date" and grows without bound.
--
-- The pair is stored in a fixed low/high order so one row serves both
-- directions — exposure is a property of the pair, not of a viewer.
-- ---------------------------------------------------------------------------

create table if not exists halal_mode_private.pair_exposure (
  user_low              uuid not null references public.profiles(id) on delete cascade,
  user_high             uuid not null references public.profiles(id) on delete cascade,
  times_shown           integer not null default 0,
  first_reciprocal_score numeric(6,5),
  last_reciprocal_score  numeric(6,5),
  last_shown_at         timestamptz,
  last_round_id         uuid,
  cooldown_until        timestamptz,
  -- Set when the pair should stop resurfacing: the repeat limit was reached,
  -- or the reciprocal estimate kept falling across appearances.
  retired_at            timestamptz,
  retired_reason        text,
  primary key (user_low, user_high),
  check (user_low < user_high)
);

create index if not exists pair_exposure_cooldown_idx
  on halal_mode_private.pair_exposure (cooldown_until)
  where retired_at is null;

comment on table halal_mode_private.pair_exposure is
  'Per-pair exposure, cooldown and decay state. Not visible to members; a member can never learn that a specific pair was shown to them before.';

revoke all on table halal_mode_private.pair_exposure from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- match_health — a view, not a table
--
-- Every field the brief lists is already stored somewhere. Copying them into a
-- second table would create two sources of truth for the same fact and let them
-- drift. This reads them in one place instead.
-- ---------------------------------------------------------------------------

create or replace view halal_mode_private.match_health as
with last_mutual as (
  select p.id as user_id,
         max(c.created_at) as last_mutual_at
  from public.profiles p
  left join public.connections c
    on (c.user_a = p.id or c.user_b = p.id)
  group by p.id
)
select
  p.id as user_id,
  -- Qualified exposures received and times chosen already live on the private
  -- selection-score row.
  coalesce(s.times_shown, 0) as qualified_exposures,
  coalesce(s.times_kept, 0)  as times_picked_by_others,
  -- Keeps this member made that never became mutual.
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
  -- Submitted rounds since the most recent mutual match. Zero for a member who
  -- has never matched and never completed a round.
  (
    select count(*)
    from public.rounds r
    where r.user_id = p.id
      and r.submitted_at is not null
      and r.submitted_at > coalesce(lm.last_mutual_at, '-infinity'::timestamptz)
  ) as rounds_since_last_mutual,
  lm.last_mutual_at,
  p.updated_at as profile_changed_at,
  -- Confidence ramps linearly to 1 at the configured exposure threshold.
  least(
    1.0,
    coalesce(s.times_shown, 0)::numeric
      / greatest(1, (halal_mode_private.active_matching_config() ->> 'exposure_full_confidence')::numeric)
  ) as model_confidence
from public.profiles p
left join public.selection_scores s on s.user_id = p.id
left join last_mutual lm on lm.user_id = p.id;

comment on view halal_mode_private.match_health is
  'Private per-member matching signals, derived rather than duplicated. Never exposed to any client role.';

revoke all on halal_mode_private.match_health from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Set-context learning — also a view
--
-- Who was shown together, who was picked, the set size and tier, and whether
-- the pick became mutual are all already recorded across rounds, introductions
-- and selections. This assembles them for analysis without a second write path.
-- ---------------------------------------------------------------------------

create or replace view halal_mode_private.round_set_events as
select
  r.id            as round_id,
  r.user_id       as viewer_id,
  r.tier          as viewer_tier,
  r.opens_at,
  r.submitted_at,
  count(i.id)                                          as set_size,
  array_agg(i.subject_id order by i.subject_id)        as shown_subject_ids,
  array_remove(array_agg(
    case when sel.decision = 'kept' then i.subject_id end
    order by i.subject_id
  ), null)                                             as picked_subject_ids,
  array_remove(array_agg(
    case when c.id is not null then i.subject_id end
    order by i.subject_id
  ), null)                                             as mutual_subject_ids
from public.rounds r
join public.introductions i
  on i.round_id = r.id and i.viewer_id = r.user_id
left join public.introduction_selections sel
  on sel.introduction_id = i.id
left join public.connections c
  on c.user_a = least(r.user_id, i.subject_id)
 and c.user_b = greatest(r.user_id, i.subject_id)
group by r.id, r.user_id, r.tier, r.opens_at, r.submitted_at;

comment on view halal_mode_private.round_set_events is
  'Set context per round: who was shown together, who was picked, and which picks became mutual. Feeds offline analysis; no member-facing surface reads it.';

revoke all on halal_mode_private.round_set_events from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Cohort control reuses the existing release-flag mechanism, which already
-- supports explicit membership and deterministic percentage rollout.
-- ---------------------------------------------------------------------------

insert into halal_mode_private.release_flags (key, enabled, rollout_percentage)
values ('reciprocal_matching_v1', false, 0)
on conflict (key) do nothing;

revoke all on function halal_mode_private.active_matching_config() from public, anon, authenticated;
revoke all on function halal_mode_private.active_matching_config_version() from public, anon, authenticated;
