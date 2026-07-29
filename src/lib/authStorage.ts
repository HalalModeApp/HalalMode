import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { authStoragePlatformFor } from './authStoragePolicy';

type AuthStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

const secureStore: AuthStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};

/**
 * Expo SecureStore uses Keychain on iOS and encrypted storage backed by the
 * Android Keystore. Web has no equivalent Expo primitive, so its session is
 * deliberately isolated to the browser storage adapter.
 */
export const authStorage: AuthStorage =
  authStoragePlatformFor(Platform.OS) === 'web' ? AsyncStorage : secureStore;
