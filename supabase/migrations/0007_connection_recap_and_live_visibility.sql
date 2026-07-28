-- Finish the question flow on the server, and keep introduction visibility
-- limited to a live, unsubmitted round.

alter table connections
  add column if not exists recap jsonb not null default '[]'::jsonb;

drop policy if exists "introduced profiles are readable" on profiles;
create policy "live introduced profiles are readable"
  on profiles for select
  using (
    exists (
      select 1
      from introductions i
      join rounds r on r.id = i.round_id
      where i.subject_id = profiles.id
        and i.viewer_id = auth.uid()
        and r.submitted_at is null
        and r.expires_at > now()
    )
    or exists (
      select 1 from connections c
      where c.closed_at is null
        and (
          (c.user_a = auth.uid() and c.user_b = profiles.id) or
          (c.user_b = auth.uid() and c.user_a = profiles.id)
        )
    )
  );

-- A deliberately neutral recap. It compares only answers that both people
-- have already chosen to reveal; no preference data or ranking is involved.
create or replace function build_connection_recap(p_connection_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'questionId', paired.question_id,
      'heading', 'A shared question',
      'verdict', case
        when lower(trim(paired.answer_a)) = lower(trim(paired.answer_b)) then 'aligned'
        else 'discuss'
      end,
      'note', case
        when lower(trim(paired.answer_a)) = lower(trim(paired.answer_b))
          then 'You gave similar answers. Start there if it feels useful.'
        else 'You approached this differently. It could make for a good conversation.'
      end
    ) order by paired.question_id
  ), '[]'::jsonb)
  from (
    select qa.question_id,
           max(qa.body) filter (where qa.user_id = c.user_a) as answer_a,
           max(qa.body) filter (where qa.user_id = c.user_b) as answer_b
    from question_answers qa
    join connections c on c.id = qa.connection_id
    where qa.connection_id = p_connection_id
    group by qa.question_id
    having count(distinct qa.user_id) = 2
  ) paired;
$$;

create or replace function refresh_connection_stage_after_answer(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = public as $$
begin
  if not exists (
    select 1
    from question_picks qp
    where qp.connection_id = p_connection_id
      and not exists (
        select 1 from question_answers qa
        where qa.connection_id = qp.connection_id
          and qa.question_id = qp.question_id
        group by qa.connection_id, qa.question_id
        having count(distinct qa.user_id) = 2
      )
  ) then
    update connections
    set stage = 'recap', recap = build_connection_recap(p_connection_id)
    where id = p_connection_id and stage = 'answering';
  end if;
end;
$$;

-- This supersedes the initial implementation with stage and question checks.
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
  if length(trim(p_answer)) < 10 then raise exception 'Answer is too short'; end if;
  if not exists (
    select 1 from question_picks
    where connection_id = p_connection_id and question_id = p_question_id
  ) then raise exception 'Question was not selected for this connection'; end if;

  insert into question_answers (connection_id, user_id, question_id, body)
  values (p_connection_id, auth.uid(), p_question_id, trim(p_answer))
  on conflict (connection_id, user_id, question_id) do nothing;

  select body into their_answer from question_answers
  where connection_id = p_connection_id and user_id = other_id and question_id = p_question_id;

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
    'myAnswer', trim(p_answer),
    'theirAnswer', their_answer,
    'mySubmittedAt', now()
  );
end;
$$;

create or replace function get_connection_recap(p_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare result jsonb;
begin
  select recap into result from connections
  where id = p_connection_id
    and closed_at is null
    and stage in ('recap', 'open')
    and (user_a = auth.uid() or user_b = auth.uid());
  if result is null then raise exception 'Recap is not available'; end if;
  return result;
end;
$$;

create or replace function open_connection(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = public as $$
begin
  update connections
  set stage = 'open'
  where id = p_connection_id
    and closed_at is null
    and stage = 'recap'
    and (user_a = auth.uid() or user_b = auth.uid());
  if not found then raise exception 'Connection cannot be opened'; end if;
end;
$$;

grant execute on function build_connection_recap(uuid) to authenticated;
grant execute on function get_connection_recap(uuid) to authenticated;
grant execute on function open_connection(uuid) to authenticated;
grant execute on function submit_answer(uuid, text, text) to authenticated;
