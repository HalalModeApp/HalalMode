-- Give each member a shortlist instead of considering every pair.
--
-- Measured, at 432 members:
--
--   pairs after the cheap pre-filter   34,575
--   the pre-filter itself                153ms
--   eligibility, per pair               1.33ms
--   both compatibility calls, per pair  0.38ms
--   projected total                       59 seconds
--
-- The filtering is free. The per-pair functions are the entire cost, and there
-- are simply too many pairs to ask about. Making those functions faster buys
-- one doubling; the shape is the problem. Pairs grow with the square of
-- members, so every new member costs more than the last one did.
--
-- Nobody needs 34,575 candidates evaluated to receive five introductions. Each
-- member gets a shortlist of the most plausible, and only those are scored
-- properly. That turns N-squared into N times a constant: the work per member
-- stops growing as the app does.
--
-- Two things make this safe rather than a quiet narrowing of everyone's world:
--
-- The shortlist is a union, not an intersection. A pair survives if it is in
-- either member's shortlist, so being unpopular by the cheap measure does not
-- remove you from the reach of somebody who would rank you highly.
--
-- The ordering is a proxy, not a verdict. It ranks by age gap and rough
-- distance — arithmetic on columns already to hand — purely to decide who is
-- worth the expensive question. The real compatibility score and the real
-- eligibility rules are unchanged and still decide everything that matters.

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
  with eligible_pairs as (
    select
      m.id as male_id,
      f.id as female_id,
      -- Cheap closeness: years of age gap plus a rough distance in units of
      -- 100km. Equirectangular rather than great-circle — at these distances
      -- the difference is irrelevant for deciding who to look at properly, and
      -- it costs one cosine per row instead of a trigonometric distance.
      abs(m.age - f.age)
        + sqrt(
            pow((f.latitude - m.latitude) * 111.0, 2)
            + pow((f.longitude - m.longitude) * 111.0
                  * cos(radians((m.latitude + f.latitude) / 2)), 2)
          ) / 100.0 as apartness
    from halal_mode_private.matching_pool m
    join halal_mode_private.matching_pool f on f.gender = 'female'
    where m.gender = 'male'
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
      and (
        not halal_mode_private.is_must_have(m.must_have, 'age')
        or f.age between m.min_age and m.max_age
      )
      and (
        not halal_mode_private.is_must_have(f.must_have, 'age')
        or m.age between f.min_age and f.max_age
      )
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
  ), shortlisted as (
    select
      male_id, female_id,
      row_number() over (partition by male_id order by apartness, female_id) as his_rank,
      row_number() over (partition by female_id order by apartness, male_id) as her_rank
    from eligible_pairs
  ), cheap as (
    select least(male_id, female_id) as user_low,
           greatest(male_id, female_id) as user_high
    from shortlisted
    -- Forty each. A free member is shown five and Premium ten, so forty leaves
    -- the matcher real choice after cooldowns, repeats and fairness have taken
    -- their share — while keeping the work per member flat as the app grows.
    where his_rank <= 40 or her_rank <= 40
  )
  select c.user_low, c.user_high,
         halal_mode_private.compatibility(c.user_low, c.user_high),
         halal_mode_private.compatibility(c.user_high, c.user_low),
         coalesce(pe.times_shown, 0), pe.first_reciprocal_score
  from cheap c
  left join halal_mode_private.pair_exposure pe
    on pe.user_low = c.user_low and pe.user_high = c.user_high
  where (
    p_after_low is null
    or c.user_low > p_after_low
    or (c.user_low = p_after_low
      and c.user_high > coalesce(p_after_high, '00000000-0000-0000-0000-000000000000'::uuid))
  )
  -- Still the authority, now asked about a shortlist rather than everybody.
  and halal_mode_private.matching_pair_is_eligible(
    c.user_low, c.user_high, now(),
    halal_mode_private.active_matching_config_version()
  )
  order by c.user_low, c.user_high
  limit least(greatest(coalesce(p_page_size, 1000), 1), 1000);
$$;
