-- Server-owned text messaging. Clients may read rows allowed by RLS, but can
-- only create messages through send_message().

create index if not exists messages_sender_created_idx
  on messages (sender_id, created_at desc);

-- Blocking is terminal for an existing connection. Keeping this in the
-- database means every client and realtime subscriber observes the same rule.
create or replace function halal_mode_private.close_connections_after_block()
returns trigger
language plpgsql
security definer
set search_path = public as $$
begin
  update connections
  set closed_at = coalesce(closed_at, now()),
      stage = 'closed'
  where closed_at is null
    and (
      (user_a = new.blocker_id and user_b = new.blocked_id)
      or (user_a = new.blocked_id and user_b = new.blocker_id)
    );
  return new;
end;
$$;

revoke all on function halal_mode_private.close_connections_after_block()
  from public, anon, authenticated;

drop trigger if exists close_connections_after_block on blocks;
create trigger close_connections_after_block
after insert on blocks
for each row execute function halal_mode_private.close_connections_after_block();

drop policy if exists "send to own open connections" on messages;
drop policy if exists "messages in own open connections" on messages;
create policy "messages in own unblocked open connections"
on messages for select to authenticated
using (
  exists (
    select 1
    from connections c
    where c.id = messages.connection_id
      and c.closed_at is null
      and c.stage = 'open'
      and (c.user_a = auth.uid() or c.user_b = auth.uid())
      and not exists (
        select 1 from blocks b
        where (b.blocker_id = c.user_a and b.blocked_id = c.user_b)
           or (b.blocker_id = c.user_b and b.blocked_id = c.user_a)
      )
  )
);

-- Supabase's API roles normally receive table grants outside migrations. Make
-- the write boundary explicit even if those defaults change later.
revoke insert, update, delete on table messages from public, anon, authenticated;

create or replace function send_message(
  p_connection_id uuid,
  p_body text
) returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_sender uuid := auth.uid();
  v_other uuid;
  v_body text := trim(p_body);
  v_message messages%rowtype;
begin
  if v_sender is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if v_body is null or v_body = '' then
    raise exception 'Message cannot be empty' using errcode = '22023';
  end if;
  if char_length(v_body) > 2000 then
    raise exception 'Message is too long' using errcode = '22001';
  end if;

  -- Serializes bursts from one account so parallel requests cannot trivially
  -- race past the rolling limits.
  perform pg_advisory_xact_lock(hashtextextended(v_sender::text, 1818));

  select case when c.user_a = v_sender then c.user_b else c.user_a end
  into v_other
  from connections c
  where c.id = p_connection_id
    and c.closed_at is null
    and c.stage = 'open'
    and (c.user_a = v_sender or c.user_b = v_sender)
  for update;

  if v_other is null then
    raise exception 'Connection is not available' using errcode = '42501';
  end if;
  if exists (
    select 1 from blocks b
    where (b.blocker_id = v_sender and b.blocked_id = v_other)
       or (b.blocker_id = v_other and b.blocked_id = v_sender)
  ) then
    raise exception 'Connection is not available' using errcode = '42501';
  end if;

  if (select count(*) from messages
      where sender_id = v_sender and created_at > now() - interval '1 minute') >= 20
  then
    raise exception 'Please wait before sending more messages' using errcode = 'P0001';
  end if;
  if (select count(*) from messages
      where sender_id = v_sender and created_at > now() - interval '24 hours') >= 500
  then
    raise exception 'Daily message limit reached' using errcode = 'P0001';
  end if;

  insert into messages (connection_id, sender_id, body)
  values (p_connection_id, v_sender, v_body)
  returning * into v_message;

  return to_jsonb(v_message);
end;
$$;

-- Read receipts remain server-owned and can only affect messages sent by the
-- other member of an active, unblocked connection.
create or replace function mark_connection_messages_read(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = public as $$
declare
  v_other uuid;
begin
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

  update messages
  set read_at = now()
  where connection_id = p_connection_id
    and sender_id = v_other
    and read_at is null;
end;
$$;

revoke all on function send_message(uuid, text) from public, anon, authenticated;
revoke all on function mark_connection_messages_read(uuid) from public, anon, authenticated;
grant execute on function send_message(uuid, text) to authenticated;
grant execute on function mark_connection_messages_read(uuid) to authenticated;
