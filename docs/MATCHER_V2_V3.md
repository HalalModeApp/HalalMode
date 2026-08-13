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

## Three-way benchmark evidence (2026-08-13)

The repository now contains a deterministic comparison harness at
`scripts/matching-benchmark.mjs`. It runs each allocator in a fresh Node
process, so a large-cohort failure is recorded instead of taking down the
whole report. The graph has 40 pre-filtered shortlist edges per member, a
balanced pool, free capacity 5, Premium capacity 10, and no persistence or
network latency. The hidden-choice model is independent of the matcher score
unless a run explicitly says otherwise. Therefore these are allocation and
ranking measurements, not proof that the estimator predicts real members.

The three labels are deliberately explicit:

- **Legacy V1 / pre-v1** is the old scheduled SQL generator. Its production
  path still calls the row-at-a-time eligibility functions.
- **Matcher V2** is the active reciprocal allocator, `greedy_global_v1`.
- **Matcher V3** is the inactive `anchored_maxmin_v1` allocator, labelled
  `anchored_maxmin_v2` in runs.

The current-configuration allocator-core timings were:

| Members | Legacy V1 | Matcher V2 | Matcher V3 |
| ---: | ---: | ---: | ---: |
| 455 | 28 ms | 62 ms | 94 ms |
| 2,000 | 72 ms | 606 ms | 625 ms |
| 5,000 | 258 ms | 3.24 s | 3.47 s |
| 10,000 | 327 ms | 15.0 s | 15.8 s |
| 25,000 | 1.06 s | 121.9 s | 140.5 s |

These V2/V3 figures include the current exploration and repair passes but
exclude candidate fetching and finalization. At 25,000 members both reciprocal
allocators are already at or beyond the documented 125-second gateway ceiling;
they are not a hundred-thousand-user solution. The legacy numbers above are a
pure allocation equivalent, not the production SQL cost: the live performance
handover measured 59 seconds for 34,575 old per-pair checks, versus 153 ms for
the same set-based pre-filter.

With exploration and repair disabled to measure a lower bound, 100,000 members
still used about 1.0 GB of Node memory and took 15.1 s (V2) or 31.4 s (V3);
200,000 used about 2.0–2.1 GB and took 42.2 s (V2) or 56.8 s (V3). Those are
not safe Edge Function budgets because the graph is represented as JavaScript
objects with UUID strings. The design note's typed-array/dense-index plan and
regional partitioning remain launch requirements for six-figure pools.

The target-quality proxy is the number of mutual first choices *inside the
sets actually shown*, not merely globally high-scoring pairs. At 100,000
members in the independent-choice lower-bound run:

| Matcher | Full sets | Mutual #1 edges | Mutual picks (free #1 / Premium top 3) | Mean hidden reciprocal |
| --- | ---: | ---: | ---: | ---: |
| Legacy V1 | 34.6% | 5.88% | 11.05% | 0.5400 |
| Matcher V2 | 95.1% | 3.36% | 6.40% | 0.5402 |
| Matcher V3 | 95.1% | 3.38% | 6.40% | 0.5400 |

V3 did place essentially every globally predicted mutual-top edge first, but
that did not increase the set-local mutual-#1 rate. In the stricter 10,000-
member run where hidden choice exactly equalled the estimator, V2 produced a
2.11% set-local predicted mutual-top rate and V3 only 0.47%. The current V3
objective therefore does not yet justify a rollout; it anchors globally mutual
pairs, then its constrained fill changes the other members' local rankings.

**Current conclusion:** keep the hosted release disabled and keep Matcher V2
as the comparison baseline. Legacy V1 is not scalable, and V3 is not a proven
quality improvement. Before a six-figure launch, partition candidate generation
by reciprocal geography/eligibility, use dense integer edge storage (or stream
bounded allocation), and validate mutual-top lift with real double-blind
selection outcomes. The hosted Supabase evidence is still partial: the latest
432-member V3 shadow prepared 11,043 edges and wrote 1,600 private shadow edges
with zero one-sided edges, but finalization was cancelled before a complete
outcome run.

Reproduce the safe default comparison with:

```bash
npm test
node scripts/matching-benchmark.mjs --core-only
```

Use explicit `--members 25000`, `100000`, or `200000` for stress runs and
`--fast` only when measuring the allocator's lower-bound cost.
