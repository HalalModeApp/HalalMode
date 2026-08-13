# Handoff notes

> **State as of 2026-08-12.** Migrations through `0095` are applied to the
> hosted project; the `generate-round` Edge Function is at version 12; the
> active matching configuration is version 10. 209 client tests pass and **CI is
> fully green**, including the 44-file pgTAP suite. The app has been run against
> the live backend and a complete member journey verified end to end.

## What is actually proven now

A real journey, walked in a browser against the hosted project rather than
argued from tests:

sign in by magic link -> onboarding -> profile readiness -> a generated round ->
reciprocal introductions -> one-sided interest (which created nothing and was
invisible to the other member) -> mutual interest -> a connection at
`choosing_questions`.

Fourteen test members exist, all built through the app's own RPCs. The privacy
promises held at every step that could be checked, and two server boundaries
correctly refused the test harness mid-run.

## Decisions made

1. **The same-country distance cap applies only where a member marks distance a
   "must have".** The app offers that toggle beside age, height and sect; if the
   radius applied regardless, those controls would do nothing. An unmarked
   radius means "ideally nearby" and the score accounts for it, which also keeps
   a thin pool from producing empty rounds. Missing coordinates still fail
   closed, unconditionally. Recorded in `0092`, with the misleading comment that
   caused a near-miss corrected in the live function.

2. **The waitlist lives at `/join`** and is the page halalmo.de points at. Same
   backend, separate route from the app's sign-in splash, and it retires when
   signups open. Collects email, city, age range.

## Still open

- **The thresholds in the matching config are estimates**, not findings: 30 days
  after a first pass, x0.5 rank per pass, x1.5 per soft select, the 0.6
  generosity anchor, 2-5 appearances, 2-21 day cooldowns. All versioned config,
  changeable without a deploy, none tested against a real member.
- **`reciprocal_matching_v1` is still off**, so live rounds use the legacy band
  matcher. The v1 scoring work is inert until it is flipped; shadow first, per
  the rollout section at the foot of this file.
- **The client-side dwell inference has never run in a browser.** The pass and
  soft-select server paths are covered by pgTAP and by `0085` against the live
  database, but the part that watches how long a profile is read has only unit
  tests.
- **Nothing has been seen on a device.** Web is a means, not a target.

## Working on this project

- **Pushing needs the `HalalModeApp` GitHub account.** `gh` has both it and
  `ArtificialMo` logged in; the latter has no write access and pushes 403. Run
  `gh auth switch --user HalalModeApp` — it does not always survive a new
  session.
- **`EXPO_PUBLIC_USE_MOCKS=0`** — the local app talks to the real project. Set
  it back to `1` for a demo build.
- **Test accounts are all `@halalmodetest.com`** and nothing real ever will be.
  Remove every one of them, and everything hanging off them, with a single call:
  `purge_test_accounts_service('delete every test account')` as service role.
- **Running the app on web**: `npx expo start --web`. Metro is slow here — a
  cold bundle is 30s and a rebuild has been seen to take over three minutes, so
  a page that will not load is usually still compiling. Expo's reverse geocoding
  does not work on web, so onboarding cannot pass its location step in a
  browser; call `complete_onboarding` directly instead.
- **A shadow round is a free end-to-end smoke test** after any migration
  touching the round pipeline. It needs the scheduler secret from Dashboard ->
  Project Settings -> Vault.

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
- Migrations through `0095` are applied to the hosted project and the Edge
  Function is deployed. Saying no now has four strengths: not selected this
  round, a deliberate pass (rank penalty plus 30 days), a second pass (further
  rank penalty plus ~90 days), and hiding, which is mutual, permanent and only
  ever chosen explicitly. Soft select is the one positive outcome. Repeat
  allowance (2–5) and cooldown (2–21 days) both scale with the reciprocal
  estimate.

## What is not release-ready

1. The isolated pgTAP CI job runs on every push and is green. This machine has
   no working Docker runtime and deliberately does not need one.
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

- Migrations through `0095` apply from a clean database and all 44 pgTAP files
  pass in GitHub Actions.
- Client typecheck, lint, all 209 tests, the Android export, and the
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

## Matcher V2/V3 comparison state (2026-08-13)

- The pre-change baseline is preserved on local branch `matcher-v2` at commit
  `573234b`; it has not been deleted or rewritten.
- Matcher V3 is implemented behind the inactive config row seeded by migration
  `20260813102643_matcher_v3_anchor_first_config.sql`. Its run label is
  `anchored_maxmin_v2`; the active config and release flag remain on Matcher V2.
- V3 now carries directional estimates into allocation and anchors predicted
  mutual first-choice edges before the constrained-first fill.
- Hosted shadow smoke evidence is partial only: 430 fake members had 1–5
  reciprocal edges and zero one-sided edges before the existing batched shadow
  finalizer stalled at 1,600 edges. Do not enable the release flag until the
  finalizer completes a full run and the outcome metrics are measured.
- The local comparison now includes a privacy-safe deterministic cohort of 455
  profiles and about 9,120 shortlist edges. V2 and V3 both finish in under a
  second on that graph; the legacy V1 simulator and V2 also run on 454
  profiles. These are capacity and completion checks, not evidence that the
  estimator predicts real preferences.
