begin;

set local search_path = public, extensions;
select plan(4);

select ok(
  has_function_privilege('service_role', 'public.generate_round_for_pairs(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.expire_stale_rounds()', 'EXECUTE')
  and has_function_privilege('service_role', 'public.set_madinah_fajr_cron(text)', 'EXECUTE'),
  'the Fajr service role can generate, expire, and plan rounds'
);
select ok(
  not has_function_privilege('authenticated', 'public.set_madinah_fajr_cron(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.set_madinah_fajr_cron(text)', 'EXECUTE'),
  'members and anonymous callers cannot alter the Fajr schedule'
);
select ok(
  position('accepts_subject_country' in pg_get_functiondef('public.passes_criteria(uuid,uuid)'::regprocedure)) > 0,
  'matching still applies the reciprocal country gate before location checks'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000261', 'coordinate-viewer@example.test'),
  ('00000000-0000-0000-0000-000000000262', 'coordinate-subject@example.test');
insert into profiles (
  id, name, first_name, birth_date, gender, city, country, latitude, longitude, onboarding_complete
) values
  ('00000000-0000-0000-0000-000000000261', 'Coordinate Viewer', 'Viewer', '1990-01-01', 'male', 'Riyadh', 'Saudi Arabia', 24.7136, 46.6753, true),
  ('00000000-0000-0000-0000-000000000262', 'Coordinate Subject', 'Subject', '1991-01-01', 'female', 'Jeddah', 'Saudi Arabia', null, null, true);
insert into private_preferences (user_id, max_distance_km) values
  ('00000000-0000-0000-0000-000000000261', 100),
  ('00000000-0000-0000-0000-000000000262', 100);
select ok(
  not passes_criteria(
    '00000000-0000-0000-0000-000000000261',
    '00000000-0000-0000-0000-000000000262'
  ),
  'same-country matching fails closed when a coordinate is missing'
);

select * from finish();
rollback;
