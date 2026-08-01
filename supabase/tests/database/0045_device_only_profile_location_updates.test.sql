begin;
set local search_path = public, extensions;
select plan(8);

select ok(
  has_function_privilege('authenticated', 'public.update_my_location(text,text,double precision,double precision)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.update_my_location(text,text,double precision,double precision)', 'EXECUTE'),
  'only signed-in members can invoke the location update boundary'
);
select ok(
  position('''city''' in pg_get_functiondef('public.update_my_profile(jsonb)'::regprocedure)) = 0
  and position('''country''' in pg_get_functiondef('public.update_my_profile(jsonb)'::regprocedure)) = 0,
  'the general profile patch no longer allows city or country keys'
);
select ok(
  position('city = case' in pg_get_functiondef('public.update_my_profile(jsonb)'::regprocedure)) = 0
  and position('country = case' in pg_get_functiondef('public.update_my_profile(jsonb)'::regprocedure)) = 0,
  'the general profile update cannot write place labels'
);
select ok(
  position('where id = auth.uid() and onboarding_complete' in pg_get_functiondef('public.update_my_location(text,text,double precision,double precision)'::regprocedure)) > 0,
  'location updates target only the signed-in completed profile'
);
select ok(
  position('set city = trim(p_city)' in pg_get_functiondef('public.update_my_location(text,text,double precision,double precision)'::regprocedure)) > 0
  and position('country = trim(p_country)' in pg_get_functiondef('public.update_my_location(text,text,double precision,double precision)'::regprocedure)) > 0
  and position('latitude = p_latitude' in pg_get_functiondef('public.update_my_location(text,text,double precision,double precision)'::regprocedure)) > 0
  and position('longitude = p_longitude' in pg_get_functiondef('public.update_my_location(text,text,double precision,double precision)'::regprocedure)) > 0,
  'place labels and private coordinates are written atomically'
);
select ok(
  position('p_latitude not between -90 and 90' in pg_get_functiondef('public.update_my_location(text,text,double precision,double precision)'::regprocedure)) > 0
  and position('p_longitude not between -180 and 180' in pg_get_functiondef('public.update_my_location(text,text,double precision,double precision)'::regprocedure)) > 0,
  'the server validates coordinate bounds'
);
select ok(
  position('current_setting(''app.location_rpc''' in pg_get_functiondef('public.guard_profile_client_update()'::regprocedure)) > 0
  and position('new.latitude is distinct from old.latitude' in pg_get_functiondef('public.guard_profile_client_update()'::regprocedure)) > 0
  and position('new.city is distinct from old.city' in pg_get_functiondef('public.guard_profile_client_update()'::regprocedure)) > 0,
  'the profile trigger permits location changes only through the dedicated boundary'
);
select ok(
  not has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
  and position('''latitude''' in pg_get_functiondef('public.safe_member_profile(public.profiles)'::regprocedure)) = 0
  and position('''longitude''' in pg_get_functiondef('public.safe_member_profile(public.profiles)'::regprocedure)) = 0,
  'members cannot write raw profiles and precise coordinates remain outside public DTOs'
);

select * from finish();
rollback;
