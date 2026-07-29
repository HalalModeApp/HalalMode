/**
 * A gallery may contain full-resolution private photos. Keep only the active
 * page and its immediate neighbours mounted, while preserving enough overlap
 * for a natural page swipe.
 */
export const galleryListPerformancePolicy = {
  initialNumToRender: 1,
  maxToRenderPerBatch: 2,
  windowSize: 3,
  removeClippedSubviews: true,
} as const;

/** Expo Image keeps private gallery images on disk, not indefinitely in RAM. */
export const galleryImagePerformancePolicy = {
  cachePolicy: 'disk' as const,
  allowDownscaling: true,
  enforceEarlyResizing: true,
} as const;

/** Forces a fresh native image request after a signed URL or network failure. */
export function galleryRetryKey(source: string, attempt: number): string {
  return `${source}:${attempt}`;
}
