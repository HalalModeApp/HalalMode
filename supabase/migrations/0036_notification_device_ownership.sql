-- A physical push token belongs to one signed-in member at a time. When a
-- shared device changes account, notifications must move with the device
-- instead of reaching a previous member.

begin;

-- The earlier per-member uniqueness permitted a single Expo token to remain
-- active on more than one account. Preserve the most recently seen legacy
-- registration before enforcing device-wide ownership.
with ranked as (
  select
    id,
    row_number() over (
      partition by platform, token_hash
      order by last_seen_at desc, created_at desc, id desc
    ) as row_number
  from halal_mode_private.notification_devices
)
delete from halal_mode_private.notification_devices devices
using ranked
where devices.id = ranked.id
  and ranked.row_number > 1;

alter table halal_mode_private.notification_devices
  add constraint notification_devices_platform_token_hash_key unique (platform, token_hash);

create or replace function public.register_my_notification_device(
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

  -- A member who signs into a shared device takes ownership deliberately by
  -- enabling notifications. The raw token never leaves this function.
  insert into halal_mode_private.notification_devices (
    user_id, platform, token_hash, locale, notifications_enabled, last_seen_at
  )
  values (auth.uid(), p_platform, v_token_hash, p_locale, true, now())
  on conflict (platform, token_hash) do update set
    user_id = excluded.user_id,
    locale = excluded.locale,
    notifications_enabled = true,
    last_seen_at = now();
end;
$$;

revoke all on function public.register_my_notification_device(text, text, text) from public, anon;
grant execute on function public.register_my_notification_device(text, text, text) to authenticated;

commit;
