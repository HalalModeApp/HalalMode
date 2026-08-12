-- Rule out the impossible pairs before doing any work on them.
--
-- Candidate generation pairs every man with every woman in the pool and then
-- asks three plpgsql functions about each pair. At 53 members that is 660 pairs
-- and it is instant. At 432 members it is 44,720 pairs, and the round times out
-- before it has decided anything at all.
--
-- The multiplication is not really the problem. 44,720 column comparisons is
-- nothing to a database. The problem is that each of those pairs triggers
-- `matching_pair_is_eligible` and two `compatibility` calls, and every one of
-- those re-reads the same handful of rows: the viewer's profile, the viewer's
-- preferences, the subject's profile, the subject's preferences. For 432
-- members that is roughly seven hundred thousand index lookups to answer
-- questions about 432 people. Each member's row is fetched some three hundred
-- times.
--
-- So the fix is not a faster check. It is to carry each member's own limits on
-- the row that already describes them, and compare columns — once — before any
-- function is called.
--
-- Three pre-filters, and every one of them can only remove a pair the
-- authority would remove anyway:
--
--   Country, which is universal and reciprocal. Written out exactly as
--   accepts_subject_country decides it, in both directions.
--
--   Age, but only where that member marked it a must-have. An unmarked age
--   range means "ideally", and the score handles it — filtering on it would
--   quietly delete valid people, which is the mistake 0092 exists to prevent.
--
--   Distance, likewise only where marked, and as a bounding box rather than a
--   circle. A box drawn around a circle contains it, so this can over-include
--   but never wrongly exclude, and it costs two subtractions instead of a
--   trigonometric distance. The exact radius is still applied afterwards by the
--   authority.
--
-- Everything unmarked stays scored rather than excluded, so nobody disappears
-- from anybody's reach because of an optimisation.

create or replace view halal_mode_private.matching_pool as
select
  p.id,
  p.gender,
  p.tier,
  p.country,
  p.latitude,
  p.longitude,
  extract(year from age(p.birth_date))::int as age,
  l.introductions as introductions_per_round,
  h.qualified_exposures,
  h.times_picked_by_others,
  h.rounds_since_last_mutual,
  h.rounds_since_last_served,
  h.active_match_count,
  h.model_confidence,
  l.open_connections as active_match_cap,
  -- Appended rather than slotted in beside the other profile columns: `create
  -- or replace view` cannot reorder or rename existing ones, only add at the
  -- end. The member's own stated limits, carried here so a comparison does not
  -- require a query. Left joined, so a member without preferences is filtered
  -- by the authority as before rather than silently dropped here.
  p.relocation,
  pref.min_age,
  pref.max_age,
  pref.max_distance_km,
  pref.preferred_countries,
  pref.must_have
from public.profiles p
cross join lateral tier_limits(p.tier) l
join halal_mode_private.match_health h on h.user_id = p.id
left join public.private_preferences pref on pref.user_id = p.id
where p.onboarding_complete
  and not p.is_paused
  and public.profile_is_ready_for_matching(p.id)
  and halal_mode_private.member_has_current_legal_consents(p.id)
  and h.active_match_count < l.open_connections
  and not exists (
    select 1 from public.rounds r
    where r.user_id = p.id and r.submitted_at is null
  );

revoke all on halal_mode_private.matching_pool from public, anon, authenticated;

create or replace function halal_mode_private.matching_candidate_edges(
  p_after_low uuid default null,
  p_after_high uuid default null,
  p_page_size integer default 1000
) returns table (
  user_low uuid,
  user_high uuid,
  compat_low_to_high numeric,
  compat_high_to_low numeric,
  pair_times_shown integer,
  pair_first_score numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public, halal_mode_private as $$
  with cheap as (
    select least(m.id, f.id) as user_low,
           greatest(m.id, f.id) as user_high
    from halal_mode_private.matching_pool m
    join halal_mode_private.matching_pool f on f.gender = 'female'
    where m.gender = 'male'
      -- Country, both ways. Same country always passes; otherwise the member
      -- must be open to relocating and, if they named countries, the other
      -- must be among them.
      and (
        lower(btrim(m.country)) = lower(btrim(f.country))
        or (
          m.relocation in ('open', 'willing_abroad')
          and (
            coalesce(array_length(m.preferred_countries, 1), 0) = 0
            or exists (
              select 1 from unnest(m.preferred_countries) as allowed(country)
              where lower(btrim(allowed.country)) = lower(btrim(f.country))
            )
          )
        )
      )
      and (
        lower(btrim(f.country)) = lower(btrim(m.country))
        or (
          f.relocation in ('open', 'willing_abroad')
          and (
            coalesce(array_length(f.preferred_countries, 1), 0) = 0
            or exists (
              select 1 from unnest(f.preferred_countries) as allowed(country)
              where lower(btrim(allowed.country)) = lower(btrim(m.country))
            )
          )
        )
      )
      -- Age, only where marked a must-have.
      and (
        not halal_mode_private.is_must_have(m.must_have, 'age')
        or f.age between m.min_age and m.max_age
      )
      and (
        not halal_mode_private.is_must_have(f.must_have, 'age')
        or m.age between f.min_age and f.max_age
      )
      -- Distance, only where marked, and as a box around the circle. One degree
      -- of latitude is about 111km; a degree of longitude shrinks with the
      -- cosine of the latitude, floored so the poles cannot divide by zero.
      and (
        not halal_mode_private.is_must_have(m.must_have, 'distance')
        or (
          abs(f.latitude - m.latitude) <= m.max_distance_km / 111.0
          and abs(f.longitude - m.longitude)
              <= m.max_distance_km / (111.0 * greatest(cos(radians(m.latitude)), 0.01))
        )
      )
      and (
        not halal_mode_private.is_must_have(f.must_have, 'distance')
        or (
          abs(m.latitude - f.latitude) <= f.max_distance_km / 111.0
          and abs(m.longitude - f.longitude)
              <= f.max_distance_km / (111.0 * greatest(cos(radians(f.latitude)), 0.01))
        )
      )
      and (
        p_after_low is null
        or least(m.id, f.id) > p_after_low
        or (least(m.id, f.id) = p_after_low
          and greatest(m.id, f.id) > coalesce(
            p_after_high, '00000000-0000-0000-0000-000000000000'::uuid
          ))
      )
  )
  select c.user_low, c.user_high,
         halal_mode_private.compatibility(c.user_low, c.user_high),
         halal_mode_private.compatibility(c.user_high, c.user_low),
         coalesce(pe.times_shown, 0), pe.first_reciprocal_score
  from cheap c
  left join halal_mode_private.pair_exposure pe
    on pe.user_low = c.user_low and pe.user_high = c.user_high
  -- Still the authority, now asked about far fewer pairs.
  where halal_mode_private.matching_pair_is_eligible(
    c.user_low, c.user_high, now(),
    halal_mode_private.active_matching_config_version()
  )
  order by c.user_low, c.user_high
  limit least(greatest(coalesce(p_page_size, 1000), 1), 1000);
$$;
