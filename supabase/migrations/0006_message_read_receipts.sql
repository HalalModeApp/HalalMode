-- Delivery/read receipts are private to the two people in an open connection.
-- The sender sees `read_at`; no third party can infer conversation activity.

alter table messages
  add column if not exists read_at timestamptz;

create or replace function mark_connection_messages_read(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = public as $$
begin
  if not exists (
    select 1 from connections
    where id = p_connection_id
      and closed_at is null
      and stage = 'open'
      and (user_a = auth.uid() or user_b = auth.uid())
  ) then
    raise exception 'Not your open connection' using errcode = '42501';
  end if;

  update messages
  set read_at = now()
  where connection_id = p_connection_id
    and sender_id <> auth.uid()
    and read_at is null;
end;
$$;

grant execute on function mark_connection_messages_read(uuid) to authenticated;
