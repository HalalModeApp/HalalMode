import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { requireSupabase } from '@/lib/supabase';

/**
 * Signing in with Google or Apple.
 *
 * There is no session handling here on purpose. Supabase sends the person back
 * to `halalmode://auth?code=...`, and the deep-link listener in `state/auth`
 * already trades that code for a session — the same path the email link has
 * always used. A second place that adopted a session would be a second place
 * that could get it wrong.
 */
export type AuthProvider = 'google' | 'apple';

export const REDIRECT_TO = 'halalmode://auth';

export async function signInWithProvider(provider: AuthProvider): Promise<void> {
  const client = requireSupabase();

  // On the web the browser is already the browser: let Supabase navigate the
  // page, and the code comes back as a normal query parameter.
  if (Platform.OS === 'web') {
    const { error } = await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
    return;
  }

  const { data, error } = await client.auth.signInWithOAuth({
    provider,
    options: { redirectTo: REDIRECT_TO, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data.url) throw new Error('no sign-in url');

  // An auth session rather than a plain browser tab: it closes itself on the
  // redirect and hands the URL straight back, so nobody is left staring at a
  // blank page wondering whether it worked.
  const result = await WebBrowser.openAuthSessionAsync(data.url, REDIRECT_TO);

  if (result.type === 'success' && result.url) {
    const code = new URL(result.url).searchParams.get('code');
    if (code) {
      const exchange = await client.auth.exchangeCodeForSession(code);
      if (exchange.error) throw exchange.error;
    }
  }
}
