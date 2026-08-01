# Reciprocal matching v1 — design note (Phase 1)

**Status:** reviewed and approved. Section 10 records what the simulations then changed.

This note reviews the matcher as it stands today, proposes the smallest set of changes that meet the v1 goals, and gives expected performance at current and 10x scale.

Performance figures are **modelled, not measured** — there is no populated database to benchmark against yet. The model, its assumptions and the benchmark that would confirm it are all stated below so the numbers can be checked rather than trusted.

---

## 1. What exists today

The matcher lives entirely in Postgres. The current definitions are:

| Concern | Where | Notes |
| --- | --- | --- |
| Eligibility | `passes_criteria()` — `0023` | Latest revision; fails closed on incomplete coordinates |
| Country rules | `accepts_subject_country()` — `0021` | Reciprocal, never paid |
| Calibration band | `matching_band_for_score()` — `0021` | Reviewed per-gender policy table |
| Round generation | `generate_round_for_pairs()` — `0039` | Adds the profile-readiness gate |
| Selection + match creation | `submit_round_selections()` — `0019` | Transactional, advisory-locked |
| Capacity overflow | `mutual_connection_queue` + `promote_waiting_connections()` — `0019` | Oldest-first promotion |
| Tier limits | `tier_limits()` — `0024` | free 5/1/5, premium 10/3/10 |

### How a round is built now

```
for every (male, female) pair in the active pool:
    keep if |band_m - band_f| <= 1
    and passes_criteria(m, f) and passes_criteria(f, m)
    and the pair has never been introduced before
rank each side's survivors by (band_gap, random())
keep pairs inside BOTH sides' top-N
loop row by row, inserting two introductions and linking the twins
```

### What this system does well

- **Reciprocity is structural, not incidental.** Twin rows linked through `reciprocal_id`, written together, and `submit_round_selections` re-verifies the twin link before creating a match. This is genuinely well built and should not be touched.
- **Match creation is already correct** under concurrency: row lock on the round, advisory locks taken in a universal id order, block/duplicate/capacity re-checks inside the transaction, and a deterministic oldest-first waiting queue when capacity is short. The spec's "several mutual picks resolve at once" rule is already implemented.
- **The privacy posture is right.** `selection_scores` has RLS enabled and no policy at all; private preferences never leave the server; a keep is invisible unless mutual.
- **`matching_band_policies` is a good pattern** — a reviewed, gender-aware, service-only config table with an ethics-review requirement. The new configuration should copy this pattern rather than invent another.

### What is missing or wrong

1. **There is no estimation stage at all.** Nothing computes `P(A picks B)`. Ranking is `(band_gap, random())` — effectively random within a band. This is the single biggest gap between the current system and the goal.
2. **Fairness is not represented.** `times_shown` is recorded but never read by the generator. There is no exposure need, no rolling appearance limit, no no-match tracking.
3. **The double top-N cap systematically under-fills sets.** A pair survives only if it is in *both* sides' top-N. Popular members' lists crowd each other out, so many members receive fewer than five introductions for structural reasons rather than pool scarcity — the opposite of the intent.
4. **Pairs are excluded permanently.** `not exists (any prior introduction)` means a pair that was not picked can never resurface. The spec explicitly wants cooldown-and-return.
5. **`random()` makes runs unreproducible**, which blocks shadow mode, A/B comparison, and debugging.
6. **The band gate is inert at launch and a hazard later.** Every member starts at score `0.5000`, and `ceil(0.5 × 5) = 3`, so the entire pool is band 3 on day one and `|Δ| ≤ 1` filters nothing. Once scores spread, it becomes a hard gate that can starve small pools and lock members into a range.
7. **Active-match capacity is not checked at round generation.** It is enforced at match creation, so a member at their cap still receives and consumes introductions. The spec wants rounds to pause.
8. **It is O(N²) with a very expensive constant** — see §7.

---

## 2. Keep, change, retire

### Keep unchanged

