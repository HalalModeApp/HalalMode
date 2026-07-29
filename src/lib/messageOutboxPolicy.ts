/**
 * SecureStore is backed by the device keychain/keystore on native platforms.
 * Browsers do not have an equivalent Expo primitive, so the web client keeps
 * its durable retry data inside its origin-scoped storage instead.
 */
export function shouldSecureOutboxBodies(platform: string): boolean {
  return platform !== 'web';
}

/**
 * iOS SecureStore values are intentionally kept well below its small-value
 * limit. 512 Unicode code points are at most 2 KiB in UTF-8.
 */
export const OUTBOX_BODY_CHUNK_SIZE = 512;

export function splitOutboxBody(body: string): string[] {
  const characters = Array.from(body);
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += OUTBOX_BODY_CHUNK_SIZE) {
    chunks.push(characters.slice(index, index + OUTBOX_BODY_CHUNK_SIZE).join(''));
  }
  return chunks;
}

export function joinOutboxBody(chunks: readonly string[]): string | null {
  if (!chunks.length || chunks.some((chunk) => typeof chunk !== 'string' || !chunk.length)) return null;
  return chunks.join('');
}
