# Private reciprocal matching calibration

Halal Mode’s matcher uses a private feedback band to distribute daily introductions across broad, comparable cohorts. It is not a public score, rank, attractiveness rating, eligibility grade, or a signal that one member chose another.

## What the matcher requires

An introduction exists only when every one of these conditions holds in both directions:

1. Each member passes the other’s private age, height/build, practice, timeline, block, and country settings.
2. The members’ private calibration bands are at most one broad band apart.
3. Neither member has already been introduced to the other.
4. Both daily round limits allow the reciprocal pair.

The pair graph creates both cards together. A keep is never disclosed until it is mutual.

## Private calibration policy

`halal_mode_private.matching_band_policies` contains one reviewed row per gender. Its only initial setting, `feedback_weight`, dampens how much the existing private selection-feedback value can move a member away from the neutral midpoint. Both genders start at `0.900`; the separate rows permit a future evidence-backed adjustment without hiding it in application code. Policy updates must go through the service-only recalculation routine, which refreshes affected stored bands atomically so the daily pair graph remains fast at scale.

Changing a policy requires an ethics and fairness review, an updated migration, database tests, and a one-sentence entry in `DECISIONS.md`. No client role has read or write access to the policy, scores, or bands.

## International matching

Country matching is reciprocal and never paid. For a cross-country pair, each member must choose `open` or `willing_abroad` and, if they maintain a country list, include the other member’s country. Empty country lists mean no country-specific restriction. Local distance caps apply only to same-country pairs; they do not override an explicit reciprocal international choice.
