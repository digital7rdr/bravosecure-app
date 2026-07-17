import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  Vibration,
  BackHandler,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import * as LocalAuthentication from 'expo-local-authentication';
import {Colors} from '@theme/index';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {useVaultStore} from '@/modules/messenger/vault';

type Nav = NativeStackNavigationProp<MessengerStackParamList, 'VaultLock'>;

const PIN_LENGTH = 6;

const KEYS = [
  [{num: '1', alpha: ''}, {num: '2', alpha: 'ABC'}, {num: '3', alpha: 'DEF'}],
  [{num: '4', alpha: 'GHI'}, {num: '5', alpha: 'JKL'}, {num: '6', alpha: 'MNO'}],
  [{num: '7', alpha: 'PQRS'}, {num: '8', alpha: 'TUV'}, {num: '9', alpha: 'WXYZ'}],
];

/**
 * Vault unlock screen.
 *
 * Flow (matches Signal / WhatsApp vault UX):
 *   1. On mount — if biometric is enabled AND the device has biometric
 *      hardware/enrollment, auto-prompt biometric ONCE.
 *   2. If that succeeds, the vault unlocks and we forward to VaultScreen.
 *   3. If the user cancels / fails / biometric is unavailable, the PIN
 *      pad stays available as a fallback.
 *   4. PIN entry is validated locally against the stored SHA-256 hash
 *      (see `vaultStore.ts`). The PIN never leaves the device; access
 *      to server-side vault data is gated separately by the stateless
 *      HS256 action-token minted by auth-service (see `vaultClient.ts`).
 */
