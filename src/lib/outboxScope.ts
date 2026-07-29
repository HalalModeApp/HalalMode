const OUTBOX_PREFIX = 'halal-mode.message-outbox.v2';

/**
 * Keeps unsent text isolated per member on a shared device. Connection IDs are
 * not enough: a new account could otherwise inherit an old account's outbox.
 */
export function outboxStorageKeyForMember(memberId: string): string {
  const normalized = memberId.trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(normalized)) {
    throw new Error('A valid member identifier is required for the message outbox.');
  }
  return `${OUTBOX_PREFIX}.${normalized}`;
}
