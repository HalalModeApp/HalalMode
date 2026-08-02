# Handoff notes

> **State as of 2026-08-02.** Migrations through `0088` are applied to the
> hosted project; the `generate-round` Edge Function is deployed at version 10;
> the active matching configuration is version 8. 203 client tests pass. CI has
> **two known failures**, both the same open question — see "Decisions waiting
> on you" below. Nothing in the matching stack has ever run against real data:
> the project holds **zero profiles**, so every shadow round returns
> `pairsCreated: 0` and every claim below is about mechanism, not behaviour.

## Decisions waiting on you

1. **Is the same-country distance cap absolute, or only when marked "must
   have"?** `0061` made it conditional on the marking. Its own comment says the
   opposite — *"distance stays a hard limit for same-country pairs whether or
   not it is marked... a member who set a radius has already expressed a
   boundary"* — and two contract tests (`0021` tests 10 and 16) side with the
   comment. The code and its stated rationale disagree; one of them is wrong.
   This changes who gets matched, so it was left for you. Those two tests are
   the only CI failures.

2. **The thresholds in the matching config are estimates, not findings.** 30
   days after a first pass, ×0.5 rank per pass, ×1.5 per soft select, the 0.6
   generosity anchor, the squared curve, 2–5 appearances, 2–21 day cooldowns.
   All are versioned config, changeable without a deploy. None has been tested
   against a real member.

## Things worth pointing out

- **Pushing needs the `HalalModeApp` GitHub account.** `gh` has both it and
  `ArtificialMo` logged in; the latter has no write access and a push as it
  fails with a 403. `gh auth switch --user HalalModeApp` before pushing.
- **The round scheduler secret was rotated** on 2026-08-02 and exists only in
  Supabase Vault (`halal_mode_round_scheduler`). Both cron jobs read it at call
  time, so nothing needs redeploying, but a manual shadow run needs it from the
  dashboard.
- **Docker is installed on this machine but its engine has never started**, and
  nothing here needs it. `verify:sql`, `verify:client`, `db push` and the hosted
  shadow run are all Docker-free; only `db:reset`, `db:test:local` and
  `supabase start` need it, and CI runs those. A local Supabase stack would add
  a second database that can drift from hosted — this codebase has already been
  bitten twice by two copies of one truth drifting, so that is a real cost.
- **A shadow round is a free end-to-end smoke test** and worth running after any
  migration that touches the round pipeline:
  `curl.exe -X POST ".../functions/v1/generate-round?mode=shadow" -H "x-cron-secret: ..."`.
  It exercises config read, snapshot prepare, edge paging, planning and
  finalisation without touching anything a member can see. While the project has
  no members, `pairsCreated: 0` is the expected answer; after launch, a `0`
  there means something is wrong.

## The failure mode this codebase actually has

Four times in one sitting, a piece of work was complete and correct read on its
own, and did nothing — or the wrong thing — where it sat. Worth knowing, because
none of it was caught by tests passing or migrations applying cleanly:

- `explicit_pass` was read by four call sites and written by none, for eight
  migrations.
- `expire_explicit_passes()` was defined in a schema PostgREST cannot reach and
  called by nothing.
- The SQL and TypeScript halves of the repeat curve diverged when only one
  gained an exponent; both looked right alone.
- A guard added to stop submissions erasing a pass also blocked the expiry that
  is *supposed* to erase it, so bans became permanent.

Two more were regressions from restatements: `0064` restated `update_my_profile`
and dropped the media guard `0055` exists to protect; `0069` restated
`matching_member_signals()` and re-applied a grant `0054` had deliberately
revoked. **`create or replace` carries the body forward and leaves grants alone
— the risk is in the lines written around it out of habit.**

The defences that now exist for this: a mirror test comparing the stored config
to the code, assertion blocks inside migrations that run against the live
database, and CI. Prefer adding to those over adding a comment.

Read [README.md](README.md), [quality gates](docs/QUALITY_GATES.md), and the
[release checklist](docs/RELEASE_CHECKLIST.md) first. These notes describe the
current source; they are not evidence that every capability has passed native
or production verification.

## Working features

- Mock mode runs the core daily round, profile, mutual match, question, recap,
  and chat flow without a backend.
