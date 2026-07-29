# Halal Mode quality gates

This document describes evidence required for a release candidate. It does not claim a gate passed merely because the code exists.

## Automated now

| Gate | Command | Current scope |
| --- | --- | --- |
| Type safety | `npm run typecheck` | Strict TypeScript across the app source. |
| Lint | `npm run lint` | Expo and React Native static checks. |
| Unit invariants | `npm test` | Daily-round rules, carousel geometry, compatibility privacy, memberships, and launch foundations. |
| Client bundle | `npm run export:android` | Android JavaScript bundle/export on Linux CI. |
| Combined client gate | `npm run verify:client` | Typecheck, lint, then unit invariants. |

The GitHub workflow at `.github/workflows/quality.yml` runs the client gate and Android export on pull requests and pushes to `main` or `codex/**` branches.

## Database contract gate: required before production database changes

The repository contains pgTAP tests through migration `0026`, but they are not yet wired to CI because there is no committed local Supabase configuration. Do not point tests at the linked project.

When local Supabase configuration and Docker are deliberately added, enable this sequence in CI against an isolated local database:

```bash
supabase start
supabase db reset --local
supabase test db
supabase stop
```

The job must fail on any pgTAP failure and never carry production credentials. Until then, every database deployment must record a manual isolated-run result in the release checklist.

## Native device matrix

Run Expo Go for JavaScript-only changes and a development build whenever native modules, permissions, app configuration, media, notifications, or deep links change.

| Surface | Compact Android | Tall Android | iPhone small | iPhone large |
| --- | --- | --- | --- | --- |
| Sign in, deep link, validation | [ ] | [ ] | [ ] | [ ] |
| Onboarding, keyboard, resume | [ ] | [ ] | [ ] | [ ] |
| Daily deck slow/fast swipes | [ ] | [ ] | [ ] | [ ] |
| Interest, release, and retry | [ ] | [ ] | [ ] | [ ] |
| Profile, photo, and voice-introduction media | [ ] | [ ] | [ ] | [ ] |
| Questions, answers, and recap | [ ] | [ ] | [ ] | [ ] |
| Chat, reconnect, read receipt, close | [ ] | [ ] | [ ] | [ ] |
| Settings, privacy, block/report, deletion | [ ] | [ ] | [ ] | [ ] |

Repeat each relevant path in English and Arabic after a cold restart, at 200% font scale, with a screen reader and Reduce Motion enabled, in airplane mode and on slow network, and with an expired session. Check gesture navigation, display cutouts, keyboard resizing, and bottom safe area.

## Current release debt

- Stable `testID`s and source-controlled Maestro smoke contracts exist for authentication, daily introductions, recap, and chat; they have not yet run against a configured native build with controlled test accounts.
- pgTAP exists but has not run through an isolated local CI database.
- The Android/iOS matrix remains incomplete; a stale emulator bundle is not release evidence.
- The gallery still needs memory/error-state measurement. The daily deck keeps full-size images mounted to avoid card handoff flashes.
- Chat presently refetches complete history on realtime events and has no durable offline outbox; pagination and direct cache insertion are required before large conversation volumes.
- Calling and in-chat voice-note sending are not production features. Profile voice introductions use private storage and must be tested against real permissions and signed-URL expiry.
- Subscription purchase, entitlement verification, restore, cancellation, and localized pricing are not implemented. A mock membership preview cannot be marketed as Halal Mode Premium.
