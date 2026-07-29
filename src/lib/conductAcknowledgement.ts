import AsyncStorage from '@react-native-async-storage/async-storage';

const CONDUCT_VERSION = 'v1';
const ACCEPTED_VALUE = 'accepted';

/** Per-member and versioned so a future material policy update can be shown once. */
export function conductAcknowledgementKey(memberId: string): string {
  return `halal-mode:conduct:${CONDUCT_VERSION}:${encodeURIComponent(memberId)}`;
}

export async function hasAcceptedConduct(memberId: string): Promise<boolean> {
  return (await AsyncStorage.getItem(conductAcknowledgementKey(memberId))) === ACCEPTED_VALUE;
}

export async function acceptConduct(memberId: string): Promise<void> {
  await AsyncStorage.setItem(conductAcknowledgementKey(memberId), ACCEPTED_VALUE);
}
