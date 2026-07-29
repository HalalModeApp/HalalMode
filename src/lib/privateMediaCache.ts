import { Image } from 'expo-image';

let activeClear: Promise<void> | null = null;

/**
 * Signed profile media can be cached by the native image pipeline. Clear both
 * tiers when the member changes so the next person using this device cannot
 * recover the previous member's viewed photos from the app cache.
 */
export function clearPrivateMediaCache(): Promise<void> {
  if (activeClear) return activeClear;
  activeClear = Promise.all([
    Image.clearMemoryCache(),
    Image.clearDiskCache(),
  ])
    .catch(() => undefined)
    .then(() => undefined)
    .finally(() => {
      activeClear = null;
    });
  return activeClear;
}
