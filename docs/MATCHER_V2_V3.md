# Matcher V2 and Matcher V3

## Why there are two versions

Matcher V2 is the preserved greedy baseline. It is still the active server
configuration (`greedy_global_v1`) and is kept on the local `matcher-v2` branch
at the pre-V3 commit so it can be checked out for a direct comparison.

Matcher V3 (`anchored_maxmin_v2`) is the first-choice-focused path. It uses the
existing server allocator selector `anchored_maxmin_v1` but records a distinct
run label, so no client or database enum migration is needed just to compare
the algorithms. The selector is inactive by default and the reciprocal release
flag remains off.

## What V3 changes

1. The planner keeps both directional estimates (`P(a picks b)` and
   `P(b picks a)`) instead of collapsing them before allocation.
2. Each member's candidate edges are ranked from that member's directional
   estimate.
3. Edges that are number one for both endpoints are placed first, strongest
   weaker-direction estimate first, subject to the same score floor and
   capacity rules.
4. Members not covered by a mutual top edge are covered best-first, with the
   most constrained members considered before high-degree members.
5. The existing greedy fill, bounded fairness, exploration, repair, composition,
   and no-write shadow finalization remain in place.

This is an objective change, not a promise: estimates are still model scores,
not observed probabilities. A mutual-top anchor is a prediction that must be
measured against later selections.

## Safety and rollback

- The V3 config row is version 11, inactive, and was seeded on the hosted
  project with the same parameters as active V2 except for its allocator.
- The active hosted config was restored to version 9 after the shadow check.
- `reciprocal_matching_v1` remains disabled, so no member-facing live round can
  use either new path.
- Switch to the `matcher-v2` branch to inspect or run the exact pre-V3 code.

## Current hosted evidence

The fake cohort currently contains 514 auth accounts and 455 eligible profiles.
The deployed V3 shadow run created 1,600 private shadow edges before the
existing batched shadow finalizer stalled; its partial shape had 430 members,
1–5 edges per member, and **zero one-sided edges**. This is useful smoke-test
evidence, not a completed quality comparison. The finalizer stall is a separate
operational blocker and must be fixed before using a full hosted shadow run as
release evidence.
