# Account deletion operations

The app's **Delete account** action immediately pauses the profile and closes
connections. It does not directly delete Auth records or storage objects.

Deploy `finalize-account-deletions` only after setting a high-entropy
`DELETION_WORKER_SECRET` as an Edge Function secret. Invoke it from a trusted
scheduled job with that secret in the `x-deletion-worker-secret` header. The
function uses the server-held service-role key, claims up to 25 requests for a
15-minute lease, removes profile media, then removes the Auth user. Deleting
the Auth user cascades the profile and all request records.

Failures clear the lease and retain a short error message in the private queue,
so a later scheduled attempt can retry safely. Do not expose this function to
the client, publish its worker secret, or invoke it before the retention policy
and support review are approved.
