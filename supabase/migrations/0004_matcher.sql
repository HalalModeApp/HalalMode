-- The reciprocal introduction matcher.
--
-- Runs as a scheduled job, not on demand, because a round must be built for the
-- whole eligible population at once. The defining constraint:
--
--     if Mo appears in Lama's set, Lama appears in Mo's set
--
-- You cannot get that by querying candidates independently per user, which is
-- why this builds a pair graph first and derives both sides' cards from it.

create or replace function generate_round_for_pairs(p_expires_at timestamptz)
returns int
language plpgsql security definer set search_path = public as $$
declare
  pair record;
  round_a uuid;
  round_b uuid;
  intro_a uuid;
  intro_b uuid;
  created int := 0;
begin
  -- Everyone eligible gets exactly one open round to hang cards on.
  insert into rounds (user_id, tier, expires_at)
  select p.id, p.tier, p_expires_at
  from profiles p
  where p.onboarding_complete and not p.is_paused
    and not exists (
      select 1 from rounds r where r.user_id = p.id and r.submitted_at is null
    );

  for pair in
    with eligible as (
      select p.id, p.gender, p.tier,
             coalesce(s.band, 3) as band
      from profiles p
      left join selection_scores s on s.user_id = p.id
      where p.onboarding_complete and not p.is_paused
    ),
    -- Candidate pairs: mutually acceptable, in adjacent score bands, and not
    -- already introduced. The band window is deliberately +/-1, not exact, so
    -- nobody is sealed into a single tier.
    candidates as (
      select m.id as male_id, f.id as female_id,
             abs(m.band - f.band) as band_gap,
             -- Controlled randomness. Without it the same pairs surface every
             -- round and the population calcifies.
             random() as jitter
      from eligible m
      join eligible f on f.gender = 'female'
      where m.gender = 'male'
        and abs(m.band - f.band) <= 1
        and passes_criteria(m.id, f.id)
        and passes_criteria(f.id, m.id)
        and not exists (
          select 1 from introductions i
          where (i.viewer_id = m.id and i.subject_id = f.id)
             or (i.viewer_id = f.id and i.subject_id = m.id)
        )
    ),
    ranked as (
      select *,
             row_number() over (
               partition by male_id order by band_gap, jitter
             ) as male_rank,
             row_number() over (
               partition by female_id order by band_gap, jitter
             ) as female_rank
      from candidates
    )
    -- Cap both sides so introductions are distributed fairly rather than
    -- concentrated on whoever happens to match everyone.
    select r.male_id, r.female_id
    from ranked r
    join eligible em on em.id = r.male_id
    join eligible ef on ef.id = r.female_id
    where r.male_rank <= (select introductions from tier_limits(em.tier))
      and r.female_rank <= (select introductions from tier_limits(ef.tier))
  loop
    select id into round_a from rounds
      where user_id = pair.male_id and submitted_at is null limit 1;
    select id into round_b from rounds
      where user_id = pair.female_id and submitted_at is null limit 1;

    continue when round_a is null or round_b is null;

    insert into introductions (round_id, viewer_id, subject_id, agreements)
    values (round_a, pair.male_id, pair.female_id,
            agreement_summary(pair.male_id, pair.female_id))
    on conflict (round_id, subject_id) do nothing
    returning id into intro_a;

    insert into introductions (round_id, viewer_id, subject_id, agreements)
    values (round_b, pair.female_id, pair.male_id,
            agreement_summary(pair.female_id, pair.male_id))
    on conflict (round_id, subject_id) do nothing
    returning id into intro_b;

    -- Link the twins so an audit can prove reciprocity holds.
    if intro_a is not null and intro_b is not null then
      update introductions set reciprocal_id = intro_b where id = intro_a;
      update introductions set reciprocal_id = intro_a where id = intro_b;
      created := created + 1;
    end if;
  end loop;

  return created;
end;
$$;

/**
 * Quietly expires unresolved rounds. Non-mutual keeps simply lapse — neither
 * side is told anything happened.
 */
create or replace function expire_stale_rounds()
returns int
language plpgsql security definer set search_path = public as $$
declare
  affected int;
begin
  update introduction_selections s
  set decision = 'expired'
  from introductions i
  join rounds r on r.id = i.round_id
  where s.introduction_id = i.id
    and s.decision = 'kept'
    and r.expires_at < now()
    and not exists (
      select 1 from introduction_selections other
      where other.viewer_id = s.subject_id
        and other.subject_id = s.viewer_id
        and other.decision = 'kept'
    );

  get diagnostics affected = row_count;

  update rounds set submitted_at = now()
  where submitted_at is null and expires_at < now();

  return affected;
end;
$$;

revoke all on function generate_round_for_pairs(timestamptz) from public;
revoke all on function expire_stale_rounds() from public;
