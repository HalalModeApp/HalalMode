-- Members can take safety actions only against the other person in one of
-- their connections; the server derives the subject rather than trusting an id.

create or replace function halal_mode_private.connection_other_member(p_connection_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public as $$
  select case when c.user_a = auth.uid() then c.user_b else c.user_a end
  from connections c
  where c.id = p_connection_id
    and (c.user_a = auth.uid() or c.user_b = auth.uid());
$$;

create or replace function report_connection_member(
  p_connection_id uuid,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare v_subject uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_reason not in ('harassment', 'misrepresentation', 'safety_concern', 'other') then
    raise exception 'Report reason is invalid' using errcode = '22023';
  end if;
  select halal_mode_private.connection_other_member(p_connection_id) into v_subject;
  if v_subject is null then raise exception 'Connection is not available' using errcode = '42501'; end if;
  insert into reports (reporter_id, subject_id, reason) values (auth.uid(), v_subject, p_reason);
end;
$$;

create or replace function block_connection_member(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare v_subject uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select halal_mode_private.connection_other_member(p_connection_id) into v_subject;
  if v_subject is null then raise exception 'Connection is not available' using errcode = '42501'; end if;
  insert into blocks (blocker_id, blocked_id) values (auth.uid(), v_subject)
  on conflict (blocker_id, blocked_id) do nothing;
end;
$$;

revoke all on function halal_mode_private.connection_other_member(uuid) from public, anon, authenticated;
revoke all on function report_connection_member(uuid, text) from public, anon;
revoke all on function block_connection_member(uuid) from public, anon;
grant execute on function report_connection_member(uuid, text) to authenticated;
grant execute on function block_connection_member(uuid) to authenticated;
