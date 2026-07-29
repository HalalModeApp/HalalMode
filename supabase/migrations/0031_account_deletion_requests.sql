-- A deletion request immediately removes a member from matching and contact.
-- Final auth/media erasure is intentionally handled by a separately audited
-- service job, never by an unauthenticated client request.

create table halal_mode_private.account_deletion_requests (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function request_my_account_deletion()
returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  update profiles set is_paused = true, updated_at = now() where id = auth.uid();
  if not found then raise exception 'Profile not found' using errcode = 'P0002'; end if;
  update connections
  set closed_at = coalesce(closed_at, now()), stage = 'closed'
  where closed_at is null and (user_a = auth.uid() or user_b = auth.uid());
  insert into account_deletion_requests (user_id)
  values (auth.uid())
  on conflict (user_id) do update set requested_at = excluded.requested_at, processed_at = null;
  insert into audit_events (actor_id, subject_id, event_type)
  values (auth.uid(), auth.uid(), 'account_deletion_requested');
end;
$$;

revoke all on table halal_mode_private.account_deletion_requests from public, anon, authenticated;
revoke all on function request_my_account_deletion() from public, anon;
grant execute on function request_my_account_deletion() to authenticated;
