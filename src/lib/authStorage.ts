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
 * Nothing is stored while a page is being rendered on the server.
 *
 * Expo Router server-renders web routes in Node, and the Supabase client is
 * built at module scope, so its storage adapter runs during that render — where
 * AsyncStorage reaches straight for `window.localStorage` and throws, taking
 * the whole render with it. Returning "nothing stored" is the truthful answer
 * rather than a workaround: a server render has no member session, and the
 * browser re-reads real storage the moment it hydrates.
 */
const noStorage: AuthStorage = {
  getItem: async () => null,
  setItem: async () => {},
  removeItem: async () => {},
};

/**
 * Expo SecureStore uses Keychain on iOS and encrypted storage backed by the
 * Android Keystore. Web has no equivalent Expo primitive, so its session is
 * deliberately isolated to the browser storage adapter.
 */
export const authStorage: AuthStorage =
  authStoragePlatformFor(Platform.OS) === 'web'
    ? (typeof window === 'undefined' ? noStorage : AsyncStorage)
    : secureStore;
