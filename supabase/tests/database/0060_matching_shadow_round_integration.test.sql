begin;
set local search_path = public, extensions;
select plan(14);

-- Eight members are large enough to exercise paging, mixed tiers, reciprocal
-- international preferences, safety history and repeat-pair history without
-- turning a contract test into a load test.
insert into auth.users (id, email)
select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       'shadow-integration-' || n || '@example.test'
from generate_series(6001, 6008) n;

insert into profiles (
  id, name, first_name, birth_date, gender, city, country, latitude, longitude,
  bio, photos, languages_spoken, tier, onboarding_complete
)
select
  ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  'Shadow ' || n, 'Shadow',
  date '1988-01-01' + ((n - 6001) * interval '1 year'),
  case when n <= 6004 then 'male'::gender else 'female'::gender end,
  case when n = 6008 then 'Lima' else 'Madinah' end,
  case when n = 6008 then 'Peru' else 'Saudi Arabia' end,
  case when n = 6008 then -12.0464 else 24.4672 + ((n - 6001)::numeric / 10000) end,
  case when n = 6008 then -77.0428 else 39.6024 end,
  repeat(chr(97 + (n - 6001)), 50),
  array['shadow-' || n || '.jpg'],
  case when n % 2 = 0 then array['Arabic', 'English'] else array['Arabic'] end,
  case when n in (6001, 6004, 6006, 6008) then 'premium'::membership_tier else 'free'::membership_tier end,
  true
from generate_series(6001, 6008) n;

insert into private_preferences (
  user_id, min_age, max_age, preferred_countries, max_distance_km,
  matching_preferences_completed_at
)
select
  ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  18, 50,
  case when n = 6004 then array['Saudi Arabia'] else '{}'::text[] end,
  100,
  now()
from generate_series(6001, 6008) n;

insert into selection_scores (user_id, score, band, times_shown, times_kept)
select
  ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  (0.45 + ((n - 6001)::numeric / 100))::numeric(5,4),
  3,
  (n - 5998),
  greatest(0, n - 6002)
from generate_series(6001, 6008) n;

insert into halal_mode_private.member_legal_consent_history (
  user_id, document_type, version, acceptance_context
)
select member.id, document.document_type, document.version, 'onboarding'
from (
  select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid as id
  from generate_series(6001, 6008) n
) member
cross join halal_mode_private.legal_document_registry document
where document.is_current;

-- A submitted historic round gives M2 a deliberate permanent pass on F2.
insert into rounds (id, user_id, tier, opens_at, expires_at, submitted_at) values
  ('00000000-0000-0000-0000-000000006021', '00000000-0000-0000-0000-000000006002', 'free',
   '2026-07-20 05:00+03', '2026-07-21 05:00+03', '2026-07-20 06:00+03'),
  ('00000000-0000-0000-0000-000000006022', '00000000-0000-0000-0000-000000006001', 'premium',
   '2026-07-31 05:00+03', '2026-08-01 05:00+03', '2026-07-31 06:00+03');
insert into introductions (id, round_id, viewer_id, subject_id) values
  ('00000000-0000-0000-0000-000000006031', '00000000-0000-0000-0000-000000006021',
   '00000000-0000-0000-0000-000000006002', '00000000-0000-0000-0000-000000006006'),
  ('00000000-0000-0000-0000-000000006032', '00000000-0000-0000-0000-000000006022',
   '00000000-0000-0000-0000-000000006001', '00000000-0000-0000-0000-000000006006');
insert into introduction_selections (introduction_id, viewer_id, subject_id, decision) values
  ('00000000-0000-0000-0000-000000006031',
   '00000000-0000-0000-0000-000000006002', '00000000-0000-0000-0000-000000006006',
   'explicit_pass');

insert into blocks (blocker_id, blocked_id) values
  ('00000000-0000-0000-0000-000000006001', '00000000-0000-0000-0000-000000006005');
insert into halal_mode_private.pair_exposure (
  user_low, user_high, times_shown, first_reciprocal_score,
  last_reciprocal_score, cooldown_until
) values
  ('00000000-0000-0000-0000-000000006003', '00000000-0000-0000-0000-000000006007', 1, 0.72, 0.70, now() + interval '1 day'),
  ('00000000-0000-0000-0000-000000006001', '00000000-0000-0000-0000-000000006007', 1, 0.82, 0.80, null);

create function pg_temp.relation_fingerprint(p_relation regclass)
returns text
language plpgsql
as $$
declare
  v_hash text;
