# Halal Mode matcher handover for Claude

**Date:** 2026-08-13  
**Repository:** `C:\Users\Mohammed\Documents\HalalModeX`  
**Branch:** `feature/social-sign-in`  
**Latest benchmark commit:** `f2c9801` (`Add three-way matcher benchmark evidence`)

This is the current truth about reciprocal matching. It is intentionally blunt:
the code is safe to compare in shadow mode, but no matcher is yet proven for
large production pools or for the product's strongest success criterion:
people's first choice also choosing them first.

## Read these files first

1. `HANDOFF.md` — especially the reciprocal-matching section and privacy rules.
2. `docs/RECIPROCAL_MATCHING_V1_DESIGN.md` — §§7, 10, 11, and 12.
3. `docs/matching-performance-handover.md` — measured SQL and gateway limits.
4. `docs/MATCHER_V2_V3.md` — the three-way benchmark and current verdict.
5. `scripts/matching-benchmark.mjs` — the reproducible local harness.
6. `src/matching/allocate.ts`, `src/matching/estimate.ts`, and
   `supabase/functions/generate-round/matching.ts`.

Then run the baseline yourself:

```powershell
cd C:\Users\Mohammed\Documents\HalalModeX
git status --short
npm run verify:client
node scripts/matching-benchmark.mjs --core-only
```

## The three paths

The word “V1” is overloaded. Use these names in code, reports, and commits.

### Legacy V1 / pre-v1

`public.generate_round_for_pairs_scheduled` in
`supabase/migrations/0128_every_member_their_own_dawn.sql`.

This is the current member-facing path because the global
`reciprocal_matching_v1` release flag is disabled. It uses the old band/random
ordering and row-at-a-time eligibility functions. The production performance
handover measured 59 seconds for 34,575 old per-pair checks, compared with 153
ms for equivalent set-based filtering. It also under-fills sets and eventually
repeats/exhausts a small pool.

### Matcher V2

Allocator `greedy_global_v1`, hosted config row 9. This is the preserved global
greedy baseline. It gives excellent capacity and reciprocity invariants and is
the correct comparison baseline for any new algorithm. Its exploration and
repair passes currently become very expensive because they repeatedly scan
large ordered edge arrays.

### Matcher V3

Allocator `anchored_maxmin_v1`, hosted config row 11, run label
`anchored_maxmin_v2`. It carries directional estimates and tries to place
globally predicted mutual-top pairs first. It is inactive and must remain so.

Important: the current V3 anchor pass is not just a small anchor step. It also
performs a constrained-first fill before the ordinary greedy pass. That can
change the rest of each member's local set ranking. The benchmark found no
mutual-first-choice uplift and, in a perfect-estimator stress test, V3 was
worse than V2 (0.47% versus 2.11% set-local predicted mutual-top edges).

## What is working

- V2 and V3 preserve pair reciprocity and capacity in the local tests.
- The set-based SQL candidate preparation removes the forbidden per-pair
  function calls from the new path.
- Shadow mode writes to private shadow tables and does not write live
  introductions, connections, pair exposure, or notifications.
- The 455-profile local planner completes and all 241 client/database contract
  tests pass.
- Hosted smoke evidence for V3 had 432 members, 11,043 candidate edges, 1,600
  private shadow edges, and zero one-sided edges.
- Release is safely disabled; the partial hosted run was cancelled before a
  complete outcome comparison.

## What is not working or not proven

1. **Scale.** With the current configuration, V2 took about 122 seconds and V3
   140 seconds at 25,000 members, excluding fetch/finalization. The current
   JavaScript object graph is not a six-figure design.
2. **Raw candidate growth.** Even with a 40-edge shortlist, raw eligibility is
   quadratic unless the pool is partitioned before pairing. At 100k members a
   full cross-gender pool is billions of possible pairs.
3. **Allocator hot loops.** `ordered.find()` and `assigned.indexOf()` appear in
   repeated repair/exploration paths. They are acceptable at hundreds of
   members and unsafe at large edge counts.
4. **V3 objective.** Anchoring a globally mutual pair does not guarantee a
   mutual #1 inside the final set. Do not describe V3 as solving the product
   objective.
5. **Estimator calibration.** `directionalEstimate` is a ranking score, not a
   calibrated probability. There is not enough real double-blind selection data
   to know whether it predicts preferences.
6. **Hosted proof.** The finalizer still stalls/cancels on the larger shadow
   run. There is no complete hosted V2-versus-V3 outcome dataset yet.
