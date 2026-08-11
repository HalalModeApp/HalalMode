-- Count passes where they actually happen.
--
-- 0091 counted passes as `introduction_selections` rows with decision
-- 'explicit_pass'. That was wrong the moment 0083 landed: a *first* pass
-- deliberately records an ordinary release and banks the count on the pair, so
-- only second passes ever reach that decision. The metric read zero while a
-- pass was being made, which was found by making one and looking.
--
-- The count lives on pair_exposure, but that table records no time, so there
-- was nothing to window a rate against. A pass now stamps when it happened,
-- which is what makes "how often are people passing this week" answerable at
-- all — and that question matters more than most here, because the inference
-- that produces a pass is a guess about behaviour and could easily be firing
-- too often without anyone noticing.

alter table halal_mode_private.pair_exposure
  add column if not exists last_passed_at timestamptz;

comment on column halal_mode_private.pair_exposure.last_passed_at is
  'When this pair was last passed. Present so passes can be counted over a window; the count itself lives in explicit_pass_count.';

create or replace function public.pass_introduction(p_introduction_id uuid)
returns void
language plpgsql
security definer
set search_path = public, halal_mode_private as $$
declare
  v_viewer uuid := auth.uid();
  v_introduction introductions%rowtype;
  v_cfg jsonb;
  v_ban_after int;
  v_first_wait int;
  v_passes int;
begin
  if v_viewer is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  perform halal_mode_private.require_current_legal_consents(v_viewer);

  select i.* into v_introduction
  from introductions i
  join rounds r on r.id = i.round_id
  where i.id = p_introduction_id
    and i.viewer_id = v_viewer
    and r.user_id = v_viewer
    and r.submitted_at is null
    and r.expires_at > now();

  if v_introduction is null then
    raise exception 'Introduction is not available' using errcode = '42501';
  end if;

  v_cfg := halal_mode_private.active_matching_config();
  v_ban_after := coalesce((v_cfg ->> 'explicit_pass_ban_after')::int, 2);
  v_first_wait := coalesce((v_cfg ->> 'explicit_pass_first_cooldown_days')::int, 30);

  insert into halal_mode_private.pair_exposure as pe (
    user_low, user_high, explicit_pass_count, cooldown_until, last_passed_at
  )
  values (
    least(v_viewer, v_introduction.subject_id),
    greatest(v_viewer, v_introduction.subject_id),
    1,
    now() + make_interval(days => v_first_wait),
    now()
  )
  on conflict (user_low, user_high) do update
    set explicit_pass_count = pe.explicit_pass_count + 1,
        last_passed_at = now(),
        -- Greatest, so a pass lengthens a wait and never shortens one.
        cooldown_until = greatest(
          coalesce(pe.cooldown_until, now()),
          now() + make_interval(days => v_first_wait)
        )
  returning pe.explicit_pass_count into v_passes;

  insert into introduction_selections (introduction_id, viewer_id, subject_id, decision)
  values (
    v_introduction.id, v_viewer, v_introduction.subject_id,
    case
      when v_passes >= v_ban_after then 'explicit_pass'::selection_decision
      else 'released'::selection_decision
    end
  )
  on conflict (introduction_id) do update
    set viewer_id = excluded.viewer_id,
        subject_id = excluded.subject_id,
        decision = excluded.decision,
        decided_at = now()
    where introduction_selections.viewer_id = v_viewer;
end;
$$;

revoke all on function public.pass_introduction(uuid) from public, anon;
grant execute on function public.pass_introduction(uuid) to authenticated;

-- Backfill the pass this was found by, so the number is not misleading from
-- today onward while being silently short by one.
update halal_mode_private.pair_exposure
set last_passed_at = coalesce(last_passed_at, now())
where explicit_pass_count > 0 and last_passed_at is null;

