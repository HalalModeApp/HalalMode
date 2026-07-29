-- Private flags can be enabled only by server operations. Cohorts provide a
-- deterministic, auditable controlled-beta path instead of client toggles.

create table halal_mode_private.release_flag_members (
  key text not null references halal_mode_private.release_flags(key) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (key, user_id)
);

create or replace function halal_mode_private.release_flag_enabled_for(
  p_key text,
  p_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  select coalesce((
    select f.enabled and (
      exists (select 1 from release_flag_members m where m.key = f.key and m.user_id = p_user_id)
      or (f.rollout_percentage > 0 and mod(abs(hashtextextended(p_user_id::text || ':' || f.key, 29029)), 100) < f.rollout_percentage)
    )
    from release_flags f where f.key = p_key
  ), false);
$$;

create or replace function get_my_release_flags()
returns jsonb
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  select coalesce(jsonb_object_agg(f.key, halal_mode_private.release_flag_enabled_for(f.key, auth.uid())), '{}'::jsonb)
  from halal_mode_private.release_flags f
  where auth.uid() is not null;
$$;

create or replace function halal_mode_private.set_release_flag(
  p_key text,
  p_enabled boolean,
  p_rollout_percentage smallint
) returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Release flags require service role' using errcode = '42501';
  end if;
  if p_rollout_percentage < 0 or p_rollout_percentage > 100 then
    raise exception 'Rollout percentage is invalid' using errcode = '22023';
  end if;
  update release_flags
  set enabled = p_enabled, rollout_percentage = p_rollout_percentage, updated_at = now()
  where key = p_key;
  if not found then raise exception 'Release flag not found' using errcode = 'P0002'; end if;
  insert into audit_events (event_type, metadata)
  values ('release_flag_updated', jsonb_build_object('key', p_key, 'enabled', p_enabled, 'rolloutPercentage', p_rollout_percentage));
end;
$$;

revoke all on table halal_mode_private.release_flag_members from public, anon, authenticated;
revoke all on function halal_mode_private.release_flag_enabled_for(text, uuid) from public, anon, authenticated;
revoke all on function halal_mode_private.set_release_flag(text, boolean, smallint) from public, anon, authenticated;
revoke all on function get_my_release_flags() from public, anon;
grant execute on function get_my_release_flags() to authenticated;
grant execute on function halal_mode_private.set_release_flag(text, boolean, smallint) to service_role;
