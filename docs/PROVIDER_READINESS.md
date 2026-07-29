# Provider readiness

Halal Mode ships only flows backed by an enforceable provider integration. The client flags in `src/lib/featureFlags.ts` keep unconnected features off by default.

## Required before enabling a flag

| Capability | Server source of truth | Required proof |
| --- | --- | --- |
| Premium purchases | Audited provider webhook calls `halal_mode_private.apply_membership_entitlement`; never client state | Valid sandbox purchase, expiry, refund, duplicate delivery, and self-upgrade rejection tests |
| Identity and age verification | Provider webhook updates private verification records; no ID image or reference enters public tables | Approved, rejected, expired, retry, and access-control tests |
| Push notifications | Server stores only hashed device tokens and applies consent, locale, quiet hours, and unsubscribe checks | Device delivery plus opt-out and quiet-hours tests on iOS and Android |
| Live calls | Authenticated connection-scoped short-lived token from a server function; a provider never receives profile data beyond the minimum | Mutual-connection, blocked, expired-token, call-failure, and reporting tests |
| Voice notes | Private storage path authorization and connection-scoped playback authorization | Upload, playback, deletion, blocked-member, and expiry tests |

## Non-negotiable rules

- Do not place provider secrets, webhook secrets, service-role keys, receipt payloads, verification identifiers, or raw notification tokens in the app bundle, logs, analytics, or public tables.
- Keep feature flags disabled until a staging environment has passed the proof listed above and an owner has approved the rollout percentage.
- Never grant a member direct write access to membership tier, verification status, release flags, private audit data, or device tokens.
- A browser, app store account, and provider credentials are still needed for the external integrations; this repository provides the secure local boundary only.
