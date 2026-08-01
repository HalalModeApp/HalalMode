begin;

set local search_path = public, extensions;
select plan(20);

select is(
  (select count(*)::int from halal_mode_private.matching_band_policies),
  2,
  'the reviewed policy has one private row for each supported gender'
);
select is(
  (select count(distinct feedback_weight)::int from halal_mode_private.matching_band_policies),
  1,
  'both genders start with the same neutral calibration policy'
);
select ok(
  not has_table_privilege('authenticated', 'halal_mode_private.matching_band_policies', 'SELECT')
  and not has_table_privilege('authenticated', 'public.selection_scores', 'SELECT'),
  'members cannot inspect matching policies, scores, or bands'
);
select ok(
  not has_function_privilege('authenticated', 'halal_mode_private.matching_band_for_score(gender,numeric)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'halal_mode_private.accepts_subject_country(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'halal_mode_private.set_matching_band_policy(gender,numeric)', 'EXECUTE'),
  'private calibration, country, and policy helpers are not callable by members'
);
select ok(
  position('passes_criteria(m.id, f.id)' in pg_get_functiondef('public.generate_round_for_pairs(timestamptz)'::regprocedure)) > 0
  and position('passes_criteria(f.id, m.id)' in pg_get_functiondef('public.generate_round_for_pairs(timestamptz)'::regprocedure)) > 0,
  'the matcher keeps the reciprocal eligibility gate in both directions'
);
select ok(
  position('coalesce(s.band, 3)' in pg_get_functiondef('public.generate_round_for_pairs(timestamptz)'::regprocedure)) > 0
  and position('matching_band_for_score' in pg_get_functiondef('halal_mode_private.sync_selection_score_band()'::regprocedure)) > 0,
  'the matcher uses materialized private bands and the trigger recomputes them on every score change'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000211', 'calibration-lebanon@example.test'),
  ('00000000-0000-0000-0000-000000000212', 'calibration-peru@example.test'),
  ('00000000-0000-0000-0000-000000000213', 'calibration-local@example.test');
insert into profiles (
  id, name, first_name, birth_date, gender, city, country, relocation,
  latitude, longitude, bio, photos, onboarding_complete
) values
  ('00000000-0000-0000-0000-000000000211', 'Lebanon Member', 'Lebanon', '1990-01-01', 'male', 'Beirut', 'Lebanon', 'open', 33.8938, 35.5018, repeat('a', 40), array['211/photo.jpg'], true),
  ('00000000-0000-0000-0000-000000000212', 'Peru Member', 'Peru', '1991-01-01', 'female', 'Lima', 'Peru', 'open', -12.0464, -77.0428, repeat('b', 40), array['212/photo.jpg'], true),
  ('00000000-0000-0000-0000-000000000213', 'Local Member', 'Local', '1991-01-01', 'female', 'Tripoli', 'Lebanon', 'open', 34.4367, 35.8497, repeat('c', 40), array['213/photo.jpg'], true);
insert into private_preferences (
  user_id, preferred_countries, max_distance_km, matching_preferences_completed_at
) values
  ('00000000-0000-0000-0000-000000000211', array['peru'], 10, now()),
  ('00000000-0000-0000-0000-000000000212', array['LEBANON'], 10, now()),
  ('00000000-0000-0000-0000-000000000213', array['Lebanon'], 10, now());
insert into halal_mode_private.member_legal_consent_history (
  user_id, document_type, version, acceptance_context
)
select p.id, d.document_type, d.version, 'reacceptance'
from profiles p
cross join halal_mode_private.legal_document_registry d
where p.id in (
    '00000000-0000-0000-0000-000000000211',
    '00000000-0000-0000-0000-000000000212',
    '00000000-0000-0000-0000-000000000213'
  )
  and d.is_current;
insert into selection_scores (user_id, score) values
  ('00000000-0000-0000-0000-000000000211', 0.9000),
  ('00000000-0000-0000-0000-000000000212', 0.9000),
  ('00000000-0000-0000-0000-000000000213', 0.9000);

select is(
  (select band from selection_scores where user_id = '00000000-0000-0000-0000-000000000211'),
  halal_mode_private.matching_band_for_score('male', 0.9000),
  'the score trigger persists the policy-derived private band'
);
select ok(
  halal_mode_private.accepts_subject_country(
    '00000000-0000-0000-0000-000000000211', '00000000-0000-0000-0000-000000000212'
  ) and halal_mode_private.accepts_subject_country(
    '00000000-0000-0000-0000-000000000212', '00000000-0000-0000-0000-000000000211'
  ),
  'Lebanon and Peru accept each other when both country settings are reciprocal'
);
select ok(
  passes_criteria('00000000-0000-0000-0000-000000000211', '00000000-0000-0000-0000-000000000212')
  and passes_criteria('00000000-0000-0000-0000-000000000212', '00000000-0000-0000-0000-000000000211'),
  'an explicitly reciprocal international pair passes even when its local distance caps are small'
);
select ok(
  not passes_criteria('00000000-0000-0000-0000-000000000211', '00000000-0000-0000-0000-000000000213'),
  'same-country pairs still respect the local distance cap'
);

update profiles set relocation = 'strictly_local'
where id = '00000000-0000-0000-0000-000000000211';
select ok(
  not halal_mode_private.accepts_subject_country(
    '00000000-0000-0000-0000-000000000211', '00000000-0000-0000-0000-000000000212'
  ),
  'strictly local blocks an international introduction even when the country list contains it'
);
update profiles set relocation = 'open'
where id = '00000000-0000-0000-0000-000000000211';
update private_preferences set preferred_countries = array['Canada']
where user_id = '00000000-0000-0000-0000-000000000212';
select ok(
  passes_criteria('00000000-0000-0000-0000-000000000211', '00000000-0000-0000-0000-000000000212')
  and not passes_criteria('00000000-0000-0000-0000-000000000212', '00000000-0000-0000-0000-000000000211'),
  'a one-sided country setting cannot satisfy reciprocal eligibility'
);
update private_preferences set preferred_countries = array['Lebanon']
where user_id = '00000000-0000-0000-0000-000000000212';

select lives_ok(
  $$ select generate_round_for_pairs(now() + interval '1 day') $$,
  'the matcher can build a round with private calibration enabled'
);
select is(
  (select count(*)::int from introductions
   where (viewer_id = '00000000-0000-0000-0000-000000000211' and subject_id = '00000000-0000-0000-0000-000000000212')
      or (viewer_id = '00000000-0000-0000-0000-000000000212' and subject_id = '00000000-0000-0000-0000-000000000211')),
  2,
  'a reciprocal international pair receives exactly two linked cards'
);
select ok(
  exists (
    select 1 from introductions a
    join introductions b on b.id = a.reciprocal_id and b.reciprocal_id = a.id
    where a.viewer_id = '00000000-0000-0000-0000-000000000211'
      and a.subject_id = '00000000-0000-0000-0000-000000000212'
  ),
  'international cards retain the reciprocal twin invariant'
);
select ok(
  not exists (
    select 1 from introductions
    where viewer_id = '00000000-0000-0000-0000-000000000211'
      and subject_id = '00000000-0000-0000-0000-000000000213'
  ),
  'a local-distance-ineligible pair is not introduced'
);
select is(
  halal_mode_private.matching_band_for_member('00000000-0000-0000-0000-000000000211'),
  (select band from selection_scores where user_id = '00000000-0000-0000-0000-000000000211'),
  'the member helper and stored diagnostic band agree'
);
select ok(
  position('selection_scores' in pg_get_functiondef('public.get_current_round()'::regprocedure)) = 0,
  'the daily-round response cannot disclose private calibration inputs'
);
select ok(
  not has_function_privilege('authenticated', 'halal_mode_private.matching_band_for_member(uuid)', 'EXECUTE'),
  'members cannot ask the server for their own calibration band'
);
select ok(
  not has_function_privilege('authenticated', 'public.generate_round_for_pairs(timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.generate_round_for_pairs(timestamptz)', 'EXECUTE'),
  'members and anonymous callers cannot generate or manipulate daily rounds'
);

select * from finish();
rollback;
