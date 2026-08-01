-- Sect, and "Must have" on every preference.
--
-- This changes the shape of matching criteria rather than adding to them.
--
-- Until now, practice, timeline, build and country were *hard filters*: fail
-- one and the pair never existed. They were then also scored in
-- compatibility(), which meant those terms were always exactly 1.0 for every
-- surviving pair — the two criteria members care about most contributed nothing
-- to ranking. See 0061 for the scoring side of that fix.
--
-- Every criterion now grades. A member marks a criterion "Must have" only when
-- they genuinely mean it, and that is the sole hard filter. The judgement about
-- what is absolute moves to the person who holds it, because it is not the same
-- for everyone: sect is decisive for one family and irrelevant to the next.
--
-- Nothing here is visible to another member. Preferences, and now the fact that
-- something is a must-have, stay in the private row that only its owner and the
-- matcher can read.

-- ---------------------------------------------------------------------------
-- Sect
--
-- Absent from the model entirely until now, which has a specific and expensive
-- failure mode: two people look compatible on every axis we measure, one does
-- not reciprocate, and the estimator records unexplained noise because the
-- variable that explains it was never captured.
--
-- 'prefer_not_to_say' exists so nobody is forced to declare. It is treated as
-- compatible with everything rather than as a mismatch — declining to state
-- something is not the same as stating a difference.
-- ---------------------------------------------------------------------------

create type sect as enum (
  'sunni',
  'shia',
  'other',
  'prefer_not_to_say'
);

alter table public.profiles
  add column if not exists sect sect not null default 'prefer_not_to_say';

comment on column public.profiles.sect is
  'Self-declared. Shown on a profile and used in matching. prefer_not_to_say never counts as a mismatch.';

alter table public.private_preferences
  add column if not exists preferred_sects sect[] not null default '{}';

comment on column public.private_preferences.preferred_sects is
  'Empty means no sect preference. Private to its owner, like every column here.';

-- ---------------------------------------------------------------------------
-- Must have
--
-- A jsonb map keyed by criterion rather than a column per criterion, so adding
-- a criterion later is a code change instead of a migration, and the matcher
-- can iterate the keys generically.
--
-- Absent or false means the criterion is a weighted preference. True makes it a
-- hard filter for that member only — it never constrains anybody else.
-- ---------------------------------------------------------------------------

alter table public.private_preferences
  add column if not exists must_have jsonb not null default '{}'::jsonb;

alter table public.private_preferences
  add constraint private_preferences_must_have_is_object
  check (jsonb_typeof(must_have) = 'object');

comment on column public.private_preferences.must_have is
  'Criteria this member treats as absolute, e.g. {"sect": true, "children": true}. Everything unset grades instead of filtering. The only hard filters in matching, and chosen by the member who pays their cost.';

/**
 * Whether a member has marked one criterion as absolute.
 *
 * Unknown keys and non-boolean values read as false, so a malformed map cannot
 * silently narrow somebody's pool.
 */
create or replace function halal_mode_private.is_must_have(
  p_must_have jsonb,
  p_criterion text
) returns boolean
language sql
immutable
as $$
  select coalesce(
    case
      when jsonb_typeof(coalesce(p_must_have, '{}'::jsonb) -> p_criterion) = 'boolean'
        then (p_must_have ->> p_criterion)::boolean
      else false
    end,
    false
  );
$$;

-- ---------------------------------------------------------------------------
-- Ordered vocabularies
--
-- Build was compared by array membership, so selecting "Slim, Athletic"
-- silently excluded "Lean", "Slender" and "Toned" — to most eyes the same
-- thing. Practice, timeline and relocation were compared the same way.
--
-- Giving each an explicit position lets the scorer measure *distance* rather
-- than membership, which is what makes "practicing is worth 0.7 to someone
-- seeking very practicing" expressible at all.
-- ---------------------------------------------------------------------------