7. **Metrics.** Longitudinal mutual rate, time-to-first-mutual, zero-match rate,
   Gini, and free/Premium and new/established breakdowns are not yet durable
   production metrics.
8. **Durable waiting.** Some rotation/defer state is simulated in memory rather
   than persisted across Edge Function runs.

## Benchmark results to keep in mind

The local harness uses a balanced synthetic pool, 40 shortlist edges per
member, free capacity 5, Premium capacity 10, and a hidden independent-choice
model. It is useful for comparing algorithms, not for claiming real-user lift.

| Members | Legacy V1 | Matcher V2 | Matcher V3 |
| ---: | ---: | ---: | ---: |
| 455 | 28 ms | 62 ms | 94 ms |
| 2,000 | 72 ms | 606 ms | 625 ms |
| 5,000 | 258 ms | 3.24 s | 3.47 s |
| 10,000 | 327 ms | 15.0 s | 15.8 s |
| 25,000 | 1.06 s | 121.9 s | 140.5 s |

At 100k in the lower-bound run (exploration and repair disabled), V2 and V3
both served 100% of members and filled about 95% of sets, but each produced
about 6.4% mutual picks. The hidden-choice mutual-#1 rates were about 3.36%
for V2 and 3.38% for V3. These are not statistically meaningful differences;
V3 has not demonstrated an improvement.

## Ordered plan of work

Do these in order. Do not skip to a new matching objective before the system
can produce trustworthy measurements.

### Phase 1 — finish the safe proof

1. Fix the hosted shadow finalizer so a complete 432-member shadow run can
   finish in bounded batches. Keep it shadow-only.
2. Add/verify a hosted outcome query that compares V2 and V3 on the same frozen
   candidate snapshot without exposing private scores or preferences.
3. Seed a cross-timezone cohort (for example Tokyo, San Francisco, Jakarta,
   Cairo, and London) and verify each member's own Fajr opening/expiry and
   asynchronous reciprocal submission.
4. Keep the release flag disabled until the run has `pairs_created`, no error,
   `one_sided_edges = 0`, and a balanced fewest/most-shown spread.

### Phase 2 — remove the scale cliff

1. Partition the candidate pool by reciprocal country/region/distance and
   eligibility before building edges. Do not use a single global cross join at
   six-figure scale.
2. Keep each API statement below the 8-second limit; resume work with cursors
   or jobs rather than increasing the global timeout.
3. Map UUIDs to dense integer IDs and store edge columns in typed arrays or
   bounded batches. Never hold millions of `{uuid, uuid, ...}` objects in an
   Edge Function.
4. Replace repeated global scans in repair/exploration with per-member
   adjacency indexes and bounded candidate queues. Preserve the score floor,
   fairness `boost_cap`, no duplicate pairs, and capacity invariants.
5. Benchmark 2k, 10k, 25k, 50k, 100k, and 200k after every structural change.

### Phase 2A — investigate incremental coverage before considering a rewrite

Do not assume the matcher must compare the entire world in one run. A simpler
and potentially cheaper model is to split the giant member pool into bounded
**discovery buckets** before pair eligibility is known. A job/day processes a
small selection of raw buckets, evaluates real two-way eligibility inside them,
retains only the best bounded private candidates per member, and moves to other
raw buckets on later cycles. Over many cycles, the app can cover the eligible
universe without ever holding billions of possible pairs in memory at once.

These buckets are not claims that their pairs are eligible. They are only an
efficient way to divide a huge search space. Eligibility is still evaluated
after a bucket is opened, using the existing server-side rules in both
directions. Do not discard a promising worldwide match merely because its raw
bucket was not today's first bucket.

This is an investigation first, not permission to invent a second matcher.
Reuse the existing set-based eligibility, V2 scoring, V2 invariants, chunk
progress tables, shadow finalizer, and tests. Adapt the smallest proven pieces;
do not replace the system with a fresh general-purpose rewrite.

The design must answer these questions with a small prototype and numbers:

1. **How are raw discovery buckets formed?** Start with cheap indexed member
   attributes: gender direction, broad age bands, language, country/region,
   relocation openness, and other reviewed must-have signals. Use them to avoid
   obviously hopeless searches (for example, mutually closed countries or an
   impossible age range), but do not treat a bucket as an eligibility decision.
   Soft preferences such as ideal age, distance, practice, or timing remain
   scoring signals unless explicitly marked must-have.
2. **How are buckets ordered?** Give each raw bucket a cheap upper bound on
   possible two-way quality. Process the buckets most likely to contain a truly
   strong worldwide match first, not merely the easiest local matches. A simple
   first version may use reviewed compatibility bands plus a seeded shuffle;
   a later version may use branch-and-bound-style upper bounds. Include a small
   deterministic exploration share so the scheduler cannot become a filter
   bubble.
