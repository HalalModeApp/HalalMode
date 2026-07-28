-- Server-side logic. Everything here is `security definer` because it must read
-- tables the caller cannot: private preferences on both sides, selection
-- scores, and the other member's unrevealed answers.
--
-- Each function returns only derived, disclosable output. None of them ever
-- return a preference row, a score, or an un-earned answer.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function tier_limits(p_tier membership_tier)
returns table (introductions int, keeps int, open_connections int)
language sql immutable as $$
  select case when p_tier = 'plus' then 10 else 5 end,
         case when p_tier = 'plus' then 3 else 1 end,
         case when p_tier = 'plus' then 5 else 3 end;
$$;

/**
 * Great-circle distance in kilometres. Good enough for a radius filter; not
 * worth a PostGIS dependency for what is effectively a coarse bucket.
 */
create or replace function distance_km(
  lat1 double precision, lon1 double precision,
  lat2 double precision, lon2 double precision
) returns double precision
language sql immutable as $$
  select 6371 * acos(
    least(1, greatest(-1,
      cos(radians(lat1)) * cos(radians(lat2)) * cos(radians(lon2) - radians(lon1))
      + sin(radians(lat1)) * sin(radians(lat2))
    ))
  );
$$;

/**
 * True when `viewer` would accept `subject` on the viewer's own private
 * criteria. One-directional — the matcher calls it both ways and requires both.
 */
create or replace function passes_criteria(p_viewer uuid, p_subject uuid)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v private_preferences%rowtype;
  s profiles%rowtype;
  vp profiles%rowtype;
  s_prefs private_preferences%rowtype;
  s_age int;
begin
  select * into v from private_preferences where user_id = p_viewer;
  select * into vp from profiles where id = p_viewer;
  select * into s from profiles where id = p_subject;
  select * into s_prefs from private_preferences where user_id = p_subject;

  if v is null or s is null then return false; end if;

  -- Opposite gender only, and never someone paused or mid-onboarding.
  if s.gender = vp.gender then return false; end if;
  if s.is_paused or not s.onboarding_complete then return false; end if;

  s_age := extract(year from age(s.birth_date));
  if s_age < v.min_age or s_age > v.max_age then return false; end if;

  -- Height and build come from the subject's *private* row. This is the whole
  -- reason the function is security definer: the viewer can never read it.
  if s_prefs.own_height_cm is not null
     and (s_prefs.own_height_cm < v.min_height_cm
          or s_prefs.own_height_cm > v.max_height_cm) then
    return false;
  end if;

  if array_length(v.preferred_builds, 1) is not null
     and s_prefs.own_build is not null
     and not (s_prefs.own_build = any (v.preferred_builds)) then
    return false;
  end if;

  if array_length(v.preferred_practice, 1) is not null
     and not (s.religious_practice = any (v.preferred_practice)) then
    return false;
  end if;

  if array_length(v.desired_timeline, 1) is not null
     and not (s.timeline = any (v.desired_timeline)) then
    return false;
  end if;

  if array_length(v.preferred_countries, 1) is not null
     and not (s.country = any (v.preferred_countries)) then
    return false;
  end if;

  if vp.latitude is not null and s.latitude is not null
     and distance_km(vp.latitude, vp.longitude, s.latitude, s.longitude)
         > v.max_distance_km then
    return false;
  end if;

  -- Blocks cut both ways.
  if exists (
    select 1 from blocks
    where (blocker_id = p_viewer and blocked_id = p_subject)
       or (blocker_id = p_subject and blocked_id = p_viewer)
  ) then
    return false;
  end if;

  return true;
end;
$$;

/**
 * The neutral overlap statements shown on an introduction card.
 *
 * Note what this returns: agreements only, phrased as shared facts. It never
 * emits a range, a threshold, or a "you matched on 8 of 12" style score.
 */
