import React, {useEffect, useCallback} from 'react';
import {StatusBar, LogBox} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {StripeProvider} from '@stripe/stripe-react-native';
import * as SplashScreen from 'expo-splash-screen';
import {
  useFonts,
  Manrope_300Light,
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
} from '@expo-google-fonts/manrope';
import RootNavigator from '@navigation/index';
import {useAuthStore} from '@store/authStore';
import BiometricGate from '@components/BiometricGate';
import {BravoAlertHost} from '@components/BravoAlertHost';
import FloatingCallOverlay from '@screens/messenger/FloatingCallOverlay';
import {ErrorBoundary} from '@modules/observability';
import {initI18n} from '@/i18n';

LogBox.ignoreLogs(['Non-serializable values were found in the navigation state']);

void SplashScreen.preventAutoHideAsync();

// Expo only inlines env vars with the EXPO_PUBLIC_ prefix into the client
// bundle. A bare `STRIPE_PUBLISHABLE_KEY` reads as undefined, leaves the
// native SDK uninitialised, and crashes the process the moment
// initPaymentSheet runs.
const STRIPE_KEY = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';

export default function App(): React.JSX.Element | null {
  const {initialize} = useAuthStore();

  const [fontsLoaded, fontError] = useFonts({
    Manrope_300Light,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });

  useEffect(() => {
    // Step 25 — seed i18n from the device locale (a persisted preference overrides it once
    // loaded from /users/me/preferences). Sets the session's RTL direction; a later change
    // in Settings prompts a reload, an RN forceRTL constraint.
    initI18n();
    void initialize();
  }, [initialize]);

  const onLayoutRootView = useCallback(() => {
    if (fontsLoaded || fontError) {
      void SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{flex: 1}} onLayout={onLayoutRootView}>
        <SafeAreaProvider>
          <StripeProvider publishableKey={STRIPE_KEY}>
            {/* Translucent status bar — each screen's own background shows
                through the top strip edge-to-edge (Command Home is #07090D,
                other dark screens fill their own bg). Avoids a hardcoded
                navy band above the near-black dashboard. */}
            <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
            <BiometricGate>
              <RootNavigator />
              {/* Persistent overlay — renders only when there's an active
                  call AND the user has minimized it. Mounted at this
                  level so it survives any navigation inside RootNavigator. */}
              <FloatingCallOverlay />
            </BiometricGate>
            {/* B-88 — global obsidian dialog host backing @utils/alert.
                OUTSIDE BiometricGate so gate-time errors still surface;
                its transparent Modal stacks above any other open Modal. */}
            <BravoAlertHost />
          </StripeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
