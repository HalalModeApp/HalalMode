-- Service-role accessors the round function needs.
--
-- Named for who may call them. Neither is reachable from a client role: the
-- configuration would reveal internal weights, and the flag decides which
-- cohort a member lands in.

create or replace function public.matching_run_config()
returns jsonb
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  -- Carries its own version so a run records exactly which parameters produced
  -- it, without a second round trip.
  select halal_mode_private.active_matching_config()
    || jsonb_build_object('__version', halal_mode_private.active_matching_config_version());
$$;

create or replace function public.release_flag_active(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  select coalesce((select enabled from halal_mode_private.release_flags where key = p_key), false);
$$;

revoke all on function public.matching_run_config() from public, anon, authenticated;
revoke all on function public.release_flag_active(text) from public, anon, authenticated;
grant execute on function public.matching_run_config() to service_role;
grant execute on function public.release_flag_active(text) to service_role;