create table halal_mode_private.criterion_scale (
  criterion text not null check (criterion ~ '^[a-z][a-z0-9_]{1,40}$'),
  value     text not null,
  position  smallint not null,
  primary key (criterion, value)
);

comment on table halal_mode_private.criterion_scale is
  'Ordered positions for graded categorical criteria. Distance along the scale drives partial credit; adjacent values are near-matches rather than misses.';

insert into halal_mode_private.criterion_scale (criterion, value, position) values
  -- Most to least observant. Adjacent steps are near-neighbours in both
  -- directions: the gap between "very practicing" and "practicing" is the same
  -- whichever of the two is doing the looking.
  ('practice', 'very_practicing', 1),
  ('practice', 'practicing',      2),
  ('practice', 'moderate',        3),
  ('practice', 'learning',        4),

  -- Soonest to latest. People compromise on timing far more readily than on
  -- belief, so this scale is scored more gently than practice.
  ('timeline', 'within_3_months', 1),
  ('timeline', 'within_6_months', 2),
  ('timeline', 'within_1_year',   3),
  ('timeline', '1_to_2_years',    4),

  -- Most to least willing to move. The ends of this scale are close to a hard
  -- no in practice, whatever both parties say early on.
  ('relocation', 'willing_abroad',  1),
  ('relocation', 'open',            2),
  ('relocation', 'preferred_local', 3),
  ('relocation', 'strictly_local',  4),

  -- Children. "Open to children" sits between wanting and not wanting them,
  -- because it genuinely does.
  ('children', 'wants_children_soon',  1),
  ('children', 'wants_children_later', 2),
  ('children', 'open_to_children',     3),
  ('children', 'no_children',          4),

  -- Build, slightest to largest, following the vocabulary members already see.
  -- Neighbouring terms describe near-identical people and should score as such.
  ('build', 'Petite',            1),
  ('build', 'Slim',              2),
  ('build', 'Slender',           3),
  ('build', 'Lean',              4),
  ('build', 'Tall & Lean',       5),
  ('build', 'Average',           6),
  ('build', 'Fit / Active',      7),
  ('build', 'Toned',             8),
  ('build', 'Athletic',          9),
  ('build', 'Muscular',         10),
  ('build', 'Medium / Solid',   11),
  ('build', 'Curvy',            12),
  ('build', 'Full-Figured',     13),
  ('build', 'Broad',            14),
  ('build', 'Stocky',           15),
  ('build', 'Robust / Sturdy',  16),
  ('build', 'Plus Size',        17)
on conflict (criterion, value) do nothing;

revoke all on table halal_mode_private.criterion_scale from public, anon, authenticated;
revoke all on function halal_mode_private.is_must_have(jsonb, text) from public, anon, authenticated;

/**
 * Partial credit for two positions on the same scale.
 *
 * `p_falloff` is the score at one step apart; further steps fall away
 * geometrically. Practice at 0.70 therefore gives 0.70, 0.49, 0.34 — so a
 * near-neighbour is a real candidate and the far end of the scale is not.
 *
 * Returns 1.0 when either value is unknown to the scale rather than 0, so a new
 * vocabulary entry that has not been positioned yet cannot silently exclude
 * people.
 */
create or replace function halal_mode_private.scale_proximity(
  p_criterion text,
  p_left text,
  p_right text,
  p_falloff numeric
) returns numeric
language sql
stable
security definer
set search_path = halal_mode_private, public as $$
  select coalesce((
    select power(greatest(0.01, least(1.0, p_falloff)), abs(l.position - r.position))
    from halal_mode_private.criterion_scale l
    join halal_mode_private.criterion_scale r
      on r.criterion = l.criterion and r.value = p_right
    where l.criterion = p_criterion and l.value = p_left
  ), 1.0);
$$;

revoke all on function halal_mode_private.scale_proximity(text, text, text, numeric)
  from public, anon, authenticated;
