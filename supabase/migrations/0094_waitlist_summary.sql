-- A way to see how the waitlist is doing, without reading anybody's address.
--
-- 0093 made the table unreachable from the API on purpose, which left no way to
-- answer "how many people have signed up, and where are they" short of opening
-- the dashboard. That is right for the addresses themselves and wrong for the
-- counts: deciding which city to open first should not require a query that
-- also puts a list of real email addresses on screen.
--
-- So the counts get a function and the addresses do not. Pulling the actual
-- list to send invitations stays a deliberate act in the SQL editor, which is
-- the correct amount of friction for that, and this returns nothing that
-- identifies anyone.

create or replace function public.waitlist_summary_service()
returns jsonb
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  select jsonb_build_object(
    'total', (select count(*) from halal_mode_private.waitlist),
    'invited', (select count(*) from halal_mode_private.waitlist where invited_at is not null),
    'waiting', (select count(*) from halal_mode_private.waitlist where invited_at is null),
    'joined_last_7_days', (
      select count(*) from halal_mode_private.waitlist
      where created_at >= now() - interval '7 days'
    ),
    -- Cities worth opening in are the ones with enough people to make a round.
    -- Ordered by size, and capped, because a long tail of ones is noise here.
    'top_cities', coalesce((
      select jsonb_agg(c) from (
        select jsonb_build_object('city', initcap(city), 'count', count(*)) as c
        from halal_mode_private.waitlist
        group by initcap(city)
        order by count(*) desc, initcap(city)
        limit 20
      ) t
    ), '[]'::jsonb),
    'by_age_range', coalesce((
      select jsonb_object_agg(age_range, n) from (
        select age_range, count(*) as n
        from halal_mode_private.waitlist group by age_range
      ) t
    ), '{}'::jsonb),
    'by_locale', coalesce((
      select jsonb_object_agg(coalesce(locale, 'unknown'), n) from (
        select locale, count(*) as n
        from halal_mode_private.waitlist group by locale
      ) t
    ), '{}'::jsonb)
  );
$$;

comment on function public.waitlist_summary_service() is
  'Counts only — totals, top cities, age spread, language. Never returns an email address; pulling the list itself is a deliberate dashboard action.';

revoke all on function public.waitlist_summary_service() from public, anon, authenticated;
grant execute on function public.waitlist_summary_service() to service_role;

do $$
declare
  v jsonb;
begin
  v := public.waitlist_summary_service();
  assert v ? 'total' and v ? 'top_cities' and v ? 'by_age_range',
    'the summary should report totals, cities and ages';

  -- The whole point: nothing identifying comes back. Checked rather than
  -- assumed, because a later edit could add a column to that aggregate without
  -- noticing what it is.
  assert v::text !~ '@', 'the summary must never contain an email address';

  assert not has_function_privilege('anon', 'public.waitlist_summary_service()', 'EXECUTE'),
    'the summary is for the operator, not for callers';
  assert not has_function_privilege('authenticated', 'public.waitlist_summary_service()', 'EXECUTE'),
    'a signed-in member has no business reading waitlist counts';
end;
$$;
