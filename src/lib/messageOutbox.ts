import AsyncStorage from '@react-native-async-storage/async-storage';

import { outboxStorageKeyForMember } from '@/lib/outboxScope';

const LEGACY_STORAGE_KEY = 'halal-mode.message-outbox.v1';

export type PendingMessage = {
  id: string;
  connectionId: string;
  body: string;
  createdAt: string;
};

export async function enqueueMessage(memberId: string, connectionId: string, body: string): Promise<PendingMessage> {
  const entry: PendingMessage = {
    id: createRequestId(),
    connectionId,
    body,
    createdAt: new Date().toISOString(),
  };
  const entries = await getPendingMessages(memberId);
  await AsyncStorage.setItem(outboxStorageKeyForMember(memberId), JSON.stringify([...entries, entry]));
  return entry;
}

export async function getPendingMessages(memberId: string, connectionId?: string): Promise<PendingMessage[]> {
  // v1 was device-wide. Discard it rather than guessing its owner and risking
  // one member seeing another member's unsent private text after an upgrade.
  await AsyncStorage.removeItem(LEGACY_STORAGE_KEY);
  const raw = await AsyncStorage.getItem(outboxStorageKeyForMember(memberId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const entries = parsed.filter(isPendingMessage);
    return connectionId ? entries.filter((entry) => entry.connectionId === connectionId) : entries;
  } catch {
    return [];
  }
}

export async function removePendingMessage(memberId: string, id: string): Promise<void> {
  const entries = await getPendingMessages(memberId);
  await AsyncStorage.setItem(
    outboxStorageKeyForMember(memberId),
    JSON.stringify(entries.filter((entry) => entry.id !== id))
  );
}

function isPendingMessage(value: unknown): value is PendingMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && /^[a-zA-Z0-9_-]{12,80}$/.test(candidate.id)
    && typeof candidate.connectionId === 'string'
    && typeof candidate.body === 'string'
    && typeof candidate.createdAt === 'string';
}

function createRequestId(): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `mobile_${Date.now().toString(36)}_${random}`;
}
