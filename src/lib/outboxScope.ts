const OUTBOX_PREFIX = 'halal-mode.message-outbox.v3';
const LEGACY_OUTBOX_PREFIX = 'halal-mode.message-outbox.v2';

/**
 * Keeps unsent text isolated per member on a shared device. Connection IDs are
 * not enough: a new account could otherwise inherit an old account's outbox.
 */
export function outboxStorageKeyForMember(memberId: string): string {
  return `${OUTBOX_PREFIX}.${normalizeOutboxMemberId(memberId)}`;
}

export function legacyOutboxStorageKeyForMember(memberId: string): string {
  return `${LEGACY_OUTBOX_PREFIX}.${normalizeOutboxMemberId(memberId)}`;
}

export function outboxBodyStorageKeyForMember(memberId: string, messageId: string, chunkIndex: number): string {
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(messageId) || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error('A valid message identifier is required for the message outbox.');
  }
  return `halal-mode.message-outbox.body.v1.${normalizeOutboxMemberId(memberId)}.${messageId}.${chunkIndex}`;
}

function normalizeOutboxMemberId(memberId: string): string {
  const normalized = memberId.trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(normalized)) {
    throw new Error('A valid member identifier is required for the message outbox.');
  }
  return normalized;
}
