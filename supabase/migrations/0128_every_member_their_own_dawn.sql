-- Give every member their own dawn.
--
-- Rounds were created with one expiry for the whole world, opening at the
-- instant they were written — Fajr in Madinah, which is 2:30am in London and
-- the previous evening in Los Angeles. Now each member's round opens at their
-- own Fajr and runs for their own day from there.
--
-- The pair is still created together and reciprocity is untouched: if she is in
-- his set, he is in hers. Only the moment each of them sees it moves. Two
-- members thirteen hours apart will act on the same pair most of a day apart,
-- and the matching already handles that — mutual interest is detected whenever
-- the second person submits, with no requirement that the first one's window is
-- still open.
--
-- The dawn itself is computed by the caller, from each member's coordinates,
-- before this runs. Doing it here would mean a second implementation of the
-- same astronomy in a second language, which is the shape that has already
-- drifted twice in this repository.

create or replace function public.generate_round_for_pairs_scheduled(p_schedule jsonb)
returns int
language plpgsql security definer set search_path = public, halal_mode_private as $$
declare pair record; round_a uuid; round_b uuid; intro_a uuid; intro_b uuid; created int := 0;
begin
  -- One row per member, each with their own dawn and their own day. The
  -- schedule is computed from each member's coordinates before this is called;
  -- anybody missing from it gets no round, which is what should happen when we
  -- cannot work out when their dawn is.
  insert into rounds (user_id, tier, opens_at, expires_at)
  select p.id, p.tier, s.opens_at, s.expires_at
  from profiles p
  join jsonb_to_recordset(p_schedule)
    as s(user_id uuid, opens_at timestamptz, expires_at timestamptz)
    on s.user_id = p.id
  where p.onboarding_complete and not p.is_paused
    and profile_is_ready_for_matching(p.id)
    and halal_mode_private.member_has_current_legal_consents(p.id)
    and not exists (select 1 from rounds r where r.user_id = p.id and r.submitted_at is null);

  for pair in
    with eligible as (
      select p.id, p.gender, p.tier, coalesce(s.band, 3) as band
      from profiles p left join selection_scores s on s.user_id = p.id
      where p.onboarding_complete and not p.is_paused
        and profile_is_ready_for_matching(p.id)
        and halal_mode_private.member_has_current_legal_consents(p.id)
    ), candidates as (
      select m.id as male_id, f.id as female_id, abs(m.band - f.band) as band_gap, random() as jitter
      from eligible m join eligible f on f.gender = 'female'
      where m.gender = 'male' and abs(m.band - f.band) <= 1
        and passes_criteria(m.id, f.id) and passes_criteria(f.id, m.id)
        and not exists (select 1 from introductions i where (i.viewer_id = m.id and i.subject_id = f.id) or (i.viewer_id = f.id and i.subject_id = m.id))
    ), ranked as (
      select *, row_number() over (partition by male_id order by band_gap, jitter) as male_rank,
        row_number() over (partition by female_id order by band_gap, jitter) as female_rank from candidates
    )
    select r.male_id, r.female_id from ranked r join eligible em on em.id = r.male_id join eligible ef on ef.id = r.female_id
    where r.male_rank <= (select introductions from tier_limits(em.tier)) and r.female_rank <= (select introductions from tier_limits(ef.tier))
  loop
    select id into round_a from rounds where user_id = pair.male_id and submitted_at is null limit 1;
    select id into round_b from rounds where user_id = pair.female_id and submitted_at is null limit 1;
    continue when round_a is null or round_b is null;
    insert into introductions (round_id, viewer_id, subject_id, agreements) values (round_a, pair.male_id, pair.female_id, agreement_summary(pair.male_id, pair.female_id)) on conflict (round_id, subject_id) do nothing returning id into intro_a;
    insert into introductions (round_id, viewer_id, subject_id, agreements) values (round_b, pair.female_id, pair.male_id, agreement_summary(pair.female_id, pair.male_id)) on conflict (round_id, subject_id) do nothing returning id into intro_b;
    if intro_a is not null and intro_b is not null then
      update introductions set reciprocal_id = intro_b where id = intro_a;
      update introductions set reciprocal_id = intro_a where id = intro_b;
      created := created + 1;
    end if;
  end loop;
  return created;
end;
$$;

-- Who needs a round, and where they are.
--
-- Coordinates only, and only for members already eligible — the caller needs
-- them solely to work out when dawn is. No names, no ages, nothing that
-- identifies anybody.
create or replace function public.members_awaiting_round_service()
returns table (user_id uuid, latitude double precision, longitude double precision)
language sql
stable
security definer
set search_path = public, halal_mode_private as $$
  select p.id, p.latitude, p.longitude
  from public.profiles p
  where p.onboarding_complete
    and not p.is_paused
    and public.profile_is_ready_for_matching(p.id)
    and halal_mode_private.member_has_current_legal_consents(p.id)
    and p.latitude is not null and p.longitude is not null
    and not exists (
      select 1 from public.rounds r
      where r.user_id = p.id and r.submitted_at is null and r.expires_at > now()
    );
$$;

revoke all on function public.members_awaiting_round_service() from public, anon, authenticated;
grant execute on function public.members_awaiting_round_service() to service_role;

revoke all on function public.generate_round_for_pairs_scheduled(jsonb) from public, anon, authenticated;
grant execute on function public.generate_round_for_pairs_scheduled(jsonb) to service_role;
