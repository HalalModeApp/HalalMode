export type AuthStoragePlatform = 'native' | 'web';

/**
 * Refresh tokens are bearer credentials. Native clients must keep them in the
 * OS-backed secure store; the browser fallback exists solely for Expo web.
 */
export function authStoragePlatformFor(os: string): AuthStoragePlatform {
  return os === 'web' ? 'web' : 'native';
}
