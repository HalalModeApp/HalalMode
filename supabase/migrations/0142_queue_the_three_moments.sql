-- Queue a notification when the three things worth interrupting for happen.
--
-- Triggers rather than call sites, because a call site can be added later and
-- forgotten — which is how this codebase ended up with a pass nobody wrote and
-- an expiry nobody called. A trigger fires for every path that creates the
-- row, including one written next year.

create or replace function halal_mode_private.notify_round_ready()
returns trigger
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
begin
  -- Held until the round actually opens. Rounds are now built ahead of time
  -- and revealed at each member's own dawn, so sending on insert would wake
  -- somebody hours early to tell them about a set they cannot open yet.
  perform halal_mode_private.enqueue_notification(
    new.user_id, 'round_ready', '{}'::jsonb,
    greatest(new.opens_at - now(), interval '0')
  );
  return new;
end;
$$;

drop trigger if exists notify_round_ready on public.rounds;
create trigger notify_round_ready
  after insert on public.rounds
  for each row execute function halal_mode_private.notify_round_ready();

create or replace function halal_mode_private.notify_mutual_match()
returns trigger
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
begin
  -- Both sides. A connection exists only when interest was returned, so this
  -- is the one moment where telling someone reveals nothing they should not
  -- know — and it is the moment the whole app exists for.
  perform halal_mode_private.enqueue_notification(new.user_a, 'mutual_match');
  perform halal_mode_private.enqueue_notification(new.user_b, 'mutual_match');
  return new;
end;
$$;

drop trigger if exists notify_mutual_match on public.connections;
create trigger notify_mutual_match
  after insert on public.connections
  for each row execute function halal_mode_private.notify_mutual_match();

create or replace function halal_mode_private.notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_recipient uuid;
begin
  select case when c.user_a = new.sender_id then c.user_b else c.user_a end
  into v_recipient
  from public.connections c
  where c.id = new.connection_id;

  if v_recipient is null then return new; end if;

  -- Two minutes late on purpose. Someone typing three messages in a row is one
  -- conversation, not three interruptions, and `enqueue_notification` collapses
  -- anything already waiting of the same kind.
  perform halal_mode_private.enqueue_notification(
    v_recipient, 'new_message', '{}'::jsonb, interval '2 minutes'
  );
  return new;
end;
$$;

drop trigger if exists notify_new_message on public.messages;
create trigger notify_new_message
  after insert on public.messages
  for each row execute function halal_mode_private.notify_new_message();

do $$
begin
  assert (select count(*) from pg_trigger
          where tgname in ('notify_round_ready', 'notify_mutual_match', 'notify_new_message')
            and not tgisinternal) = 3,
    'all three notification triggers should exist';
end;
$$;
