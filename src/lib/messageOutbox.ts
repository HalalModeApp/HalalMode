import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'halal-mode.message-outbox.v1';

export type PendingMessage = {
  id: string;
  connectionId: string;
  body: string;
  createdAt: string;
};

export async function enqueueMessage(connectionId: string, body: string): Promise<PendingMessage> {
  const entry: PendingMessage = {
    id: createRequestId(),
    connectionId,
    body,
    createdAt: new Date().toISOString(),
  };
  const entries = await getPendingMessages();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...entries, entry]));
  return entry;
}

export async function getPendingMessages(connectionId?: string): Promise<PendingMessage[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
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

export async function removePendingMessage(id: string): Promise<void> {
  const entries = await getPendingMessages();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries.filter((entry) => entry.id !== id)));
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
