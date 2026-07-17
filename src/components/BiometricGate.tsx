import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  AppState,
  InteractionManager,
  type AppStateStatus,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useVaultStore} from '@/modules/messenger/vault';

type Status = 'checking' | 'prompting' | 'authed' | 'failed' | 'unsupported';

// Opt-in flag set by Settings → Biometric Lock (ProfileScreen). The gate only
// engages when this is '1'; it is OFF by default.
const LOCK_KEY = 'settings:biometricLock';

// BS-LOCK — how long the app can be backgrounded before we force a
// re-lock on return. Short app-switches (checking a code in another app,
// an OS permission dialog, bouncing between dashboards) fall under this
// window and DON'T re-prompt; a real exit / long background does.
const LOCK_GRACE_MS = 30_000;

interface Props {
  children: React.ReactNode;
}

/**
 * Gates the app behind device biometrics (fingerprint / face) with a
 * PIN/pattern fallback via `disableDeviceFallback: false`. The gate re-locks
 * when the app returns to foreground.
 */
export default function BiometricGate({children}: Props) {
  const [status, setStatus] = useState<Status>('checking');
  // Tracks whether the user has EVER successfully unlocked in this session.
  // After the first unlock we keep `children` mounted and only overlay the
  // lock UI on re-lock, so the navigation tree (and its state) survives
  // every AppState background↔active cycle.
  const [everUnlocked, setEverUnlocked] = useState(false);
  // null = still reading the opt-in flag, false = lock off (no gate), true = on.
  const [lockEnabled, setLockEnabled] = useState<boolean | null>(null);
  // Guard: prevents concurrent authenticate() calls (AppState 'active' fires
  // on Android launch, racing with the mount effect; biometric dialog going
  // bg→active would also trigger a second call while the first is pending).
  const authenticating = useRef(false);
  // Wall-clock when the app last went to background — drives the grace
  // window so a quick switch-and-return doesn't re-lock. Null = foreground.
  const backgroundedAt = useRef<number | null>(null);

  const authenticate = useCallback(async () => {
    if (authenticating.current) {return;}
    authenticating.current = true;
    setStatus('prompting');
    try {
      // Run both checks in parallel to shave ~50–100 ms off the cold path.
      const [hasHw, hasCreds] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      if (!hasHw || !hasCreds) {
        // Device has no biometric hardware OR no fingerprint/face/PIN set up.
        // Let the user in so they aren't locked out of an unconfigured device.
        setStatus('unsupported');
        setEverUnlocked(true);
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Bravo Secure',
        fallbackLabel: 'Use device PIN',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });
      if (result.success) {
        setStatus('authed');
        setEverUnlocked(true);
      } else {
        setStatus('failed');
      }
    } catch {
      setStatus('failed');
    } finally {
      authenticating.current = false;
    }
  }, []);

  // Read the opt-in flag once on mount. Biometric Lock is OFF by default —
  // the gate only engages when the user enabled it in Settings.
  useEffect(() => {
    void (async () => {
      const v = await AsyncStorage.getItem(LOCK_KEY).catch(() => null);
      setLockEnabled(v === '1');
    })();
  }, []);

  // Defer the initial prompt until after the first frame paints (so the
  // LockView renders smoothly before the native biometric dialog appears) —
  // but only once we know the lock is actually enabled.
  useEffect(() => {
    if (lockEnabled !== true) {return;}
    const task = InteractionManager.runAfterInteractions(() => { void authenticate(); });
    return () => task.cancel();
  }, [lockEnabled, authenticate]);

  // Re-lock on return from background — but only after a GRACE WINDOW.
  // BS-LOCK — QA: the password/biometric prompt should fire on app start
  // and after a real exit, NOT on every quick app-switch or when bouncing
  // between dashboards (which can briefly background the app via a native
  // dialog / OS chrome). Re-locking on every background blip forced a
  // re-prompt constantly. Fix: stamp the time we backgrounded; on return,
  // only re-lock if we were away longer than LOCK_GRACE_MS. A quick
  // round-trip stays unlocked (WhatsApp/banking-app behaviour); a genuine
  // exit (or a long background) still re-prompts.
  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        backgroundedAt.current = Date.now();
        return;
      }
      if (next === 'active') {
        const awayMs = backgroundedAt.current ? Date.now() - backgroundedAt.current : 0;
        backgroundedAt.current = null;
        // Within the grace window → treat as a quick switch; stay unlocked.
        if (awayMs > 0 && awayMs < LOCK_GRACE_MS) {return;}
        // Re-read the opt-in flag so enabling/disabling Biometric Lock in
        // Settings takes effect on the next foreground. Only re-lock when on.
        void (async () => {
          const v = await AsyncStorage.getItem(LOCK_KEY).catch(() => null);
          const enabled = v === '1';
          setLockEnabled(enabled);
          if (!enabled) {return;}
          useVaultStore.getState().lock();
          setStatus('checking');
          void authenticate();
        })();
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [status, authenticate]);

  const unlocked = status === 'authed' || status === 'unsupported';
  const showLock = !unlocked;

  // Lock OFF (default) → no gate at all.
  if (lockEnabled === false) {return <>{children}</>;}
  // Still reading the flag → neutral dark splash for the ~instant it takes,
  // so app content never flashes before a (possibly enabled) lock engages.
  if (lockEnabled === null) {return <View style={s.root} />;}

  // First boot — no children yet; full-screen lock until first unlock.
  if (!everUnlocked) {
    return <LockView status={status} onRetry={() => void authenticate()} />;
  }

  // After first unlock — keep children mounted; overlay lock when re-locked.
  return (
    <View style={{flex: 1}}>
      {children}
      {showLock && (
        <View style={[StyleSheet.absoluteFillObject, {zIndex: 1000}]}>
          <LockView status={status} onRetry={() => void authenticate()} />
        </View>
      )}
    </View>
  );
}

function LockView({status, onRetry}: {status: Status; onRetry: () => void}) {
  return (
    <View style={s.root}>
      <View style={s.logoBox}>
        <Icon name="shield-lock" size={52} color={PRIMARY} />
      </View>
      <Text style={s.title}>Bravo Secure</Text>
      <Text style={s.subtitle}>
        {status === 'failed'
          ? 'Authentication cancelled or failed.'
          : 'Verifying identity…'}
      </Text>

      {status === 'prompting' || status === 'checking' ? (
        <ActivityIndicator color={PRIMARY} style={{marginTop: 28}} />
      ) : (
        <TouchableOpacity style={s.retryBtn} activeOpacity={0.85} onPress={onRetry}>
          <Icon name="fingerprint" size={18} color="#fff" style={{marginRight: 8}} />
          <Text style={s.retryText}>UNLOCK</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const PRIMARY = '#2563EB';
const BG      = '#0A0F1E';

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: BG,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  logoBox: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: 'rgba(37,99,235,0.12)',
    borderWidth: 1, borderColor: 'rgba(37,99,235,0.35)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 28,
  },
  title: {
    fontSize: 24, fontWeight: '800',
    color: '#f1f5f9',
    letterSpacing: -0.3,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#94a3b8',
    textAlign: 'center',
    lineHeight: 20,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center',
    marginTop: 36,
    height: 52,
    paddingHorizontal: 28,
    backgroundColor: PRIMARY,
    borderRadius: 12,
    shadowColor: PRIMARY,
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: {width: 0, height: 4},
    elevation: 6,
  },
  retryText: {
    color: '#fff',
    fontSize: 14, fontWeight: '800',
    letterSpacing: 1.5,
  },
});
