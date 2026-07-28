-- Close the remaining API boundary gaps without rewriting existing data.
-- Public profile DTOs continue to flow through get_current_round() and
-- get_connection(); raw profile rows are now owner-only.

create extension if not exists supabase_vault;

drop policy if exists "live introduced profiles are readable" on profiles;
drop policy if exists "introduced profiles are readable" on profiles;
drop policy if exists "own profile is writable" on profiles;

revoke insert, update, delete on profiles from public, anon, authenticated;

create or replace function update_my_profile(p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public as $$
declare
  v_unknown_key text;
  v_photos text[];
  v_chips text[];
  v_languages text[];
begin
  if auth.uid() is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Profile changes must be an object' using errcode = '22023';
  end if;

  select key into v_unknown_key
  from jsonb_object_keys(p_patch) as patch_keys(key)
  where key not in (
    'name', 'first_name', 'occupation', 'education', 'city', 'country',
    'bio', 'photos', 'chips', 'religious_practice', 'timeline',
    'relocation', 'family_goals', 'languages_spoken',
    'audio_greeting_url', 'audio_duration_seconds'
  )
  limit 1;
  if v_unknown_key is not null then
    raise exception 'Profile field is server controlled: %', v_unknown_key
      using errcode = '42501';
  end if;

  if p_patch ? 'photos' then
    if jsonb_typeof(p_patch->'photos') <> 'array' or jsonb_array_length(p_patch->'photos') > 6 then
      raise exception 'Choose at most six photos' using errcode = '22023';
    end if;
    select coalesce(array_agg(value), '{}') into v_photos
    from jsonb_array_elements_text(p_patch->'photos') as photo_values(value);
  end if;
  if p_patch ? 'chips' then
    if jsonb_typeof(p_patch->'chips') <> 'array' or jsonb_array_length(p_patch->'chips') > 12 then
      raise exception 'Choose at most twelve profile details' using errcode = '22023';
    end if;
    select coalesce(array_agg(value), '{}') into v_chips
    from jsonb_array_elements_text(p_patch->'chips') as chip_values(value);
  end if;
  if p_patch ? 'languages_spoken' then
    if jsonb_typeof(p_patch->'languages_spoken') <> 'array' or jsonb_array_length(p_patch->'languages_spoken') > 12 then
      raise exception 'Choose at most twelve languages' using errcode = '22023';
    end if;
    select coalesce(array_agg(value), '{}') into v_languages
    from jsonb_array_elements_text(p_patch->'languages_spoken') as language_values(value);
  end if;

  if p_patch ? 'name' and length(trim(p_patch->>'name')) not between 2 and 100 then
    raise exception 'Name must be between 2 and 100 characters' using errcode = '22023';
  end if;
  if p_patch ? 'first_name' and length(trim(p_patch->>'first_name')) not between 1 and 60 then
    raise exception 'First name must be between 1 and 60 characters' using errcode = '22023';
  end if;
  if p_patch ? 'bio' and length(p_patch->>'bio') > 2000 then
    raise exception 'Bio is too long' using errcode = '22023';
  end if;
  if p_patch ? 'audio_duration_seconds'
     and (p_patch->>'audio_duration_seconds')::int not between 1 and 120 then
    raise exception 'Audio greeting must be between 1 and 120 seconds' using errcode = '22023';
  end if;

  update profiles
  set name = case when p_patch ? 'name' then trim(p_patch->>'name') else name end,
      first_name = case when p_patch ? 'first_name' then trim(p_patch->>'first_name') else first_name end,
      occupation = case when p_patch ? 'occupation' then left(trim(p_patch->>'occupation'), 120) else occupation end,
      education = case when p_patch ? 'education' then nullif(left(trim(p_patch->>'education'), 160), '') else education end,
      city = case when p_patch ? 'city' then left(trim(p_patch->>'city'), 100) else city end,
      country = case when p_patch ? 'country' then left(trim(p_patch->>'country'), 100) else country end,
      bio = case when p_patch ? 'bio' then p_patch->>'bio' else bio end,
      photos = case when p_patch ? 'photos' then v_photos else photos end,
      chips = case when p_patch ? 'chips' then v_chips else chips end,
      religious_practice = case when p_patch ? 'religious_practice' then (p_patch->>'religious_practice')::religious_practice else religious_practice end,
      timeline = case when p_patch ? 'timeline' then (p_patch->>'timeline')::marriage_timeline else timeline end,
      relocation = case when p_patch ? 'relocation' then (p_patch->>'relocation')::relocation_preference else relocation end,
      family_goals = case when p_patch ? 'family_goals' then (p_patch->>'family_goals')::family_goals else family_goals end,
      languages_spoken = case when p_patch ? 'languages_spoken' then v_languages else languages_spoken end,
      audio_greeting_url = case when p_patch ? 'audio_greeting_url' then nullif(p_patch->>'audio_greeting_url', '') else audio_greeting_url end,
      audio_duration_seconds = case when p_patch ? 'audio_duration_seconds' then (p_patch->>'audio_duration_seconds')::int else audio_duration_seconds end,
      updated_at = now()
  where id = auth.uid();

  if not found then raise exception 'Profile not found' using errcode = 'P0002'; end if;
end;
$$;

-- Birth date and gender affect legal eligibility and reciprocal matching. They
-- are set once during onboarding and cannot be rewritten by replaying the
-- onboarding RPC or by crafting a raw profile update.
create or replace function guard_profile_client_update()
returns trigger
language plpgsql
security definer
set search_path = public as $$
begin
  if auth.role() = 'authenticated'
     and coalesce(current_setting('app.onboarding_rpc', true), '') <> 'true'
     and coalesce(current_setting('app.account_control_rpc', true), '') <> 'true'
     and (
       new.tier is distinct from old.tier
       or new.is_verified is distinct from old.is_verified
       or new.onboarding_complete is distinct from old.onboarding_complete
       or new.is_paused is distinct from old.is_paused
       or new.birth_date is distinct from old.birth_date
       or new.gender is distinct from old.gender
     ) then
    raise exception 'Profile field is server controlled' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function complete_onboarding(
  p_name text,
  p_first_name text,
  p_birth_date date,
  p_gender text,
  p_city text,
  p_country text
) returns void
language plpgsql
security definer
set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'You must be signed in' using errcode = '42501'; end if;
  if exists (select 1 from profiles where id = v_user_id and onboarding_complete) then
    raise exception 'Onboarding is already complete' using errcode = '42501';
  end if;
  if p_name is null or p_first_name is null
     or length(trim(p_name)) not between 2 and 100
     or length(trim(p_first_name)) not between 1 and 60 then
    raise exception 'Please provide your name' using errcode = '22023';
  end if;
  if p_birth_date is null
     or p_birth_date > current_date - interval '18 years'
     or p_birth_date < current_date - interval '100 years' then
    raise exception 'You must be between 18 and 100 years old' using errcode = '22023';
  end if;
  if p_gender is null or p_gender not in ('male', 'female') then raise exception 'Choose a gender' using errcode = '22023'; end if;
  if p_city is null or p_country is null
     or length(trim(p_city)) not between 2 and 100
     or length(trim(p_country)) not between 2 and 100 then
    raise exception 'Please provide your city and country' using errcode = '22023';
  end if;

  perform set_config('app.onboarding_rpc', 'true', true);
  insert into profiles (id, name, first_name, birth_date, gender, city, country, onboarding_complete)
  values (
    v_user_id, trim(p_name), trim(p_first_name), p_birth_date,
    p_gender::gender, trim(p_city), trim(p_country), true
  )
  on conflict (id) do update set
    name = excluded.name,
    first_name = excluded.first_name,
    birth_date = excluded.birth_date,
    gender = excluded.gender,
    city = excluded.city,
    country = excluded.country,
    onboarding_complete = true,
    updated_at = now()
  where not profiles.onboarding_complete;

  insert into private_preferences (user_id) values (v_user_id)
  on conflict (user_id) do nothing;
  insert into selection_scores (user_id) values (v_user_id)
  on conflict (user_id) do nothing;
end;
$$;

-- One reviewed profile DTO is shared by every cross-member read path. The
-- stored full name, birth date, coordinates, tier, and account flags never
-- cross this boundary. Until a separate preferred-name field exists, the
-- member's first name is used for both legacy client keys.
create or replace function safe_member_profile(p_profile profiles)
returns jsonb
language sql
stable
security definer
set search_path = public as $$
  select jsonb_build_object(
    'id', p_profile.id,
    'name', p_profile.first_name,
    'firstName', p_profile.first_name,
    'age', extract(year from age(p_profile.birth_date)),
    'gender', p_profile.gender,
    'occupation', p_profile.occupation,
    'education', p_profile.education,
    'city', p_profile.city,
    'country', p_profile.country,
    'bio', p_profile.bio,
    'photos', p_profile.photos,
    'chips', p_profile.chips,
    'religiousPractice', p_profile.religious_practice,
    'timeline', p_profile.timeline,
    'relocation', p_profile.relocation,
    'familyGoals', p_profile.family_goals,
    'languagesSpoken', p_profile.languages_spoken,
    'isVerified', p_profile.is_verified,
    'audioGreetingUrl', p_profile.audio_greeting_url,
    'audioDurationSeconds', p_profile.audio_duration_seconds
  );
$$;

create or replace function get_current_round()
returns jsonb
language plpgsql
stable
security definer
set search_path = public as $$
declare
  r rounds%rowtype;
  cards jsonb;
begin
  select * into r
  from rounds
  where user_id = auth.uid()
    and submitted_at is null
    and expires_at > now()
  order by opens_at desc
  limit 1;

  if r is null then return null; end if;

  select coalesce(jsonb_agg(card order by card->>'id'), '[]'::jsonb) into cards
  from (
    select jsonb_build_object(
      'id', i.id,
      'roundId', i.round_id,
      'agreements', i.agreements,
      'profile', safe_member_profile(p)
    ) as card
    from introductions i
    join profiles p on p.id = i.subject_id
    where i.round_id = r.id and i.viewer_id = auth.uid()
  ) cards_q;

  return jsonb_build_object(
    'id', r.id,
    'opensAt', r.opens_at,
    'expiresAt', r.expires_at,
    'tier', r.tier,
    'submitted', false,
    'introductions', cards
  );
end;
$$;

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
  if c is null then raise exception 'Connection not found' using errcode = 'P0002'; end if;

  select * into other_profile
  from profiles
  where id = case when c.user_a = auth.uid() then c.user_b else c.user_a end;

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
      ) order by picked.question_id
    ),
    '[]'::jsonb
  ) into questions
  from (
    select qp.question_id,
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
    'profile', safe_member_profile(other_profile),
    'myQuestionPicksSubmitted', (
      select count(*) = 5 from question_picks qp
      where qp.connection_id = c.id and qp.user_id = auth.uid()
    ),
    'theirQuestionPicksSubmitted', (
      select count(*) = 5 from question_picks qp
      where qp.connection_id = c.id and qp.user_id <> auth.uid()
    ),
    'questions', questions,
    'recap', '[]'::jsonb,
    'lastMessage', (
      select coalesce(m.body, 'Voice note') from messages m
      where m.connection_id = c.id order by m.created_at desc limit 1
    ),
    'lastMessageAt', (
      select m.created_at from messages m
      where m.connection_id = c.id order by m.created_at desc limit 1
    ),
    'unread', exists (
      select 1 from messages m
      where m.connection_id = c.id
        and m.sender_id <> auth.uid()
        and m.read_at is null
    )
  );
