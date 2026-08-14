-- Find out when the app breaks for somebody.
--
-- Today a crash in Jakarta at 2am leaves no trace anywhere. Nobody learns
-- about it, and the member gets a broken screen and no reason to come back.
--
-- No third-party service, because that would be another account, another key
-- shipped to the client, and another company holding data about Muslim people
-- looking for a spouse. A table and one function is enough to answer "is
-- anything broken, and for how many people".
--
-- What is deliberately NOT recorded: no message text, no profile fields, no
-- names, no coordinates, no identifiers of anyone the member was looking at.
-- An error report says what broke and where, never who it was about.

create table if not exists halal_mode_private.client_errors (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  -- The error's own message, trimmed. Stack traces are deliberately excluded:
  -- they carry file paths and sometimes interpolated values.
  message text not null check (length(message) between 1 and 500),
  -- Which screen, so a fault can be located without guessing.
  screen text check (screen is null or length(screen) <= 100),
  platform text check (platform is null or platform in ('ios', 'android', 'web')),
  app_version text check (app_version is null or length(app_version) <= 40),
  created_at timestamptz not null default now()
);

create index if not exists client_errors_recent_idx
  on halal_mode_private.client_errors (created_at desc);

revoke all on table halal_mode_private.client_errors from public, anon, authenticated;

-- Reportable by anyone, including before sign-in — a crash on the sign-in
-- screen is exactly the one you cannot afford to miss. The member's id is
-- taken from their session rather than the argument list, so a caller cannot
-- attribute an error to somebody else.
create or replace function public.report_client_error(
  p_message text,
  p_screen text default null,
  p_platform text default null,
  p_app_version text default null
) returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_recent integer;
begin
  if p_message is null or btrim(p_message) = '' then
    return;
  end if;

  -- A broken screen can retry in a loop, and a flood of identical rows is
  -- both useless and a way to fill the table. Twenty an hour per member is
  -- plenty to spot a fault and far too few to be a lever.
  select count(*) into v_recent
  from halal_mode_private.client_errors
  where created_at > now() - interval '1 hour'
    and user_id is not distinct from auth.uid();
  if v_recent >= 20 then
    return;
  end if;

  insert into halal_mode_private.client_errors (user_id, message, screen, platform, app_version)
  values (
    auth.uid(),
    left(btrim(p_message), 500),
    left(nullif(btrim(coalesce(p_screen, '')), ''), 100),
    nullif(btrim(coalesce(p_platform, '')), ''),
    left(nullif(btrim(coalesce(p_app_version, '')), ''), 40)
  );
exception when others then
  -- Reporting a failure must never itself fail the caller. A member whose
  -- screen already broke should not get a second error because telling us
  -- about the first one did not work.
  return;
end;
$$;

revoke all on function public.report_client_error(text, text, text, text) from public;
grant execute on function public.report_client_error(text, text, text, text) to anon, authenticated;

-- Reading them is service-role only, and returns counts rather than a feed, so
-- the common question ("is anything broken right now") is answered without
-- paging through individual members' bad days.
create or replace function public.recent_client_errors_service(p_hours integer default 24)
returns table (message text, screen text, platform text, occurrences bigint, last_seen timestamptz, members bigint)
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  select e.message, e.screen, e.platform,
         count(*) as occurrences,
         max(e.created_at) as last_seen,
         count(distinct e.user_id) as members
  from halal_mode_private.client_errors e
  where e.created_at > now() - make_interval(hours => greatest(1, least(p_hours, 720)))
  group by e.message, e.screen, e.platform
  order by count(*) desc
  limit 100;
$$;

revoke all on function public.recent_client_errors_service(integer) from public, anon, authenticated;
grant execute on function public.recent_client_errors_service(integer) to service_role;