- Real mode has magic-link auth, route gating, onboarding, profile updates,
  reciprocal introductions, questions, recap, messages/read receipts, blocks,
  reports, account controls, and private profile media boundaries.
- English/Arabic typed catalogs and RTL-aware layouts are in source. Question
  copy now has a central locale fallback; adding a language remains a catalog
  and server-content task rather than a screen-by-screen rewrite. Changing
  native direction intentionally waits for a cold restart.
- Profile voice introductions use `expo-audio` and private storage. Chat voice
  sending and actual calling remain unavailable by design until a provider,
  consent model, abuse controls, and retention policy are approved.
- Migrations through `0088` are applied to the hosted project and the Edge
  Function is deployed. Saying no now has four strengths: not selected this
  round, a deliberate pass (rank penalty plus 30 days), a second pass (further
  rank penalty plus ~90 days), and hiding, which is mutual, permanent and only
  ever chosen explicitly. Soft select is the one positive outcome. Repeat
  allowance (2–5) and cooldown (2–21 days) both scale with the reciprocal
  estimate.

## What is not release-ready

1. The isolated pgTAP CI job runs on every push and currently has two known
   failures, both the distance question in "Decisions waiting on you". This
   machine has no working Docker runtime and deliberately does not need one.
2. Maestro source contracts and stable test IDs cover key paths, but they have
   not run against a configured native build with controlled test accounts.
3. The native matrix, Arabic cold-restart behavior, screen reader behavior, and
   media permissions are incomplete.
4. Chat now uses cursor paging, direct realtime cache updates, and a persistent
   text-message outbox; its database contract and native reconnect behavior are
   still unverified.
5. Purchases/entitlements/restore, real calling, in-chat voice notes, contact
   sharing, photo moderation, and release assets are unfinished.
6. The EAS project ID is a placeholder; do not attempt a production build until
   it is replaced with the real project configuration.

## Non-negotiable privacy boundaries

- Never expose `selection_scores`, including to their owner.
- Never expose one-sided interest or private preferences.
- Keep double-blind answer release inside the database RPC.
- Keep profile/media, connection, message, block, report, and deletion rules
  server-authorized with RLS and RPC checks.
- Never ship the service-role key to Expo, source control, logs, or CI output.

## Safe next steps

1. Run the release checklist for the pending migrations and current client work.
2. Validate native builds on the four-size matrix rather than trusting stale
   emulator content or browser previews.
3. Keep **Halal Mode Premium** consistent in member-facing copy and server-side
   tier values; the local session migration accepts the retired `plus` value
   only to upgrade older installed clients safely.

## Working conventions

- Reuse tokens in `src/theme/tokens.ts`; do not hardcode design values.
- Keep mock and real API branches working together.
- Treat localisation, RTL, accessibility, privacy, and error/recovery states as
  part of the feature, not follow-up polish.
- Record only approved departures from the core concept in `DECISIONS.md`, each
  with a one-sentence rationale.

---

# Reciprocal matching v1 — handoff (2026-08)

Branch `main`. Read `docs/RECIPROCAL_MATCHING_V1_DESIGN.md` first,
especially §10 (three design errors simulation caught), §11 (scale) and §12
(imbalance).

## Verified implementation baseline

- Migrations through `0088` apply from a clean database. 44 pgTAP files run in
  GitHub Actions; two assertions fail, both the open distance question.
- Client typecheck, lint, all 203 tests, the Android export, and the
  `generate-round` Deno typecheck pass.
- Live completion is one idempotent database transaction: it rechecks current
  safety state, persists reciprocal rounds, stores durable repeat retirements,
  records derived metrics, and claims the cycle together. A classifiable late
  veto gets at most one fresh snapshot/replan; an ambiguous response gets one
  exact retry of the same request.
- Shadow completion can write only private shadow results and run diagnostics;
  its database contracts assert that live rounds, introductions, connections,
  pair exposure, notifications, and repeat retirements remain untouched.

## Assess this work independently before extending it

Do not treat the previous agent's code as correct because the tests pass. The
tests were written by the same agent that wrote the code, so they encode its
assumptions as well as its intent. Specifically worth attacking:

- **The estimator is not a calibrated probability.** `directionalEstimate`
  returns a number in [0,1] used for *ranking*. Nothing validates that it
  predicts anything. Once real selection data exists, check whether the
  predicted reciprocal score correlates with observed mutual picks at all. If it
  does not, the weights are decoration.
