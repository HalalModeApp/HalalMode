-- Conversation capacity is enforced at the only connection-creation boundary.
-- Mutual interest that cannot activate yet is retained in a private queue.

create or replace function tier_limits(p_tier membership_tier)
returns table (introductions int, keeps int, open_connections int)
language sql immutable as $$
  select case when p_tier = 'plus' then 10 else 5 end,
         case when p_tier = 'plus' then 3 else 1 end,
         case when p_tier = 'plus' then 10 else 5 end;
$$;

create table if not exists mutual_connection_queue (
  user_a uuid not null references profiles on delete cascade,
  user_b uuid not null references profiles on delete cascade,
  matched_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)
);
alter table mutual_connection_queue enable row level security;
revoke all on table mutual_connection_queue from public, anon, authenticated;

-- Promote a bounded snapshot of oldest queued mutuals involving the supplied
-- members. Every involved member is locked in UUID order before counts are
-- read, matching the order used by round submission and avoiding deadlocks.
create or replace function halal_mode_private.promote_waiting_connections(
  p_member_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = public as $$
declare
  v_candidates jsonb;
  v_user uuid;
  v_pair record;
  v_cap_a int;
  v_cap_b int;
  v_count_a int;
  v_count_b int;
  v_promoted int := 0;
begin
  -- Remove a bounded batch of terminal rows for hygiene. Candidate selection
  -- also excludes all stale rows, so a backlog larger than this cleanup batch
  -- can never crowd out a real mutual.
  with supplied as (
    select distinct member_id
    from unnest(coalesce(p_member_ids, '{}'::uuid[])) member_id
    order by member_id
    limit 10
  ), stale as (
    select q.user_a, q.user_b
    from mutual_connection_queue q
    join supplied on supplied.member_id in (q.user_a, q.user_b)
    where (
        exists (select 1 from connections c where c.user_a = q.user_a and c.user_b = q.user_b)
        or exists (
          select 1 from blocks b
          where (b.blocker_id = q.user_a and b.blocked_id = q.user_b)
             or (b.blocker_id = q.user_b and b.blocked_id = q.user_a)
        )
      )
    order by q.matched_at, q.user_a, q.user_b
    limit 100
  )
  delete from mutual_connection_queue q
  using stale s
  where q.user_a = s.user_a and q.user_b = s.user_b;

  -- Give every supplied member an independent share of the bounded scan.
  -- DISTINCT removes pairs shared by two supplied members; final ordering
  -- keeps global oldest-first activation without sacrificing per-member reach.
  with supplied as (
    select distinct member_id
    from unnest(coalesce(p_member_ids, '{}'::uuid[])) member_id
    order by member_id
    limit 10
  ), ranked as (
    select q.user_a, q.user_b, q.matched_at, supplied.member_id,
           row_number() over (
             partition by supplied.member_id
             order by q.matched_at, q.user_a, q.user_b
           ) as member_rank
    from supplied
    join mutual_connection_queue q
      on supplied.member_id in (q.user_a, q.user_b)
    where not exists (
      select 1 from connections c where c.user_a = q.user_a and c.user_b = q.user_b
    )
      and not exists (
        select 1 from blocks b
        where (b.blocker_id = q.user_a and b.blocked_id = q.user_b)
           or (b.blocker_id = q.user_b and b.blocked_id = q.user_a)
      )
  ), fair_candidates as (
    select user_a, user_b, min(matched_at) as matched_at
    from ranked
    where member_rank <= 10
    group by user_a, user_b
    order by min(matched_at), user_a, user_b
  )
  select coalesce(jsonb_agg(
    jsonb_build_object('a', q.user_a, 'b', q.user_b)
    order by q.matched_at, q.user_a, q.user_b
  ), '[]'::jsonb)
  into v_candidates
  from fair_candidates q;

  for v_user in
    select distinct candidate_id
    from jsonb_to_recordset(v_candidates) as candidate(a uuid, b uuid)
    cross join lateral unnest(array[candidate.a, candidate.b]) candidate_id
    order by candidate_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_user::text, 1919));
  end loop;

  for v_pair in
    select candidate.a, candidate.b
    from jsonb_to_recordset(v_candidates) as candidate(a uuid, b uuid)
  loop
    if exists (
      select 1 from blocks b
      where (b.blocker_id = v_pair.a and b.blocked_id = v_pair.b)
         or (b.blocker_id = v_pair.b and b.blocked_id = v_pair.a)
    ) or exists (
      select 1 from connections c where c.user_a = v_pair.a and c.user_b = v_pair.b
    ) then
      delete from mutual_connection_queue
      where user_a = v_pair.a and user_b = v_pair.b;
      continue;
    end if;

    select l.open_connections into v_cap_a
    from profiles p cross join lateral tier_limits(p.tier) l
    where p.id = v_pair.a;
    select l.open_connections into v_cap_b
    from profiles p cross join lateral tier_limits(p.tier) l
    where p.id = v_pair.b;
    select count(*)::int into v_count_a from connections
    where closed_at is null and (user_a = v_pair.a or user_b = v_pair.a);
    select count(*)::int into v_count_b from connections
    where closed_at is null and (user_a = v_pair.b or user_b = v_pair.b);

    if v_count_a < v_cap_a and v_count_b < v_cap_b then
      insert into connections (user_a, user_b)
      values (v_pair.a, v_pair.b)
      on conflict (user_a, user_b) do nothing;
      if found then v_promoted := v_promoted + 1; end if;
      delete from mutual_connection_queue
      where user_a = v_pair.a and user_b = v_pair.b;
    end if;
  end loop;

  return v_promoted;
