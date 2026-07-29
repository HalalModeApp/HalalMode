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
- Migrations through `0032` and matching pgTAP contracts are committed locally.
  They still need isolated pgTAP validation, deployment, and remote verification
  before their server-side changes can be called live.

## What is not release-ready

1. No committed Supabase local configuration/CI job runs pgTAP automatically.
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

1. Add a local Supabase config deliberately, then run `supabase db reset --local`
   and `supabase test db`; only then enable the database CI job.
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
