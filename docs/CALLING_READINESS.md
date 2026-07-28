# Calling readiness

Halal Mode does not currently provide live audio or video calling. The app must
not show a successful call state until a real-time provider is integrated and
verified in native development builds.

## Required provider boundary

A production integration needs one provider adapter behind a Supabase Edge
Function. The mobile app must never receive the provider's account secret.

1. `start-call(connectionId, media)` authenticates the member, verifies an open
   and unblocked connection, creates a short-lived provider room, and returns a
   participant token scoped to that member and room.
2. `join-call(callId)` repeats membership, open-connection, and block checks at
   join time before issuing another short-lived participant token.
3. `end-call(callId)` permits either participant to end the session and is
   idempotent.
4. A signed provider webhook is the authority for ringing, answered, declined,
   failed, and ended timestamps. Webhook event IDs must be stored uniquely so
   retries cannot create duplicate history.

The database needs `call_sessions` with the connection, initiator, media type,
provider room identifier, state, timestamps, and a unique provider event key.
Clients may read call history only through the same open/unblocked connection
boundary as messages. Provider tokens, API secrets, and webhook secrets belong
in Supabase secrets, never in tables or the Expo bundle.

## Product and safety requirements

- Use a provider-supported React Native SDK in an Expo development build;
  browser preview and Expo Go are not sufficient native verification.
- Recheck block and connection status when starting and joining, not only when
  opening the chat screen.
- Default to no recording. Recording requires an explicit product decision,
  consent UI, retention policy, access logs, and deletion workflow.
- Handle denied microphone/camera permission, interruption, network handoff,
  backgrounding, missed calls, remote hang-up, token expiry, and reconnect.
- Do not expose phone numbers or use device telephone links as a substitute.
- Add provider cost controls, maximum call duration, abuse throttling, and
  observability before enabling the feature in production.

Until those pieces exist, calling is **not ready**. UI can describe it as
unavailable or coming later, but must not imitate ringing, connected, or call
history states.
