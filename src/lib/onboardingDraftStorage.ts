import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { isOnboardingDraftCurrent, onboardingDraftExpiresAt } from '@/lib/onboardingDraftPolicy';

type StoredOnboardingDraft = { step: number; draft: unknown; expiresAt: number };

export function onboardingDraftStorageKey(memberId: string): string {
  return `halalmode.onboarding.v3.${memberId}`;
}

export function legacyOnboardingDraftStorageKey(memberId: string): string {
  return `halalmode.onboarding.v2.${memberId}`;
}

export function clearLegacyOnboardingDraft(memberId: string): Promise<void> {
  return AsyncStorage.removeItem(legacyOnboardingDraftStorageKey(memberId));
}

/** Native drafts are encrypted by the operating system. Web retains the scoped fallback. */
function readDraft(key: string): Promise<string | null> {
  return Platform.OS === 'web'
    ? AsyncStorage.getItem(key)
    : SecureStore.getItemAsync(key);
}

function writeDraft(key: string, value: string): Promise<void> {
  return Platform.OS === 'web'
    ? AsyncStorage.setItem(key, value)
    : SecureStore.setItemAsync(key, value);
}

function removeDraft(key: string): Promise<void> {
  return Platform.OS === 'web'
    ? AsyncStorage.removeItem(key)
    : SecureStore.deleteItemAsync(key);
}

export async function loadOnboardingDraft(memberId: string): Promise<StoredOnboardingDraft | null> {
  const key = onboardingDraftStorageKey(memberId);
  const raw = await readDraft(key);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<StoredOnboardingDraft>;
    if (
      typeof stored.step !== 'number' ||
      !stored.draft ||
      !isOnboardingDraftCurrent(stored.expiresAt)
    ) {
      await removeDraft(key);
      return null;
    }
    return stored as StoredOnboardingDraft;
  } catch {
    await removeDraft(key);
    return null;
  }
}

export function saveOnboardingDraft(memberId: string, step: number, draft: unknown): Promise<void> {
  return writeDraft(
    onboardingDraftStorageKey(memberId),
    JSON.stringify({ step, draft, expiresAt: onboardingDraftExpiresAt() })
  );
}

/** Removes both the secure current draft and the former plaintext v2 draft. */
export async function clearOnboardingDraft(memberId: string): Promise<void> {
  await Promise.all([
    removeDraft(onboardingDraftStorageKey(memberId)),
    clearLegacyOnboardingDraft(memberId),
  ]);
}
