import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import {
  joinOutboxBody,
  shouldSecureOutboxBodies,
  splitOutboxBody,
} from '@/lib/messageOutboxPolicy';
import {
  legacyOutboxStorageKeyForMember,
  outboxBodyStorageKeyForMember,
  outboxStorageKeyForMember,
} from '@/lib/outboxScope';

const LEGACY_STORAGE_KEY = 'halal-mode.message-outbox.v1';

export type PendingMessage = {
  id: string;
  connectionId: string;
  body: string;
  createdAt: string;
};

type StoredPendingMessage = Omit<PendingMessage, 'body'> & { bodyChunks: number };

/**
 * The retry manifest contains only routing metadata. Native message text is
 * split into SecureStore values so a locked device does not expose unsent
 * private chat text through the app's normal async-storage files.
 */
export async function enqueueMessage(memberId: string, connectionId: string, body: string): Promise<PendingMessage> {
  const entry: PendingMessage = {
    id: createRequestId(),
    connectionId,
    body,
    createdAt: new Date().toISOString(),
  };
  const entries = await getStoredPendingMessages(memberId);
  const bodyChunks = await writeBody(memberId, entry.id, body);
  try {
    await writeStoredPendingMessages(memberId, [
      ...entries,
      { id: entry.id, connectionId, createdAt: entry.createdAt, bodyChunks },
    ]);
  } catch (error) {
    await removeBody(memberId, entry.id, bodyChunks);
    throw error;
  }
  return entry;
}

export async function getPendingMessages(memberId: string, connectionId?: string): Promise<PendingMessage[]> {
  const entries = await getStoredPendingMessages(memberId);
  const hydrated: (PendingMessage | null)[] = await Promise.all(entries.map(async (entry) => {
    const body = await readBody(memberId, entry.id, entry.bodyChunks);
    return body
      ? { id: entry.id, connectionId: entry.connectionId, createdAt: entry.createdAt, body }
      : null;
  }));
  const valid = hydrated.filter((entry): entry is PendingMessage => entry !== null);

  // A crash between secure-body and manifest writes, or a keychain reset,
  // must not leave a retry row that can never be sent.
  if (valid.length !== entries.length) {
    await writeStoredPendingMessages(
      memberId,
      valid.map(({ id, connectionId, createdAt, body }) => ({
        id,
        connectionId,
        createdAt,
        bodyChunks: splitOutboxBody(body).length,
      }))
    );
  }
  return connectionId ? valid.filter((entry) => entry.connectionId === connectionId) : valid;
}

export async function removePendingMessage(memberId: string, id: string): Promise<void> {
  const entries = await getStoredPendingMessages(memberId);
  const entry = entries.find((item) => item.id === id);
  if (!entry) return;
  await removeBody(memberId, id, entry.bodyChunks);
  await writeStoredPendingMessages(memberId, entries.filter((item) => item.id !== id));
}

async function getStoredPendingMessages(memberId: string): Promise<StoredPendingMessage[]> {
  // v1/v2 stored full message text in AsyncStorage. Discard it rather than
  // retaining private text in plaintext after the secure outbox upgrade.
  await Promise.all([
    AsyncStorage.removeItem(LEGACY_STORAGE_KEY),
    AsyncStorage.removeItem(legacyOutboxStorageKeyForMember(memberId)),
  ]);
  const raw = await AsyncStorage.getItem(outboxStorageKeyForMember(memberId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isStoredPendingMessage) : [];
  } catch {
    return [];
  }
}

function writeStoredPendingMessages(memberId: string, entries: StoredPendingMessage[]): Promise<void> {
  return AsyncStorage.setItem(outboxStorageKeyForMember(memberId), JSON.stringify(entries));
}

async function writeBody(memberId: string, id: string, body: string): Promise<number> {
  const chunks = splitOutboxBody(body);
  if (!chunks.length) throw new Error('A pending message must include text.');
  await Promise.all(chunks.map((chunk, index) => setBodyChunk(memberId, id, index, chunk)));
  return chunks.length;
}

async function readBody(memberId: string, id: string, chunkCount: number): Promise<string | null> {
  const chunks = await Promise.all(
    Array.from({ length: chunkCount }, (_, index) => getBodyChunk(memberId, id, index))
  );
  const validChunks: string[] = [];
  for (const chunk of chunks) {
    if (typeof chunk !== 'string') return null;
    validChunks.push(chunk);
  }
  return joinOutboxBody(validChunks);
}

async function removeBody(memberId: string, id: string, chunkCount: number): Promise<void> {
  await Promise.all(
    Array.from({ length: chunkCount }, (_, index) => deleteBodyChunk(memberId, id, index))
  );
}

function bodyKey(memberId: string, id: string, chunkIndex: number): string {
  return outboxBodyStorageKeyForMember(memberId, id, chunkIndex);
}

function setBodyChunk(memberId: string, id: string, chunkIndex: number, value: string): Promise<void> {
  const key = bodyKey(memberId, id, chunkIndex);
  return shouldSecureOutboxBodies(Platform.OS)
    ? SecureStore.setItemAsync(key, value)
    : AsyncStorage.setItem(key, value);
}

function getBodyChunk(memberId: string, id: string, chunkIndex: number): Promise<string | null> {
  const key = bodyKey(memberId, id, chunkIndex);
  return shouldSecureOutboxBodies(Platform.OS)
    ? SecureStore.getItemAsync(key)
    : AsyncStorage.getItem(key);
}

function deleteBodyChunk(memberId: string, id: string, chunkIndex: number): Promise<void> {
  const key = bodyKey(memberId, id, chunkIndex);
  return shouldSecureOutboxBodies(Platform.OS)
    ? SecureStore.deleteItemAsync(key)
    : AsyncStorage.removeItem(key);
}

function isStoredPendingMessage(value: unknown): value is StoredPendingMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && /^[a-zA-Z0-9_-]{12,80}$/.test(candidate.id)
    && typeof candidate.connectionId === 'string'
    && typeof candidate.createdAt === 'string'
    && Number.isInteger(candidate.bodyChunks)
    && Number(candidate.bodyChunks) > 0
    && Number(candidate.bodyChunks) <= 4;
}

function createRequestId(): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `mobile_${Date.now().toString(36)}_${random}`;
}
