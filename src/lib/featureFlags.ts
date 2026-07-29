/**
 * High-risk capabilities default to off. Remote delivery may override only
 * known boolean flags after a server-authorised configuration source exists.
 */
export const defaultFeatureFlags = {
  inChatVoiceNotes: false,
  liveCalling: false,
  pushNotifications: false,
  identityVerification: false,
  premiumPurchases: false,
  controlledBeta: false,
} as const;

export type FeatureFlag = keyof typeof defaultFeatureFlags;
export type FeatureFlags = Record<FeatureFlag, boolean>;

export function resolveFeatureFlags(value: unknown): FeatureFlags {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...defaultFeatureFlags };
  }

  const candidate = value as Record<string, unknown>;
  const resolved = { ...defaultFeatureFlags } as FeatureFlags;
  for (const key of Object.keys(defaultFeatureFlags) as FeatureFlag[]) {
    if (typeof candidate[key] === 'boolean') resolved[key] = candidate[key];
  }
  return resolved;
}
