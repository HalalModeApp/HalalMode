# Halal Mode

Halal Mode is an intentional Muslim marriage app built around a small daily set
of reciprocal introductions. Members keep only people they genuinely want to
meet; a conversation opens only after mutual interest, five double-blind
compatibility answers, and a neutral recap.

The product deliberately avoids public popularity scores, one-sided-like
disclosure, endless browsing, and paid visibility.

## Current product status

- Expo SDK 54 / React Native 0.81 / strict TypeScript / Expo Router.
- Supabase for Auth, Postgres, Storage, Edge Functions, and RLS.
- Email magic-link authentication and onboarding are implemented for the real
  backend. Mock mode remains the default for local product work.
- English and Arabic copy, in-app language choice, and explicit RTL styling are
  implemented. A native direction change requires a cold restart and still needs
  a complete native device matrix.
- Reciprocal rounds, mutual interest, question picks, double-blind answers,
  recap, connection closing, message read receipts, blocking, reporting, and
  account controls have server-side boundaries in migrations.
- Profile voice introductions can record, upload to private storage, and play.
  In-chat voice-note sending and real calling are not production features.
- Halal Mode Premium is the member-facing and server-side membership tier.

See [release gates](docs/QUALITY_GATES.md) and the
[release checklist](docs/RELEASE_CHECKLIST.md) for what is actually verified.

## Run locally

```bash
npm install
copy .env.example .env
npm start
```

`EXPO_PUBLIC_USE_MOCKS=1` lets the complete introduction to connection flow run
without a Supabase project. To use a real backend, set
`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, and
`EXPO_PUBLIC_USE_MOCKS=0`.

```bash
npm run verify:client
npm run export:android
```

## Project layout

```text
app/                      Expo Router screens and flows
src/api/                  Mock and Supabase data paths
src/components/           Introductions, UI, navigation, profile components
src/i18n/                 Typed English/Arabic catalogs and provider
src/lib/                  Pure rules and infrastructure helpers
src/state/                Session, auth, and round state
src/theme/                Design tokens
supabase/migrations/      Schema, RLS, RPCs, and matcher boundaries
supabase/functions/       Scheduled round generation
supabase/tests/database/  pgTAP database contracts
tests/                    Node unit invariants
docs/                     Quality gates and release checklist
```

## Privacy model

The app enforces sensitive access rules in Postgres, not only in the client:

- Private preferences are visible only to their owner. Matching functions read
  both sides internally and return only permitted results.
- Selection scores are not readable by members, including their owner. They are
  a matching input, never a popularity feature.
- A member cannot discover one-sided interest. Selection access is scoped to the
  viewer and mutual state is resolved server-side.
- Question answers are write-once and double-blind. The answer RPC releases the
  other person's answer only after the caller has answered.
- Profile visibility, connections, messaging, blocks, reports, and private
  media are protected by RLS/RPC/storage policies.

## Membership limits

| | Free | Halal Mode Premium |
| --- | --- | --- |
| Introductions per round | 5 | 10 |
| May keep | 1 | 3 |
| Open connections | 5 | 10 |

Client limits make the interface responsive; database functions enforce the
same limits once migration `0019_connection_capacity.sql` is deployed. The
membership preview in mock mode is not a purchase system.

## Backend deployment

Apply migrations only after the isolated database contract gate in
`docs/QUALITY_GATES.md` passes:

```bash
supabase db push
supabase functions deploy generate-round --no-verify-jwt
```

The round function is scheduled for Madinah Fajr using a server-side schedule
prepared the previous day. Treat deployment, cron credentials, and remote
verification as separate release steps. Never place the service-role key in the
app or repository.

## Known release blockers

- The isolated database contract gate is passing in CI, but production schema
  deployment remains deliberately separate until remote Supabase access and
  release approval are verified.
- Stable `testID`s and Maestro smoke contracts exist, but they still need to
  run on a configured native build with controlled test accounts.
- iOS and full Android device/accessibility/RTL verification are incomplete.
- Chat has cursor pagination, direct realtime cache insertion, and a durable
  offline outbox; native reconnect, memory, and recovery testing are still
  required before a high-volume release.
- Real purchases, entitlement verification, subscription restore, real calling,
  and in-chat voice-note sending are not implemented.