end;
$$;

-- Answers remain write-once. A replay returns the authoritative stored answer
-- and timestamp, never the replacement text supplied by the replaying client.
create or replace function submit_answer(
  p_connection_id uuid,
  p_question_id text,
  p_answer text
) returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  other_id uuid;
  their_answer text;
  my_answer text;
  my_submitted_at timestamptz;
  origin text;
begin
  select case when user_a = auth.uid() then user_b else user_a end
  into other_id
  from connections
  where id = p_connection_id
    and closed_at is null
    and stage = 'answering'
    and (user_a = auth.uid() or user_b = auth.uid());

  if other_id is null then raise exception 'Connection is not ready for answers'; end if;
  if p_answer is null or length(trim(p_answer)) not between 10 and 2000 then
    raise exception 'Answer must be between 10 and 2000 characters' using errcode = '22023';
  end if;
  if not exists (
    select 1 from question_picks
    where connection_id = p_connection_id and question_id = p_question_id
  ) then raise exception 'Question was not selected for this connection'; end if;

  insert into question_answers (connection_id, user_id, question_id, body)
  values (p_connection_id, auth.uid(), p_question_id, trim(p_answer))
  on conflict (connection_id, user_id, question_id) do nothing;

  select body, submitted_at into my_answer, my_submitted_at
  from question_answers
  where connection_id = p_connection_id
    and user_id = auth.uid()
    and question_id = p_question_id;

  select body into their_answer from question_answers
  where connection_id = p_connection_id
    and user_id = other_id
    and question_id = p_question_id;

  select case
    when count(*) = 2 then 'both'
    when bool_or(user_id = auth.uid()) then 'me'
    else 'them'
  end into origin
  from question_picks
  where connection_id = p_connection_id and question_id = p_question_id;

  perform refresh_connection_stage_after_answer(p_connection_id);

  return jsonb_build_object(
    'questionId', p_question_id,
    'origin', coalesce(origin, 'both'),
    'myAnswer', my_answer,
    'theirAnswer', their_answer,
    'mySubmittedAt', my_submitted_at
  );
