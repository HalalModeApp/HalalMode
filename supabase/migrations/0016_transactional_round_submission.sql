-- Make round submission a single, locked, exact-round transaction.
-- Concurrent retries serialize on the round row; only the first submission can
-- write selections, update scores, or create connections.

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
  v_mutuals uuid[] := '{}'::uuid[];
  v_pair_key text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in' using errcode = '42501';
  end if;

  -- Do not filter by state here: after acquiring the row lock we return a
  -- precise terminal-state error, and a concurrent retry sees the committed
  -- submitted_at value from the first transaction.
  select * into r
  from rounds
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
     or exists (select 1 from unnest(v_ids) requested(introduction_id) where introduction_id is null) then
    raise exception 'Introduction choices must be unique and non-null' using errcode = '22023';
  end if;

  select keeps into v_keep_limit from tier_limits(r.tier);
  if v_requested_count > v_keep_limit then
    raise exception 'At most % selections allowed on this tier', v_keep_limit
      using errcode = '22023';
  end if;

  select count(*)::int into v_valid_count
  from introductions i
  where i.round_id = r.id
    and i.viewer_id = auth.uid()
    and i.id = any(v_ids);

  if v_valid_count <> v_requested_count then
    raise exception 'Every introduction must belong to this round' using errcode = '22023';
  end if;

  -- The round lock is held before the first write. Any later error rolls all of
  -- these effects back together.
  insert into introduction_selections (
    introduction_id, viewer_id, subject_id, decision, decided_at
  )
  select i.id,
         i.viewer_id,
         i.subject_id,
         case when i.id = any(v_ids) then 'kept' else 'released' end::selection_decision,
         now()
  from introductions i
  where i.round_id = r.id and i.viewer_id = auth.uid()
  on conflict (introduction_id) do update set
    viewer_id = excluded.viewer_id,
    subject_id = excluded.subject_id,
    decision = excluded.decision,
    decided_at = excluded.decided_at;

  -- Each subject shown in this exact round receives exactly one observation.
  -- The submitted_at guard plus FOR UPDATE makes this once-only under retries.
  insert into selection_scores (
    user_id, score, band, times_shown, times_kept, last_recomputed_at
  )
  select i.subject_id,
         case when s.decision = 'kept' then 0.5300 else 0.4900 end,
         3,
         1,
         case when s.decision = 'kept' then 1 else 0 end,
         now()
  from introductions i
  join introduction_selections s on s.introduction_id = i.id
  where i.round_id = r.id and i.viewer_id = auth.uid()
  on conflict (user_id) do update set
    times_shown = selection_scores.times_shown + 1,
    times_kept = selection_scores.times_kept
      + case when excluded.times_kept = 1 then 1 else 0 end,
    score = greatest(0.05, least(0.95,
      selection_scores.score
      + case when excluded.times_kept = 1 then 0.03 else -0.01 end
    )),
    band = greatest(1, least(5, ceil(
      greatest(0.05, least(0.95,
        selection_scores.score
        + case when excluded.times_kept = 1 then 0.03 else -0.01 end
      )) * 5
    )::smallint)),
    last_recomputed_at = now();

  update rounds
  set submitted_at = now()
  where id = r.id and submitted_at is null;

  if not found then
    raise exception 'Round submission lost its lock' using errcode = '40001';
  end if;

  -- Different users lock different round rows, so reciprocal submissions can
  -- otherwise both inspect the pair before either commits. Serialize only the
  -- selected UUID pairs, in deterministic order, so the waiter takes a fresh
  -- READ COMMITTED snapshot after the first submitter commits. Unrelated pairs
  -- continue concurrently.
  for v_pair_key in
    select least(i.viewer_id, i.subject_id)::text || ':'
      || greatest(i.viewer_id, i.subject_id)::text
    from introductions i
    where i.round_id = r.id
      and i.viewer_id = auth.uid()
      and i.id = any(v_ids)
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_pair_key, 0));
  end loop;

  -- A mutual is valid only when the kept introduction and its linked twin are
  -- structurally reciprocal and the other member already submitted the twin's
  -- round. Historical selections for the same UUID pair are irrelevant.
  with mutual_pairs as (
    select distinct mine.subject_id
    from introductions mine
    join introduction_selections mine_selection
      on mine_selection.introduction_id = mine.id
     and mine_selection.viewer_id = mine.viewer_id
     and mine_selection.subject_id = mine.subject_id
     and mine_selection.decision = 'kept'
    join introductions twin
      on twin.id = mine.reciprocal_id
     and twin.reciprocal_id = mine.id
     and twin.viewer_id = mine.subject_id
     and twin.subject_id = mine.viewer_id
    join rounds twin_round
      on twin_round.id = twin.round_id
     and twin_round.user_id = twin.viewer_id
     and twin_round.submitted_at is not null
    join introduction_selections twin_selection
      on twin_selection.introduction_id = twin.id
     and twin_selection.viewer_id = twin.viewer_id
     and twin_selection.subject_id = twin.subject_id
     and twin_selection.decision = 'kept'
    where mine.round_id = r.id
      and mine.viewer_id = auth.uid()
  ), inserted_connections as (
    insert into connections (user_a, user_b)
    select least(auth.uid(), subject_id), greatest(auth.uid(), subject_id)
    from mutual_pairs
    on conflict (user_a, user_b) do nothing
    returning id
  )
  select coalesce(array_agg(subject_id order by subject_id), '{}'::uuid[])
  into v_mutuals
  from mutual_pairs;

  return jsonb_build_object('mutualProfileIds', to_jsonb(v_mutuals));
end;
$$;

revoke all on function submit_round_selections(uuid, uuid[]) from public, anon, authenticated;
grant execute on function submit_round_selections(uuid, uuid[]) to authenticated;
