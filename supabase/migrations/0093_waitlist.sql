-- The waitlist behind halalmo.de.
--
-- The landing page is anonymous by definition — anyone can post to it — which
-- makes the table it writes to the most exposed surface in this schema. So it
-- does not live in `public` at all: PostgREST can only reach `public`, and a
-- table it cannot see is a table nobody can enumerate, whatever an RLS policy
-- may or may not say later. One security-definer function is the entire way in,
-- and there is no way out.
--
-- Nothing here is readable by a member or by anon. Reading the list is an
-- operator action through the dashboard, which is the correct amount of
-- friction for a table of people's email addresses.

create table if not exists halal_mode_private.waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  city        text not null,
  age_range   text not null,
  locale      text,
  created_at  timestamptz not null default now(),
  -- Set when this person is actually invited, so the list can be worked through
  -- in order without a second table tracking who has already been contacted.
  invited_at  timestamptz,
  constraint waitlist_email_unique unique (email),
  constraint waitlist_email_shape check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint waitlist_email_length check (length(email) between 6 and 254),
  constraint waitlist_city_length check (length(trim(city)) between 2 and 80),
  constraint waitlist_age_range check (
    age_range in ('18-24', '25-29', '30-34', '35-39', '40-49', '50+')
  )
);

comment on table halal_mode_private.waitlist is
  'People who asked to be told when Halal Mode opens. Founders are simply the earliest rows: order by created_at. Deliberately outside the public schema so no API caller can read it.';

revoke all on halal_mode_private.waitlist from public, anon, authenticated;

create index if not exists waitlist_created_at_idx
  on halal_mode_private.waitlist (created_at);

-- ---------------------------------------------------------------------------
-- The only way in
-- ---------------------------------------------------------------------------

create or replace function public.join_waitlist(
  p_email text,
  p_city text,
  p_age_range text,
  p_locale text default null
) returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_city  text := trim(coalesce(p_city, ''));
begin
  -- Validated here rather than trusted from a page anyone can post to. The
  -- table constraints say the same things again, because a check constraint is
  -- the only one of the two that a future caller cannot skip.
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or length(v_email) not between 6 and 254 then
    raise exception 'That email address does not look right' using errcode = '22023';
  end if;
  if length(v_city) not between 2 and 80 then
    raise exception 'Please tell us which city you are in' using errcode = '22023';
  end if;
  if p_age_range not in ('18-24', '25-29', '30-34', '35-39', '40-49', '50+') then
    raise exception 'Please choose an age range' using errcode = '22023';
  end if;

  insert into halal_mode_private.waitlist as w (email, city, age_range, locale)
  values (v_email, v_city, p_age_range, nullif(trim(coalesce(p_locale, '')), ''))
  on conflict (email) do update
    -- Someone signing up twice is usually correcting themselves, so the later
    -- answer wins. created_at is untouched: their place in the queue is the
    -- first time they asked, not the last.
    set city = excluded.city,
        age_range = excluded.age_range,
        locale = coalesce(excluded.locale, w.locale);
end;
$$;

comment on function public.join_waitlist(text, text, text, text) is
  'Adds someone to the waitlist, or quietly updates them if they sign up again. Returns nothing on purpose: telling a caller whether an address was already present would turn an open endpoint into a way to test whether a given person has signed up.';

revoke all on function public.join_waitlist(text, text, text, text) from public;
grant execute on function public.join_waitlist(text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Checks, on the real database
-- ---------------------------------------------------------------------------

do $$
declare
  v_count int;
  v_created timestamptz;
begin
  perform public.join_waitlist('Check.Person@Example.com  ', '  Manchester ', '25-29', 'en');
  select count(*) into v_count from halal_mode_private.waitlist
  where email = 'check.person@example.com';
  assert v_count = 1, 'the address should be stored lowercased and trimmed';

  select created_at into v_created from halal_mode_private.waitlist
  where email = 'check.person@example.com';

  -- Signing up again corrects the details without losing the place in the queue.
  perform public.join_waitlist('check.person@example.com', 'Leeds', '30-34', 'ar');
  select count(*) into v_count from halal_mode_private.waitlist
  where email = 'check.person@example.com' and city = 'Leeds' and age_range = '30-34';
  assert v_count = 1, 'a second signup should correct the details';
  assert (select created_at from halal_mode_private.waitlist
          where email = 'check.person@example.com') = v_created,
    'a second signup must not move somebody down the queue';

  -- Rubbish is refused, and refused by the function rather than by a 500.
  begin
    perform public.join_waitlist('not-an-email', 'Leeds', '25-29');
    raise exception 'a malformed address should have been refused';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.join_waitlist('someone@example.com', 'L', '25-29');
    raise exception 'a one-letter city should have been refused';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.join_waitlist('someone@example.com', 'Leeds', '12-15');
    raise exception 'an unlisted age range should have been refused';
  exception when sqlstate '22023' then null;
  end;

  delete from halal_mode_private.waitlist where email = 'check.person@example.com';

  -- The list itself must stay unreachable from the API.
  assert not has_table_privilege('anon', 'halal_mode_private.waitlist', 'SELECT'),
    'anon must never be able to read the waitlist';
  assert not has_table_privilege('authenticated', 'halal_mode_private.waitlist', 'SELECT'),
    'a signed-in member must not be able to read the waitlist either';
  assert has_function_privilege('anon', 'public.join_waitlist(text,text,text,text)', 'EXECUTE'),
    'joining has to work before anyone has an account';
end;
$$;
