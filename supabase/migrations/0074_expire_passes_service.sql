-- Make the pass expiry reachable from the generator.
--
-- 0070 put expire_explicit_passes() in halal_mode_private, where PostgREST
-- cannot see it, and nothing called it. Left that way the cooldown would have
-- been a number in a config table that no code ever read, and every pass would
-- have stayed permanent — precisely the behaviour 0070 was written to end.
--
-- This is the same failure as `explicit_pass` itself, which four migrations
-- branched on and nothing ever wrote. Both look complete in isolation and do
-- nothing in place, and neither shows up in a migration that applies cleanly.

create or replace function public.expire_explicit_passes_service()
returns integer
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_expired integer;
begin
  -- Service role only, and not reachable from a member session at all. The
  -- grants below are the boundary; this is a second line for the case where a
  -- future migration re-grants too broadly.
  if auth.uid() is not null then
    raise exception 'Not available' using errcode = '42501';
  end if;
  select halal_mode_private.expire_explicit_passes() into v_expired;
  return v_expired;
end;
$$;

comment on function public.expire_explicit_passes_service() is
  'Runs the explicit-pass cooldown. Called once per generation cycle, before candidates are built, so a pass that expired overnight is available to today round.';

revoke all on function public.expire_explicit_passes_service()
  from public, anon, authenticated;
grant execute on function public.expire_explicit_passes_service() to service_role;
