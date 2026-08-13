# Handover: make round generation set-based

## The task

Round generation cannot finish for 432 members. Make it complete in seconds,
and stay linear as the app grows. The cause is understood and measured; this is
a rewrite of one stage, not an investigation.

## The one-sentence diagnosis

**The matcher asks questions one pair at a time, through plpgsql functions that
each re-read the same rows.** Cost is `pairs × functions × queries per function`,
and pairs grow with the square of members.

## The measurements that matter

All taken on the live project with 432 eligible members (455 seeded, 37 paused).

| Thing | Measurement |
|---|---|
| Possible pairs (260 men × 172 women) | 44,720 |
| After cheap pre-filter (country, marked age/distance) | 34,575 |
| After shortlist of 40 each | 11,043 |
| **Pre-filter, as set-based SQL over columns** | **153 ms for all 34,575** |
| `matching_pair_is_eligible`, per pair | 1.33 ms |
| `compatibility` (both directions), per pair | 0.38 ms |
| **Projected per-pair total for 34,575** | **59 seconds** |
| Fetching 11,043 candidate edges (12 paged calls) | 4.4 s |
| `planRound` over 11,043 edges (pure TypeScript) | 0.6 s |
| Validating a finalization batch of 25 pairs | 0.43 s |
| Validating a finalization batch of 150 pairs | ~30 s |

Two conclusions:

1. **Set-based is ~385× faster than per-pair** (153 ms vs 59 s for the same
   pairs). This is the whole problem.
2. **Validation is superlinear in batch size** — 6× the pairs costs ~70× the
   time. Suspected cause: a large jsonb payload re-parsed across a dozen
   statements, with `jsonb_to_recordset` giving the planner a fixed 100-row
   estimate regardless of actual size.

## Hard constraints (do not break these)

- **8-second statement timeout** on everything arriving through PostgREST.
  Lifted to 110 s for three round-building functions only (migration 0137).
  Do not lift it globally.
- **125-second gateway ceiling.** A client giving up does **not** stop the
  statement — it commits anyway. This caused runs showing more pairs written
  than they were opened for.
- **`lock_timeout` does not apply to advisory locks.** Use
  `halal_mode_private.take_matching_lock(key, salt, deadline)`, which tries
  rather than waits (migrations 0114/0115). An unbounded advisory wait took the
  whole API down: every waiting call holds a PostgREST connection, ten of them
  exhaust the pool, and the project answers 503 to everything.
- **Reciprocity is absolute.** If A is shown B, B is shown A. Verify with
  `shadow_round_shape_service(run_id)` — `one_sided_edges` must be 0.
- **Only must-have preferences may exclude.** Age and distance are hard limits
  *only* where the member marked them. Unmarked means "ideally" and must be
  scored, never filtered. See migration 0092 — this has already been got wrong
  once. Country is universal and reciprocal; blocks, hiding, pause and consent
  are universal.

## What to change

Rewrite `halal_mode_private.matching_candidate_snapshot_prepare_unclamped`
(current version in migration 0138) so candidate generation calls **no plpgsql
function per pair**:

1. `matching_run_member_snapshots` already carries every column needed —
   country, relocation, latitude, longitude, age, min_age, max_age,
   max_distance_km, preferred_countries, must_have (added in 0138). Use them.
2. Express `compatibility` as arithmetic over those columns instead of a
   function call. The current implementation is in migration 0052; it must give
   the same score, and there are contract tests on it.
3. Express the remainder of `matching_pair_is_eligible` as SQL predicates.
   The plausibility pre-filter already exists as
   `halal_mode_private.snapshot_pair_is_plausible` (0138) — extend rather than
   duplicate, and keep the rules in one place.
4. Prepare in chunks if a single statement still cannot finish: cursor over
   member ranges, each chunk its own short statement, the same pattern
   finalization now uses.

Then reduce the finalization payload: pass edges as arrays or a temp table
rather than one large jsonb blob re-parsed per statement, which should remove
the superlinearity and allow batches far larger than the current 40.

## How to test

```bash
# Fire a shadow run (safe: writes only to shadow_round_edges, nothing reads it)
curl -s -X POST "$URL/rest/v1/rpc/fire_worker_service" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" -d '{"p_worker":"round-shadow"}'

# What the run did
curl -s -X POST "$URL/rest/v1/rpc/recent_matching_runs_service" ... -d '{"p_limit":1}'

# Fairness and reciprocity — the go/no-go
curl -s -X POST "$URL/rest/v1/rpc/shadow_round_shape_service" ... -d '{"p_run_id":"<id>"}'
```

A good run: `pairs_created` non-null, `error` null, `one_sided_edges` 0, and
`fewest_shown` close to `most_shown` (even distribution, not a good average).

**Watch the API while testing.** `curl "$URL/rest/v1/profiles?select=id&limit=1"`
must stay 200 throughout. If it goes 503 the connection pool is wedged; clear it
with the pattern in migration 0113.

## Also outstanding

**Cross-timezone matching is untested.** Rounds now open at each member's own
Fajr (0128), computed from their coordinates (`src/lib/prayerTimes.ts`, verified
against the Umm al-Qura API for six cities). But the seeded population is 85% UK
— the whole cohort spans about 50 minutes — so no round has ever had two members
whose dawns are hours apart.

Worth seeding a globally spread cohort (Tokyo, San Francisco, Jakarta, Cairo,
London) and verifying that:

- each member's round opens at their own dawn and expires 24 h later
- a pair spanning many hours still matches when the second member submits,
  after the first member's window has closed
- `get_current_round` does not reveal a round before `opens_at`

The matching logic already supports asynchronous submission — mutual interest is
detected whenever the second person submits, with no requirement that the first
one's round is still open — but it has not been exercised.

## Current state

- `reciprocal_matching_v1` flag is **false**; live rounds use the legacy band
  matcher, which works but never repeats a pairing and so exhausts a small pool
  in about a week.
- 455 seeded members on `@halalmodetest.com`, removable via
  `purge_test_accounts_service('delete every test account')`.
- Latest shadow runs reach ~600 of 855 pairs before the function's lifetime
  ends, with 299 members served and zero one-sided edges.
