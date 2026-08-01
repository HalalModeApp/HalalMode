-- Re-key hiding onto the relationship, not the member id.
--
-- 0070 shipped `hide_member(p_subject_id uuid)`, which is the one shape every
-- other safety action in this schema deliberately avoids. 0030 states the rule
-- in its first line: the server derives the subject rather than trusting an id.
-- Reporting and blocking both take a connection or introduction id and resolve
-- the other member from it, so a caller can only act on someone they can be
-- shown to be in a relationship with — holding a stranger's uuid grants nothing.
--
-- 0070's version guarded itself by checking for an introduction or connection
-- before writing, which reaches the same place, but only because that check
-- happened to be written. The relationship-keyed form cannot be got wrong: there
-- is no parameter in which to pass a stranger.
--
-- Dropped rather than deprecated. It is a day old, nothing calls it, and an
-- unused member-id entry point is exactly the kind of thing that gets picked up
-- later by someone who assumes it is the intended route.

drop function if exists public.hide_member(uuid);

create or replace function halal_mode_private.hide_pair(p_viewer uuid, p_subject uuid)
returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
begin
  if p_viewer is null or p_subject is null or p_viewer = p_subject then
    raise exception 'A member cannot be hidden from themselves' using errcode = '22023';
  end if;

  insert into halal_mode_private.member_hides (hider_id, hidden_id)
  values (p_viewer, p_subject)
  on conflict (hider_id, hidden_id) do nothing;

  -- Retire the pair outright as well. A hidden pair should never be reconsidered
  -- by the repeat logic, whatever its score does later.
  insert into halal_mode_private.pair_exposure as pe (
    user_low, user_high, retired_at, retired_reason
  )
  values (
    least(p_viewer, p_subject), greatest(p_viewer, p_subject),
    now(), 'hidden'
  )
  on conflict (user_low, user_high) do update
    set retired_at = coalesce(pe.retired_at, now()),
        retired_reason = coalesce(pe.retired_reason, 'hidden');
end;
$$;

create or replace function public.hide_introduction_member(p_introduction_id uuid)
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

  v_subject := halal_mode_private.current_introduction_subject(p_introduction_id);
  if v_subject is null then
    raise exception 'Introduction is not available' using errcode = '42501';
  end if;

  perform halal_mode_private.hide_pair(v_viewer, v_subject);
end;
$$;

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
end;
$$;

comment on function public.hide_introduction_member(uuid) is
  'Hides the other member of an introduction, in both directions, permanently and silently. For recognising someone in real life; carries no moderation meaning, unlike block_introduction_member.';
comment on function public.hide_connection_member(uuid) is
  'Hides the other member of a connection, in both directions, permanently and silently. For recognising someone in real life; carries no moderation meaning, unlike block_connection_member.';

revoke all on function halal_mode_private.hide_pair(uuid, uuid) from public, anon, authenticated;
revoke all on function public.hide_introduction_member(uuid) from public, anon;
revoke all on function public.hide_connection_member(uuid) from public, anon;
grant execute on function public.hide_introduction_member(uuid) to authenticated;
grant execute on function public.hide_connection_member(uuid) to authenticated;
