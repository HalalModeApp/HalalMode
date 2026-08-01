-- Hiding someone you are already talking to has to end the conversation.
--
-- 0071 stopped a hidden pair being introduced again, which is the whole story
-- on an introduction card but only half of it inside a connection: the member
-- who just said "hide us from each other" would still be sitting in an open
-- chat with them. Leaving that open is worse than not offering the action.
--
-- The other member sees the connection closed, which is exactly what they would
-- see if it had been closed the ordinary way. They are not told why, and they
-- are not told they were hidden — the silence the feature promises is about the
-- reason, not about the conversation vanishing without explanation.
--
-- Reuses close_connection rather than repeating its update, because closing also
-- promotes anyone waiting on capacity. A copied `set closed_at = now()` would
-- look right and quietly leak a connection slot every time it ran.

create or replace function public.hide_connection_member(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_viewer uuid := auth.uid();
  v_subject uuid;
begin
  if v_viewer is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  perform halal_mode_private.require_current_legal_consents(v_viewer);

  v_subject := halal_mode_private.connection_other_member(p_connection_id);
  if v_subject is null then
    raise exception 'Connection is not available' using errcode = '42501';
  end if;

  perform halal_mode_private.hide_pair(v_viewer, v_subject);

  -- Guarded because closing an already-closed connection raises. Hiding someone
  -- from a conversation that ended months ago is a perfectly ordinary thing to
  -- want, and it must not fail on the way out.
  if exists (
    select 1 from public.connections
    where id = p_connection_id and closed_at is null
  ) then
    perform halal_mode_private.close_connection_after_legal_consent(p_connection_id);
  end if;
end;
$$;

revoke all on function public.hide_connection_member(uuid) from public, anon;
grant execute on function public.hide_connection_member(uuid) to authenticated;
