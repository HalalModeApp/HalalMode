-- The member leaves matching immediately, but permanent Auth/media erasure is
-- not eligible until the approved 30-day recovery window has elapsed.
create or replace function public.claim_account_deletion_requests(p_limit integer default 25)
returns table (user_id uuid, photo_paths text[], voice_path text)
language plpgsql security definer set search_path = public, halal_mode_private as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Deletion finalization requires service role' using errcode = '42501'; end if;
  if p_limit < 1 or p_limit > 100 then raise exception 'Limit must be between 1 and 100' using errcode = '22023'; end if;
  return query
  with candidates as (
    select r.user_id from account_deletion_requests r
    where r.processed_at is null
      and r.requested_at <= now() - interval '30 days'
      and (r.processing_started_at is null or r.processing_started_at < now() - interval '15 minutes')
    order by r.requested_at limit p_limit for update skip locked
  ), claimed as (
    update account_deletion_requests r set processing_started_at = now(), attempts = r.attempts + 1, last_error = null
    from candidates c where r.user_id = c.user_id returning r.user_id
  )
  select c.user_id, p.photos, p.audio_greeting_url from claimed c join public.profiles p on p.id = c.user_id;
end;
$$;

revoke all on function public.claim_account_deletion_requests(integer) from public, anon, authenticated;
grant execute on function public.claim_account_deletion_requests(integer) to service_role;