create or replace function halal_mode_private.matching_outcome_metrics(
  p_since timestamptz default now() - interval '30 days'
) returns jsonb
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  with served as (
    select distinct r.user_id, r.tier
    from public.rounds r
    where r.opens_at >= p_since
  ), matched as (
    select distinct m.user_id
    from public.connections c
    cross join lateral (values (c.user_a), (c.user_b)) as m(user_id)
    where c.created_at >= p_since
  ), set_sizes as (
    select i.viewer_id, count(*)::numeric as shown
    from public.introductions i
    where i.created_at >= p_since
    group by i.viewer_id
  ), first_mutual as (
    select p.id, extract(epoch from (f.first_at - p.created_at)) / 86400 as days
    from public.profiles p
    join lateral (
      select min(c.created_at) as first_at
      from public.connections c
      where p.id in (c.user_a, c.user_b)
    ) f on true
    where f.first_at >= p_since
  )
  select jsonb_build_object(
    'since', p_since,
    'rounds_submitted', (
      select count(*) from public.rounds where submitted_at >= p_since
    ),
    'keeps', (
      select count(*) from public.introduction_selections
      where decision = 'kept' and decided_at >= p_since
    ),
    'first_choices_made', (
      select count(*) from public.introduction_selections
      where decision = 'kept' and rank = 1 and decided_at >= p_since
    ),
    'mutual_first_choices', (
      select count(*) from halal_mode_private.mutual_first_choices
      where matched_at >= p_since
    ),
    'connections_created', (
      select count(*) from public.connections where created_at >= p_since
    ),
    'contact_exchanged', (
      select count(*) from public.connections
      where contact_shared_at is not null and contact_shared_at >= p_since
    ),

    'members_served', (select count(*) from served),
    'zero_match_share', (
      select case when count(*) = 0 then null
        else round(1 - (
          select count(*)::numeric from served s
          where exists (select 1 from matched m where m.user_id = s.user_id)
        ) / count(*), 4) end
      from served
    ),
    'exposure_gini', halal_mode_private.gini(array(select shown from set_sizes)),
    'mean_set_size', (select round(avg(shown), 2) from set_sizes),
    'median_days_to_first_mutual', (
      select round(percentile_cont(0.5) within group (order by days)::numeric, 1)
      from first_mutual
    ),
    'mutual_rate', (
      select case when k = 0 then null else round(c::numeric / k, 4) end
      from (
        select (select count(*) from public.introduction_selections
                where decision = 'kept' and decided_at >= p_since) as k,
               (select count(*) from public.connections
                where created_at >= p_since) as c
      ) t
    ),

    -- Counted from the pair rather than the decision, because a first pass is
    -- recorded as an ordinary release on purpose and would otherwise never
    -- appear here at all.
    'pairs_passed', (
      select count(*) from halal_mode_private.pair_exposure
      where last_passed_at >= p_since
    ),
    -- Of those, the ones that reached a second pass and are now held apart.
    'pairs_passed_twice', (
      select count(*) from halal_mode_private.pair_exposure
      where last_passed_at >= p_since and explicit_pass_count >= 2
    ),
    -- The rate worth watching: if the inference is firing on most rounds, it is
    -- asking too often and the thresholds are wrong.
    'pass_rate_per_round', (
      select case when r = 0 then null else round(p::numeric / r, 4) end
      from (
        select (select count(*) from public.rounds where submitted_at >= p_since) as r,
               (select count(*) from halal_mode_private.pair_exposure
                where last_passed_at >= p_since) as p
      ) t
    ),
    'soft_selects', (
      select count(*) from public.introduction_selections
      where decision = 'soft_select' and decided_at >= p_since
    ),
    'hidden_pairs', (
      select count(*) from halal_mode_private.pair_exposure
      where retired_reason = 'hidden' and retired_at >= p_since
    ),

    'by_tier', (
      select coalesce(jsonb_object_agg(t.tier, t.stats), '{}'::jsonb)
      from (
        select s.tier::text as tier,
               jsonb_build_object(
                 'members_served', count(*),
                 'zero_match_share', round(1 - (
                   count(*) filter (
                     where exists (select 1 from matched m where m.user_id = s.user_id)
                   )::numeric / count(*)
                 ), 4)
               ) as stats
        from served s
        group by s.tier
      ) t
    )
  );
$$;

revoke all on function halal_mode_private.matching_outcome_metrics(timestamptz)
  from public, anon, authenticated;
grant execute on function halal_mode_private.matching_outcome_metrics(timestamptz)
  to service_role;

do $$
declare
  v jsonb := halal_mode_private.matching_outcome_metrics(now() - interval '30 days');
begin
  assert v ? 'pairs_passed' and v ? 'pass_rate_per_round',
    'passes must be countable over a window';
  -- The pass made while testing this must now be visible. If this fails, the
  -- metric is still blind to first passes and the whole point was missed.
  assert (v ->> 'pairs_passed')::int >= 1,
    format('a pass was made and should be counted; got %s', v ->> 'pairs_passed');
end;
$$;
