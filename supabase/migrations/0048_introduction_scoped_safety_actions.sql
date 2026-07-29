-- Safety actions from a daily introduction accept only the introduction id.
-- The server derives the other member from the caller's current round so a
-- client can never report or block an arbitrary profile id.

create or replace function halal_mode_private.current_introduction_subject(
  p_introduction_id uuid
) returns uuid
language sql
stable
security definer
set search_path = public as $$
  select i.subject_id
  from public.introductions i
  join public.rounds r on r.id = i.round_id
  where i.id = p_introduction_id
    and i.viewer_id = auth.uid()
    and r.user_id = auth.uid()
    and r.submitted_at is null
    and r.expires_at > now()
  limit 1;
$$;

revoke all on function halal_mode_private.current_introduction_subject(uuid)
  from public, anon, authenticated;

-- RLS evaluates block-table subqueries as the caller, whose own-block policy
-- intentionally cannot reveal an incoming block. This reviewed helper checks
-- both directions as a definer without returning either member id.
create or replace function halal_mode_private.can_read_current_introduction(
  p_introduction_id uuid
) returns boolean
language sql
stable
security definer
set search_path = public as $$
  select exists (
    select 1
    from public.introductions i
    join public.rounds r on r.id = i.round_id
    where i.id = p_introduction_id
      and i.viewer_id = auth.uid()
      and r.user_id = auth.uid()
      and r.submitted_at is null
      and r.expires_at > now()
      and not exists (
        select 1
        from public.blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = i.subject_id)
           or (b.blocker_id = i.subject_id and b.blocked_id = auth.uid())
      )
  );
$$;

revoke all on function halal_mode_private.can_read_current_introduction(uuid)
  from public, anon, authenticated;
grant execute on function halal_mode_private.can_read_current_introduction(uuid)
  to authenticated;

create or replace function public.report_introduction_member(
  p_introduction_id uuid,
  p_reason text
) returns void
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

  if p_reason is null or p_reason not in (
    'harassment', 'misrepresentation', 'safety_concern', 'other'
  ) then
    raise exception 'Report reason is invalid' using errcode = '22023';
  end if;

  v_subject := halal_mode_private.current_introduction_subject(p_introduction_id);
  if v_subject is null then
    raise exception 'Introduction is not available' using errcode = '42501';
  end if;

  insert into public.reports (reporter_id, subject_id, reason)
  values (v_viewer, v_subject, p_reason);
end;
$$;

create or replace function public.block_introduction_member(
  p_introduction_id uuid
) returns void
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

  insert into public.blocks (blocker_id, blocked_id)
  values (v_viewer, v_subject)
  on conflict (blocker_id, blocked_id) do nothing;

  -- Introduction rows are intentionally retained as private audit/matching
  -- history. The block is the source of truth that hides both directions.
end;
$$;

revoke all on function public.report_introduction_member(uuid, text)
  from public, anon, authenticated;
revoke all on function public.block_introduction_member(uuid)
  from public, anon, authenticated;
grant execute on function public.report_introduction_member(uuid, text)
  to authenticated;
grant execute on function public.block_introduction_member(uuid)
  to authenticated;

-- Hide blocked introduction rows from direct RLS reads in both directions.
-- The rows remain in place for audit and matching-history integrity.
drop policy if exists "own introductions" on public.introductions;
create policy "own introductions"
  on public.introductions for select
  to authenticated
  using (
    viewer_id = auth.uid()
    and halal_mode_private.can_read_current_introduction(id)
  );

-- get_current_round() is SECURITY DEFINER and therefore needs the same block
-- filter explicitly rather than relying on the RLS policy above.
create or replace function public.get_current_round()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, halal_mode_private as $$
declare
  r rounds%rowtype;
  cards jsonb;
begin
  if auth.uid() is null
     or not halal_mode_private.member_has_current_legal_consents(auth.uid())
     or not profile_is_ready_for_matching(auth.uid()) then
    return null;
  end if;

  select * into r
  from rounds
  where user_id = auth.uid() and submitted_at is null and expires_at > now()
  order by opens_at desc limit 1;
  if r is null then return null; end if;

  select coalesce(jsonb_agg(card order by card->>'id'), '[]'::jsonb) into cards
  from (
    select jsonb_build_object(
      'id', i.id, 'roundId', i.round_id, 'agreements', i.agreements,
      'profile', safe_member_profile(p)
    ) as card
    from introductions i
    join profiles p on p.id = i.subject_id
    where i.round_id = r.id
      and i.viewer_id = auth.uid()
      and not exists (
        select 1
        from blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = i.subject_id)
           or (b.blocker_id = i.subject_id and b.blocked_id = auth.uid())
      )
  ) cards_q;

  return jsonb_build_object(
    'id', r.id, 'opensAt', r.opens_at, 'expiresAt', r.expires_at,
    'tier', r.tier, 'submitted', false, 'introductions', cards
  );
end;
$$;

revoke all on function public.get_current_round() from public, anon;
grant execute on function public.get_current_round() to authenticated;
