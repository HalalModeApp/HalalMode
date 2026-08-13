begin;
set local search_path = public, extensions;
select plan(24);

select ok(
  to_regclass('halal_mode_private.matching_run_candidate_shortlists') is not null
  and to_regclass('halal_mode_private.matching_run_shortlist_progress') is not null,
  'candidate preparation has private staging and retry progress tables'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.matching_candidate_snapshot_score_batch_service(uuid,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.matching_candidate_snapshot_score_batch_service(uuid,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.matching_candidate_snapshot_score_batch_service(uuid,integer)',
    'EXECUTE'
  ),
  'only the service role can advance candidate scoring'
);
select ok(
  not has_table_privilege(
    'service_role',
    'halal_mode_private.matching_run_candidate_shortlists',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'halal_mode_private.matching_run_candidate_shortlists',
    'SELECT'
  )
  and not has_table_privilege(
    'anon',
    'halal_mode_private.matching_run_candidate_shortlists',
    'SELECT'
  ),
  'unscored shortlists are inaccessible outside private definer functions'
);
select ok(
  not (pg_get_functiondef(
    'halal_mode_private.matching_candidate_snapshot_prepare_unclamped(uuid,bigint)'::regprocedure
  ) || pg_get_functiondef(
    'halal_mode_private.matching_shortlist_batch_edges(uuid,uuid[],uuid[],timestamptz,integer)'::regprocedure
  ) || pg_get_functiondef(
    'public.matching_candidate_snapshot_score_batch_service(uuid,integer)'::regprocedure
  )) ~ any(array[
    'compatibility\(', 'matching_pair_is_eligible\(',
    'snapshot_pair_is_plausible\(', 'pair_apartness\(',
    'passes_criteria\(', 'is_must_have\(', 'distance_km\(',
    'scale_proximity\(', 'pg_advisory_xact_lock\('
  ]),
  'candidate preparation and scoring contain no row-at-a-time helper calls or unbounded lock'
);
select ok(
  'statement_timeout=8s' = any(coalesce((
    select proconfig from pg_proc
    where oid = 'public.matching_candidate_snapshot_prepare_service(uuid,bigint)'::regprocedure
  ), '{}'::text[]))
  and 'statement_timeout=8s' = any(coalesce((
    select proconfig from pg_proc
    where oid = 'public.matching_candidate_snapshot_score_batch_service(uuid,integer)'::regprocedure
  ), '{}'::text[])),
  'every PostgREST candidate-building statement remains bounded at eight seconds'
);

insert into auth.users (id, email)
select
  ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  'set-matcher-' || n || '@example.test'
from generate_series(140001, 140006) n;

-- Isolate this fixture from any developer seed data. The pool is a private
-- view over ready profiles, so pausing unrelated rows gives exact expectations
-- without deleting or mutating permanent data outside this rolled-back test.
update profiles
set is_paused = true
where id not between '00000000-0000-0000-0000-000000140001'
                 and '00000000-0000-0000-0000-000000140006';

insert into profiles (
  id, name, first_name, birth_date, gender, city, country, latitude, longitude,
  bio, photos, languages_spoken, religious_practice, timeline, family_goals,
  sect, relocation, onboarding_complete
) values
  ('00000000-0000-0000-0000-000000140001', 'Set M1', 'M1', '1990-01-01', 'male', 'Madinah', 'Saudi Arabia', 24.4672, 39.6024, repeat('a', 50), array['m1.jpg'], array['Arabic','English'], 'very_practicing', 'within_6_months', 'wants_children_soon', 'sunni', 'open', true),
  ('00000000-0000-0000-0000-000000140002', 'Set M2', 'M2', '1989-01-01', 'male', 'Madinah', 'Saudi Arabia', 24.4680, 39.6030, repeat('b', 50), array['m2.jpg'], array['Arabic'], 'practicing', 'within_1_year', 'open_to_children', 'sunni', 'open', true),
  ('00000000-0000-0000-0000-000000140003', 'Set M3', 'M3', '1991-01-01', 'male', 'Madinah', 'Saudi Arabia', 24.4690, 39.6040, repeat('c', 50), array['m3.jpg'], array['English'], 'moderate', 'within_1_year', 'wants_children_later', 'shia', 'preferred_local', true),
  ('00000000-0000-0000-0000-000000140004', 'Set F1', 'F1', '1970-01-01', 'female', 'Jeddah', 'Saudi Arabia', 21.5433, 39.1728, repeat('d', 50), array['f1.jpg'], array['Arabic','English'], 'practicing', 'within_3_months', 'wants_children_soon', 'sunni', 'open', true),
  ('00000000-0000-0000-0000-000000140005', 'Set F2', 'F2', '1992-01-01', 'female', 'Madinah', 'Saudi Arabia', null, null, repeat('e', 50), array['f2.jpg'], array['Arabic'], 'learning', '1_to_2_years', 'no_children', 'prefer_not_to_say', 'open', true),
  ('00000000-0000-0000-0000-000000140006', 'Set F3', 'F3', '1993-01-01', 'female', 'Madinah', 'Saudi Arabia', 24.4678, 39.6028, repeat('f', 50), array['f3.jpg'], array['English'], 'very_practicing', 'within_6_months', 'wants_children_later', 'shia', 'preferred_local', true);

insert into private_preferences (
  user_id, min_age, max_age, min_height_cm, max_height_cm,
  preferred_builds, preferred_countries, max_distance_km,
  preferred_practice, desired_timeline, desired_family_goals,
  preferred_sects, must_have, own_height_cm, own_build,
  matching_preferences_completed_at
) values
  ('00000000-0000-0000-0000-000000140001', 25, 35, 150, 190, array['Athletic'], array['Saudi Arabia'], 100, array['very_practicing']::religious_practice[], array['within_6_months']::marriage_timeline[], array['wants_children_soon']::family_goals[], array['sunni']::sect[], '{}', 180, 'Athletic', now()),
  ('00000000-0000-0000-0000-000000140002', 25, 50, 150, 190, array['Average'], array['Saudi Arabia'], 100, array['practicing']::religious_practice[], array['within_1_year']::marriage_timeline[], array['open_to_children']::family_goals[], array['sunni']::sect[], '{}', 175, 'Average', now()),
  ('00000000-0000-0000-0000-000000140003', 25, 35, 150, 190, array['Slim'], array['Saudi Arabia'], 100, array['moderate']::religious_practice[], array['within_1_year']::marriage_timeline[], array['wants_children_later']::family_goals[], array['shia']::sect[], '{"age":true,"distance":true}', 178, 'Lean', now()),
  ('00000000-0000-0000-0000-000000140004', 18, 70, 150, 200, '{}', array['Saudi Arabia'], 100, '{}', '{}', '{}', '{}', '{}', 165, 'Average', now()),
  ('00000000-0000-0000-0000-000000140005', 18, 70, 150, 200, '{}', array['Saudi Arabia'], 100, '{}', '{}', '{}', '{}', '{}', 168, 'Slim', now()),
  ('00000000-0000-0000-0000-000000140006', 18, 70, 150, 200, '{}', array['Saudi Arabia'], 100, '{}', '{}', '{}', '{}', '{}', 170, 'Athletic', now());

insert into halal_mode_private.member_legal_consent_history (
  user_id, document_type, version, acceptance_context
)
select member.id, document.document_type, document.version, 'onboarding'
from (
  select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid as id
  from generate_series(140001, 140006) n
) member
cross join halal_mode_private.legal_document_registry document
where document.is_current;

insert into halal_mode_private.pair_exposure (
  user_low, user_high, times_shown, first_reciprocal_score,
  last_reciprocal_score, explicit_pass_count, soft_select_count
) values (
  '00000000-0000-0000-0000-000000140001',
  '00000000-0000-0000-0000-000000140006',
  2, 0.82, 0.78, 1, 2
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table set_small_context as
select public.matching_run_start_service(
  'set-contract-v1', halal_mode_private.active_matching_config_version(),
  140001, 'shadow', '2026-08-13', '2026-08-13 05:00+03'
) as value;

create temporary table set_expected_scores as
select
  male.id as user_low,
  female.id as user_high,
  halal_mode_private.compatibility(male.id, female.id) as low_to_high,
  halal_mode_private.compatibility(female.id, male.id) as high_to_low
from profiles male
join profiles female on female.gender = 'female'
where male.gender = 'male'
  and male.id between '00000000-0000-0000-0000-000000140001'
                  and '00000000-0000-0000-0000-000000140003'
  and female.id between '00000000-0000-0000-0000-000000140004'
                    and '00000000-0000-0000-0000-000000140006';

select ok(
  (select (value ->> 'pool_member_count')::integer = 6 from set_small_context)
  and exists (
    select 1
    from halal_mode_private.matching_run_member_snapshots snapshot
    where snapshot.run_id = (
      select (value ->> 'run_id')::uuid from set_small_context
    )
      and snapshot.user_id = '00000000-0000-0000-0000-000000140001'
      and snapshot.own_build = 'Athletic'
      and snapshot.religious_practice = 'very_practicing'
      and snapshot.preferred_practice = array['very_practicing']::religious_practice[]
  ),
  'run start freezes the complete score input for every eligible member'
);

-- If preparation reads live profile/preferences instead of the frozen run,
-- these changes alter both eligibility and scores and the assertions below fail.
update private_preferences
set must_have = '{}'
where user_id = '00000000-0000-0000-0000-000000140003';
update private_preferences
set preferred_practice = array['learning']::religious_practice[]
where user_id = '00000000-0000-0000-0000-000000140001';
update profiles set latitude = 24.4685, longitude = 39.6035
where id = '00000000-0000-0000-0000-000000140005';

create temporary table set_small_prepare as
select public.matching_candidate_snapshot_prepare_service(
  (select (value ->> 'run_id')::uuid from set_small_context), 9
) as value;

select ok(
  (select value @> '{"potential_edge_count":9,"candidate_edge_count":5,"scoring_complete":true}'::jsonb
   from set_small_prepare),
  'a small shortlist prepares and scores atomically with exact frozen counts'
);
select ok(
  exists (
    select 1 from halal_mode_private.matching_run_candidate_snapshots candidate
    where candidate.run_id = (select (value ->> 'run_id')::uuid from set_small_context)
      and candidate.user_low = '00000000-0000-0000-0000-000000140001'
      and candidate.user_high = '00000000-0000-0000-0000-000000140004'
  ),
  'unmarked age and a known distance beyond the preferred radius are scored, not filtered'
);
select ok(
  not exists (
    select 1 from halal_mode_private.matching_run_candidate_snapshots candidate
    where candidate.run_id = (select (value ->> 'run_id')::uuid from set_small_context)
      and candidate.user_low = '00000000-0000-0000-0000-000000140003'
      and candidate.user_high = '00000000-0000-0000-0000-000000140004'
  ),
  'marked age and distance remain hard reciprocal eligibility rules'
);
select ok(
  not exists (
    select 1 from halal_mode_private.matching_run_candidate_snapshots candidate
    where candidate.run_id = (select (value ->> 'run_id')::uuid from set_small_context)
      and candidate.user_high = '00000000-0000-0000-0000-000000140005'
  ),
  'same-country matching still fails closed when frozen coordinates are missing'
);
select ok(
  not exists (
    select 1
    from halal_mode_private.matching_run_candidate_snapshots candidate
    join set_expected_scores expected using (user_low, user_high)
    where candidate.run_id = (select (value ->> 'run_id')::uuid from set_small_context)
      and (candidate.compat_low_to_high <> expected.low_to_high
        or candidate.compat_high_to_low <> expected.high_to_low)
  ),
  'set-based directional scores exactly match the established scorer on frozen inputs'
);
select ok(
  exists (
    select 1 from halal_mode_private.matching_run_candidate_snapshots candidate
    where candidate.run_id = (select (value ->> 'run_id')::uuid from set_small_context)
      and candidate.user_low = '00000000-0000-0000-0000-000000140001'
      and candidate.user_high = '00000000-0000-0000-0000-000000140006'
      and candidate.pair_times_shown = 2
      and candidate.pair_first_score = 0.82
      and candidate.pair_last_score = 0.78
      and candidate.explicit_pass_count = 1
      and candidate.soft_select_count = 2
  ),
  'every pair-history signal reaches the immutable candidate snapshot'
);
select ok(
  not exists (
    select 1 from halal_mode_private.matching_run_candidate_shortlists shortlist
    where shortlist.run_id = (select (value ->> 'run_id')::uuid from set_small_context)
  )
  and (select count(*) = 5
       from halal_mode_private.matching_run_candidate_snapshots candidate
       where candidate.run_id = (select (value ->> 'run_id')::uuid from set_small_context)),
  'completed scoring removes transient staging without losing authoritative edges'
);
select is(
  public.matching_candidate_snapshot_prepare_service(
    (select (value ->> 'run_id')::uuid from set_small_context), 9
  ),
  (select value from set_small_prepare),
  'retrying a completed preparation is exactly idempotent'
);

-- Add enough balanced members to force more than one scoring transaction.
insert into auth.users (id, email)
select
  ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  'set-batch-' || n || '@example.test'
from generate_series(141001, 141088) n;

insert into profiles (
  id, name, first_name, birth_date, gender, city, country, latitude, longitude,
  bio, photos, languages_spoken, onboarding_complete
)
select
  ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  'Batch ' || n, 'Batch', date '1988-01-01' + ((n % 10) * interval '1 year'),
  case when n <= 141044 then 'male'::gender else 'female'::gender end,
  'Madinah', 'Saudi Arabia',
  24.4672 + ((n - 141001)::double precision / 100000),
  39.6024 + ((n - 141001)::double precision / 100000),
  repeat('g', 50), array['batch.jpg'], array['Arabic'], true
from generate_series(141001, 141088) n;

insert into private_preferences (
  user_id, min_age, max_age, preferred_countries, max_distance_km,
  matching_preferences_completed_at
)
select
  ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  18, 70, array['Saudi Arabia'], 1000, now()
from generate_series(141001, 141088) n;

insert into halal_mode_private.member_legal_consent_history (
  user_id, document_type, version, acceptance_context
)
select member.id, document.document_type, document.version, 'onboarding'
from (
  select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid as id
  from generate_series(141001, 141088) n
) member
cross join halal_mode_private.legal_document_registry document
where document.is_current;

create temporary table set_large_context as
select public.matching_run_start_service(
  'set-batch-v1', halal_mode_private.active_matching_config_version(),
  141001, 'shadow', '2026-08-13', '2026-08-13 05:00+03'
) as value;
create temporary table set_large_prepare as
select public.matching_candidate_snapshot_prepare_service(
  (select (value ->> 'run_id')::uuid from set_large_context), 10000
) as value;

select ok(
  (select (value ->> 'candidate_edge_count')::integer > 500
          and (value ->> 'shortlist_complete')::boolean is false
          and (value ->> 'shortlist_members_processed')::integer = 80
          and (value ->> 'scoring_complete')::boolean is false
   from set_large_prepare),
  'the first large-shortlist call advances only one bounded member batch'
);
select throws_ok(
  format(
    'select * from public.matching_candidate_edges_service(%L::uuid, null, null, 10)',
    (select value ->> 'run_id' from set_large_context)
  ),
  '55000', 'Prepare the matching candidate snapshot before paging it',
  'an incomplete score snapshot cannot leak partial candidate pages'
);

create temporary table set_large_prepare_complete as
select public.matching_candidate_snapshot_prepare_service(
  (select (value ->> 'run_id')::uuid from set_large_context), 10000
) as value;
select ok(
  (select (value ->> 'candidate_edge_count')::integer > 500
          and (value ->> 'shortlist_complete')::boolean
          and (value ->> 'shortlist_members_processed')::integer = 94
          and (value ->> 'scoring_complete')::boolean is false
   from set_large_prepare_complete),
  'the next bounded member batch completes the exact reciprocal shortlist'
);

create temporary table set_batch_one as
select public.matching_candidate_snapshot_score_batch_service(
  (select (value ->> 'run_id')::uuid from set_large_context), 500
) as value;
select ok(
  (select (value ->> 'scored_rows')::integer = 500
          and (value ->> 'remaining_rows')::integer =
            (select (value ->> 'candidate_edge_count')::integer - 500
             from set_large_prepare_complete)
          and (value ->> 'complete')::boolean is false
   from set_batch_one),
  'the first score call advances exactly one bounded batch'
);
select throws_ok(
  format(
    'select * from public.matching_candidate_edges_service(%L::uuid, null, null, 10)',
    (select value ->> 'run_id' from set_large_context)
  ),
  '55000', 'Prepare the matching candidate snapshot before paging it',
  'one completed batch still cannot expose a partial snapshot'
);

create temporary table set_batch_final(value jsonb not null) on commit drop;
do $score_to_completion$
declare
  result jsonb;
begin
  for attempt in 1..10 loop
    result := public.matching_candidate_snapshot_score_batch_service(
      (select (value ->> 'run_id')::uuid from set_large_context), 500
    );
    if (result ->> 'complete')::boolean then
      insert into set_batch_final values (result);
      return;
    end if;
  end loop;
  raise exception 'test scoring did not complete within its bound';
end;
$score_to_completion$;
select ok(
  (select (value ->> 'complete')::boolean
          and (value ->> 'remaining_rows')::integer = 0
          and (value ->> 'scored_rows')::integer between 1 and 500
   from set_batch_final)
  and not exists (
    select 1 from halal_mode_private.matching_run_candidate_shortlists shortlist
    where shortlist.run_id = (select (value ->> 'run_id')::uuid from set_large_context)
  )
  and (select count(*) = (select (value ->> 'candidate_edge_count')::integer
                          from set_large_prepare_complete)
       from halal_mode_private.matching_run_candidate_snapshots candidate
       where candidate.run_id = (select (value ->> 'run_id')::uuid from set_large_context)),
  'the final bounded batch atomically completes the snapshot and clears staging'
);
select is(
  public.matching_candidate_snapshot_score_batch_service(
    (select (value ->> 'run_id')::uuid from set_large_context), 500
  ),
  '{"complete":true,"scored_rows":0,"remaining_rows":0}'::jsonb,
  'retrying completed scoring is exactly idempotent'
);
select ok(
  (public.matching_candidate_snapshot_prepare_service(
    (select (value ->> 'run_id')::uuid from set_large_context), 10000
  ) ->> 'scoring_complete')::boolean,
  'retrying preparation reports the completed score snapshot'
);
select lives_ok(
  format(
    'select * from public.matching_candidate_edges_service(%L::uuid, null, null, 10)',
    (select value ->> 'run_id' from set_large_context)
  ),
  'candidate pages become readable only after every score is complete'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000140001","role":"authenticated"}',
  true
);
select throws_ok(
  format(
    'select public.matching_candidate_snapshot_score_batch_service(%L::uuid, 500)',
    (select value ->> 'run_id' from set_large_context)
  ),
  '42501', 'Matching snapshot scoring requires service role',
  'an authenticated member cannot advance private candidate scoring'
);

select * from finish();
rollback;
