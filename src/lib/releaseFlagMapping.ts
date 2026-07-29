import { resolveFeatureFlags, type FeatureFlags } from './featureFlags';

const serverKeyMap = {
  in_chat_voice_notes: 'inChatVoiceNotes',
  live_calling: 'liveCalling',
  push_notifications: 'pushNotifications',
  identity_verification: 'identityVerification',
  premium_purchases: 'premiumPurchases',
  controlled_beta: 'controlledBeta',
} as const;

export function mapServerReleaseFlags(data: unknown): FeatureFlags {
  const raw = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const mapped: Record<string, unknown> = {};
  for (const [serverKey, clientKey] of Object.entries(serverKeyMap)) {
    mapped[clientKey] = raw[serverKey];
  }
  return resolveFeatureFlags(mapped);
}
