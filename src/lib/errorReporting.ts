import { Platform } from 'react-native';
import Constants from 'expo-constants';

import { supabase, USE_MOCKS } from '@/lib/supabase';

/**
 * Tells the server when something broke, so a fault is visible to somebody.
 *
 * A crash for a member abroad at 2am currently leaves no trace: they see a
 * broken screen, close the app, and nobody ever learns why. This is the
 * smallest thing that fixes that — no third-party service, no extra key
 * shipped to the client, and no other company holding data about Muslim people
 * looking for a spouse.
 *
 * Only what is needed to locate a fault: the error's message, the screen, the
 * platform and the app version. Never message text, profile fields, names,
 * coordinates, or who the member was looking at. If it would identify a person
 * or reveal what they were reading, it does not belong here.
 */

/** Never let reporting a failure become a second failure for the member. */
function safely(work: () => Promise<unknown>): void {
  try {
    void work().catch(() => {});
  } catch {
    // Nothing. A member whose screen already broke must not get a second
    // error because telling us about the first one did not work.
  }
}

function appVersion(): string | undefined {
  const version = Constants.expoConfig?.version;
  return typeof version === 'string' ? version : undefined;
}

/**
 * The message only. An Error's stack carries file paths and sometimes
 * interpolated values, so it is deliberately dropped rather than trimmed.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

export function reportError(error: unknown, screen?: string): void {
  if (USE_MOCKS || !supabase) return;

  const platform = Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web'
    ? Platform.OS
    : undefined;

  const client = supabase;
  safely(async () => client.rpc('report_client_error', {
    p_message: messageOf(error).slice(0, 500),
    p_screen: screen ?? null,
    p_platform: platform ?? null,
    p_app_version: appVersion() ?? null,
  }));

}

/**
 * Catches what never reaches a component: a rejected promise nobody awaited,
 * and on native the errors that would otherwise only reach a red screen.
 *
 * Installed once at startup. Safe to call again — the handler replaces itself
 * rather than stacking.
 */
let installed = false;

export function installErrorReporting(): void {
  if (installed || USE_MOCKS) return;
  installed = true;

  // Unhandled promise rejections. The web and native runtimes disagree about
  // the event's shape, so both are read defensively.
  const globalScope = globalThis as unknown as {
    addEventListener?: (type: string, handler: (event: unknown) => void) => void;
    ErrorUtils?: {
      getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
      setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
    };
  };

  globalScope.addEventListener?.('unhandledrejection', (event: unknown) => {
    const reason = (event as { reason?: unknown } | undefined)?.reason;
    reportError(reason ?? 'Unhandled promise rejection', 'unhandled');
  });

  globalScope.addEventListener?.('error', (event: unknown) => {
    const error = (event as { error?: unknown } | undefined)?.error;
    reportError(error ?? 'Uncaught error', 'uncaught');
  });

  // React Native routes fatal errors through ErrorUtils. The existing handler
  // is kept and called after reporting, so the red screen and crash behaviour
  // in development are unchanged.
  const previous = globalScope.ErrorUtils?.getGlobalHandler?.();
  globalScope.ErrorUtils?.setGlobalHandler?.((error: unknown, isFatal?: boolean) => {
    reportError(error, isFatal ? 'fatal' : 'uncaught');
    previous?.(error, isFatal);
  });
}