- **Independent simulation invalidated the original headline claims.** The
  mixed model shows a smaller synthetic quality gain but worse zero-match and
  mutual rates; an unobserved choice model is flat. Real shadow selections must
  validate the estimator before any live rollout.
- **Waiting is not durable.** The simulator increments an in-memory counter, but
  production persists no deferred/no-candidate outcome. A rotation guarantee
  cannot be enforced across Edge Function runs until this is server state.
- **Candidate truncation is biased.** `matching_candidate_edges` uses an
  unordered `limit 500000`; a large graph is silently cut at an arbitrary point
  and the discarded work is absent from overload metrics.
- **Database fetch latency is omitted from threshold breaches.** The fetch
  duration is appended after `planRound()` has already classified the run.
- **Compatibility weights every term equally** (`avg` over the terms array). Age
  and shared languages count the same as religious practice. That is almost
  certainly wrong as product judgement; it was chosen for simplicity.

## What remains to reach done

In dependency order.

1. **Run the shadow proof against an approved hosted environment.**
   `supabase/tests/database/0060_matching_shadow_round_integration.test.sql`
   now seeds a mixed eight-member population, pages the candidate snapshot,
   finalizes three shadow pairs, retries exactly, and fingerprints live tables
   to prove that `introductions`, `connections`, `pair_exposure`, notifications,
   and live rounds remain untouched. The isolated CI proof is complete; only an
   explicitly approved hosted shadow run remains.

2. **Benchmark `passes_criteria`.** The entire latency model in §7 rests on an
   assumed ~25 µs per call. Measure it, then correct §7 rather than leaving an
   estimate presented as a projection.

3. **Wire the new round states into the app.** **Complete.** `awaiting_turn`
   and `at_match_capacity` are accepted by the client normalizer and rendered
   with their existing English and Arabic copy in `app/(tabs)/daily.tsx`.

4. **`explicit_pass` has no way to be set.** **Done.** It is inferred from how
   a member reads their whole set — every profile read and one read least, or
   every profile but one read and that one never opened — then confirmed once
   before submission. Reading times never leave the device. `soft_select` was
   added as its positive counterpart and is not confirmed, because it costs the
   member nothing if wrong. Neither has run against a real member.

5. **Retire the dead path.** Once v1 is live, `generate_round_for_pairs` and the
   `|band| <= 1` gate are unused. Removing them is the point at which the band
   retirement approved in §2 actually happens.

6. **Metrics.** §Metrics of the brief asks for exposure distribution, zero-match
   rate, time to first mutual, mutual rate, Gini, and free/premium and
   new/established breakdowns. `matching_runs` records per-run performance only.
   Nothing yet computes outcome metrics over time.

## How to roll this out — and why "a small cohort" is not what it sounds like

The previous handoff said to enable `reciprocal_matching_v1` "for a small
cohort". That instruction was wrong and is corrected here.

`release_flags` supports per-member cohorts through `release_flag_members` and
`rollout_percentage`, and that works for UI features. **It does not work for
matching.** A round is built for the whole pool at once and every introduction
is reciprocal: if A is shown B then B is shown A. Two members in the same pool
cannot be served by different matchers, because each would have to appear in the
other's set. Splitting the pool by member would either break reciprocity or
silently divide the pool in half — which in a launch pool of a few hundred is
severe, since a halved pool is a quartered candidate graph.

`release_flag_active()` therefore reads the global `enabled` column and ignores
percentage and membership. That is deliberate.

The real options:

- **Shadow first.** Already built. Run v1 in shadow against production data for
  as many cycles as it takes to compare its output against what live produced.
  This is the safe canary and costs nothing.
- **Geographic cohort.** Because distance caps make matching local, regions are
  near-independent pools, so one country can run v1 while others run the old
  matcher without breaking reciprocity. This is the only true partial rollout
  available, and it is not implemented — it would need a region predicate on the
  pool view and a per-region flag.
- **Whole-pool switch with instant rollback.** What the flag does today. Viable
  at launch scale precisely because the pool is small and one bad cycle expires
  at the next Fajr.

Recommended: shadow until the comparison is convincing, then whole-pool with the
flag as the rollback switch. Build geographic cohorting only when a single
region is large enough for the comparison to be meaningful on its own.
