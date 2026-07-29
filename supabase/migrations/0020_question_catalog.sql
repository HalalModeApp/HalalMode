-- Authoritative compatibility-question boundary. Display copy remains
-- localized in the client; the server owns stable IDs, versions, and activity.

create table if not exists question_catalog (
  id text primary key,
  catalog_version integer not null,
  category text not null,
  display_order integer not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (id ~ '^q[1-9][0-9]*$'),
  check (catalog_version > 0),
  check (category in ('faith', 'family', 'money', 'conflict', 'future', 'work', 'home', 'health')),
  check (display_order > 0)
);
alter table question_catalog enable row level security;
revoke all on table question_catalog from public, anon, authenticated;

insert into question_catalog (id, catalog_version, category, display_order, active)
values
  ('q1',  1, 'faith',    1,  true),
  ('q2',  1, 'family',   2,  true),
  ('q3',  1, 'money',    3,  true),
  ('q4',  1, 'conflict', 4,  true),
  ('q5',  1, 'future',   5,  true),
  ('q6',  1, 'work',     6,  true),
  ('q7',  1, 'home',     7,  true),
  ('q8',  1, 'faith',    8,  true),
  ('q9',  1, 'family',   9,  true),
  ('q10', 1, 'health',   10, true),
  ('q11', 1, 'money',    11, true),
  ('q12', 1, 'future',   12, true)
on conflict (id) do update set
  catalog_version = excluded.catalog_version,
  category = excluded.category,
  display_order = excluded.display_order,
  active = excluded.active;

-- Once both members submit, this immutable snapshot is the only set that may
-- be answered. Catalog deactivation affects future picks, never active flows.
create table if not exists connection_questions (
  connection_id uuid not null references connections on delete cascade,
  question_id text not null references question_catalog(id),
  catalog_version integer not null,
  picked_by_a boolean not null,
  picked_by_b boolean not null,
  created_at timestamptz not null default now(),
  primary key (connection_id, question_id),
  check (picked_by_a or picked_by_b),
  check (catalog_version > 0)
);
alter table connection_questions enable row level security;
revoke all on table connection_questions from public, anon, authenticated;

-- Backfill only structurally valid in-flight connections: exactly five
-- distinct, currently catalogued picks from each member. Invalid legacy rows
-- remain quarantined rather than being silently legitimized.
insert into connection_questions (
  connection_id, question_id, catalog_version, picked_by_a, picked_by_b
)
select c.id, qc.id, qc.catalog_version,
       bool_or(qp.user_id = c.user_a), bool_or(qp.user_id = c.user_b)
from connections c
join question_picks qp on qp.connection_id = c.id
join question_catalog qc on qc.id = qp.question_id
where c.closed_at is null
  and (select count(*) from question_picks p where p.connection_id = c.id and p.user_id = c.user_a) = 5
  and (select count(*) from question_picks p where p.connection_id = c.id and p.user_id = c.user_b) = 5
  and (select count(*) from question_picks p join question_catalog q on q.id = p.question_id
       where p.connection_id = c.id and p.user_id = c.user_a) = 5
  and (select count(*) from question_picks p join question_catalog q on q.id = p.question_id
       where p.connection_id = c.id and p.user_id = c.user_b) = 5
group by c.id, qc.id, qc.catalog_version
on conflict (connection_id, question_id) do nothing;