3. **How is pair work owned?** Once a raw bucket is opened, evaluate both
   directions and score the actual pair with existing V2 code. A stable shared
   bucket/pair key may assign work to one job, but it must never imply that the
   pair was eligible before evaluation. Final assignment still requires a
   reciprocal edge and both endpoints' capacities.
4. **How does coverage advance?** Persist an epoch, raw-bucket cursor, seed,
   upper-bound state, and completion state. A retry must be idempotent; a
   restart must resume; a new epoch must use a new deterministic shuffle so the
   same popular profiles are not always processed first. Revisit buckets after
   profile changes, new members, or a scheduled refresh.
5. **How are worldwide best candidates retained?** Keep a bounded private
   top-K reservoir per member across all assessed buckets. A later bucket must
   be able to replace an earlier candidate. At round time, select from the
   best-known reservoir, not from whatever mediocre options happened to be in
   the latest bucket. If unseen buckets still have a higher possible upper
   bound, the system must mark the result provisional and continue searching on
   later jobs rather than claim a global optimum.
6. **How is a daily round built?** Allocate from the private reservoir plus the
   current raw bucket, then persist reciprocal edges in one bounded finalization
   step. The selected set must have zero one-sided edges, no duplicate pairs,
   valid capacities, and no weak filler merely to reach five.
7. **What does “everyone eventually” mean?** Measure coverage over the eligible,
   non-blocked, non-hidden, non-retired pair universe after evaluation. Do not
   promise exposure to pairs excluded by preferences, safety, age, distance,
   consent, or churn. A 100-million-member pool may need many epochs; that is
   acceptable if each job is bounded and coverage is visible and resumable.
8. **Does it improve the product target?** Compare incremental coverage with V2
   on the same frozen graph: set-local mutual-first-choice rate, full-set
   coverage, mean reciprocal quality, exposure fairness, repeat rate, memory,
   and time per bucket. Include interrupted jobs, pool changes, imbalanced pools,
   worldwide/cross-timezone members, and multiple scheduler seeds.

A viable bucket design is allowed to take days or weeks to cover a very large
eligible universe, but it must provide a measurable coverage guarantee,
bounded per-job cost, useful rounds every day, and a path toward genuinely
worldwide top candidates. Do not trade away today's reciprocal safety or the
global-quality goal merely to claim eventual reach.

### Phase 3 — optimize the real product objective

1. Define the measured target as set-local mutual-first-choice rate, plus full
   set coverage and mean true reciprocal quality. Never optimize one number
   while silently starving the other two.
2. Use recorded double-blind choices to calibrate the directional estimator.
   Report calibration and confidence intervals by gender, tier, region, and
   new/established cohort.
3. Start with a bounded, set-local allocator improvement to V2. Do not ship a
   large general-purpose solver until a small indexed approach fails. V3's
   current global anchor pass is not sufficient evidence.
4. Compare every candidate against Legacy V1 and V2 on identical frozen graphs,
   multiple seeds, independent/mixed/aligned/perfect truth models, and
   imbalanced pools.

### Phase 4 — rollout only after evidence

1. Complete metrics for mutual rate, time-to-first-mutual, zero-match rate,
   exposure Gini, capacity, and quality by cohort.
2. Run a full shadow cycle and inspect the API health during it.
3. Use a whole-pool switch for reciprocal matching; member-level percentage
   rollout is unsafe because reciprocal edges cannot use two different
   matchers. Geographic cohorting is possible later if its pool is large enough.
4. Enable the flag only with a documented rollback command and an approved
   decision. Record any product deviation in `DECISIONS.md` with one sentence.

## Non-negotiable guardrails

- Never enable the production release flag during benchmarking.
- Never expose `selection_scores`, one-sided interest, private preferences, or
  exact location to a client role.
- Never create a shadow write path to live introductions, connections, pair
  exposure, rounds, or notifications.
- Never relax the blended-score floor, fairness `boost_cap`, reciprocity, or
  capacity checks.
- Never run `git add -A` above the project directory.
- Do not delete Legacy V1 or the V2 branch until a replacement is proven and
  rollback is documented.
- Do not claim estimator quality from synthetic truth models.
- Do not use `npm install` for Expo dependencies; use `npx expo install`.

## Definition of done for the next agent

The next milestone is not “V3 is enabled.” It is:

