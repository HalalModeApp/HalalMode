-- Turn on the matcher that was written to be used.
--
-- `reciprocal_matching_v1` has been false since 0049, so every live round has
-- come from the legacy band matcher and none of the v1 scoring, pass handling
-- or cooldown work has ever affected a member. Fifty-odd migrations of matching
-- behaviour have been running against nothing.
--
-- What the shadow run on 2026-08-12 showed, against the real pool:
--
--   14 members eligible, 49 pairings possible, 47 after filtering
--   35 pairs planned — every member shown exactly 5, no more, no fewer
--   0 one-sided edges, 0 threshold breaches, no error
--
-- Even distribution and exact reciprocity are the two properties the product
-- rests on, and both hold. Earlier shadow runs reported zero pairs, which read
-- like a broken matcher and was not: the pool excludes anyone with a round they
-- have not submitted, and test accounts never open the app, so the pool was
-- permanently empty. With the cohort behaving like members, it fills.
--
-- Turned on now because there are no real members yet, which makes this the
-- cheapest moment it will ever be flipped. Live finalization is the one path
-- shadow cannot exercise; the next Fajr run is its first, and
-- `recent_matching_runs_service` will say plainly whether it worked.
--
-- To go back: update the same row to false. Nothing else needs changing.

do $$
declare
  v_enabled boolean;
begin
  update halal_mode_private.release_flags
  set enabled = true, rollout_percentage = 100, updated_at = now()
  where key = 'reciprocal_matching_v1';

  select enabled into v_enabled
  from halal_mode_private.release_flags
  where key = 'reciprocal_matching_v1';

  assert v_enabled, 'the reciprocal matcher must be enabled after this migration';
end;
$$;
