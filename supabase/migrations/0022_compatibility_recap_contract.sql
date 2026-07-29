-- The post-icebreaker compatibility view is intentionally broad. It never
-- returns preferences, filters, scores, bands, or a reason a pair was chosen.

create or replace function build_connection_compatibility_breakdown(p_connection_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public as $$
declare
  c connections%rowtype;
  a profiles%rowtype;
  b profiles%rowtype;
  recap_items jsonb;
  result jsonb := '[]'::jsonb;
begin
  select * into c from connections where id = p_connection_id and closed_at is null;
  if c is null or c.stage not in ('recap', 'open') then return result; end if;

  select * into a from profiles where id = c.user_a;
  select * into b from profiles where id = c.user_b;
  if a is null or b is null then return result; end if;

  result := result || jsonb_build_array(jsonb_build_object(
    'topic', 'values',
    'verdict', case when a.religious_practice = b.religious_practice then 'aligned' else 'discuss' end
  ));
  result := result || jsonb_build_array(jsonb_build_object(
    'topic', 'marriage_timing',
    'verdict', case when a.timeline = b.timeline then 'aligned' else 'discuss' end
  ));
  result := result || jsonb_build_array(jsonb_build_object(
    'topic', 'location_and_relocation',
    'verdict', case
      when lower(trim(a.country)) = lower(trim(b.country)) then 'aligned'
      when a.relocation = b.relocation then 'aligned'
      else 'discuss'
    end
  ));
  result := result || jsonb_build_array(jsonb_build_object(
    'topic', 'family_plans',
    'verdict', case when a.family_goals = b.family_goals then 'aligned' else 'discuss' end
  ));

  select coalesce(c.recap, '[]'::jsonb) into recap_items;
  result := result || jsonb_build_array(jsonb_build_object(
    'topic', 'conversation',
    'verdict', case
      when jsonb_array_length(recap_items) > 0
       and not exists (
         select 1 from jsonb_array_elements(recap_items) item
         where item->>'verdict' <> 'aligned'
       ) then 'aligned'
      else 'discuss'
    end
  ));
  return result;
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
    'recap', c.recap,
    'compatibilityBreakdown', build_connection_compatibility_breakdown(c.id),
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

revoke all on function build_connection_compatibility_breakdown(uuid)
  from public, anon, authenticated;
revoke all on function get_connection(uuid) from public, anon;
grant execute on function get_connection(uuid) to authenticated;
