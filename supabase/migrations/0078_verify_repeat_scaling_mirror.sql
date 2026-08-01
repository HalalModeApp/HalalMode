-- Check the two halves of the repeat scaling agree, on the real database.
--
-- repeat_generosity and pair_cooldown_days exist twice: once in SQL, where the
-- cooldown is written, and once in TypeScript, where the allowance is enforced.
-- A drift between them would not fail anything — it would quietly hand a pair a
-- three-week wait and a five-showing allowance, and nobody would notice.
--
-- There is no pgTAP here yet and the test suite cannot reach Postgres, so this
-- runs the assertions where they can actually be run: at apply time, against
-- the live configuration. A failure aborts the migration rather than being
-- reported, which is a blunter instrument than a test but a real one.
--
-- The expected values are the TypeScript results for the same inputs, computed
-- from the config this migration chain installs.

do $$
declare
  cfg jsonb := halal_mode_private.active_matching_config();
  low numeric := (cfg ->> 'min_reciprocal_score')::numeric;
  high numeric := (cfg ->> 'repeat_generous_score')::numeric;
  mid numeric;
begin
  mid := low + (high - low) / 2;

  -- Generosity: 0 at the floor, 1 at the anchor, clamped outside both.
  assert halal_mode_private.repeat_generosity(low, cfg) = 0,
    'generosity should be nil at the score floor';
  assert halal_mode_private.repeat_generosity(high, cfg) = 1,
    'generosity should be full at the anchor';
  assert halal_mode_private.repeat_generosity(mid, cfg) = 0.5,
    'generosity should be linear between the two';
  assert halal_mode_private.repeat_generosity(0, cfg) = 0,
    'a score below the floor should clamp, not go negative';
  assert halal_mode_private.repeat_generosity(1, cfg) = 1,
    'a score above the anchor should clamp, not exceed one';
  assert halal_mode_private.repeat_generosity(null, cfg) = 0,
    'an unknown score should earn no patience rather than raise';

  -- Cooldown: inverted, and bounded by the configured range.
  assert halal_mode_private.pair_cooldown_days(high, cfg)
       = (cfg ->> 'min_repeat_cooldown_days')::integer,
    'a promising pair should wait the shortest time';
  assert halal_mode_private.pair_cooldown_days(low, cfg)
       = (cfg ->> 'max_repeat_cooldown_days')::integer,
    'a pair at the floor should wait the longest';
  assert halal_mode_private.pair_cooldown_days(mid, cfg) = 12,
    'the midpoint should match the TypeScript result of 12 days';
  assert halal_mode_private.pair_cooldown_days(high, cfg)
       < halal_mode_private.pair_cooldown_days(low, cfg),
    'the wait must run against the estimate, not with it';

  -- The trigger is attached to the column it governs. Cheaper to assert than to
  -- rediscover the day a pair comes back a fortnight early.
  assert exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'halal_mode_private'
      and c.relname = 'pair_exposure'
      and t.tgname = 'pair_exposure_cooldown_from_score'
      and not t.tgisinternal
  ), 'the cooldown trigger is missing from pair_exposure';
end;
$$;
