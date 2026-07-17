import React, {useCallback, useEffect, useState} from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {navigationRef} from './navigationRef';
export {navigationRef} from './navigationRef';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {View, StyleSheet} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useAuthStore} from '@store/authStore';
import AuthNavigator from './AuthNavigator';
import MainNavigator from './MainNavigator';
import LoadingView, {type LoadingStep} from '@components/LoadingView';
import PermissionsScreen from '@screens/auth/PermissionsScreen';
import AccessEndedScreen from '@screens/cpo/AccessEndedScreen';
import type {RootStackParamList} from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();
const PERMS_KEY = 'bravo_perms_shown';

// Staged checklists for the two full-screen loaders. Each surface gets text
// specific to what it's actually doing — never a generic "Loading…".
const VERIFY_STEPS: LoadingStep[] = [
  {label: 'Validating credentials',     sub: 'Matching your encrypted key'},
  {label: 'Establishing secure channel', sub: 'TLS 1.3 · end-to-end handshake'},
  {label: 'Restoring secure state',      sub: 'Decrypting your session vault'},
  {label: 'Finalizing access',           sub: 'Bringing up your command surface'},
];

// Mirrors the real signOut() teardown order in authStore.
const SIGNOUT_STEPS: LoadingStep[] = [
  {label: 'Ending secure sessions', sub: 'Closing calls & live channels'},
  {label: 'Revoking device tokens', sub: 'Push & VoIP wake keys'},
  {label: 'Wiping local vault',     sub: 'SQLCipher store & cached keys'},
  {label: 'Clearing session',       sub: 'Returning you to sign in'},
];

export default function RootNavigator() {
  const {isAuthenticated, isLoading, isSigningOut, accessEnded, user} = useAuthStore();
  const [permsShown, setPermsShown] = useState<boolean | null>(null);

  // When the user becomes authenticated, check if we've already shown permissions.
  useEffect(() => {
    if (!isAuthenticated || !user?.role) {
      setPermsShown(null);
      return;
    }
    AsyncStorage.getItem(PERMS_KEY)
      .then(v => setPermsShown(v === '1'))
      .catch(() => setPermsShown(false));
  }, [isAuthenticated, user?.role]);

  const onPermsDone = useCallback(async () => {
    await AsyncStorage.setItem(PERMS_KEY, '1').catch(() => {});
    setPermsShown(true);
  }, []);

  const showAuth  = !isAuthenticated || !user?.role;
  const showPerms = !showAuth && permsShown === false;
  const showMain  = !showAuth && permsShown === true;

  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator screenOptions={{headerShown: false, animation: 'fade'}}>
        {accessEnded ? (
          // §35A §F — highest priority: a revoked CPO sees the access-ended screen
          // (not the login form) even after signOut() has cleared their auth state.
          <Stack.Screen name="AccessEnded" component={AccessEndedScreen} />
        ) : showAuth ? (
          <Stack.Screen name="Auth" component={AuthNavigator} />
        ) : showPerms ? (
          <Stack.Screen name="PermGate">
            {() => <PermissionsScreen onDone={() => { void onPermsDone(); }} />}
          </Stack.Screen>
        ) : showMain ? (
          <Stack.Screen name="Main" component={MainNavigator} />
        ) : (
          // permsShown === null → still loading AsyncStorage; show nothing (overlay covers it)
          <Stack.Screen name="Auth" component={AuthNavigator} />
        )}
      </Stack.Navigator>

      {(isLoading || (isAuthenticated && permsShown === null)) && !isSigningOut && (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <LoadingView fullscreen label="Verifying session…" steps={VERIFY_STEPS} />
        </View>
      )}

      {/* Sign-out teardown: the wrapping View captures touches (no
          pointerEvents="none") so the user can't interact with the dashboard
          while the runtime, push tokens, and at-rest store are being wiped. */}
      {isSigningOut && (
        <View style={StyleSheet.absoluteFill}>
          <LoadingView fullscreen label="Signing out…" steps={SIGNOUT_STEPS} />
        </View>
      )}
    </NavigationContainer>
  );
}
