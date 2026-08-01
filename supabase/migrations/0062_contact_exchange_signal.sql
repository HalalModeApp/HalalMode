-- Contact exchange as an outcome signal.
--
-- Swapping a number is the strongest evidence an introduction actually worked:
-- it is the moment two people choose to continue away from the app. Message
-- volume is a weak proxy — a pair can chat pleasantly for weeks and go nowhere.
--
-- Two paths write the same signal:
--
--   'explicit' — both members used the share control. Mutual and deliberate.
--   'detected' — a number or address appeared in a message.
--
-- Detection is deliberately narrow in scope. It runs in a row-level trigger on
-- the message being inserted, so it sees only the text its author just typed. There
-- is no batch job, no scan across the table, and no historical pass. What
-- matched is never stored and never logged — only that something did, and when.
-- The number itself is never recorded anywhere.

alter table public.connections
  add column if not exists contact_shared_at timestamptz,
  add column if not exists contact_shared_source text
    check (contact_shared_source in ('explicit', 'detected'));

comment on column public.connections.contact_shared_at is
  'When contact details were first exchanged. The details themselves are never stored — this is an outcome signal for matching quality only.';

-- ---------------------------------------------------------------------------
-- Detection
--
-- Simple by design. It recognises the shapes phone numbers actually take in
-- writing — an optional country code, then seven to fifteen digits broken up by
-- spaces, dashes, dots or brackets — plus email addresses.
--
-- Known and accepted misses: numbers spelled out in words ("oh seven nine"),
-- social handles, and numbers sent as an image. Catching those would mean
-- something far more invasive than this, for a signal that is already
-- corroborated by the explicit share control.
--
-- Separators are chosen to exclude dates and verse references: '/' and ':' are
-- absent from the character class, so 12/03/2026 and 2:255 cannot match.
-- ---------------------------------------------------------------------------

create or replace function halal_mode_private.message_contains_contact(p_body text)
returns boolean
language plpgsql
immutable
as $$
declare
  candidate text;
  digits text;
begin
  if p_body is null or length(p_body) < 7 then
    return false;
  end if;

  if p_body ~* '[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}' then
    return true;
  end if;

  for candidate in
    select (match)[1]
    from regexp_matches(p_body, '(\+?\d[\d \-\.\(\)]{5,20}\d)', 'g') as match
  loop
    digits := regexp_replace(candidate, '\D', '', 'g');
    -- Seven digits is the shortest real local number; fifteen is the E.164
    -- maximum. Outside that it is a price, a year, or a list.
    if length(digits) between 7 and 15 then
      return true;
    end if;
  end loop;

  return false;
end;
$$;

comment on function halal_mode_private.message_contains_contact(text) is
  'Whether one message appears to contain a phone number or email. Called only on the row being inserted; never used to scan stored messages.';

create or replace function halal_mode_private.flag_contact_exchange()
returns trigger
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
begin
  -- Only the first exchange is recorded. Once set, later messages are not
  -- re-examined, so a pair that swapped numbers on day two is not re-flagged
  -- every time they mention a figure afterwards.
  if new.body is not null
     and halal_mode_private.message_contains_contact(new.body) then
    update public.connections
    set contact_shared_at = now(),
        contact_shared_source = 'detected'
    where id = new.connection_id
      and contact_shared_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists messages_flag_contact_exchange on public.messages;
create trigger messages_flag_contact_exchange
after insert on public.messages
for each row execute function halal_mode_private.flag_contact_exchange();

-- ---------------------------------------------------------------------------
-- The explicit path
--
-- Both members must ask. Consent is recorded per member and the connection is
-- marked only once the second one agrees, so contact is never revealed by one
-- side acting alone — the same mutual-only shape as the match reveal and the
-- double-blind answers.
-- ---------------------------------------------------------------------------

create table if not exists halal_mode_private.contact_share_consents (
  connection_id uuid not null references public.connections on delete cascade,
  user_id       uuid not null references public.profiles on delete cascade,
  consented_at  timestamptz not null default now(),
  primary key (connection_id, user_id)
);

revoke all on table halal_mode_private.contact_share_consents
  from public, anon, authenticated;

create or replace function public.share_contact_details(p_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_member uuid := auth.uid();
  v_other uuid;
  v_both boolean;
begin
  if v_member is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  select case when user_a = v_member then user_b else user_a end
  into v_other
  from public.connections
  where id = p_connection_id
    and closed_at is null
    and stage = 'open'
    and (user_a = v_member or user_b = v_member);

  if v_other is null then
    raise exception 'Connection not found' using errcode = 'P0002';
  end if;

  insert into halal_mode_private.contact_share_consents (connection_id, user_id)
  values (p_connection_id, v_member)
  on conflict (connection_id, user_id) do nothing;

  select exists (
    select 1 from halal_mode_private.contact_share_consents
    where connection_id = p_connection_id and user_id = v_other
  ) into v_both;

  if v_both then
    update public.connections
    set contact_shared_at = coalesce(contact_shared_at, now()),
        contact_shared_source = coalesce(contact_shared_source, 'explicit')
    where id = p_connection_id;
  end if;

  -- The other member is never told that a request is pending. Learning someone
  -- asked and being able to decline silently are different things, and only the
  -- second is safe.
  return jsonb_build_object('mutual', coalesce(v_both, false));
end;
$$;

revoke all on function halal_mode_private.message_contains_contact(text)
  from public, anon, authenticated;
revoke all on function halal_mode_private.flag_contact_exchange()
  from public, anon, authenticated;
revoke all on function public.share_contact_details(uuid) from public, anon;
grant execute on function public.share_contact_details(uuid) to authenticated;
