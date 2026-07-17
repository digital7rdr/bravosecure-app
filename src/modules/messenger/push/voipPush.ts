/**
 * iOS PushKit token registration — SKELETON.
 *
 * Mirrors fcmBootstrap.ts but for iOS PushKit (which uses a SEPARATE
 * token type from regular APNs — different cert, different topic
 * suffix `.voip`, different delivery semantics).
 *
 * Why a separate file:
 *   - PushKit needs `@react-native-voip-push-notification` (or the equivalent
 *     PKPushRegistry hook inside react-native-callkeep). The existing
 *     fcmBootstrap is firebase/FCM-only — mixing PushKit there would
 *     entangle two unrelated token lifecycles.
 *   - The iOS path posts the PushKit token to the SAME server endpoint
 *     `/push/register-voip` with `platform: 'ios'`. Server's push.service
 *     keys VoIP tokens by platform so iOS lands in the APNs-VoIP code
 *     path, Android in the FCM-high-priority path. The server side of
 *     this is already covered today (push.controller validates platform).
 *
 * Status: skeleton. Stays inert until:
 *   - Apple VoIP Services Certificate (issued via developer.apple.com — manual)
 *   - `react-native-voip-push-notification` (or callkeep's PKPushRegistry hook)
 *     installed + autolinked
 *   - Server APNs HTTP/2 sender deployed with APNS_VOIP_* env vars
 *
 * The whole module is a no-op on Android (Android uses fcmBootstrap.ts —
 * no PushKit equivalent). On iOS today it logs and returns; once the
 * native module is installed it acquires the PushKit token, POSTs to
 * /push/register-voip, and persists the per-device wake key (same
 * keychain location voipWakeVerify reads from — so HMAC verification
 * keeps working for iOS the moment the server starts signing iOS wakes).
 */
import {Platform} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {MSG_BASE_URL} from '@utils/constants';

/**
 * Master kill-switch. Mirror of callKitBridge's RUNTIME_ENABLED — they
 * MUST flip together (a CallKit display-call without PushKit token
 * registration cannot fire; PushKit token without CallKit display-call
 * = guaranteed entitlement revocation).
 */
const RUNTIME_ENABLED = false;

let started = false;
let unsubTokenRefresh: (() => void) | null = null;

/**
 * Call once after the user authenticates (alongside startFcmBootstrap).
 * Idempotent. Does nothing on Android — Android stays on the FCM-data
 * VoIP path that already works.
 */
export async function startVoipPushBootstrap(): Promise<void> {
  if (Platform.OS !== 'ios') {
    // Android: FCM-data path covers VoIP wakes (see fcmBootstrap.ts).
    return;
  }
  if (started) {
    console.log('[voip-push] bootstrap skip — already started');
    return;
  }
  started = true;

  if (!RUNTIME_ENABLED) {
    console.log('[voip-push] iOS skeleton — bootstrap is a no-op until VoIP cert + PushKit module land');
    return;
  }

  const pushKit = getPushKit();
  if (!pushKit) {
    console.warn('[voip-push] iOS PushKit module not available — skeleton stays inert');
    return;
  }

  try {
    await pushKit.requestPermissions();
  } catch (e) {
    console.warn('[voip-push] requestPermissions failed:', (e as Error).message);
  }

  // Existing PushKit token (cached on first launch by the OS once registered).
  try {
    const token = await pushKit.getToken();
    if (token) {
      console.log('[voip-push] getToken ok, len =', token.length);
      await registerVoipPushToken(token).catch(e =>
        console.warn('[voip-push] register failed:', (e as Error).message));
    } else {
      console.log('[voip-push] no token yet — will arrive via onRegister');
    }
  } catch (e) {
    console.warn('[voip-push] getToken failed:', (e as Error).message);
  }

  // Token-rotation listener. Apple rotates VoIP tokens on app reinstall,
  // device restore, sandbox/production cert switch. Without this the
  // server's stored token goes stale on the next reinstall.
  unsubTokenRefresh?.();
  unsubTokenRefresh = pushKit.addEventListener('register', (token) => {
    console.log('[voip-push] onRegister, len =', token.length);
    void registerVoipPushToken(token).catch(e =>
      console.warn('[voip-push] re-register failed:', (e as Error).message));
  });

  // Inbound notification listener. iOS 13+: every push MUST report a
  // CallKit incoming call within ~5s, so this handler MUST call
  // callKitBridge.reportIncomingCall synchronously BEFORE any await.
  pushKit.addEventListener('notification', (notif) => {
    console.log('[voip-push] notification received:', notif?.callId ?? '(no callId)');
    handleInboundVoipPush(notif);
  });

  console.log('[voip-push] iOS bootstrap complete');
}

/**
 * Inbound PushKit handler. Apple's contract:
 *   - Must report a CXCallUpdate to CXProvider within ~5 seconds.
 *   - Miss it once → entitlement revoked, app pulled from store.
 *
 * So the order is non-negotiable:
 *   1. SYNCHRONOUSLY call callKitBridge.reportIncomingCall (skeleton
 *      no-op today — but the wiring stays in place).
 *   2. THEN run HMAC verification.
 *   3. If verification fails, immediately reportEnded(callId, 'failed')
 *      so CallKit dismisses the (briefly displayed) ring. The user sees
 *      a quick flash of CallKit UI in the worst case — far better than
 *      losing the entitlement.
 */
