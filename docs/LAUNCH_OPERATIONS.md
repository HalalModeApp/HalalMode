# Launch operations

## Controlled beta

1. Set the `controlled_beta` server flag to a small approved cohort only after migrations and database tests pass in staging.
2. Keep Premium purchases, identity verification, push notifications, and live calling disabled until their provider readiness proof is complete.
3. Monitor round generation, reciprocal selections, reports, blocks, failed media requests, and failed provider webhooks without recording message text, exact locations, voice content, or IDs.
4. Maintain a staffed response path for safety reports and account deletion requests before inviting external members.

## Release gates

- Run `npm run verify:client` and `npm run export:android` from a clean install.
- Run the Supabase migration and pgTAP suite in an isolated database; do not apply unverified migrations to production.
- Run the Maestro smoke flows against a signed-in native development build after the relevant test accounts and backend fixtures exist.
- Verify the Fajr scheduler uses Madinah timings for the following day before a release window. A missed scheduler run must fail closed and alert the operator; it must not generate an unexpected round.
- Validate English and Arabic layouts, large text, screen-reader labels, keyboard focus, offline/recovery states, and small/large Android safe areas.

## Incident basics

Disable the affected server flag first, preserve minimal audit metadata, and use the existing block/report boundary to stop further contact. Do not inspect private messages or media unless the incident process and applicable policy allow it.
