# Release checklist

Use this checklist for one named release candidate. A checked item must have a
command output, device build, or deployment URL attached to the release record.

## Source and client verification

- [ ] `npm ci` completed from the lockfile.
- [ ] `npm run verify:client` passed.
- [ ] `npm run export:android` passed on Linux CI.
- [ ] Dependency review completed with `npx expo install --check`.
- [ ] Every changed visible control has a stable `testID`, an accessibility
      label where appropriate, and an Arabic/RTL review.
- [ ] The change has a focused unit, integration, or Maestro test. A missing
      test is recorded as release debt, not silently accepted.

## Database and security

- [ ] Migrations were tested on an isolated local Supabase database with
      `supabase db reset --local`.
- [ ] `supabase test db` passed all pgTAP contracts after the reset.
- [ ] Remote schema lint has no actionable warnings.
- [ ] Any migration was dry-run and reviewed for locks, indexes, RLS, RPC
      permissions, storage policies, and rollback/recovery implications.
- [ ] A production deployment used `supabase db push` only after the isolated
      database pass; its migration history was verified afterwards.
- [ ] No client build, repository history, log, or CI secret contains a
      service-role key.

## Native experience

- [ ] Test the affected path on compact and tall Android, plus small and large
      iPhone hardware or simulators.
- [ ] Test English, Arabic after a cold restart, 200% text size, screen reader,
      Reduce Motion, gesture navigation, keyboard, and safe areas.
- [ ] Exercise loading, empty, offline, retry, expired-session, and server-error
      recovery states.
- [ ] Capture only the key screens needed to validate visual regressions; do not
      rely on browser rendering for native gestures, permissions, or media.

## Product, privacy, and operations

- [ ] Verify reciprocal introduction, mutual interest, question selection,
      double-blind answers, recap, chat, block, report, and account deletion.
- [ ] Verify profile media cannot be read or changed outside its server-authorized
      relationship.
- [ ] Verify membership entitlement and restore/cancellation paths if a purchase
      flow changed. Do not describe a preview toggle as a purchase.
- [ ] Update `DECISIONS.md` only for an approved departure from the core product;
      each entry needs a one-sentence rationale.
- [ ] Commit the release candidate, push it, deploy applicable services, and
      record the commit, deployment, and verification result.

## Native gates not yet automated

These are release blockers for a production claim, not optional polish:

- Maestro or equivalent end-to-end flows built on stable `testID`s.
- First passing Docker-backed pgTAP CI run for the candidate commit.
- Real-device coverage across the four-size matrix.
- Accessibility tree/screen-reader assertions and Arabic cold-restart checks.
- Chat pagination/offline outbox/retry tests, gallery memory measurement, and
  subscription restore verification once purchases are implemented.