end;
$$;

-- Selection identity is always derived from the introduction. A client can no
-- longer manufacture viewer/subject pairs through the table endpoint.
drop policy if exists "own selections writable" on introduction_selections;
drop policy if exists "own selections updatable" on introduction_selections;
revoke insert, update, delete on introduction_selections from public, anon, authenticated;

create or replace function guard_selection_identity()
returns trigger
language plpgsql
security definer
set search_path = public as $$
begin
  if not exists (
    select 1 from introductions i
    where i.id = new.introduction_id
      and i.viewer_id = new.viewer_id
      and i.subject_id = new.subject_id
  ) then
    raise exception 'Selection does not match its introduction' using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists introduction_selections_identity_guard on introduction_selections;
create trigger introduction_selections_identity_guard
before insert or update of introduction_id, viewer_id, subject_id on introduction_selections
for each row execute function guard_selection_identity();

create or replace function release_introduction(p_introduction_id uuid)
returns void
language plpgsql
security definer
set search_path = public as $$
declare
  v_introduction introductions%rowtype;
begin
  select i.* into v_introduction
  from introductions i
  join rounds r on r.id = i.round_id
  where i.id = p_introduction_id
    and i.viewer_id = auth.uid()
    and r.user_id = auth.uid()
    and r.submitted_at is null
    and r.expires_at > now();

  if v_introduction is null then
    raise exception 'Introduction is not available' using errcode = '42501';
  end if;

  insert into introduction_selections (introduction_id, viewer_id, subject_id, decision)
  values (v_introduction.id, auth.uid(), v_introduction.subject_id, 'released')
  on conflict (introduction_id) do update
    set viewer_id = excluded.viewer_id,
        subject_id = excluded.subject_id,
        decision = 'released',
        decided_at = now()
    where introduction_selections.viewer_id = auth.uid();