create or replace function submit_question_picks(
  p_connection_id uuid,
  p_question_ids text[]
) returns void
language plpgsql
security definer
set search_path = public as $$
declare
  v_connection connections%rowtype;
  v_ids text[] := coalesce(p_question_ids, '{}'::text[]);
  v_count integer;
  v_distinct_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select * into v_connection
  from connections
  where id = p_connection_id
    and closed_at is null
    and stage = 'choosing_questions'
    and (user_a = auth.uid() or user_b = auth.uid())
  for update;
  if v_connection is null then
    raise exception 'Connection is not accepting question choices' using errcode = '42501';
  end if;

  select count(*)::int, count(distinct id)::int
  into v_count, v_distinct_count
  from unnest(v_ids) selected(id);
  if v_count <> 5 or v_distinct_count <> 5
     or exists (select 1 from unnest(v_ids) selected(id) where id is null) then
    raise exception 'Choose exactly five different questions' using errcode = '22023';
  end if;
  if (select count(*) from question_catalog
      where active and id = any(v_ids)) <> 5 then
    raise exception 'One or more questions are unavailable' using errcode = '22023';
  end if;

  if exists (
    select 1 from question_picks
    where connection_id = p_connection_id and user_id = auth.uid()
  ) then
    if (select count(*) from question_picks
        where connection_id = p_connection_id and user_id = auth.uid()) = 5
       and not exists (
         (select unnest(v_ids))
         except
         (select question_id from question_picks
          where connection_id = p_connection_id and user_id = auth.uid())
       ) then
      return;
    end if;
    raise exception 'Question choices were already submitted' using errcode = '22023';
  end if;

  insert into question_picks (connection_id, user_id, question_id)
  select p_connection_id, auth.uid(), id from unnest(v_ids) selected(id);

  if (select count(distinct user_id) from question_picks
      where connection_id = p_connection_id
      group by connection_id
      having count(*) = 10 and count(distinct question_id) between 5 and 10) = 2 then
    insert into connection_questions (
      connection_id, question_id, catalog_version, picked_by_a, picked_by_b
    )
    select p_connection_id, qc.id, qc.catalog_version,
           bool_or(qp.user_id = v_connection.user_a),
           bool_or(qp.user_id = v_connection.user_b)
    from question_picks qp
    join question_catalog qc on qc.id = qp.question_id
    where qp.connection_id = p_connection_id
    group by qc.id, qc.catalog_version
    on conflict (connection_id, question_id) do nothing;

    update connections set stage = 'answering'
    where id = p_connection_id and stage = 'choosing_questions';
  end if;
end;
$$;

create or replace function refresh_connection_stage_after_answer(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = public as $$
begin
  if exists (select 1 from connection_questions where connection_id = p_connection_id)
     and not exists (
       select 1 from connection_questions cq
       where cq.connection_id = p_connection_id
         and (select count(distinct qa.user_id) from question_answers qa
              where qa.connection_id = cq.connection_id
                and qa.question_id = cq.question_id) <> 2
     ) then
    update connections
    set stage = 'recap', recap = build_connection_recap(p_connection_id)
    where id = p_connection_id and stage = 'answering';
  end if;
end;
$$;

create or replace function submit_answer(
  p_connection_id uuid,
  p_question_id text,
  p_answer text
) returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  v_other_id uuid;
  v_their_answer text;
  v_my_answer text;
  v_my_submitted_at timestamptz;
  v_origin text;
begin
  select case when user_a = auth.uid() then user_b else user_a end
  into v_other_id
  from connections
  where id = p_connection_id
    and closed_at is null
    and stage = 'answering'
    and (user_a = auth.uid() or user_b = auth.uid());
  if v_other_id is null then
    raise exception 'Connection is not ready for answers' using errcode = '42501';
  end if;
  if p_answer is null or length(trim(p_answer)) not between 10 and 2000 then
    raise exception 'Answer must be between 10 and 2000 characters' using errcode = '22023';
  end if;
  if not exists (
    select 1 from connection_questions
    where connection_id = p_connection_id and question_id = p_question_id
  ) then
    raise exception 'Question is not in this connection' using errcode = '22023';
  end if;

  insert into question_answers (connection_id, user_id, question_id, body)
  values (p_connection_id, auth.uid(), p_question_id, trim(p_answer))
  on conflict (connection_id, user_id, question_id) do nothing;

  select body, submitted_at into v_my_answer, v_my_submitted_at
  from question_answers
  where connection_id = p_connection_id
    and user_id = auth.uid() and question_id = p_question_id;
  select body into v_their_answer
  from question_answers
  where connection_id = p_connection_id
    and user_id = v_other_id and question_id = p_question_id;

  select case
    when picked_by_a and picked_by_b then 'both'
    when (picked_by_a and auth.uid() = c.user_a) or (picked_by_b and auth.uid() = c.user_b) then 'me'
    else 'them'
  end into v_origin
  from connection_questions cq
  join connections c on c.id = cq.connection_id
  where cq.connection_id = p_connection_id and cq.question_id = p_question_id;

  perform refresh_connection_stage_after_answer(p_connection_id);
  return jsonb_build_object(
    'questionId', p_question_id,
    'origin', v_origin,
    'myAnswer', v_my_answer,
    'theirAnswer', v_their_answer,
    'mySubmittedAt', v_my_submitted_at
  );
end;
$$;

revoke all on function submit_question_picks(uuid, text[]) from public, anon, authenticated;
revoke all on function submit_answer(uuid, text, text) from public, anon, authenticated;
revoke all on function refresh_connection_stage_after_answer(uuid) from public, anon, authenticated;
grant execute on function submit_question_picks(uuid, text[]) to authenticated;
grant execute on function submit_answer(uuid, text, text) to authenticated;

