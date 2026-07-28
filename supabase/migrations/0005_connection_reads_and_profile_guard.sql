-- Connection read models and profile-integrity guard.
--
-- These functions provide the shapes consumed by the mobile client while
-- preserving the existing privacy boundaries: no internal score, no private
-- preference row, and no other member's answer is returned here.

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

-- RLS can decide which rows a member may update, but it cannot restrict a
-- column within an UPDATE. This trigger keeps membership, verification, and
-- onboarding status server-controlled even if a client crafts a raw REST call.
create or replace function guard_profile_client_update()
returns trigger
language plpgsql
security definer
set search_path = public as $$
begin
  if auth.role() = 'authenticated'
     and (
       new.tier is distinct from old.tier
       or new.is_verified is distinct from old.is_verified
       or new.onboarding_complete is distinct from old.onboarding_complete
     ) then
    raise exception 'Profile field is server controlled'
      using errcode = '42501';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_guard_client_update on profiles;
create trigger profiles_guard_client_update
before update on profiles
for each row execute function guard_profile_client_update();

-- ---------------------------------------------------------------------------
-- Connections
-- ---------------------------------------------------------------------------

-- Kept here because get_connection() exposes a connection's unread state.
-- `if not exists` makes the later receipt migration safe to re-run as well.
alter table messages
  add column if not exists read_at timestamptz;

create or replace function get_connection(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  c connections%rowtype;
  other_profile profiles%rowtype;
  questions jsonb;
begin
  select * into c
  from connections
  where id = p_id
    and closed_at is null
    and (user_a = auth.uid() or user_b = auth.uid());

  if c is null then
    raise exception 'Connection not found' using errcode = 'P0002';
  end if;

  select * into other_profile
  from profiles
  where id = case when c.user_a = auth.uid() then c.user_b else c.user_a end;

  -- Question picks are safe to disclose to both people in the connection. The
  -- answers themselves are intentionally not read here: submit_answer() is the
  -- sole path that can reveal the other member's answer after a commitment.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'questionId', picked.question_id,
        'origin', case
          when picked.picked_by_me and picked.picked_by_them then 'both'
          when picked.picked_by_me then 'me'
          else 'them'
        end,
        'myAnswer', coalesce(own_answer.body, ''),
        'mySubmittedAt', own_answer.submitted_at
      )
      order by picked.question_id
    ),
    '[]'::jsonb
  ) into questions
  from (
    select
      qp.question_id,
      bool_or(qp.user_id = auth.uid()) as picked_by_me,
      bool_or(qp.user_id <> auth.uid()) as picked_by_them
    from question_picks qp
    where qp.connection_id = c.id
    group by qp.question_id
  ) picked
  left join question_answers own_answer
    on own_answer.connection_id = c.id
   and own_answer.question_id = picked.question_id
   and own_answer.user_id = auth.uid();

  return jsonb_build_object(
    'id', c.id,
    'createdAt', c.created_at,
    'stage', c.stage,
    'profile', jsonb_build_object(
      'id', other_profile.id,
      'name', other_profile.name,
      'firstName', other_profile.first_name,
      'age', extract(year from age(other_profile.birth_date)),
      'gender', other_profile.gender,
      'occupation', other_profile.occupation,
      'education', other_profile.education,
      'city', other_profile.city,
      'country', other_profile.country,
      'bio', other_profile.bio,
      'photos', other_profile.photos,
      'chips', other_profile.chips,
      'religiousPractice', other_profile.religious_practice,
      'timeline', other_profile.timeline,
      'relocation', other_profile.relocation,
      'familyGoals', other_profile.family_goals,
      'languagesSpoken', other_profile.languages_spoken,
      'isVerified', other_profile.is_verified,
      'audioGreetingUrl', other_profile.audio_greeting_url,
      'audioDurationSeconds', other_profile.audio_duration_seconds
    ),
    'questions', questions,
    'recap', '[]'::jsonb,
    'lastMessage', (
      select coalesce(m.body, 'Voice note')
      from messages m
      where m.connection_id = c.id
      order by m.created_at desc
      limit 1
    ),
    'lastMessageAt', (
      select m.created_at
      from messages m
      where m.connection_id = c.id
      order by m.created_at desc
      limit 1
    ),
    'unread', exists (
      select 1
      from messages m
      where m.connection_id = c.id
        and m.sender_id <> auth.uid()
        and m.read_at is null
    )
  );
end;
$$;

create or replace function get_connections()
returns setof jsonb
language sql
security definer
set search_path = public as $$
  select get_connection(c.id)
  from connections c
  where c.closed_at is null
    and (c.user_a = auth.uid() or c.user_b = auth.uid())
  order by c.created_at desc;
$$;

grant execute on function get_connection(uuid) to authenticated;
grant execute on function get_connections() to authenticated;
