# Product decisions

Record only approved deviations from Halal Mode's established core here, with a one-sentence rationale for each decision.

- **Push tokens are stored, not only hashed (2026-08-14).** `register_my_notification_device` hashed the token and discarded it, which made every notification unsendable — a push token is the address Apple and Google deliver to, and a hash cannot be reversed into one; the hash is kept alongside for deduplication, the token is readable only by the sending job, and it is deleted the moment a member turns notifications off or closes their account.