end;
$$;

-- Question choices are readable by their owner, but all writes must pass the
-- exact-five and connection checks in submit_question_picks().
drop policy if exists "own question picks" on question_picks;
create policy "own question picks readable"
  on question_picks for select
  using (user_id = auth.uid());
revoke insert, update, delete on question_picks from public, anon, authenticated;

-- SECURITY DEFINER routines default to executable by PUBLIC in PostgreSQL.
-- Make every boundary explicit, including internal-only helpers.
alter default privileges in schema public revoke execute on functions from public;

revoke all on function tier_limits(membership_tier) from public, anon, authenticated;
revoke all on function distance_km(double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke all on function passes_criteria(uuid, uuid) from public, anon, authenticated;
revoke all on function agreement_summary(uuid, uuid) from public, anon, authenticated;
revoke all on function generate_round_for_pairs(timestamptz) from public, anon, authenticated;
revoke all on function expire_stale_rounds() from public, anon, authenticated;
revoke all on function guard_profile_client_update() from public, anon, authenticated;
revoke all on function guard_selection_identity() from public, anon, authenticated;
revoke all on function safe_member_profile(profiles) from public, anon, authenticated;
revoke all on function build_connection_recap(uuid) from public, anon, authenticated;
revoke all on function refresh_connection_stage_after_answer(uuid) from public, anon, authenticated;
revoke all on function set_madinah_fajr_cron(text) from public, anon, authenticated;

revoke all on function get_current_round() from public, anon, authenticated;
revoke all on function submit_round_selections(uuid, uuid[]) from public, anon, authenticated;
revoke all on function submit_question_picks(uuid, text[]) from public, anon, authenticated;
revoke all on function submit_answer(uuid, text, text) from public, anon, authenticated;
revoke all on function close_connection(uuid) from public, anon, authenticated;
revoke all on function get_connection(uuid) from public, anon, authenticated;
revoke all on function get_connections() from public, anon, authenticated;
revoke all on function mark_connection_messages_read(uuid) from public, anon, authenticated;
revoke all on function get_connection_recap(uuid) from public, anon, authenticated;
revoke all on function open_connection(uuid) from public, anon, authenticated;
revoke all on function complete_onboarding(text, text, date, text, text, text) from public, anon, authenticated;
revoke all on function set_my_profile_paused(boolean) from public, anon, authenticated;
revoke all on function update_my_profile(jsonb) from public, anon, authenticated;
revoke all on function release_introduction(uuid) from public, anon, authenticated;

grant execute on function get_current_round() to authenticated;
grant execute on function submit_round_selections(uuid, uuid[]) to authenticated;
grant execute on function submit_question_picks(uuid, text[]) to authenticated;
grant execute on function submit_answer(uuid, text, text) to authenticated;
grant execute on function close_connection(uuid) to authenticated;
grant execute on function get_connection(uuid) to authenticated;
grant execute on function get_connections() to authenticated;
grant execute on function mark_connection_messages_read(uuid) to authenticated;
grant execute on function get_connection_recap(uuid) to authenticated;
grant execute on function open_connection(uuid) to authenticated;
grant execute on function complete_onboarding(text, text, date, text, text, text) to authenticated;
grant execute on function set_my_profile_paused(boolean) to authenticated;
grant execute on function update_my_profile(jsonb) to authenticated;
grant execute on function release_introduction(uuid) to authenticated;

-- Generate one high-entropy scheduler credential inside Vault. pg_cron reads
-- it only while constructing its request; it never appears in source control.
do $$
declare
  -- gen_random_uuid() is available in pg_catalog on the project's Postgres
  -- version. Two UUIDs provide a 244-bit random credential without depending
  -- on where Supabase installed pgcrypto's gen_random_bytes().
  v_secret text := replace(pg_catalog.gen_random_uuid()::text, '-', '')
    || replace(pg_catalog.gen_random_uuid()::text, '-', '');
begin
  if not exists (select 1 from vault.secrets where name = 'halal_mode_round_scheduler') then
    begin
      perform vault.create_secret(
        v_secret,
        'halal_mode_round_scheduler',
        'Authenticates internal Madinah Fajr round jobs'
      );
    exception
      -- A concurrent migration retry may win between the existence check and
      -- insertion. Keeping the already-created credential is the safe result.
      when unique_violation then null;
    end;
  end if;
end;
$$;

create or replace function verify_round_scheduler_secret(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = public, vault as $$
  select coalesce(
    p_secret = (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'halal_mode_round_scheduler'
      order by created_at desc
      limit 1
    ),
    false
  );
$$;
revoke all on function verify_round_scheduler_secret(text) from public, anon, authenticated;
grant execute on function verify_round_scheduler_secret(text) to service_role;

do $$
declare
  v_fajr_schedule text := coalesce(
    (select schedule from cron.job where jobname = 'halal-mode-madinah-fajr'),
    '0 2 * * *'
  );
begin
  if exists (select 1 from cron.job where jobname = 'halal-mode-madinah-fajr') then
    perform cron.unschedule('halal-mode-madinah-fajr');
  end if;
  if exists (select 1 from cron.job where jobname = 'halal-mode-madinah-fajr-planner') then
    perform cron.unschedule('halal-mode-madinah-fajr-planner');
  end if;

  perform cron.schedule(
    'halal-mode-madinah-fajr',
    v_fajr_schedule,
    $job$
      select net.http_post(
        url := 'https://rikqvwwhuwstanngsihs.supabase.co/functions/v1/generate-round',
        headers := jsonb_build_object(
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'halal_mode_round_scheduler' order by created_at desc limit 1),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb
      );
    $job$
  );

  perform cron.schedule(
    'halal-mode-madinah-fajr-planner',
    '30 0,1 * * *',
    $job$
      select net.http_post(
        url := 'https://rikqvwwhuwstanngsihs.supabase.co/functions/v1/generate-round?mode=plan',
        headers := jsonb_build_object(
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'halal_mode_round_scheduler' order by created_at desc limit 1),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb
      );
    $job$
  );
end;
$$;