- The reciprocal twin structure and its verification in `submit_round_selections`.
- All of `submit_round_selections`: locking, capacity re-check, waiting queue, promotion.
- `passes_criteria` and `accepts_subject_country` **semantics** — they encode reviewed product rules. Only how often they are *called* changes.
- The `matching_band_policies` review pattern.
- `profile_is_ready_for_matching` as the entry gate.
- Every RLS decision.

### Change

| Change | Reason |
| --- | --- |
| Add an estimation stage producing `P̂(A→B)` and `P̂(B→A)` | The core of the ask |
| Replace double top-N + row-by-row loop with global sort → greedy → repair | Fixes under-fill; makes fairness expressible |
| Set-based eligibility prefilter before per-pair checks | The O(N²) constant, §7 |
| `random()` → seeded deterministic tie-break | Reproducibility, shadow mode |
| Permanent exclusion → cooldown, repeat limit, edge decay | Product rule |
| Add active-match capacity to the generator's pool filter | Product rule: rounds pause at cap |
| Bulk-insert introductions instead of two inserts + two updates per pair | Latency, §7 |

### Retire

- **`random() as jitter`** — replaced by `hash(seed, a, b)`.
- **The `male_rank <= N and female_rank <= N` double cap** — replaced by capacity-aware greedy assignment.
- **The hard `|band_gap| <= 1` gate** — the selection-rate signal it encodes is better used as one bounded input to `P̂` than as a hard eligibility wall. Band remains stored and reviewed; it stops being a gate.

> ⚠️ **Retiring the band gate changes eligibility criteria**, which the Deployment section requires explicit approval for. It is proposed here, not assumed. If the review prefers to keep it, widen it to `|Δ| ≤ 2` and treat it as a guard rather than a ranker — but note it filters nothing at launch either way.

---

## 3. Proposed schema

The guiding rule was to add nothing that already exists. Most of the "private signals and markers" list is already derivable.

### Already exists — reuse, do not duplicate

| Spec item | Existing source |
| --- | --- |
| Qualified exposures received | `selection_scores.times_shown` |
| Times others picked them | `selection_scores.times_kept` |
| One-sided picks made | `introduction_selections` where `decision = 'kept'` |
| Active match count | `count(connections where closed_at is null)` |
| Recent profile changes | `profiles.updated_at` |
| Model confidence | derived from `times_shown` |
| Set context (who was shown together, who was picked, set size, tier) | `introductions` + `introduction_selections` + `rounds.tier` |

**`match_health` should therefore be a view, not a table.** Every field is either already stored or a cheap aggregate. Materialise it and refresh on the existing scheduler if the join cost shows up; do not copy columns into a second place where they can drift.

The same applies to set-context learning: a view over `introductions` + `introduction_selections` + `rounds` already answers every question in that section, including whether a previously unpicked pair was picked later.

### Genuinely new — four tables, one enum value

**1. `halal_mode_private.pair_exposure`** — no equivalent exists.
```
user_low, user_high  (ordered pair, PK)
times_shown          int
last_shown_at        timestamptz
last_round_id        uuid
cooldown_until       timestamptz
last_reciprocal_score numeric
```
Justification: cooldown, repeat limit and edge decay are all pair-level. Today this is inferred by scanning `introductions`, which is both slow and unable to express "cooled until".

**2. `halal_mode_private.matching_config`** — no equivalent.
```
version int PK, params jsonb, notes text, created_at, activated_at
```
Justification: every formula, threshold, ceiling and cooldown must be configurable and versioned. Follows the `matching_band_policies` review pattern. `params` is a single JSONB blob so a config change is one reviewed row, not a migration.

**3. `halal_mode_private.matching_runs`** — no equivalent.
```
id, algorithm_version, config_version, seed, mode ('live'|'shadow'),
started_at, finished_at, edges_after_filter, stage_latencies jsonb,
peak_memory_bytes, rounds_created, pairs_created
```
Justification: run versioning and performance monitoring, both required from day one.

