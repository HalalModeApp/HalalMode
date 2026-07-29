-- Bound chat history avoids unbounded client reads while retaining a stable,
-- connection-scoped cursor. The relationship check remains server-side.

create index if not exists messages_connection_cursor_idx
  on messages (connection_id, created_at desc, id desc);

create or replace function get_connection_messages(
  p_connection_id uuid,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
) returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_other uuid;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_limit < 1 or p_limit > 100 then
    raise exception 'Page size is invalid' using errcode = '22023';
  end if;
  if (p_before_at is null) <> (p_before_id is null) then
    raise exception 'Cursor is incomplete' using errcode = '22023';
  end if;

  select case when c.user_a = auth.uid() then c.user_b else c.user_a end
  into v_other
  from connections c
  where c.id = p_connection_id
    and c.closed_at is null
    and c.stage = 'open'
    and (c.user_a = auth.uid() or c.user_b = auth.uid());

  if v_other is null or exists (
    select 1 from blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = v_other)
       or (b.blocker_id = v_other and b.blocked_id = auth.uid())
  ) then
    raise exception 'Connection is not available' using errcode = '42501';
  end if;

  with ranked as (
    select m.*, row_number() over (order by m.created_at desc, m.id desc) as position
    from messages m
    where m.connection_id = p_connection_id
      and (p_before_at is null or (m.created_at, m.id) < (p_before_at, p_before_id))
    order by m.created_at desc, m.id desc
    limit p_limit + 1
  ), page as (
    select * from ranked where position <= p_limit
  ), oldest as (
    select created_at, id from page order by created_at asc, id asc limit 1
  )
  select jsonb_build_object(
    'messages', coalesce((select jsonb_agg(to_jsonb(page) - 'position' order by created_at asc, id asc) from page), '[]'::jsonb),
    'hasMore', exists (select 1 from ranked where position > p_limit),
    'nextCursor', case when exists (select 1 from ranked where position > p_limit)
      then (select jsonb_build_object('createdAt', created_at, 'id', id) from oldest)
      else null end
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function get_connection_messages(uuid, timestamptz, uuid, integer) from public, anon;
grant execute on function get_connection_messages(uuid, timestamptz, uuid, integer) to authenticated;
