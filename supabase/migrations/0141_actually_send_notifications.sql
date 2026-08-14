-- Make notifications sendable, then queue the three that are worth sending.
--
-- Registering a device has worked for months: permission, token, consent,
-- quiet hours. Nothing has ever sent anything, and it could not — the token
-- was hashed and discarded ("the raw token never leaves this function"), and a
-- hash cannot be reversed into the address Apple and Google deliver to. So the
-- whole feature was unreachable by construction. Recorded in DECISIONS.md.
--
-- Three moments earn an interruption in an app about marriage, and nothing
-- else does:
--
--   your introductions are ready
--   you matched with someone
--   you have a new message
--
-- Everything is queued rather than sent inline. A push that fails must never
-- fail the thing that caused it: nobody should lose a match because a
-- notification could not be delivered.

alter table halal_mode_private.notification_devices
  add column if not exists push_token text;

comment on column halal_mode_private.notification_devices.push_token is
  'The address Apple/Google deliver to. Readable by the sending job only, and '
  'cleared when the member disables notifications or closes their account.';

-- Keep the token beside its hash. The hash still does deduplication; the token
-- is what makes delivery possible.
create or replace function public.register_my_notification_device(
  p_token text,
  p_platform text,
  p_locale text default 'en'
) returns void
language plpgsql
security definer
set search_path = public, halal_mode_private, extensions as $$
declare
  v_token_hash text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_token is null or length(p_token) not between 20 and 400 then
    raise exception 'Notification token is invalid' using errcode = '22023';
  end if;
  if p_platform is null or p_platform not in ('ios', 'android') then
    raise exception 'Notification platform is invalid' using errcode = '22023';
  end if;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  insert into halal_mode_private.notification_devices
    (user_id, platform, token_hash, push_token, locale, notifications_enabled, last_seen_at)
  values (auth.uid(), p_platform, v_token_hash, p_token, coalesce(nullif(btrim(p_locale), ''), 'en'), true, now())
  on conflict (user_id, platform, token_hash) do update
    set push_token = excluded.push_token,
        locale = excluded.locale,
        notifications_enabled = true,
        last_seen_at = now();
end;
$$;

revoke all on function public.register_my_notification_device(text, text, text) from public, anon;
grant execute on function public.register_my_notification_device(text, text, text) to authenticated;

-- Turning notifications off removes the address, not just the flag. A member
-- who opts out should not leave a deliverable token behind.
create or replace function public.disable_my_notifications()
returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  update halal_mode_private.notification_devices
  set notifications_enabled = false, push_token = null
  where user_id = auth.uid();
end;
$$;

revoke all on function public.disable_my_notifications() from public, anon;
grant execute on function public.disable_my_notifications() to authenticated;

-- ---------------------------------------------------------------------------
-- The queue
-- ---------------------------------------------------------------------------

create table if not exists halal_mode_private.notification_outbox (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('round_ready', 'mutual_match', 'new_message')),
  -- Never the other member's name or any message text. The notification says
  -- that something happened; the app says what, once the member is inside it.
  payload jsonb not null default '{}'::jsonb,
  -- Not before this instant. Used to hold a message notification back so a
  -- burst of replies is one interruption, and to respect a member's night.
  send_after timestamptz not null default now(),
  sent_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(payload) = 'object')
);

create index if not exists notification_outbox_due_idx
  on halal_mode_private.notification_outbox (send_after)
  where sent_at is null;

revoke all on table halal_mode_private.notification_outbox from public, anon, authenticated;

/**
 * Queue one, unless it would be noise.
 *
 * Collapses against anything already waiting of the same kind for the same
 * member, so ten messages in a minute are one interruption rather than ten.
 */
create or replace function halal_mode_private.enqueue_notification(
  p_user_id uuid,
  p_kind text,
  p_payload jsonb default '{}'::jsonb,
  p_delay interval default interval '0'
) returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
begin
  if p_user_id is null then return; end if;

  -- No device, no consent, nothing to do.
  if not exists (
    select 1 from halal_mode_private.notification_devices d
    where d.user_id = p_user_id and d.notifications_enabled and d.push_token is not null
  ) then
    return;
  end if;

  if exists (
    select 1 from halal_mode_private.notification_outbox o
    where o.user_id = p_user_id and o.kind = p_kind and o.sent_at is null
  ) then
    return;
  end if;

  insert into halal_mode_private.notification_outbox (user_id, kind, payload, send_after)
  values (p_user_id, p_kind, coalesce(p_payload, '{}'::jsonb), now() + coalesce(p_delay, interval '0'));
exception when others then
  -- Queuing must never fail the event that caused it. A match is more
  -- important than telling someone about it.
  return;
end;
$$;

revoke all on function halal_mode_private.enqueue_notification(uuid, text, jsonb, interval)
  from public, anon, authenticated, service_role;

/**
 * Claim a bounded batch for sending.
 *
 * Returns the token so the caller can deliver, and marks the rows attempted so
 * two overlapping runs cannot send the same notification twice.
 */
create or replace function public.claim_notifications_service(p_limit integer default 100)
returns table (id bigint, user_id uuid, kind text, payload jsonb, push_token text, platform text, locale text)
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Sending notifications requires service role' using errcode = '42501';
  end if;

  return query
  with due as (
    select o.id
    from halal_mode_private.notification_outbox o
    where o.sent_at is null
      and o.send_after <= now()
      and o.attempts < 5
    order by o.send_after
    limit greatest(1, least(coalesce(p_limit, 100), 500))
    for update skip locked
  ), claimed as (
    update halal_mode_private.notification_outbox o
    set attempts = o.attempts + 1
    from due where o.id = due.id
    returning o.id, o.user_id, o.kind, o.payload
  )
  select c.id, c.user_id, c.kind, c.payload, d.push_token, d.platform, d.locale
  from claimed c
  join halal_mode_private.notification_devices d
    on d.user_id = c.user_id and d.notifications_enabled and d.push_token is not null;
end;
$$;

revoke all on function public.claim_notifications_service(integer) from public, anon, authenticated;
grant execute on function public.claim_notifications_service(integer) to service_role;

create or replace function public.settle_notifications_service(p_sent bigint[], p_failed jsonb default '[]'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Settling notifications requires service role' using errcode = '42501';
  end if;

  if p_sent is not null and array_length(p_sent, 1) is not null then
    update halal_mode_private.notification_outbox
    set sent_at = now(), last_error = null
    where id = any(p_sent);
  end if;

  update halal_mode_private.notification_outbox o
  set last_error = left(f.error, 300)
  from jsonb_to_recordset(coalesce(p_failed, '[]'::jsonb)) as f(id bigint, error text)
  where o.id = f.id;

  -- A token Apple or Google has rejected is dead. Clearing it stops the queue
  -- retrying against an address that will never work again.
  update halal_mode_private.notification_devices d
  set push_token = null, notifications_enabled = false
  where d.user_id in (
    select o.user_id from halal_mode_private.notification_outbox o
    join jsonb_to_recordset(coalesce(p_failed, '[]'::jsonb)) as f(id bigint, error text) on f.id = o.id
    where f.error ilike '%DeviceNotRegistered%'
  );
end;
$$;

revoke all on function public.settle_notifications_service(bigint[], jsonb) from public, anon, authenticated;
grant execute on function public.settle_notifications_service(bigint[], jsonb) to service_role;