function handleInboundVoipPush(notif: VoipPushNotification): void {
  if (!notif || typeof notif.callId !== 'string') {
    console.warn('[voip-push] inbound notif missing callId — cannot report to CallKit');
    return;
  }

  // Step 1 — fire the CallKit display-call FIRST. Skeleton no-ops; real
  // implementation is fully wired the day RUNTIME_ENABLED flips.

  const {reportIncomingCall} = require('./callKitBridge') as typeof import('./callKitBridge');
  reportIncomingCall({
    callId:     notif.callId,
    callerName: notif.callerName ?? 'Bravo contact',
    kind:       notif.callKind === 'video' ? 'video' : 'voice',
  });

  // Step 2 — verify the HMAC sig + nonce window. Same path Android uses.
  // If verification rejects, Step 3 fires reportEnded so the system UI
  // dismisses without ringing the user.
  void verifyAndDispatch(notif);
}

async function verifyAndDispatch(notif: VoipPushNotification): Promise<void> {
  try {

    const {verifyVoipWake} = require('./voipWakeVerify') as typeof import('./voipWakeVerify');

    const {useAuthStore} = require('@/store/authStore') as typeof import('@/store/authStore');
    const selfUserId = useAuthStore.getState().user?.id ?? '';
    const verdict = await verifyVoipWake({
      selfUserId,
      fields: {
        kind:     'voip-wake',
        callId:   notif.callId,
        callKind: notif.callKind ?? 'voice',
        nonce:    notif.nonce,
        exp:      typeof notif.exp === 'string' ? Number(notif.exp) : notif.exp,
        sig:      notif.sig,
      },
    });
    if (!verdict.ok) {
      console.warn(`[voip-push] DROPPED reason=${verdict.reason} call=${notif.callId}`);

      const {reportEnded} = require('./callKitBridge') as typeof import('./callKitBridge');
      reportEnded(notif.callId, 'failed');
      return;
    }
    // Verification passed — the inbound-call dispatcher (callDispatcher.ts)
    // will deliver the actual `call.offer` over WebSocket as usual; our
    // job here was just to wake the device + display CallKit UI in time.
    // No further action needed at the bridge layer.
  } catch (e) {
    console.warn('[voip-push] verify+dispatch failed:', (e as Error).message);
  }
}

async function registerVoipPushToken(token: string): Promise<void> {
  const access = await AsyncStorage.getItem('auth:access_token');
  if (!access) {
    console.log('[voip-push] no JWT yet — will retry on next bootstrap');
    return;
  }
  const headers: Record<string, string> = {
    'Content-Type':       'application/json',
    'Authorization':      `Bearer ${access}`,
    'X-Signal-Device-Id': '1',
  };
  const res = await fetch(`${MSG_BASE_URL}/push/register-voip`, {
    method:  'POST',
    headers,
    body:    JSON.stringify({platform: 'ios', token}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`register-voip ${res.status}: ${body.slice(0, 120)}`);
  }
  const json = await res.json().catch(() => null) as {wakeKeyB64?: string} | null;
  if (json && typeof json.wakeKeyB64 === 'string') {
    try {

      const {storeVoipWakeKey} = require('./voipWakeVerify') as typeof import('./voipWakeVerify');

      const {useAuthStore} = require('@/store/authStore') as typeof import('@/store/authStore');
      const userId = useAuthStore.getState().user?.id ?? '';
      if (userId) {
        await storeVoipWakeKey(userId, '1', json.wakeKeyB64);
        console.log('[voip-push] wake key stored');
      }
    } catch (e) {
      console.warn('[voip-push] wake key persist failed:', (e as Error).message);
    }
  }
  console.log('[voip-push] iOS PushKit token registered, len =', token.length);
}

export function stopVoipPushBootstrap(): void {
  unsubTokenRefresh?.();
  unsubTokenRefresh = null;
  started = false;
}

// ── Native-module shim ────────────────────────────────────────────────
// Lazy require so a dev build without the native module doesn't crash
// on import. Returns null when unavailable.

interface VoipPushNotification {
  callId:     string;
  callerName?: string;
  callKind?:   string;
  nonce?:      string;
  exp?:        number | string;
  sig?:        string;
}

interface PushKitLike {
  requestPermissions: () => Promise<void>;
  getToken:           () => Promise<string | null>;
  addEventListener:   ((type: 'register',     handler: (token: string) => void) => () => void)
                    & ((type: 'notification', handler: (notif: VoipPushNotification) => void) => () => void);
}

function getPushKit(): PushKitLike | null {
  if (!RUNTIME_ENABLED) {return null;}
  try {

    const mod = require('react-native-voip-push-notification') as {default?: PushKitLike} | PushKitLike;
    return ('default' in mod && mod.default ? mod.default : mod) as PushKitLike;
  } catch {
    return null;
  }
}