end;
$$;
revoke all on function halal_mode_private.promote_waiting_connections(uuid[])
  from public, anon, authenticated;

-- Replaces the 0018 trigger body so blocking also promotes another earned
-- mutual when both members have room. The blocked pair is never promoted.
create or replace function halal_mode_private.close_connections_after_block()
returns trigger
language plpgsql
security definer
set search_path = public as $$
begin
  update connections
  set closed_at = coalesce(closed_at, now()), stage = 'closed'
  where closed_at is null
    and (
      (user_a = new.blocker_id and user_b = new.blocked_id)
      or (user_a = new.blocked_id and user_b = new.blocker_id)
    );

  delete from mutual_connection_queue
  where user_a = least(new.blocker_id, new.blocked_id)
    and user_b = greatest(new.blocker_id, new.blocked_id);
  perform halal_mode_private.promote_waiting_connections(
    array[new.blocker_id, new.blocked_id]
  );
  return new;
end;
$$;
revoke all on function halal_mode_private.close_connections_after_block()
  from public, anon, authenticated;

create or replace function close_connection(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = public as $$
declare
  v_user_a uuid;
  v_user_b uuid;
begin
  update connections
  set closed_at = now(), stage = 'closed'
  where id = p_connection_id
    and closed_at is null
    and (user_a = auth.uid() or user_b = auth.uid())
  returning user_a, user_b into v_user_a, v_user_b;

  if v_user_a is null then
    raise exception 'Connection not found' using errcode = 'P0002';
  end if;
  perform halal_mode_private.promote_waiting_connections(array[v_user_a, v_user_b]);
end;
$$;

create or replace function submit_round_selections(
  p_round_id uuid,
  p_introduction_ids uuid[]
) returns jsonb
language plpgsql
security definer
set search_path = public as $$
declare
  r rounds%rowtype;
  v_ids uuid[] := coalesce(p_introduction_ids, '{}'::uuid[]);
  v_requested_count int;
  v_distinct_count int;
  v_valid_count int;
  v_keep_limit int;
  v_active_mutuals uuid[] := '{}'::uuid[];
  v_waiting_mutuals uuid[] := '{}'::uuid[];
  v_user uuid;
  v_subject uuid;
  v_cap_me int;
  v_cap_them int;
  v_count_me int;
  v_count_them int;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  select * into r from rounds
  where id = p_round_id and user_id = auth.uid()
  for update;
  if r is null then raise exception 'Round not found' using errcode = 'P0002'; end if;
  if r.submitted_at is not null then
    raise exception 'Round already submitted' using errcode = '22023';
  end if;
  if r.expires_at <= now() then
    raise exception 'Round has expired' using errcode = '22023';
  end if;

  select count(*)::int, count(distinct introduction_id)::int
  into v_requested_count, v_distinct_count
  from unnest(v_ids) requested(introduction_id);
  if v_requested_count <> v_distinct_count
     or exists (select 1 from unnest(v_ids) x(id) where id is null) then
    raise exception 'Introduction choices must be unique and non-null' using errcode = '22023';
  end if;
  select keeps into v_keep_limit from tier_limits(r.tier);
  if v_requested_count > v_keep_limit then
    raise exception 'At most % selections allowed on this tier', v_keep_limit using errcode = '22023';
  end if;
  select count(*)::int into v_valid_count from introductions i
  where i.round_id = r.id and i.viewer_id = auth.uid() and i.id = any(v_ids);
  if v_valid_count <> v_requested_count then
    raise exception 'Every introduction must belong to this round' using errcode = '22023';
  end if;

  insert into introduction_selections (introduction_id, viewer_id, subject_id, decision, decided_at)
  select i.id, i.viewer_id, i.subject_id,
         case when i.id = any(v_ids) then 'kept' else 'released' end::selection_decision,
         now()
  from introductions i
  where i.round_id = r.id and i.viewer_id = auth.uid()
  on conflict (introduction_id) do update set
    viewer_id = excluded.viewer_id, subject_id = excluded.subject_id,
    decision = excluded.decision, decided_at = excluded.decided_at;

  insert into selection_scores (user_id, score, band, times_shown, times_kept, last_recomputed_at)
  select i.subject_id,
         case when s.decision = 'kept' then 0.5300 else 0.4900 end, 3, 1,
         case when s.decision = 'kept' then 1 else 0 end, now()
  from introductions i
  join introduction_selections s on s.introduction_id = i.id
  where i.round_id = r.id and i.viewer_id = auth.uid()
  on conflict (user_id) do update set
    times_shown = selection_scores.times_shown + 1,
    times_kept = selection_scores.times_kept + case when excluded.times_kept = 1 then 1 else 0 end,
    score = greatest(0.05, least(0.95, selection_scores.score
      + case when excluded.times_kept = 1 then 0.03 else -0.01 end)),
    band = greatest(1, least(5, ceil(greatest(0.05, least(0.95,
      selection_scores.score + case when excluded.times_kept = 1 then 0.03 else -0.01 end
    )) * 5)::smallint)),
    last_recomputed_at = now();

  update rounds set submitted_at = now() where id = r.id and submitted_at is null;
  if not found then raise exception 'Round submission lost its lock' using errcode = '40001'; end if;

  -- Lock the current member and every kept subject in one universal order.
  -- This serializes reciprocal detection and capacity accounting together.
  for v_user in
    select distinct id from (
      select auth.uid() id
      union all
      select i.subject_id from introductions i
      where i.round_id = r.id and i.id = any(v_ids)
    ) members order by id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_user::text, 1919));
  end loop;

  for v_subject in
    select distinct mine.subject_id
    from introductions mine
    join introduction_selections mine_selection
      on mine_selection.introduction_id = mine.id
     and mine_selection.viewer_id = mine.viewer_id
     and mine_selection.subject_id = mine.subject_id
     and mine_selection.decision = 'kept'
    join introductions twin
      on twin.id = mine.reciprocal_id and twin.reciprocal_id = mine.id
     and twin.viewer_id = mine.subject_id and twin.subject_id = mine.viewer_id
    join rounds twin_round
      on twin_round.id = twin.round_id and twin_round.user_id = twin.viewer_id
     and twin_round.submitted_at is not null
    join introduction_selections twin_selection
      on twin_selection.introduction_id = twin.id
     and twin_selection.viewer_id = twin.viewer_id
     and twin_selection.subject_id = twin.subject_id
     and twin_selection.decision = 'kept'
    where mine.round_id = r.id and mine.viewer_id = auth.uid()
    order by mine.subject_id
  loop
    if exists (
      select 1 from blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = v_subject)
         or (b.blocker_id = v_subject and b.blocked_id = auth.uid())
    ) then
      delete from mutual_connection_queue
      where user_a = least(auth.uid(), v_subject) and user_b = greatest(auth.uid(), v_subject);
      continue;
    end if;
    if exists (
      select 1 from connections c
      where c.user_a = least(auth.uid(), v_subject) and c.user_b = greatest(auth.uid(), v_subject)
    ) then
      delete from mutual_connection_queue
      where user_a = least(auth.uid(), v_subject) and user_b = greatest(auth.uid(), v_subject);
      continue;
    end if;

    select l.open_connections into v_cap_me
    from profiles p cross join lateral tier_limits(p.tier) l where p.id = auth.uid();
    select l.open_connections into v_cap_them
    from profiles p cross join lateral tier_limits(p.tier) l where p.id = v_subject;
    select count(*)::int into v_count_me from connections
    where closed_at is null and (user_a = auth.uid() or user_b = auth.uid());
    select count(*)::int into v_count_them from connections
    where closed_at is null and (user_a = v_subject or user_b = v_subject);

    if v_count_me < v_cap_me and v_count_them < v_cap_them then
      insert into connections (user_a, user_b)
      values (least(auth.uid(), v_subject), greatest(auth.uid(), v_subject));
      delete from mutual_connection_queue
      where user_a = least(auth.uid(), v_subject) and user_b = greatest(auth.uid(), v_subject);
      v_active_mutuals := array_append(v_active_mutuals, v_subject);
    else
      insert into mutual_connection_queue (user_a, user_b)
      values (least(auth.uid(), v_subject), greatest(auth.uid(), v_subject))
      on conflict (user_a, user_b) do nothing;
      v_waiting_mutuals := array_append(v_waiting_mutuals, v_subject);
    end if;
  end loop;

  return jsonb_build_object(
    'mutualProfileIds', to_jsonb(v_active_mutuals),
    'waitingMutualProfileIds', to_jsonb(v_waiting_mutuals)
  );
end;
$$;

revoke all on function tier_limits(membership_tier) from public, anon, authenticated;
revoke all on function submit_round_selections(uuid, uuid[]) from public, anon, authenticated;
revoke all on function close_connection(uuid) from public, anon, authenticated;
grant execute on function submit_round_selections(uuid, uuid[]) to authenticated;
grant execute on function close_connection(uuid) to authenticated;
