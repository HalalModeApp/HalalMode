import {
  Beiruti_400Regular,
  Beiruti_500Medium,
  Beiruti_600SemiBold,
  Beiruti_700Bold,
} from '@expo-google-fonts/beiruti';
import {
  PlayfairDisplay_400Regular,
  PlayfairDisplay_400Regular_Italic,
} from '@expo-google-fonts/playfair-display';
import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { queryClient } from '@/lib/queryClient';
import { AuthGate, AuthProvider } from '@/state/auth';
import { RoundProvider } from '@/state/round';
import { SessionProvider } from '@/state/session';
import { color } from '@/theme/tokens';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    PlayfairDisplay_400Regular,
    PlayfairDisplay_400Regular_Italic,
    Beiruti_400Regular,
    Beiruti_500Medium,
    Beiruti_600SemiBold,
    Beiruti_700Bold,
  });

  useEffect(() => {
    // Hide on error too — a missing webfont should degrade, not deadlock launch.
    if (fontsLoaded || fontError) void SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <AuthGate>
              <SessionProvider>
                <RoundProvider>
                  <StatusBar style="dark" />
                  <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: color.surface },
                  animation: 'fade',
                }}
              >
                    <Stack.Screen name="auth" />
                    <Stack.Screen name="onboarding" />
                    <Stack.Screen name="(tabs)" />
                <Stack.Screen
                  name="introduction/[id]"
                  options={{ animation: 'slide_from_right' }}
                />
                <Stack.Screen
                  name="match/[id]"
                  options={{ animation: 'fade', gestureEnabled: false }}
                />
                <Stack.Screen name="connection/[id]" />
                <Stack.Screen
                  name="gallery/[id]"
                  options={{ presentation: 'transparentModal', animation: 'fade' }}
                />
                  </Stack>
                </RoundProvider>
              </SessionProvider>
            </AuthGate>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