export default function VaultLockScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const verifyPin        = useVaultStore(s => s.verifyPin);
  const unlockWithBio    = useVaultStore(s => s.unlockWithBiometric);
  const biometricEnabled = useVaultStore(s => s.biometricEnabled);

  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [isError, setIsError] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const autoPromptedRef = useRef(false);

  const forwardToVault = useCallback(() => {
    navigation.replace('VaultScreen');
  }, [navigation]);

  // Why: VAULT-24/32 parity — leaving the lock screen must always reset
  // to MessengerHome. The header arrow used plain goBack(), which could
  // pop to a still-mounted unlocked VaultScreen below; hardware back
  // already resets (see the back-button audit fix below).
  const exitToHome = useCallback(() => {
    navigation.reset({index: 0, routes: [{name: 'MessengerHome'}]});
  }, [navigation]);

  const tryBiometric = useCallback(async () => {
    try {
      const [hasHw, hasCreds] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      if (!hasHw || !hasCreds) {
        setBioAvailable(false);
        return;
      }
      setBioAvailable(true);
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage:         'Unlock Bravo Vault',
        fallbackLabel:         'Use PIN',
        cancelLabel:           'Cancel',
        disableDeviceFallback: false,
      });
      if (res.success) {
        unlockWithBio();
        forwardToVault();
      }
    } catch {
      // Fall through to the PIN keypad silently — UX preserves entry.
    }
  }, [unlockWithBio, forwardToVault]);

  // Round 7 / back-button audit fix #4 — trap the Android hardware back
  // button so it CANNOT bypass the lock. Previously, hardware back
  // simply popped this screen and revealed whatever was below it; if
  // VaultScreen was kept warm in the stack (freezeOnBlur), the user
  // could see the unlocked vault contents without unlocking. Route
  // back to MessengerHome instead — match the WhatsApp chat-lock
  // pattern where back exits to the chat list, not to the secret view.
  useFocusEffect(
    useCallback(() => {
      const onBack = () => {
        exitToHome();
        return true;
      };
      const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
      return () => sub.remove();
    }, [exitToHome]),
  );

  // Auto-prompt biometric once per mount when enabled. Mirrors the
  // "instant unlock" behaviour of WhatsApp / Signal's chat lock.
  useEffect(() => {
    if (autoPromptedRef.current) {return;}
    autoPromptedRef.current = true;
    if (biometricEnabled) {
      void tryBiometric();
    } else {
      void (async () => {
        const [hasHw, hasCreds] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
        ]);
        setBioAvailable(hasHw && hasCreds);
      })();
    }
  }, [biometricEnabled, tryBiometric]);

  const press = (digit: string) => {
    if (pin.length >= PIN_LENGTH) {return;}
    Vibration.vibrate(8); // crisp tap — mirrors the Bravo chat send haptic
    const next = pin + digit;
    setPin(next);
    setError('');
    setIsError(false);
    if (next.length === PIN_LENGTH) {
      // Schedule the verify after the paint so the 6th dot fills before
      // we either forward or flash red. The setTimeout callback is
      // intentionally non-async; we kick the async work off via a void
      // IIFE so the setTimeout signature stays Promise-free (lint rule
      // @typescript-eslint/no-misused-promises).
      setTimeout(() => {
        void (async () => {
          // Audit fix #34/#35 — verifyPin is now async and returns a
          // discriminated union so we can surface lockout state to the
          // user. We only branch on `ok` here; the screen could later
          // render the remaining-attempts / msUntilRetry counts to
          // match WhatsApp's lockout UX.
          const result = await verifyPin(next);
          if (result.ok) {
            forwardToVault();
            setPin('');
          } else {
            Vibration.vibrate(50);
            setIsError(true);
            if (result.reason === 'lockout') {
              const sec = Math.ceil(result.msUntilRetry / 1000);
              setError(`Too many attempts. Try again in ${sec}s.`);
            } else {
              setError('Incorrect PIN. Try again.');
            }
            setTimeout(() => {
              setPin('');
              setIsError(false);
            }, 600);
          }
        })();
      }, 80);
    }
  };

  const backspace = () => {
    Vibration.vibrate(6);
    setPin(prev => prev.slice(0, -1));
    setError('');
    setIsError(false);
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={exitToHome} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="#B8C7E0" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>SECURE VAULT</Text>
        <View style={{width: 36}} />
      </View>

      {/* Lock icon + title */}
      <View style={styles.lockSection}>
        <View style={styles.lockIcon}>
          <Icon name="lock" size={24} color="#1E88FF" />
        </View>
        <Text style={styles.lockTitle}>Enter Vault PIN</Text>
        <Text style={styles.lockSub}>
          {biometricEnabled && bioAvailable
            ? 'Use biometric or enter your 6-digit PIN'
            : 'Enter your 6-digit security code'}
        </Text>
      </View>

      {/* PIN dots */}
      <View style={styles.dotsRow}>
        {Array.from({length: PIN_LENGTH}).map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              i < pin.length && styles.dotFilled,
              isError && i < pin.length && styles.dotError,
            ]}
          />
        ))}
      </View>

      {/* Error */}
      <Text style={styles.errorText}>{error}</Text>

      {/* Keypad */}
      <View style={styles.keypad}>
        {KEYS.map((row, ri) => (
          <View key={ri} style={styles.keyRow}>
            {row.map(k => (
              <TouchableOpacity
                key={k.num}
                style={styles.keyBtn}
                onPress={() => press(k.num)}
                activeOpacity={0.7}>
                <Text style={styles.keyNum}>{k.num}</Text>
                {k.alpha ? <Text style={styles.keyAlpha}>{k.alpha}</Text> : null}
              </TouchableOpacity>
            ))}
          </View>
        ))}
        <View style={styles.keyRow}>
          <TouchableOpacity
            style={[styles.keyBtn, !bioAvailable && {opacity: 0.35}]}
            activeOpacity={0.7}
            disabled={!bioAvailable}
            onPress={() => { void tryBiometric(); }}>
            <Icon name="fingerprint" size={24} color={bioAvailable ? '#1E88FF' : '#244C82'} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.keyBtn} onPress={() => press('0')} activeOpacity={0.7}>
            <Text style={styles.keyNum}>0</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.keyBtn} onPress={backspace} activeOpacity={0.7}>
            <Icon name="backspace-outline" size={22} color="#B8C7E0" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Forgot PIN */}
      <TouchableOpacity
        style={styles.forgotBtn}
        activeOpacity={0.7}
        onPress={() => navigation.navigate('VaultForgot')}>
        <Text style={styles.forgotText}>Forgot PIN?</Text>
      </TouchableOpacity>

      <View style={styles.spacer} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(30,136,255,0.1)'},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontSize: 12, fontWeight: '700', color: '#B8C7E0', letterSpacing: 3, textTransform: 'uppercase'},

  lockSection: {alignItems: 'center', paddingTop: 24, paddingBottom: 16},
  lockIcon: {width: 48, height: 48, borderRadius: 16, backgroundColor: 'rgba(30,136,255,0.12)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.2)', alignItems: 'center', justifyContent: 'center', marginBottom: 8},
  lockTitle: {fontSize: 16, fontWeight: '800', color: '#B8C7E0', marginBottom: 4},
  lockSub: {fontSize: 11, color: '#7E8AA6', textAlign: 'center', paddingHorizontal: 32},

  dotsRow: {flexDirection: 'row', justifyContent: 'center', gap: 16, marginBottom: 8},
  dot: {width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: '#1C3B66', backgroundColor: 'transparent'},
  dotFilled: {backgroundColor: Colors.primary, borderColor: Colors.primary},
  dotError: {backgroundColor: '#D50000', borderColor: '#D50000'},

  errorText: {fontSize: 11, color: '#f87171', fontWeight: '600', textAlign: 'center', height: 16, marginBottom: 8},

  keypad: {alignItems: 'center', gap: 8, paddingHorizontal: 24},
  keyRow: {flexDirection: 'row', gap: 20},
  keyBtn: {width: 58, height: 58, borderRadius: 29, backgroundColor: 'rgba(30,136,255,0.08)', borderWidth: 1, borderColor: '#1C3B66', alignItems: 'center', justifyContent: 'center'},
  keyNum: {fontSize: 19, fontWeight: '700', color: '#FFFFFF', lineHeight: 22},
  keyAlpha: {fontSize: 7, fontWeight: '600', color: '#7E8AA6', letterSpacing: 1.5, marginTop: 1},

  forgotBtn: {alignItems: 'center', marginTop: 12},
  forgotText: {fontSize: 12, color: '#7E8AA6', fontWeight: '500'},
  spacer: {flex: 1},
});
