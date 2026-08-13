# The matcher benchmark cannot measure the product goal

Findings from an independent review on 2026-08-13, before any code change.
Everything here is reproducible with the commands at the foot of this file.

## Summary

The product goal is *mutual first choice*: each member's number-one candidate
should be as likely as possible to choose them back. The benchmark reports a
metric named for that goal. It does not measure it, and under the one
configuration that could measure it, **all three matchers perform at or below
random assignment — Matcher V3 at less than half of random.**

This is not an argument that V2 or V3 is badly written. `verify:client` is green
(241 tests, typecheck, lint, SQL verify). It is an argument that the evidence
used to compare them is not evidence about the goal.

## 1. The headline table's denominator rewards doing less work

`scripts/matching-benchmark.mjs` reports:

```js
mutualTopRate: assigned.length ? mutualTop / assigned.length : 0,
```

The denominator is the number of edges the matcher created. A matcher that
assigns fewer edges divides by a smaller number, so `MATCHER_V2_V3.md`'s
comparison table rewards restraint rather than quality. A per-member figure is
already computed one line below (`membersWithMutualTopPct`) and is the shape the
goal actually asks about — it was not the one reported.

Correcting the denominator narrows the gap but does not reverse it, so the
denominator alone was never the whole story:

| members | matcher | full sets | per-edge mutual #1 | per-member mutual #1 |
| ---: | --- | ---: | ---: | ---: |
| 10,000 | Legacy V1 | 34.6% | 5.79% | 25.46% |
| 10,000 | Matcher V2 | 94.6% | 3.32% | 19.68% |
| 10,000 | Matcher V3 | 95.8% | 3.27% | 19.42% |

## 2. "34.6% full sets" is not "serves a third of members"

Legacy V1 serves **99.8%** of members. The difference is set *size*: V1 gives a
mean of 4.38 edges against V2's 5.92. So V1 is not winning by serving fewer
people; it is showing nearly everyone a smaller set.

That matters because set-local "top choice" is easier in a smaller set. A member
shown one profile has that profile as their top choice by definition. Both the
numerator and the denominator of this metric move with set size, so it cannot
compare matchers whose set sizes differ — which is exactly the comparison being
made.

## 3. Every observed result matches random assignment

Under random preferences, the chance that an assigned edge is *both* endpoints'
set-local top is about `1 / (mean set size)²`:

| matcher | mean set | random-chance | observed | lift |
| --- | ---: | ---: | ---: | ---: |
| Legacy V1 | 4.38 | 5.21% | 5.75% | 1.10x |
| Matcher V2 | 5.92 | 2.85% | 3.31% | 1.16x |
| Matcher V3 | 5.94 | 2.83% | 3.64% | 1.29x |

Every matcher sits within noise of chance, and the entire V1-vs-V2 spread is
explained by set size.

The cause is structural, not a bug: the default `--truth independent` model
defines hidden preference as independent of the estimator
(`scripts/matching-benchmark.mjs:126-130`). Under that model no allocator can
beat random on mutual-choice metrics, because the thing being allocated on is by
construction uncorrelated with the thing being measured. `MATCHER_V2_V3.md` says
as much in prose, and then draws allocator conclusions from the table anyway.

## 4. Under a predictive estimator, V3 is worse than shuffling

`--truth aligned` makes the hidden choice 85% the estimator — the most
favourable conditions the harness can offer, far kinder than reality. This is
the only configuration in which allocation quality can appear at all:

| matcher | mean set | mutual #1 | random-chance | lift | per-member mutual #1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Legacy V1 | 4.36 | 5.10% | 5.25% | **0.97x** | 22.24% |
| Matcher V2 | 5.92 | 2.53% | 2.85% | **0.89x** | 15.00% |
| Matcher V3 | 5.94 | 1.30% | 2.84% | **0.46x** | 7.72% |

Reproduced at 5,000 members. **No matcher beats chance. V3 achieves less than
half of chance on the metric it was explicitly built to improve.**

### Why V3 is anti-correlated with its own objective

V3 anchors edges that are *globally* mutual-top — each endpoint's best partner in
the whole graph — and places them first. It then fills the rest of both members'
sets with the next-best available candidates. Those fillers frequently outrank
the anchor **within the set the member is actually shown**.

So V3 optimises a global property and destroys the local one. `MATCHER_V2_V3.md`
observed the symptom ("its constrained fill changes the other members' local
rankings"); the measurement above shows the result is worse than random, not
merely unimproved. `anchoredMembers` was 9,862 of 10,000 — the anchoring works
exactly as designed. The design is the problem.

## 5. What this does not say

- It does not say Legacy V1 is better. V1's apparent lead is set size, and V1
  remains unscalable (the live path costs 59s for 34,575 per-pair checks).
- It does not say the estimator is wrong. It is untested either way; nothing
  here validates or invalidates it against real members.
- It does not say V2 should be replaced. V2 is roughly chance on this metric,
  which is what almost any reasonable allocator would be under a truth model
  uncorrelated with its inputs.

## 6. What follows

The planned work order starts by building bounded discovery buckets. Buckets are
a **discovery** optimisation: they change which candidates are found, cheaply
and at global scale. They cannot improve mutual first choice if **allocation**
is at or below chance — the stage that decides which of the discovered
candidates a member actually sees.

Two things are worth doing before any bucket work:

1. **Make the harness able to measure the goal.** A set-size-invariant metric,
   and a truth model where the estimator is predictive, are prerequisites for
   any allocator comparison. Without them the benchmark ranks matchers by mean
   set size.
2. **Establish whether any allocator beats chance under a predictive
   estimator.** If none does, the mutual-first-choice objective is not currently
   achievable by reordering allocation, and the lever is elsewhere — most likely
   set composition (fewer, stronger candidates) rather than set ordering.

## Reproducing

```bash
npm run verify:client
node scripts/matching-benchmark.mjs --core-only
node scripts/matching-benchmark.mjs --core-only --truth aligned --members 5000
```

The random-chance baseline is `1 / (meanSetSize)²` per assigned edge, compared
against the reported `mutualTopRate`.
