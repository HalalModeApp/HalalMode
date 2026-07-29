export type GalleryState = 'ready' | 'empty' | 'unavailable';

export function getGalleryState(introductionFound: boolean, photoCount: number): GalleryState {
  if (!introductionFound) return 'unavailable';
  return photoCount > 0 ? 'ready' : 'empty';
}

export function safeGalleryIndex(index: number, photoCount: number): number {
  if (photoCount < 1) return 0;
  return Math.max(0, Math.min(Math.trunc(index), photoCount - 1));
}
