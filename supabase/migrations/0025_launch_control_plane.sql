-- Server-only records for future providers. None of these tables are exposed
-- through PostgREST; a provider integration must use audited service routines.

create type entitlement_state as enum ('active', 'grace', 'expired', 'revoked');
create type verification_state as enum ('unverified', 'pending', 'verified', 'failed', 'expired');

create table halal_mode_private.member_entitlements (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  tier membership_tier not null default 'free',
  state entitlement_state not null default 'expired',
  provider text,
  provider_reference_hash text,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((state in ('active', 'grace')) = (tier = 'premium')),
  check (provider is null or provider ~ '^[a-z0-9_-]{2,40}$')
);

create table halal_mode_private.member_verifications (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  state verification_state not null default 'unverified',
  provider text,
  provider_reference_hash text,
  verified_at timestamptz,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  check (provider is null or provider ~ '^[a-z0-9_-]{2,40}$')
);

create table halal_mode_private.notification_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text not null check (platform in ('ios', 'android')),
  token_hash text not null,
  locale text not null default 'en',
  notifications_enabled boolean not null default false,
  quiet_hours_start smallint check (quiet_hours_start between 0 and 1439),
  quiet_hours_end smallint check (quiet_hours_end between 0 and 1439),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, platform, token_hash)
);

create table halal_mode_private.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  subject_id uuid references public.profiles(id) on delete set null,
  event_type text not null check (event_type ~ '^[a-z][a-z0-9_]{2,80}$'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(metadata) = 'object')
);

create table halal_mode_private.release_flags (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{2,80}$'),
  enabled boolean not null default false,
  rollout_percentage smallint not null default 0 check (rollout_percentage between 0 and 100),
  updated_at timestamptz not null default now()
);

insert into halal_mode_private.release_flags (key) values
  ('in_chat_voice_notes'), ('live_calling'), ('push_notifications'),
  ('identity_verification'), ('premium_purchases'), ('controlled_beta')
on conflict (key) do nothing;

create or replace function halal_mode_private.apply_membership_entitlement(
  p_user_id uuid,
  p_tier membership_tier,
  p_state entitlement_state,
  p_provider text,
  p_provider_reference_hash text,
  p_expires_at timestamptz
) returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Entitlements require service role' using errcode = '42501';
  end if;
  if (p_state in ('active', 'grace')) <> (p_tier = 'premium') then
    raise exception 'Entitlement state and tier are inconsistent' using errcode = '22023';
  end if;

  insert into member_entitlements (user_id, tier, state, provider, provider_reference_hash, expires_at)
  values (p_user_id, p_tier, p_state, p_provider, p_provider_reference_hash, p_expires_at)
  on conflict (user_id) do update set
    tier = excluded.tier,
    state = excluded.state,
    provider = excluded.provider,
    provider_reference_hash = excluded.provider_reference_hash,
    expires_at = excluded.expires_at,
    updated_at = now();

  update public.profiles set tier = p_tier where id = p_user_id;
  if not found then raise exception 'Profile not found' using errcode = 'P0002'; end if;

  insert into audit_events (actor_id, subject_id, event_type, metadata)
  values (null, p_user_id, 'membership_entitlement_applied', jsonb_build_object('tier', p_tier, 'state', p_state));
end;
$$;

create or replace function get_my_membership_entitlement()
returns jsonb
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  select jsonb_build_object(
    'tier', coalesce(e.tier, p.tier),
    'state', coalesce(e.state::text, case when p.tier = 'premium' then 'active' else 'expired' end),
    'expiresAt', e.expires_at
  )
  from public.profiles p
  left join halal_mode_private.member_entitlements e on e.user_id = p.id
  where p.id = auth.uid();
$$;

revoke all on table halal_mode_private.member_entitlements,
  halal_mode_private.member_verifications,
  halal_mode_private.notification_devices,
  halal_mode_private.audit_events,
  halal_mode_private.release_flags from public, anon, authenticated;
revoke all on function halal_mode_private.apply_membership_entitlement(uuid, membership_tier, entitlement_state, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function get_my_membership_entitlement() from public, anon;
-- Edge Functions use the service role for provider webhooks and scheduled
-- jobs. Grant it explicitly: revoking PUBLIC must not silently break Fajr
-- generation or entitlement reconciliation in production.
grant execute on function halal_mode_private.apply_membership_entitlement(uuid, membership_tier, entitlement_state, text, text, timestamptz)
  to service_role;
grant execute on function get_my_membership_entitlement() to authenticated;
