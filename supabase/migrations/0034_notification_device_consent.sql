-- Device tokens are accepted only through this authenticated boundary. Raw
-- tokens are hashed in the database and are never returned to a member.

create or replace function register_my_notification_device(
  p_token text,
  p_platform text,
  p_locale text
) returns void
language plpgsql
security definer
set search_path = public, halal_mode_private, extensions as $$
declare v_token_hash text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_token is null or length(p_token) not between 20 and 400 then
    raise exception 'Notification token is invalid' using errcode = '22023';
  end if;
  if p_platform not in ('ios', 'android') then raise exception 'Notification platform is invalid' using errcode = '22023'; end if;
  if p_locale is null or p_locale !~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,12})*$' then
    raise exception 'Notification locale is invalid' using errcode = '22023';
  end if;
  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  insert into notification_devices (user_id, platform, token_hash, locale, notifications_enabled, last_seen_at)
  values (auth.uid(), p_platform, v_token_hash, p_locale, true, now())
  on conflict (user_id, platform, token_hash) do update set
    locale = excluded.locale,
    notifications_enabled = true,
    last_seen_at = now();
end;
$$;

create or replace function disable_my_notifications()
returns void
language plpgsql
security definer
set search_path = halal_mode_private, public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  update notification_devices
  set notifications_enabled = false, last_seen_at = now()
  where user_id = auth.uid() and notifications_enabled;
end;
$$;

create or replace function get_my_notification_consent()
returns boolean
language sql
stable
security definer
set search_path = halal_mode_private, public as $$
  select exists (
    select 1 from notification_devices
    where user_id = auth.uid() and notifications_enabled
  );
$$;

revoke all on function register_my_notification_device(text, text, text), disable_my_notifications(), get_my_notification_consent()
  from public, anon;
grant execute on function register_my_notification_device(text, text, text), disable_my_notifications(), get_my_notification_consent()
  to authenticated;