create or replace function agreement_summary(p_viewer uuid, p_subject uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  a profiles%rowtype;
  b profiles%rowtype;
  result jsonb := '[]'::jsonb;
begin
  select * into a from profiles where id = p_viewer;
  select * into b from profiles where id = p_subject;

  if a.timeline = b.timeline then
    result := result || jsonb_build_array(
      jsonb_build_object('label', 'Timeline', 'value',
        replace(initcap(replace(b.timeline::text, '_', ' ')), 'Within ', 'Within '))
    );
  end if;

  if a.family_goals = b.family_goals then
    result := result || jsonb_build_array(
      jsonb_build_object('label', 'Children', 'value',
        initcap(replace(replace(b.family_goals::text, 'wants_children_', ''), '_', ' ')) || ', both')
    );
  end if;

  if a.city = b.city then
    result := result || jsonb_build_array(
      jsonb_build_object('label', 'City', 'value', b.city || ', both staying')
    );
  elsif a.relocation = b.relocation then
    result := result || jsonb_build_array(
      jsonb_build_object('label', 'Relocation', 'value',
        initcap(replace(b.relocation::text, '_', ' ')) || ', both')
    );
  end if;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading the current round
-- ---------------------------------------------------------------------------

create or replace function get_current_round()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  r rounds%rowtype;
  cards jsonb;
begin
  select * into r
  from rounds
  where user_id = auth.uid() and submitted_at is null
  order by opens_at desc
  limit 1;

  if r is null then return null; end if;

  select coalesce(jsonb_agg(card order by card->>'id'), '[]'::jsonb) into cards
  from (
    select jsonb_build_object(
      'id', i.id,
      'roundId', i.round_id,
      'agreements', i.agreements,
      'profile', jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'firstName', p.first_name,
        'age', extract(year from age(p.birth_date)),
        'gender', p.gender,
        'occupation', p.occupation,
        'education', p.education,
        'city', p.city,
        'country', p.country,
        'bio', p.bio,
        'photos', p.photos,
        'chips', p.chips,
        'religiousPractice', p.religious_practice,
        'timeline', p.timeline,
        'relocation', p.relocation,
        'familyGoals', p.family_goals,
        'languagesSpoken', p.languages_spoken,
        'isVerified', p.is_verified,
        'audioGreetingUrl', p.audio_greeting_url,
        'audioDurationSeconds', p.audio_duration_seconds
      )
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
    'submitted', r.submitted_at is not null,
    'introductions', cards
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Committing selections and detecting mutuals
-- ---------------------------------------------------------------------------

create or replace function submit_round_selections(
  p_round_id uuid,
  p_introduction_ids uuid[]
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r rounds%rowtype;
  keep_limit int;
  mutuals uuid[] := '{}';
  rec record;
  a uuid;
  b uuid;
begin
  select * into r from rounds where id = p_round_id and user_id = auth.uid();
  if r is null then raise exception 'No such round'; end if;
  if r.submitted_at is not null then raise exception 'Round already submitted'; end if;

  select keeps into keep_limit from tier_limits(r.tier);
  if array_length(p_introduction_ids, 1) > keep_limit then
    raise exception 'At most % selections allowed on this tier', keep_limit;
  end if;

  -- Everything not kept is released. Silently — the subject is never told.
  insert into introduction_selections (introduction_id, viewer_id, subject_id, decision)
  select i.id, i.viewer_id, i.subject_id,
         case when i.id = any (p_introduction_ids) then 'kept' else 'released' end::selection_decision
  from introductions i
  where i.round_id = p_round_id and i.viewer_id = auth.uid()
  on conflict (introduction_id) do update set
    decision = excluded.decision,
    decided_at = now();

  update rounds set submitted_at = now() where id = p_round_id;

  -- A match exists only where both sides kept each other.
  for rec in
    select mine.subject_id
    from introduction_selections mine
    join introduction_selections theirs
      on theirs.viewer_id = mine.subject_id
     and theirs.subject_id = mine.viewer_id
     and theirs.decision = 'kept'
    where mine.viewer_id = auth.uid()
      and mine.decision = 'kept'
  loop
    mutuals := mutuals || rec.subject_id;

    a := least(auth.uid(), rec.subject_id);
    b := greatest(auth.uid(), rec.subject_id);

    insert into connections (user_a, user_b)
    values (a, b)
    on conflict (user_a, user_b) do nothing;
  end loop;

  -- Feed the private score. Being kept raises it, being shown without being
  -- kept lowers it; both move slowly and neither is ever readable.
  update selection_scores s
  set times_shown = s.times_shown + 1,
      times_kept = s.times_kept + (case when sel.decision = 'kept' then 1 else 0 end),
      score = greatest(0.05, least(0.95,
        s.score + (case when sel.decision = 'kept' then 0.03 else -0.01 end))),
      last_recomputed_at = now()
  from introduction_selections sel
  where sel.subject_id = s.user_id
    and sel.viewer_id = auth.uid()
    and sel.decided_at > now() - interval '1 minute';

  update selection_scores
  set band = greatest(1, least(5, ceil(score * 5)::smallint))
  where last_recomputed_at > now() - interval '1 minute';

  return jsonb_build_object('mutualProfileIds', to_jsonb(mutuals));
end;
$$;

-- ---------------------------------------------------------------------------
-- Compatibility questions
-- ---------------------------------------------------------------------------

create or replace function submit_question_picks(
  p_connection_id uuid,
  p_question_ids text[]
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from connections
    where id = p_connection_id
      and closed_at is null
      and (user_a = auth.uid() or user_b = auth.uid())
  ) then
    raise exception 'Not your connection';
  end if;

  if array_length(p_question_ids, 1) <> 5 then
    raise exception 'Exactly five questions must be chosen';
  end if;

  delete from question_picks
  where connection_id = p_connection_id and user_id = auth.uid();

  insert into question_picks (connection_id, user_id, question_id)
  select p_connection_id, auth.uid(), unnest(p_question_ids);

  -- Once both sides have picked, the connection moves on to answering.
  if (
    select count(distinct user_id) from question_picks
    where connection_id = p_connection_id
  ) = 2 then
    update connections set stage = 'answering' where id = p_connection_id;
  end if;
end;
$$;

/**
 * The double blind.
 *
 * Writes the caller's answer, then — and only then — returns the other side's.
 * Because `question_answers` has no RLS policy, this is the sole read path, so
 * there is no way to peek before committing.
 */
create or replace function submit_answer(
  p_connection_id uuid,
  p_question_id text,
  p_answer text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  other_id uuid;
  their_answer text;
  origin text;
begin
  select case when user_a = auth.uid() then user_b else user_a end
  into other_id
  from connections
  where id = p_connection_id
    and closed_at is null
    and (user_a = auth.uid() or user_b = auth.uid());

  if other_id is null then raise exception 'Not your connection'; end if;
  if length(trim(p_answer)) < 10 then raise exception 'Answer is too short'; end if;

  -- Answers are write-once. Editing after reading would defeat the point.
  insert into question_answers (connection_id, user_id, question_id, body)
  values (p_connection_id, auth.uid(), p_question_id, p_answer)
  on conflict (connection_id, user_id, question_id) do nothing;

  select body into their_answer
  from question_answers
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

  return jsonb_build_object(
    'questionId', p_question_id,
    'origin', coalesce(origin, 'both'),
    'myAnswer', p_answer,
    'theirAnswer', their_answer,
    'mySubmittedAt', now()
  );
end;
$$;

create or replace function close_connection(p_connection_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update connections
  set closed_at = now(), stage = 'closed'
  where id = p_connection_id
    and (user_a = auth.uid() or user_b = auth.uid());
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants — clients may call these, and nothing else
-- ---------------------------------------------------------------------------

revoke all on function passes_criteria(uuid, uuid) from public;
revoke all on function agreement_summary(uuid, uuid) from public;

grant execute on function get_current_round() to authenticated;
grant execute on function submit_round_selections(uuid, uuid[]) to authenticated;
grant execute on function submit_question_picks(uuid, text[]) to authenticated;
grant execute on function submit_answer(uuid, text, text) to authenticated;
grant execute on function close_connection(uuid) to authenticated;
