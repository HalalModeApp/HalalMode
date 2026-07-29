-- A client request id lets a persisted mobile outbox retry safely after an
-- interrupted network request without producing a duplicate message.

alter table messages add column client_request_id text;
alter table messages add constraint messages_client_request_id_format
  check (client_request_id is null or client_request_id ~ '^[a-zA-Z0-9_-]{12,80}$');
create unique index messages_sender_request_idx
  on messages (connection_id, sender_id, client_request_id)
  where client_request_id is not null;

drop function send_message(uuid, text);

create or replace function send_message(
  p_connection_id uuid,
  p_body text,
  p_client_request_id text default null
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
  if p_client_request_id is not null and p_client_request_id !~ '^[a-zA-Z0-9_-]{12,80}$' then
    raise exception 'Client request id is invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_sender::text, 1818));

  select case when c.user_a = v_sender then c.user_b else c.user_a end
  into v_other
  from connections c
  where c.id = p_connection_id
    and c.closed_at is null
    and c.stage = 'open'
    and (c.user_a = v_sender or c.user_b = v_sender)
  for update;

  if v_other is null or exists (
    select 1 from blocks b
    where (b.blocker_id = v_sender and b.blocked_id = v_other)
       or (b.blocker_id = v_other and b.blocked_id = v_sender)
  ) then
    raise exception 'Connection is not available' using errcode = '42501';
  end if;

  if p_client_request_id is not null then
    select * into v_message from messages
    where connection_id = p_connection_id
      and sender_id = v_sender
      and client_request_id = p_client_request_id;
    if found then return to_jsonb(v_message); end if;
  end if;

  if (select count(*) from messages
      where sender_id = v_sender and created_at > now() - interval '1 minute') >= 20
  then raise exception 'Please wait before sending more messages' using errcode = 'P0001'; end if;
  if (select count(*) from messages
      where sender_id = v_sender and created_at > now() - interval '24 hours') >= 500
  then raise exception 'Daily message limit reached' using errcode = 'P0001'; end if;

  insert into messages (connection_id, sender_id, body, client_request_id)
  values (p_connection_id, v_sender, v_body, p_client_request_id)
  returning * into v_message;

  return to_jsonb(v_message);
end;
$$;

revoke all on function send_message(uuid, text, text) from public, anon;
grant execute on function send_message(uuid, text, text) to authenticated;