begin
  execute format(
    'select md5(coalesce(string_agg(row_json, E''\\n'' order by row_json), ''''))
       from (select to_jsonb(t)::text as row_json from %s t) rows',
    p_relation
  ) into v_hash;
  return v_hash;
end;
$$;

create temporary table shadow_live_before (
  relation_name regclass primary key,
  fingerprint text not null
) on commit drop;
insert into shadow_live_before (relation_name, fingerprint)
select relation_name, pg_temp.relation_fingerprint(relation_name)
from (values
  ('public.profiles'::regclass),
  ('public.private_preferences'::regclass),
  ('public.selection_scores'::regclass),
  ('public.rounds'::regclass),
  ('public.introductions'::regclass),
  ('public.introduction_selections'::regclass),
  ('public.connections'::regclass),
  ('public.blocks'::regclass),
  ('halal_mode_private.pair_exposure'::regclass),
  ('halal_mode_private.matching_member_run_outcomes'::regclass),
  ('halal_mode_private.matching_run_rounds'::regclass),
  ('halal_mode_private.notification_devices'::regclass)
) live(relation_name);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table shadow_context as
select public.matching_run_start_service(
  'shadow-integration-v1', halal_mode_private.active_matching_config_version(),
  6001, 'shadow', '2026-08-01', '2026-08-01 05:00+03'
) as value;

select ok(
  (select (value ->> 'pool_member_count')::integer = 8
          and value ->> 'cycle_date' = '2026-08-01'
          and value ->> 'time_zone' = 'Asia/Riyadh'
          and (value ->> 'evaluated_at')::timestamptz = '2026-08-01 05:00+03'::timestamptz
   from shadow_context),
  'shadow start freezes all eight members and the canonical Riyadh cycle context'
);

create temporary table shadow_preparation as
select public.matching_candidate_snapshot_prepare_service(
  (select (value ->> 'run_id')::uuid from shadow_context), 1000
) as value;
select ok(
  (select (value ->> 'potential_edge_count')::integer = 16
          and (value ->> 'candidate_edge_count')::integer = 12
   from shadow_preparation),
  'candidate preparation records sixteen potential and twelve eligible edges'
);

create temporary table shadow_candidates as
select 1::integer as page, candidate.*
from public.matching_candidate_edges_service(
  (select (value ->> 'run_id')::uuid from shadow_context), null, null, 5
) candidate;
insert into shadow_candidates
select 2, candidate.*
from (
  select user_low, user_high from shadow_candidates
  order by user_low desc, user_high desc limit 1
) cursor
cross join lateral public.matching_candidate_edges_service(
  (select (value ->> 'run_id')::uuid from shadow_context),
  cursor.user_low, cursor.user_high, 5
) candidate;
insert into shadow_candidates
select 3, candidate.*
from (
  select user_low, user_high from shadow_candidates
  order by user_low desc, user_high desc limit 1
) cursor
cross join lateral public.matching_candidate_edges_service(
  (select (value ->> 'run_id')::uuid from shadow_context),
  cursor.user_low, cursor.user_high, 5
) candidate;

select ok(
  (select array_agg(count order by page) = array[5::bigint, 5::bigint, 2::bigint]
   from (select page, count(*) from shadow_candidates group by page) pages)
  and (select count(*) = count(distinct (user_low, user_high)) from shadow_candidates),
  'cursor paging returns five, five and two distinct candidates without gaps'
);
select ok(
  not exists (
    select 1 from shadow_candidates where (user_low, user_high) in (
      ('00000000-0000-0000-0000-000000006001', '00000000-0000-0000-0000-000000006005'),
      ('00000000-0000-0000-0000-000000006002', '00000000-0000-0000-0000-000000006006'),
      ('00000000-0000-0000-0000-000000006003', '00000000-0000-0000-0000-000000006007'),
      ('00000000-0000-0000-0000-000000006004', '00000000-0000-0000-0000-000000006008')
    )
  ),
  'country refusal, block, explicit pass and active cooldown each remove their pair'
);
select ok(
  exists (
    select 1 from shadow_candidates
    where user_low = '00000000-0000-0000-0000-000000006001'
      and user_high = '00000000-0000-0000-0000-000000006008'
  ),
  'reciprocal international openness keeps an allowed Saudi-Peru pair'
);
select ok(
  exists (
    select 1 from shadow_candidates
    where user_low = '00000000-0000-0000-0000-000000006001'
      and user_high = '00000000-0000-0000-0000-000000006007'
      and pair_times_shown = 1 and pair_first_score = 0.82
  ),
  'an allowed repeat pair carries its frozen private exposure history'
);

create temporary table shadow_signals as
select * from public.matching_member_signals_service(
  (select (value ->> 'run_id')::uuid from shadow_context)
);
select is((select count(*)::integer from shadow_signals), 8,
  'member signals return every frozen pool member');
select ok(
  exists (
    select 1 from shadow_signals
    where user_id = '00000000-0000-0000-0000-000000006001'
      and tier = 'premium' and times_shown = 3 and times_kept = 0
      and exposures_in_window = 1 and introductions_per_round = 10
  )
  and exists (
    select 1 from shadow_signals
    where user_id = '00000000-0000-0000-0000-000000006002'
      and tier = 'free' and introductions_per_round = 5
  ),
  'signals preserve behavioral history, window exposure and tier limits'
);

create temporary table shadow_payload as
select jsonb_agg(jsonb_build_object(
  'a', user_low, 'b', user_high, 'score', 0.75, 'utility', 0.75
) order by user_low, user_high) as edges
from shadow_candidates
where (user_low, user_high) in (
  ('00000000-0000-0000-0000-000000006001', '00000000-0000-0000-0000-000000006008'),
  ('00000000-0000-0000-0000-000000006002', '00000000-0000-0000-0000-000000006005'),
  ('00000000-0000-0000-0000-000000006004', '00000000-0000-0000-0000-000000006006')
);
select ok(
  (select jsonb_array_length(edges) = 3 from shadow_payload)
  and not exists (
    select 1 from jsonb_to_recordset((select edges from shadow_payload))
      as edge(a uuid, b uuid, score numeric, utility numeric)
    where not exists (
      select 1 from shadow_candidates candidate
      where candidate.user_low = edge.a and candidate.user_high = edge.b
    )
  ),
  'the realistic three-pair shadow plan uses only frozen candidates'
);

create temporary table shadow_result as
select public.matching_shadow_finalize_service(
  (select (value ->> 'run_id')::uuid from shadow_context),
  (select edges from shadow_payload),
  '{"fetch":12,"rotation":1,"estimate":2,"allocate":3}'::jsonb,
  65536,
  '[]'::jsonb
) as value;
select ok(
  (select value @> '{"pairs_created":3,"rounds_created":6,"eligible_members":8,"edges_after_filter":12,"idempotent":false}'::jsonb
   from shadow_result),
  'shadow finalization returns counts derived from the frozen run and written evidence'
);
select is(
  (select count(*)::integer
   from halal_mode_private.shadow_round_edges edge
   where edge.run_id = (select (value ->> 'run_id')::uuid from shadow_context)
     and exists (
       select 1 from halal_mode_private.shadow_round_edges reverse
       where reverse.run_id = edge.run_id
         and reverse.viewer_id = edge.subject_id
         and reverse.subject_id = edge.viewer_id
         and reverse.reciprocal_score = edge.reciprocal_score
         and reverse.adjusted_utility = edge.adjusted_utility
     )),
  6,
  'all six directed shadow rows have an identical reverse twin'
);
select ok(
  exists (
    select 1 from halal_mode_private.matching_runs run
    where run.id = (select (value ->> 'run_id')::uuid from shadow_context)
      and run.finished_at is not null and run.error is null
      and run.stage_latencies = '{"fetch":12,"rotation":1,"estimate":2,"allocate":3}'::jsonb
      and run.peak_memory_bytes = 65536 and run.threshold_breaches = '[]'::jsonb
      and run.eligible_members = 8 and run.edges_after_filter = 12
      and run.pairs_created = 3 and run.rounds_created = 6
      and run.finalization_hash is not null
  ),
  'the private run record stores complete diagnostics and authoritative counts'
);
select ok(
  (select count(*) = 1 from halal_mode_private.matching_runs)
  and (select count(*) = 8 from halal_mode_private.matching_run_member_snapshots)
  and (select count(*) = 12 from halal_mode_private.matching_run_candidate_snapshots)
  and (select count(*) = 6 from halal_mode_private.shadow_round_edges)
  and (select count(*) = 0 from halal_mode_private.matching_run_rounds)
  and (select count(*) = 0 from halal_mode_private.matching_member_run_outcomes),
  'shadow creates only its run, immutable snapshots and private shadow evidence'
);

create temporary table shadow_retry as
select public.matching_shadow_finalize_service(
  (select (value ->> 'run_id')::uuid from shadow_context),
  (select edges from shadow_payload),
  '{"fetch":12,"rotation":1,"estimate":2,"allocate":3}'::jsonb,
  65536,
  '[]'::jsonb
) as value;
select ok(
  not exists (
    select 1 from shadow_live_before before
    where before.fingerprint <> pg_temp.relation_fingerprint(before.relation_name)
  )
  and (select value ->> 'idempotent' = 'true' from shadow_retry)
  and (select count(*) = 6 from halal_mode_private.shadow_round_edges),
  'shadow and its identical retry leave every live row byte-for-byte unchanged'
);

select * from finish();
rollback;
