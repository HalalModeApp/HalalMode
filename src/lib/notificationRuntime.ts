/**
 * Expo Go deliberately excludes Android remote-push support. Keep the runtime
 * decision separate from the feature flag so merely rendering Settings never
 * imports an unavailable native module.
 */
export function supportsRemotePushRuntime(
  platform: string,
  executionEnvironment: string | null | undefined
): boolean {
  return (platform === 'ios' || platform === 'android')
    && executionEnvironment !== 'storeClient';
}