- a complete hosted shadow run;
- a finalizer that stays within bounded statement/API limits;
- a scale benchmark with no multi-GB object graph;
- zero one-sided edges and zero capacity violations;
- a real outcome report showing whether mutual-first-choice rate improves over
  V2 without reducing coverage or fairness; and
- a clean `npm run verify:client` run, committed with a concise evidence note.

## Copy-paste prompt for Claude

```text
You are taking over reciprocal matching on Halal Mode.

Repository: C:\Users\Mohammed\Documents\HalalModeX
Branch: feature/social-sign-in
Latest benchmark commit: f2c9801

Read, in order:
1. HANDOFF.md (reciprocal matching section and privacy rules)
2. docs/RECIPROCAL_MATCHING_V1_DESIGN.md (§§7, 10, 11, 12)
3. docs/matching-performance-handover.md
4. docs/MATCHER_V2_V3.md
5. docs/MATCHER_CLAUDE_HANDOVER.md
6. scripts/matching-benchmark.mjs

Run the baseline yourself:
  npm run verify:client
  node scripts/matching-benchmark.mjs --core-only

Be a harsh critic before editing. There are three paths:
- Legacy V1/pre-v1: the old scheduled SQL generator, currently member-facing
  because reciprocal_matching_v1 is disabled.
- Matcher V2: greedy_global_v1, the active comparison baseline.
- Matcher V3: anchored_maxmin_v1 / anchored_maxmin_v2, inactive and not proven.

Do not assume tests prove product correctness. The estimator is not calibrated,
V3 has not improved set-local mutual-first-choice rate, the hosted finalizer
has stalled, and the current JavaScript edge representation does not scale to
100k+. The product target is mutual first choice inside the final displayed
sets, measured together with full-set coverage, reciprocal quality, and fair
exposure. Synthetic truth models are only regression tools.

Use Occam's razor. Preserve and adapt the strongest working parts of Legacy V1,
V2, and V3 instead of writing a fresh matcher. Investigate this alternative
scale strategy explicitly: the app does not need to score every possible person
before serving today's round. Start with a giant pool of members, divide it
into cheap discovery buckets using broad indexed attributes, and only then
evaluate real two-way eligibility inside the selected buckets. Process the most
promising worldwide buckets first using a simple reviewed compatibility bound,
retain the best private candidates across buckets, and advance to untouched
buckets over later days or weeks. Do not call raw bucket membership
eligibility, and do not settle for mediocre local options just because they are
easy to find. Prove that the schedule is resumable, eventually covers the
eligible universe, can revisit buckets, keeps reciprocal safety, and does not
reduce global-quality or fairness before implementing it.

Work in this order:
1. Finish a shadow-only hosted proof and fix the batched finalizer. Verify
   pairs_created, no error, zero one-sided edges, balanced exposure, and no
   writes to live relationship tables. Do not enable the release flag.
2. Remove the scale cliff: partition candidate generation by reciprocal
   geography/eligibility, keep each API call bounded, map UUIDs to dense IDs,
   and eliminate repeated ordered.find/indexOf scans with adjacency indexes or
   bounded queues. Preserve reciprocity, capacity, score floor, fairness
   boost_cap, privacy, and shadow write isolation.
3. Investigate the raw discovery-bucket/reservoir strategy described above.
   Reuse the current SQL, V2 scoring, chunk progress, and finalization code;
   prototype the smallest measurable version before adding new abstractions.
   The bucket is only a search partition: evaluate actual two-way eligibility
   after opening it. Order buckets by a cheap upper bound for worldwide
   reciprocal quality, include deterministic exploration, and keep a private
   top-K reservoir so later buckets can replace weak earlier candidates.
4. Only then test a small set-local improvement to V2. Do not ship another
   global anchor heuristic without proving mutual-first-choice lift across
   multiple seeds, truth models, imbalanced pools, genders, tiers, and regions.
5. Add durable outcome metrics and estimator calibration from real double-blind
   selections. Never expose private scores or preferences.

Do not delete Legacy V1, V2, or rollback branches. Do not make destructive
production changes. Do not use service_role in the client. Do not run git
add -A above the project. Use explicit file paths.

After each meaningful change: run targeted tests, run the benchmark, inspect
loading/error/retry behavior, and run npm run verify:client before committing.
Commit only complete, scoped work. Do not deploy or enable the production flag
without explicit approval. Finish with:
- files changed and why;
- measured before/after runtime and memory;
- mutual-first-choice, coverage, fairness, and reciprocity evidence;
- hosted shadow evidence;
- tests run;
- unresolved risks and the next smallest safe step.
```