**4. `halal_mode_private.shadow_round_edges`** — no equivalent.
```
run_id, viewer_id, subject_id, reciprocal_score, adjusted_utility
```
Justification: shadow mode needs somewhere to write a proposed round that is not `introductions`. Keeping it in a separate private table makes "no side effects" enforceable by inspection rather than by care.

**5. `selection_decision` gains `'explicit_pass'`.**
Current enum is `kept | released | expired`. Map: `selected → kept`, `not_selected_this_round → released`, `explicit_pass → new`. `blocked` and `reported` need no enum value — the `blocks` and `reports` tables already carry them and are already checked.

Nothing here is a desirability score, and none of it is client-readable.

---

## 4. The v1 scoring formula

All symbols below are `matching_config.params` entries. Defaults in brackets.

### Compatibility (no behavioural data required)

`compat(A→B) ∈ [0,1]` — how well B fits A's *stated* preferences, from fields that already exist: position of B's age within A's range, height within range, build in A's list, practice match, timeline match, distance as a fraction of A's radius, shared languages, family-goal agreement. Weighted mean, each term normalised to `[0,1]`.

This is directional (it uses A's preferences) and is not an attractiveness rating.

### Behavioural estimate

```
appeal(B)      = times_kept(B) / max(times_shown(B), 1)          ∈ [0,1]
pair_prior(A,B)= decay^times_shown(A,B)                          [decay 0.70]

behavioural(A→B) = w_compat·compat(A→B)
                 + w_appeal·appeal(B)
                 + w_pair  ·pair_prior(A,B)
                 [w_compat 0.55, w_appeal 0.30, w_pair 0.15]
```

`appeal` is the existing `selection_scores` signal, used only as one bounded input to a private prediction.

### Cold start and blending

```
conf(B) = min(1, qualified_exposures(B) / EXPOSURE_FULL_CONFIDENCE)   [15]

P̂(A→B) = clamp( (1 − conf(B))·compat(A→B) + conf(B)·behavioural(A→B),
                 P_MIN, P_MAX )                                   [0.02, 0.98]
```

A member with no history is scored purely on stated compatibility — neutral, never penalised for being new. The behavioural term phases in linearly and is fully weighted at 15 qualified appearances. `EXPOSURE_FULL_CONFIDENCE` is a config value, not a constant.

Confidence is keyed on the **subject's** exposure because that is what `appeal(B)` depends on. Viewer-side selectivity is deliberately excluded from v1: members keep exactly 1 of 5 or up to 3 of 10, so a viewer's keep rate is a structural budget, not a preference signal. Modelling it properly means a choice model, which is explicitly deferred.

### Reciprocal score

```
R(A,B) = sqrt( P̂(A→B) · P̂(B→A) )

imbalance penalty (default off, λ = 0):
R'(A,B) = R(A,B) · (1 − λ·|P̂(A→B) − P̂(B→A)|)                     [λ 0.00]
```

The geometric mean already punishes lopsidedness — `sqrt(0.9 × 0.1) = 0.30` against an arithmetic mean of `0.50`. λ ships at zero and is turned on only if simulation shows lopsided pairs still surfacing.

### Adjusted utility for allocation

```
need(X)   = clamp((target_exposure − exposures_in_window(X)) / target_exposure, 0, 1)
stale(X)  = clamp(rounds_since_mutual(X) / NO_MATCH_ROUNDS, 0, 1)   [8]

boost(A,B) = clamp( φ·(need(A)+need(B))/2 + ν·(stale(A)+stale(B))/2,
                    0, BOOST_CAP )                     [φ 0.30, ν 0.20, cap 0.25]

U(A,B) = R'(A,B) · (1 + boost(A,B)) · decay^times_shown(A,B)
```

**How quality remains dominant.** `BOOST_CAP = 0.25` bounds the size of the
adjustment, but that bound alone does not preserve ordering: a boosted 0.64
would otherwise outrank an unboosted 0.79. The allocator therefore sorts a raw
quality band first (`QUALITY_BAND_WIDTH = 0.025`), then adjusted utility inside
the band. Fairness may reorder genuinely comparable edges, but it cannot cross
a stronger raw-quality band. A hard floor `R_MIN` [0.15] additionally refuses
to allocate an edge no matter how much exposure need exists — the “never force
through an incompatible pair” rule, enforced rather than hoped for.

**Tie-break:** `(U desc, hash(run_seed, user_low, user_high) asc)` — deterministic and reproducible from the run's seed.

---

## 5. Is the simple global allocator the right fit?

**Yes for v1**, with one condition: it must not run as a row-by-row PL/pgSQL loop.

- Greedy on a globally sorted edge list is the standard ½-approximation for weighted b-matching in the worst case, and performs far better than that on graphs like this one, where degree is capped at 5–10 and weights cluster. The repair pass recovers most of the remaining gap.
- The objective is not pure weight maximisation anyway — it is weight *subject to* fairness. Exactness buys little against an objective that is itself a judgement call.
- CP-SAT or min-cost flow would add a solver dependency, a second language runtime, and a much harder debugging story, for a gain simulation has not yet shown to exist.

**Condition:** allocation should run in the `generate-round` Edge Function against an edge list fetched from Postgres, not inside plpgsql. Reasons: sorting 10⁶ edges is trivial in TypeScript and awkward in SQL; the time-budgeted repair pass needs a real loop with a clock; and shadow mode is far easier to keep side-effect-free when the allocator is a pure function.

Keep it behind an interface — `allocate(edges, capacities, config) → assignments` — so a solver can replace it later without touching estimation, fairness or persistence.

---

## 6. Round pipeline (proposed)

```
1  pool      = active ∧ ready ∧ ¬paused ∧ active_matches < cap        [NEW: capacity]
2  prefilter = set-based SQL join: gender, age overlap, country/geo
              bucket, block list, cooldown                            [NEW]
3  verify    = passes_criteria(a,b) ∧ passes_criteria(b,a) on survivors only
4  estimate  = P̂ both directions
5  score     = R', then U with bounded fairness
6  allocate  = global sort → greedy under both capacities
7  repair    = time-budgeted swaps for incomplete sets / high need
8  verify    = reciprocity + capacity assertions
9  persist   = one transaction, bulk insert, twins linked
10 log       = matching_runs row
```

Steps 1–3 stay in SQL. Steps 4–8 run in the Edge Function. Step 9 is a single transactional RPC.

---

## 7. Expected performance

### Assumptions (stated so they can be challenged)

- **Today:** 2,000 matchable members, 1,000 per gender.
- **10x:** 20,000 members, 10,000 per gender.
- Mutual eligibility survival rate ≈ **5%** of raw pairs.
- Members cluster geographically; the largest metro holds ~25% of the pool.
- `passes_criteria` is `STABLE SECURITY DEFINER` PL/pgSQL — **not inlinable**. Each call performs ~7 index lookups (2× `profiles`, 2× `private_preferences`, `blocks`, plus `accepts_subject_country`'s own lookups). Estimated **~25 µs per call, two calls per pair ≈ 50 µs**.

### Candidate edges after hard filtering

| | Raw pairs | Unpartitioned | Partitioned by metro |
| --- | ---: | ---: | ---: |
| Today (2,000) | 1.0 M | ~50,000 edges | ~12,500 edges |
| 10x (20,000) | 100 M | ~5,000,000 edges | ~1,250,000 edges |

Partitioning by country/metro before building the graph is what turns `N²` into `Σ nᵢ²` — roughly a **4x reduction** at these distributions, and the single cheapest structural win available.

### Current implementation — the finding that matters

At 2,000 members the generator evaluates ~1.0 M pairs × 50 µs ≈ **50 seconds**, and the band gate removes none of them at launch because everyone starts in band 3.

**The current matcher is already at risk at today's target scale, before any of this work.** At 10x it is ~100x that. This is the strongest argument for the rewrite, independent of matching quality.

### Proposed implementation — per stage

| Stage | Today (2,000) | 10x (20,000, partitioned) |
| --- | ---: | ---: |
| 1. Pool query | 20 ms | 150 ms |
| 2. Set-based prefilter | 0.6 s | 12 s |
| 3. `passes_criteria` on survivors | 0.1 s | 2.5 s |
| 4. Estimation | 0.1 s | 2.5 s |
| 5. Scoring | 30 ms | 0.8 s |
| 6. Global sort | 10 ms | 0.5 s |
| 7. Greedy assign | 5 ms | 150 ms |
| 8. Repair (budgeted) | ≤ 0.5 s | ≤ 2 s |
| 9. Verify + bulk persist | 0.3 s | 3 s |
| **Total** | **≈ 1.7 s** | **≈ 24 s** |

The prefilter dominates because it is the only stage still touching every raw pair. Inlining the cheap predicates into a set-based join — rather than calling PL/pgSQL per pair — is where the ~50 µs collapses to ~1 µs.

### Peak memory

Edges held as parallel typed arrays with UUIDs mapped to dense integer indices: `2 × Int32 + 2 × Float64 = 24 bytes/edge`.

| | Edges | Edge arrays | Realistic peak |
| --- | ---: | ---: | ---: |
| Today | 50,000 | 1.2 MB | ~15 MB |
| 10x (partitioned) | 1.25 M | 30 MB | ~120 MB |
| 10x (unpartitioned) | 5 M | 120 MB | ~500 MB |

Two consequences worth flagging now:

- **Do not hold edges as JS objects with string UUIDs.** At 10x that is roughly 800 MB and will not fit an Edge Function. The integer-index mapping is not premature optimisation here; it is the difference between fitting and not.
- **Do not sort 5 M edges in Postgres.** At ~50 bytes per row that is ~250 MB, well past default `work_mem`, and it will spill to disk. Another reason allocation belongs in the function.

### Warning thresholds (proposed defaults)

| Metric | Warn | Fail |
| --- | ---: | ---: |
| Round latency | 30 s | 120 s |
| Edges after filter | 2 M | 8 M |
| Peak memory | 256 MB | 512 MB |

---

## 8. Open questions for review

1. **Retiring the hard band gate** changes eligibility and needs explicit sign-off. Recommendation: retire it, fold `appeal` into `P̂`.
2. **Where does allocation run?** This note assumes the `generate-round` Edge Function. If it must stay in Postgres, the 10x numbers get materially worse and partitioning becomes mandatory rather than advisable.
3. **`match_health` as a view rather than a table** — this is a deliberate deviation from the brief's wording, on the grounds that every field already exists and duplicating them invites drift. Confirm this reading is acceptable.
4. **Confirm the scale assumptions.** Every number in §7 moves with the 2,000 / 20,000 figures and the 5% survival rate. If the real launch pool is a few hundred, the current matcher is fine for longer and the ordering of work should change.

---

## 9. Recommended build order (after approval)

1. `matching_config` + `matching_runs` + run versioning and perf logging — instrument before changing anything, so improvement is measurable.
2. Set-based prefilter. Biggest latency win, no behaviour change, independently verifiable.
3. Estimation module with cold-start blend, behind a flag, shadow mode only.
4. Global allocator + repair, shadow mode only. Compare against live on the same seed.
5. `pair_exposure`, cooldowns, decay, `explicit_pass`.
6. Fairness terms in the utility function.
7. Simulations across the scenarios in the brief; then canary, with approval.


---

## 10. What simulation changed (post-approval)

Three things the design note got wrong, found by measuring rather than arguing.
All numbers are from `tests/matchingSimulation.test.ts`: 300 members, 12 rounds,
seeded, reproducible via `simulate()`.

### A flat exposure target cannot work

`target_exposures_per_window` was a single number. It cannot be: a free member
is owed 5 introductions per round and a premium member 10. Set it to the free
allowance and premium members are throttled below what they pay for; set it to
the premium allowance and nobody is throttled at all. At the flat default of 10,
members received **1.81** introductions per round instead of 5 — the fairness
throttle was quietly eating the product promise.

Replaced by `exposure_target_multiplier`, applied to each member's own tier
entitlement.

### Need must be measured against pace, not a total

With an absolute target, every member reports maximum need for most of a window
because nobody has reached it yet. The signal is then uniform, so it stops
discriminating — and quality ranking, which does favour frequently-kept members,
concentrates exposure unopposed. Raising `boost_cap` from 0.25 to 1.2 changed
the outcome by nothing at all, which is what exposed it.

`exposureNeed` now compares against the exposure a member *should* have by this
point in the window, so the term is live from the first round.

### Scoring on raw keep rates is a death spiral

This is the important one. An earlier version of the simulation scored edges
directly from observed keep rates rather than through `directionalEstimate`.
Members with a weak keep rate fell under `min_reciprocal_score`, were filtered
out of every round, and therefore never gathered the data that might have lifted
them back out. Mean set size sat at 2.5 of a possible 5.7, and exposure Gini was
0.50.

Routing through the confidence blend — where a thin record pulls the estimate
back toward stated compatibility instead of toward zero — fixed it completely.

This is precisely the "users the system currently serves poorly" failure the
brief exists to prevent, and it is only one refactor away at any time. The
regression test is `the confidence blend prevents a low keep rate becoming a
death spiral`.

### Original measured outcome (superseded)

| Metric | Baseline | v1 | |
| --- | ---: | ---: | --- |
| Mean set size | 5.73 | 5.73 | unchanged |
| Mean reciprocal quality | 0.5953 | 0.7187 | **+21%** |
| Members never matched | 41.0% | 27.3% | **−33%** |
| Exposure Gini | 0.1117 | 0.1142 | +0.0025 |
| Top exposure share | 0.0058 | 0.0058 | unchanged |

These numbers are retained only as an audit trail. They are **not valid evidence
of outcome improvement**: the original pick model was driven by the same
appeal-shaped signal the estimator learned, and “reciprocal quality” was the
estimator's own score. The simulator was grading the matcher against its own
assumptions.

The useful reading that survives is: **once the pool can supply full sets, exposure is already
close to even and there is very little concentration left for fairness to
remove.** The Gini difference is noise. The real wins are quality and the share
of members left with nothing only if independent shadow outcomes later prove
them; the original simulation did not.

The fairness machinery still earns its place — it is what stops quality ranking
concentrating exposure as the pool grows and sets stop being fillable, which is
the regime the 10x numbers in §7 describe. The assertions in the simulation
suite were rewritten to claim only what the measurements support.

### Independent audit outcome

The simulator now separates estimator inputs from a synthetic ground-truth pick
model and includes an adversarial model driven entirely by unobserved chemistry.
For the same 300-member, 12-round, seeded launch scenario, the mixed model
measured:

| Metric | Baseline | v1 | Reading |
| --- | ---: | ---: | --- |
| Mean set size | 5.73 | 5.73 | unchanged |
| Independent reciprocal quality | 0.4983 | 0.5471 | +9.8% in this synthetic model only |
| Members never matched | 12.0% | 16.3% | v1 regressed |
| Exposure Gini | 0.1124 | 0.1129 | effectively unchanged |
| Mutual rate | 6.42% | 5.64% | v1 regressed |

With an entirely unobserved choice model, reciprocal quality was effectively
flat (0.4356 baseline, 0.4377 v1), while zero-match share again worsened (2.0%
to 4.0%). This
proves the estimator is a ranking heuristic, not a calibrated predictor, and
that v1 must remain shadow-only until real selection outcomes validate it.

The original repair pass was also a no-op: greedy had already scanned every
edge while capacities could only decrease, so an add-only rescan could never
make a rejected edge feasible. It is now a bounded length-three augmenting-path
repair that replaces one assigned edge with two when coverage increases without
reducing combined utility.


---

## 11. Growth to millions

The **architecture** scales; the **implementation** does not, and the difference
matters because no redesign is needed to close the gap.

`allocate(edges, capacities, config)` takes an edge list it does not have to
produce. Estimation, allocation and fairness are already separate. What does not
scale is materialising every pair: one million members is 500k x 500k = **250
billion pairs**, which no amount of tuning survives.

Two properties rescue it, both already true of the product:

**Matching is inherently local.** Distance caps mean a member in Madinah never
competes with one in Manchester, so at scale this becomes thousands of
independent regional matchers, each over tens of thousands of members —
embarrassingly parallel, and each shard is exactly the input `allocate()`
already expects. Cross-border pairs, which require both sides to be `open` or
`willing_abroad`, form a separate and much smaller graph.

**Candidate retrieval can replace pair construction.** Fetching a top-K
candidate list per member and scoring only those is the standard
retrieval-then-ranking split, and turns O(N²) into O(N·K).

| Pool | What is required |
| --- | --- |
| < 5k | Today's SQL is adequate |
| 5k – 50k | Set-based prefilter, allocation in the Edge Function (§6) |
| 50k – 500k | Geographic sharding, top-K retrieval instead of full pair construction |
| > 500k | The above, plus `pair_exposure` partitioning and TTL — at 1M x 200 that is 200M rows |

None of this is benchmarked. The breakpoints are estimates from §7's model.

---

## 12. Imbalanced pools

### The constraint

Reciprocity forces an accounting identity:

```
sum(side A set sizes) = sum(side B set sizes) = edge count
```

With 500 men and 100 women capped at five, the ceiling is 500 edges and the men
can average at most **one** each. No algorithm avoids this; it is arithmetic.

Left to a greedy allocator the result is concentration, not scarcity shared
evenly. Measured on 500 men and 100 women:

```
women avg/min/max      : 5.00 / 5 / 5
men   avg/min/max      : 1.00 / 0 / 5
men receiving nothing  : 328 of 500
men receiving a full set:  40
```

Forty members get everything, 328 get nothing, and because winners are chosen by
score rather than by waiting time, broadly the same members win every round.

### What simulation changed about the fix

The obvious fix — serve a rotating cohort with **full** sets — is worse than it
looks. A free member keeps one person per round however many they are shown, so
selection opportunities scale with **rounds served**, not with set size.
Full-set rotation halved rounds served (7.7 to 4.0 of 12) and pushed the share of
members who never matched from 42% to 54%.

Capping served sets at `rotation_min_set_size` instead serves far more members
per round. Measured at 150:30 over 12 rounds:

| Served set cap | Set size (served) | Never matched |
| ---: | ---: | ---: |
| No rotation | 3.13 | 41.7% |
| 2 | 2.93 | 29.4% |
| **3 (default)** | **3.87** | **35.0%** |
| 4 | 4.59 | 45.6% |
| 5 (full sets) | 5.21 | 54.4% |

Three is the default because it beats no rotation on **both** axes at once —
larger sets *and* fewer members left unmatched. Two produces more matches still,
but a set of two is barely a choice; that trade is available as a config change
if the outcome data later justifies it.

### Flexibility as the ratio moves

Nothing in `src/matching/rotation.ts` knows which gender is which. The
constrained side is recomputed each round as whichever has surplus **capacity**
— capacity, not headcount, so tier mix is handled automatically.

- **1:1** — rotation is inert. Verified: identical results with it on and off.
- **Mild imbalance** — absorbed by slightly smaller sets for everyone, deferring
  nobody, while the thin set size stays at or above `rotation_min_set_size`.
- **Severe imbalance in either direction** — a mirrored 150:750 pool defers the
  same number of members as 750:150, and the improvement holds.

Waiting is bounded because the queue is ordered by rounds since last served,
which only increases. A 10:1 pool over 20 rounds never leaves anyone permanently
deferred.

Members who are deferred should be told plainly that today is not their round.
`0044_explainable_daily_round_state` already provides that surface.

### Consequence for metrics

The **ratio itself becomes a per-region metric**, since it sets the achievable
round cadence. It belongs alongside eligible-pool size in the breakdowns.
