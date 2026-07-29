import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { requireSupabase, USE_MOCKS } from '@/lib/supabase';

export type NotificationPermissionError = 'unsupported_device' | 'permission_denied' | 'project_unconfigured';

export async function fetchMyNotificationConsent(): Promise<boolean> {
  if (USE_MOCKS) return false;
  const { data, error } = await requireSupabase().rpc('get_my_notification_consent');
  if (error) throw error;
  return data === true;
}

export async function enableMyNotifications(locale: string): Promise<void> {
  if (USE_MOCKS) return;
  if (!Device.isDevice) throw new Error('unsupported_device' satisfies NotificationPermissionError);
  const existing = await Notifications.getPermissionsAsync();
  const permission = existing.status === 'granted'
    ? existing
    : await Notifications.requestPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('permission_denied' satisfies NotificationPermissionError);

  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (!projectId || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(projectId)) {
    throw new Error('project_unconfigured' satisfies NotificationPermissionError);
  }
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  const platform = Platform.OS;
  if (platform !== 'ios' && platform !== 'android') throw new Error('unsupported_device' satisfies NotificationPermissionError);
  const { error } = await requireSupabase().rpc('register_my_notification_device', {
    p_token: token.data,
    p_platform: platform,
    p_locale: locale.split('-')[0],
  });
  if (error) throw error;
}

export async function disableMyNotifications(): Promise<void> {
  if (USE_MOCKS) return;
  const { error } = await requireSupabase().rpc('disable_my_notifications');
  if (error) throw error;
}
