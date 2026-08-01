# Handoff notes

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
- Migrations through `0035`, matching pgTAP contracts, and an isolated
  Docker-backed GitHub Actions contract job are committed locally. They still
  need their first successful remote CI run, deployment, and hosted-project
  verification before their server-side changes can be called live.

## What is not release-ready

1. The isolated pgTAP CI job is wired but has not yet run remotely because the
   branch has not been pushed; this machine also has no Docker/Podman runtime.
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

1. Push the branch and record the first passing isolated database CI result.
2. Run the release checklist for the pending migrations and current client work.
3. Validate native builds on the four-size matrix rather than trusting stale
   emulator content or browser previews.
4. Keep **Halal Mode Premium** consistent in member-facing copy and server-side
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
- **`0049`–`0054` have never executed.** Assume syntax and permission errors.

## What remains to reach done

In dependency order.

1. **Run the SQL.** Migrations `0049`–`0054` and their pgTAP suites are still
   unexecuted. The client/Edge static checks are green, but this machine has no
   Docker or local PostgreSQL and the Supabase plan has no preview branches.
   Push the current checkpoint so the existing `database-contracts` GitHub
   Action can run `supabase db reset --local && supabase test db` in an isolated
   stack. Fix every migration or contract failure before seeding or shadow
   execution. The new tests cover capacity, deterministic pagination,
   cooldown/retirement/explicit pass, all-or-nothing reciprocal persistence,
   service-role boundaries, shadow isolation, durable outcomes, and the
   established `get_current_round_state` response contract.

2. **Seed a realistic population and run a shadow round.**
   `POST /generate-round?mode=shadow`. Verify `matching_runs` receives stage
   latencies and `edges_after_filter`, that `shadow_round_edges` fills, and that
   `introductions`, `connections` and `pair_exposure` are all untouched. That
   last check is the whole basis for trusting shadow mode.

3. **Benchmark `passes_criteria`.** The entire latency model in §7 rests on an
   assumed ~25 µs per call. Measure it, then correct §7 rather than leaving an
   estimate presented as a projection.

4. **Wire the new round states into the app.** `0053` returns `awaiting_turn`
   and `at_match_capacity`; copy exists in `src/i18n/catalog.ts` in both
   languages, but `app/(tabs)/daily.tsx` still branches only on
   `matching_inputs_unavailable`. Deferred members currently see the wrong
   message until this is done.

5. **`explicit_pass` has no way to be set.** The enum value exists and the
   prefilter honours it, but no UI or RPC ever writes it. Either add a
   deliberate "not for me" action or drop the value — a filter nothing can
   trigger is worse than no filter.

6. **Retire the dead path.** Once v1 is live, `generate_round_for_pairs` and the
   `|band| <= 1` gate are unused. Removing them is the point at which the band
   retirement approved in §2 actually happens.

7. **Metrics.** §Metrics of the brief asks for exposure distribution, zero-match
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
