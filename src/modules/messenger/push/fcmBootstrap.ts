/**
 * FCM token bootstrap.
 *
 * Called once after the user authenticates. Responsibilities:
 *
 *   1. Request the runtime POST_NOTIFICATIONS permission (Android 13+).
 *   2. Acquire the FCM registration token via @react-native-firebase/messaging.
 *   3. POST it to messenger-service `/push/register-voip` so the gateway can
 *      fan VoIP wake-ups to it when a 1:1 `call.offer` or group `sfu.ring`
 *      arrives for an offline callee.
 *   4. Subscribe to onTokenRefresh and re-register if FCM rotates the token.
 *
 * iOS path is stubbed for now — VoIP on iOS needs PushKit (a separate
 * token type) which requires the `@react-native-voip-push-notification`
 * native module + Apple PushKit cert. Android FCM works with the same
 * react-native-firebase module already linked.
 *
 * The push payload itself carries ONLY a wake hint (`{wake: true, callId}`)
 * — never the SDP, never message content. Keeps with the spec invariant
 * documented in messenger-service `push.service.ts`.
 */
import {Platform, PermissionsAndroid} from 'react-native';
import messaging from '@react-native-firebase/messaging';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {MSG_BASE_URL} from '@utils/constants';

let unsubTokenRefresh: (() => void) | null = null;
let unsubOnMessage: (() => void) | null = null;
let started = false;

async function retryServerRegister(): Promise<void> {
  try {
    const token = await messaging().getToken();
    if (!token) {return;}
    const results = await Promise.all([
      registerDataToken(token).then(() => true).catch(e => { console.warn('[fcm] retry register-data failed:', (e as Error).message); return false; }),
      registerVoipToken(token).then(() => true).catch(e => { console.warn('[fcm] retry register-voip failed:', (e as Error).message); return false; }),
    ]);
    if (results.every(Boolean)) {
      serverRegistered = true;
      console.log('[fcm] server-register OK on retry');
    }
  } catch (e) {
    console.warn('[fcm] retry getToken failed:', (e as Error).message);
  }
}
// Why: a first-time bootstrap can succeed at the framework level (permission
// + getToken + onTokenRefresh wired) but the SERVER-SIDE push register can
// still fail silently (no JWT yet OR 401). Without re-attempting the
// server register on each user-id change, the recipient stays invisible
// to push.chat.sendChatWake forever — sender sees "delivered" via WS but
// receiver gets no notification banner. This flag tracks whether we've
// successfully posted to BOTH /push/register and /push/register-voip;
// subsequent startFcmBootstrap calls re-attempt registration when it's
// still false even if the framework bootstrap already ran.
let serverRegistered = false;

// B-48 — reconnect self-heal. The server can delete this device's token
// rows while the app runs or sits killed (dead-token GC after an FCM
// `not-registered`, logout tombstone from an account switch on another
// device) — and `serverRegistered=true` would mask it forever, since the
// only other re-register triggers are app start and FCM token rotation.
// Called from the messenger runtime on every WS `connected`, this
// unconditionally re-asserts BOTH /push/register* rows (idempotent POSTs),
// throttled so socket flaps don't spam the server.
let lastEnsureRegisteredAt = 0;
const ENSURE_REGISTER_MIN_INTERVAL_MS = 60_000;
export async function ensurePushRegistered(): Promise<void> {
  // Bootstrap hasn't run yet (pre-login or MainNavigator not mounted) —
  // startFcmBootstrap will do the full register imminently.
  if (!started) {return;}
  // P1-9 / P1-BR-3 — this runs on every WS `connected`, so it's our "on first
  // connect" hook to flush deferred killed-app actions (queued replies / reads /
  // declines). Fire-and-forget; drainPendingActions has its own in-flight guard.
  void drainPendingActions();
  const now = Date.now();
  if (now - lastEnsureRegisteredAt < ENSURE_REGISTER_MIN_INTERVAL_MS) {return;}
  lastEnsureRegisteredAt = now;
  await retryServerRegister();
}

// P1-9 / P1-BR-3 — drain the durable queue of actions taken from a notification
// while the process was killed (inline Reply, Mark-as-read, call Decline). The
// slim bundle-entry handler persists them; here (runtime ready / WS connected) we
// dispatch: replies + reads via the runtime outbox, declines via the server
// endpoint. Entries are removed ONLY on success, so a transient failure retries
// on the next connect (the queue self-sweeps entries older than 7 days).
let draining = false;
async function drainPendingActions(): Promise<void> {
  if (draining) {return;}
  draining = true;
  try {
    let owner: string | undefined;
    try {
      const {useAuthStore} = require('@/store/authStore') as typeof import('@/store/authStore');
      owner = useAuthStore.getState().user?.id || undefined;
    } catch { owner = undefined; }
    const {loadPendingActions, removePendingAction, sendCallDecline} = require('./pendingActions') as typeof import('./pendingActions');
    const entries = await loadPendingActions(owner);
    if (!entries.length) {return;}
    let rt: {sendText?: (c: string, t: string) => Promise<void>; markRead?: (c: string) => void} | null = null;
    const getRt = async () => {
      if (!rt) {
        const {getMessengerRuntime} = require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
        rt = (await getMessengerRuntime('production')) as unknown as typeof rt;
      }
      return rt!;
    };
    for (const e of entries) {
      let ok = false;
      try {
        if (e.t === 'decline') {
          ok = await sendCallDecline({callId: e.callId, peerUserId: e.peerUserId, kind: e.kind, roomId: e.roomId});
        } else if (e.t === 'reply') {
          const r = await getRt();
          // sendText enqueues to the durable outbox; resolving == accepted for send.
          await r.sendText?.(e.convId, e.text);
          r.markRead?.(e.convId);
          ok = true;
        } else if (e.t === 'read') {
          const r = await getRt();
          r.markRead?.(e.convId);
          ok = true;
        }
      } catch (err) {
        console.warn('[fcm] pending-action dispatch failed:', (err as Error).message);
        ok = false;
      }
      if (ok) { await removePendingAction(e); }
    }
  } catch (e) {
    console.warn('[fcm] drainPendingActions failed:', (e as Error).message);
  } finally {
    draining = false;
  }
}

export async function startFcmBootstrap(): Promise<void> {
  // M-04 — warm-path group/message banners are store-driven (sealed sender
  // hides the conversation from the FCM frame). Idempotent; restarted here
  // after a logout→login because stopFcmBootstrap tears it down.
  try {
    const {startBackgroundMessageNotifier} = require('./backgroundMessageNotifier') as typeof import('./backgroundMessageNotifier');
    startBackgroundMessageNotifier();
  } catch (e) {
    console.warn('[fcm] bg-message notifier start failed:', (e as Error).message);
  }
  if (started && serverRegistered) {
    console.log('[fcm] bootstrap skip — already started + server-registered');
    return;
  }
  if (started) {
    console.log('[fcm] bootstrap re-attempting server-register');
    await retryServerRegister();
    return;
  }
  started = true;
  console.log('[fcm] bootstrap start, platform =', Platform.OS, 'apiLevel =', Platform.Version);

  // Android 13+ requires runtime POST_NOTIFICATIONS grant; older Androids
  // grant it implicitly. iOS uses messaging().requestPermission() which
  // shows the iOS permissions sheet.
  try {
    if (Platform.OS === 'android') {
      const apiLevel = typeof Platform.Version === 'number'
        ? Platform.Version
        : Number.parseInt(String(Platform.Version), 10);
      if (apiLevel >= 33) {
        // Avoid a double prompt: PermissionsScreen (onboarding) may already
        // have requested POST_NOTIFICATIONS. Only request here if it isn't
        // already granted — a redundant request re-surfaces the sheet.
        const already = await PermissionsAndroid.check('android.permission.POST_NOTIFICATIONS' as never);
        if (!already) {
          const result = await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as never);
          console.log('[fcm] POST_NOTIFICATIONS grant =', result);
        } else {
          console.log('[fcm] POST_NOTIFICATIONS already granted');
        }
      } else {
        console.log('[fcm] POST_NOTIFICATIONS skipped, apiLevel < 33');
      }
      // BS-MSG1 — create the `bravo-messages` channel the server targets
      // in its chat-wake FCM `notification.android.channelId`. Without an
      // existing channel, Android 8+ SILENTLY DROPS the notification — so
      // calls (which create their own channel) rang while message wakes
      // showed nothing. Create it up front so the server's backgrounded
      // notification renders, and the msg-wake handler can reuse it.
      await ensureMessagesChannel();
      // B-21 — pre-create the high-importance incoming-call ring channel
      // (sound + vibration + full-screen) at boot too, not lazily on the
      // first ring. A voip-wake delivered to a freshly-launched headless JS
      // context could otherwise fire `showIncomingCallNotif` before the
      // channel exists; on Android 8+ a notification to a missing channel
      // is SILENTLY DROPPED — exactly the "no ring" symptom. Pre-creating
      // also surfaces an "Incoming calls" entry in system settings so the
      // user can pre-configure the ringtone. Idempotent (Android ignores a
      // repeat createChannel for an existing id).
      try {
        const {ensureIncomingCallChannel} = require('./callNotification') as typeof import('./callNotification');
        await ensureIncomingCallChannel();
      } catch (e) {
        console.warn('[fcm] ensureIncomingCallChannel failed:', (e as Error).message);
      }
    } else {
      // Skip iOS permission prompt for now — VoIP on iOS needs PushKit
      // and the regular-APNs prompt would mis-train the user.
      console.log('[fcm] iOS permission prompt skipped (PushKit not yet wired)');
    }
  } catch (e) {
    console.warn('[fcm] permission prompt failed:', (e as Error).message);
  }

  // Acquire current token. messaging().getToken() returns the cached
  // token if Firebase has one, or fetches a fresh one. Failures here
  // typically mean google-services.json is missing or the package
  // isn't registered in the Firebase project.
  try {
    const token = await messaging().getToken();
    if (token) {
      console.log('[fcm] getToken ok, len =', token.length, 'prefix =', token.slice(0, 10) + '…');
      // Register against BOTH endpoints. /register-voip wakes the device
      // for incoming calls; /register is for chat-message wakes. They
      // share the same FCM token but live in different Redis keyspaces
      // on the server so we can lifecycle them independently (e.g.
      // unregister VoIP only when the user mutes the contact).
      const results = await Promise.all([
        registerDataToken(token).then(() => true).catch(e => { console.warn('[fcm] register-data failed:', (e as Error).message); return false; }),
        registerVoipToken(token).then(() => true).catch(e => { console.warn('[fcm] register-voip failed:', (e as Error).message); return false; }),
      ]);
      // Both must succeed to flip the gate — partial success would leave
      // either chat-wake or call-wake broken.
      if (results.every(Boolean)) {
        serverRegistered = true;
        console.log('[fcm] server-register OK (both endpoints)');
      } else {
        console.warn('[fcm] server-register PARTIAL — next bootstrap call will retry');
      }
    } else {
      console.warn('[fcm] getToken returned empty');
    }
  } catch (e) {
    console.warn('[fcm] getToken failed:', (e as Error).message);
  }

  // Re-register on rotate. FCM rotates tokens on app reinstall, data
  // clear, sustained offline period, or anti-abuse triggers. Without
  // re-registering, the server's token cache goes stale and the next
  // VoIP wake fires into the void.
  unsubTokenRefresh?.();
  unsubTokenRefresh = messaging().onTokenRefresh(token => {
    console.log('[fcm] token rotated, len =', token.length);
    void Promise.all([
      registerDataToken(token).then(() => true).catch(e => { console.warn('[fcm] re-register-data failed:', (e as Error).message); return false; }),
      registerVoipToken(token).then(() => true).catch(e => { console.warn('[fcm] re-register-voip failed:', (e as Error).message); return false; }),
    ]).then(results => {
      serverRegistered = results.every(Boolean);
    });
  });
  // notifee event handlers — Accept / Decline button taps OR the
  // notification body tap from the drawer. We dismiss the notif then
  // navigate to the right ring screen so the user sees the full UI
  // they expect (existing IncomingGroupCallScreen / CallScreen).
  // The handler is attached after token registration so ready calls
  // arriving immediately after install don't race the navigation
  // ref bootstrap.
  installNotifeeHandlers();

  // Foreground data-push handler. setBackgroundMessageHandler only fires when
  // the app is backgrounded/killed; without onMessage a data push arriving
  // while the app is FOREGROUNDED is dropped entirely. Chat is already
  // delivered live over the WS, so for msg-wake we just nudge a pull; the
  // server-driven wakes (booking/agent/SOS/opaque) surface their notification
  // via the shared dispatcher even in the foreground. Registered once; the
  // returned unsubscribe is torn down on logout.
  try {
    unsubOnMessage?.();
    unsubOnMessage = messaging().onMessage(async (msg) => {
      const data = msg?.data ?? {};
      const kind = typeof data.kind === 'string' ? data.kind : '';
      // P2-5 — handle call-cancel in the FOREGROUND too: stop a ring drawn
      // while backgrounded the instant the caller gives up, instead of letting
      // it run out its 45 s timeout after the app is foregrounded.
      if (kind === 'call-cancel') { await handleCallCancel(stringFields(data)); return; }
      if (kind === 'voip-wake') { return; } // live WS call.offer drives the ring UI
      if (kind === 'msg-wake') {
        try {
          const {getMessengerRuntime} = require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
          const rt = await getMessengerRuntime('production');
          await (rt as unknown as {pullEnvelopes?: () => Promise<void>}).pullEnvelopes?.();
        } catch { /* WS foreground delivery is the backstop */ }
        return;
      }
      try {
        const {showServerWakeNotification} = require('./serverWakeNotifications') as typeof import('./serverWakeNotifications');
        // N-18 — warm path: also record a durable in-app bell row (store is
        // hydrated here, unlike the fully-killed headless path).
        await showServerWakeNotification(data as Record<string, unknown>, {recordActivity: true});
      } catch (e) {
        console.warn('[fcm] foreground server-wake failed:', (e as Error).message);
      }
    });
  } catch (e) {
    console.warn('[fcm] onMessage register failed:', (e as Error).message);
  }

  // CallKit (iOS) + Telecom (Android) bridge.
  //   Android: ACTIVE — Telecom ConnectionService displays system call
  //     UI alongside the existing notifee path. Both fire (de-duped by
  //     callId). If Telecom setup fails (OEM stripped Telecom, user
  //     denied phone-account permission), the bridge silently no-ops
  //     and notifee remains the sole ringer — Android calling keeps
  //     working exactly as before.
  //   iOS: SKELETON — flips to active when Apple VoIP cert + APNs
  //     server creds + IOS_RUNTIME_ENABLED all line up.
  try {

    const {setupCallKit} = require('./callKitBridge') as typeof import('./callKitBridge');

    const {startVoipPushBootstrap} = require('./voipPush') as typeof import('./voipPush');
    await setupCallKit();
    await startVoipPushBootstrap();
    installCallKitEventHandlers();
  } catch (e) {
    console.warn('[fcm] CallKit/Telecom bootstrap failed:', (e as Error).message);
  }

  // P1-9 / P1-BR-3 — flush any actions queued while the app was killed.
  void drainPendingActions();

  console.log('[fcm] bootstrap complete');
}

/**
 * Wire system-call-UI events (Telecom Accept / End / Mute on Android,
 * CXProvider equivalents on iOS once enabled) into Bravo's existing
 * call lifecycle.
 *
 *   Accept tap (lock screen / system UI) → look up cached payload →
 *     same nav + accept flow as the notifee Accept tap.
 *   End tap → if call hasn't been accepted yet, send call.hangup with
 *     reason='declined' to peer; otherwise treat as remote-ended
 *     hangup (CallScreen.hangup() handles it).
 *
 * Idempotent — guarded by `callKitHandlersInstalled` so a re-bootstrap
 * doesn't double-subscribe (which would double-fire every accept).
 */
let callKitHandlersInstalled = false;
/**
 * The unsubscribe returned by subscribeToCallKitEvents. Previously this was
 * discarded, so a logout→login within the same process left the OLD answer/end
 * listeners attached AND added a second set — a single system-UI Accept then
 * fired onAnswer twice (and a decline could send call.hangup twice). Captured
 * here and invoked in stopFcmBootstrap so the listeners are torn down on logout.
 */
let callKitUnsub: (() => void) | null = null;
function installCallKitEventHandlers(): void {
  if (callKitHandlersInstalled) {return;}
  callKitHandlersInstalled = true;


  const bridge = require('./callKitBridge') as typeof import('./callKitBridge');

  const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');

  callKitUnsub = bridge.subscribeToCallKitEvents({
    onAnswer: (callId) => {
      console.log('[callkit-ev] answer callId=', callId);
      const payload = cache.getIncomingCallPayload(callId);
      if (!payload) {
        console.warn('[callkit-ev] no cached payload for callId=', callId, '— Telecom event arrived without prior reportIncomingCall (notifee path may handle it)');
        // Surface the app to the foreground regardless — when payload
        // is missing the notifee handler likely owns this call and
        // its tap-handler will navigate. Bringing the app forward
        // gives that handler something to navigate ON.
        bridge.bringAppToForeground();
        return;
      }
      // Same flow as the notifee Accept tap — wait for nav, then
      // navigate to the right screen. CallScreen.useCall picks up
      // the offer SDP and runs accept locally.
      void navigateToIncomingCall(callId, payload);
      // Do NOT clear the cache here — the navigated screen consumes
      // the SDP. The cache entry will be cleared once the call ends
      // (peer hangup or user hangup, both routed to clearByCallId
      // through the same bridge.reportEnded path).
    },

    onEnd: (callId) => {
      console.log('[callkit-ev] end callId=', callId);
      const payload = cache.getIncomingCallPayload(callId);
      if (payload) {
        // Call was still pending (user hasn't accepted yet) →
        // decline. Send call.hangup with reason='declined' so the
        // caller stops ringing instead of waiting for the 30s no-
        // answer timeout.
        sendCallHangup(callId, payload, 'declined');
        cache.clearIncomingCallPayload(callId);
        clearAcceptedCallId(callId);
        // Also dismiss the notifee notification so a duplicate ring
        // doesn't outlive the Telecom decline.
        try {

          const cn = require('./callNotification') as typeof import('./callNotification');
          void cn.dismissCallNotif(callId);
        } catch { /* notifee may not be ready in headless JS */ }
        return;
      }
      // Call already accepted → user hit End from system UI. The
      // active CallScreen owns hangup; we just need to make sure
      // the active controller hears it. Easiest path: navigate the
      // existing controller to hang up via the call registry.
      try {

        const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        const active = reg.getActiveCall();
        if (active && active.callId === callId) {
          // The active call's controller will see this and run its
          // own hangup / cleanup via the existing onState=ended path.
          reg.endActiveCall('ended');
        }
      } catch (e) {
        console.warn('[callkit-ev] end propagate failed:', (e as Error).message);
      }
    },

    onToggleMute: (callId, muted) => {
      console.log('[callkit-ev] mute', callId, muted);
      // System UI mute → flip the local audio track directly via the
      // active-call registry. The track is what carries audio; flipping
      // .enabled mutes immediately. We do NOT round-trip through
      // useCall's toggleMute callback because that lives inside React
      // state and isn't reachable from headless JS.
      //
      // Caveat: the in-app mute icon is driven by useCall's local
      // useState which won't update from this path — so a system-UI
      // mute won't visually flip the in-app button until CallScreen
      // remounts. Acceptable trade-off; the audio IS muted (which is
      // the contract the user cares about).
      try {

        const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        const active = reg.getActiveCall();
        if (active && active.callId === callId && active.audioTrack) {
          active.audioTrack.enabled = !muted;
          console.log(`[callkit-ev] audioTrack.enabled = ${!muted} for callId=${callId}`);
        }
      } catch (e) {
        console.warn('[callkit-ev] mute mirror failed:', (e as Error).message);
      }
    },
  });

  console.log('[callkit] event handlers installed');
}

/**
 * Tracks callIds that have already been navigated to, so a notifee
 * Accept tap + Telecom Answer event for the SAME callId (which fires
 * within ms of each other on Android FullScreenIntent) doesn't mount
 * CallScreen twice and send TWO `call.answer` frames to the gateway.
 * The second frame would cross the caller's setRemoteDescription mid-
 * flight and the call would stick in have-local-offer.
 *
 * Cleared when the call ends (peer hangup, our hangup, or decline)
 * via `clearAcceptedCallId(callId)` — both clearByCallId paths in
 * onEnd/decline-handler call it. Bounded scrub (older-than-5-min) on
 * every check so an abandoned entry can't outlive the day.
 */
const acceptedCallIds = new Map<string, number>();
function markAccepted(callId: string): boolean {
  // Scrub stale entries (>5 min). 5 min is well past any realistic
  // accept-then-end window; any entry older than this is a leak.
  const cutoff = Date.now() - 5 * 60_000;
  for (const [cid, t] of acceptedCallIds) {
    if (t < cutoff) {acceptedCallIds.delete(cid);}
  }
  if (acceptedCallIds.has(callId)) {return false;}
  acceptedCallIds.set(callId, Date.now());
  return true;
}
function clearAcceptedCallId(callId: string): void {
  acceptedCallIds.delete(callId);
}
/**
 * Public helper for useCall's onState('ended') path to clear the
 * accept-dedupe entry without reaching into module internals. Called
 * after the call lifecycle naturally ends so the next incoming call
 * with the same callId (extremely unlikely but possible on a buggy
 * server) can navigate fresh.
 */
export function notifyCallEnded(callId: string): void {
  clearAcceptedCallId(callId);
}

/**
 * Look up the navigationRef and route to the right ring screen.
 * Mirrors the notifee Accept-tap path (so a notifee Accept and a
 * Telecom Accept land on identical UI).
 */
async function navigateToIncomingCall(
  callId: string,
  payload: import('./incomingCallCache').CachedIncomingCall,
): Promise<void> {
  // Dedupe: if a notifee Accept tap already navigated for this callId,
  // and the Telecom Answer event fires 50ms later (Android FSI), the
  // second invocation is silently dropped. Without this both paths
  // mount CallScreen and both fire `call.answer` — the second one
  // races the caller's setRemoteDescription and the call hangs.
  if (!markAccepted(callId)) {
    console.log('[callkit-ev] navigate skipped (already accepted) callId=', callId);
    return;
  }
  try {

    const {navigationRef} = require('@navigation/navigationRef') as typeof import('@navigation/navigationRef');
    const t0 = Date.now();
    // P1-BR-2 — cold launch from a killed state can take 10–25 s; wait 20 s.
    while (Date.now() - t0 < 20000) {
      if ((navigationRef as unknown as {isReady?: () => boolean})?.isReady?.()) {break;}
      await new Promise(r => setTimeout(r, 100));
    }
    if (!(navigationRef as unknown as {isReady?: () => boolean})?.isReady?.()) {
      console.warn('[callkit-ev] nav not ready after 20s — abandoning route');
      clearAcceptedCallId(callId); // P3 — don't leave the accept latch set for 5 min
      return;
    }

    // A Telecom Answer event is always an explicit accept → autoAccept.
    const isGroup = payload.kind === 'group-voice' || payload.kind === 'group-video';
    if (isGroup) {
      (navigationRef as unknown as {navigate: (n: string, p?: unknown) => void}).navigate('Main', {
        screen: 'MessengerTab',
        params: {
          screen: 'IncomingGroupCallScreen',
          params: {
            roomId:         payload.roomId ?? '',
            conversationId: payload.conversationId ?? '',
            roomToken:      payload.roomToken ?? '', // P1-BR-1 — echo to sfu.join
            callType:       payload.kind === 'group-video' ? 'video' : 'voice',
            callerName:     payload.callerName,
            fromUserId:     payload.fromUserId ?? '',
            autoAccept:     true,
          },
        },
      });
    } else {
      (navigationRef as unknown as {navigate: (n: string, p?: unknown) => void}).navigate('Main', {
        screen: 'MessengerTab',
        params: {
          screen: 'CallScreen',
          params: {
            callType:       payload.kind === 'video' ? 'video' : 'voice',
            isIncoming:     true,
            conversationId: payload.conversationId ?? `direct:${payload.fromUserId ?? ''}`,
            callId,
            remoteUserId:   payload.fromUserId,
            remoteDeviceId: payload.remoteDeviceId ?? 1,
            incomingSdp:    payload.incomingSdp,
            autoAccept:     true,
          },
        },
      });
    }
    console.log('[callkit-ev] navigated → callId=', callId);
  } catch (e) {
    console.warn('[callkit-ev] navigate failed:', (e as Error).message);
  }
}

/**
 * Send `call.hangup` to the peer over the live transport. Used by:
 *   - Telecom End-tap-while-ringing (decline)
 *   - Notifee Decline button tap
 *
 * Fire-and-forget — if the WS isn't connected (app cold-launched
 * directly into the system call UI without messenger runtime up),
 * the caller will see no-answer instead of decline. Acceptable
 * degradation; the alternative is making the user wait while we
 * boot a runtime just to send one frame.
 */
function sendCallHangup(
  callId: string,
  payload: import('./incomingCallCache').CachedIncomingCall,
  reason: 'declined' | 'busy' | 'ended' | 'failed',
): void {
  if (!payload.fromUserId) {
    console.warn('[callkit-ev] cannot send call.hangup — no fromUserId in cached payload, callId=', callId);
    return;
  }
  try {

    const reg = require('@/modules/messenger/runtime/transportRegistry') as typeof import('@/modules/messenger/runtime/transportRegistry');
    const tx = reg.getLiveTransport();
    if (!tx) {
      console.warn('[callkit-ev] cannot send call.hangup — no live transport, callId=', callId);
      return;
    }
    tx.send({
      event: 'call.hangup',
      data: {
        callId,
        to: {userId: payload.fromUserId, deviceId: payload.remoteDeviceId ?? 1},
        reason,
      },
    } as never);
    console.log('[callkit-ev] sent call.hangup reason=', reason, 'callId=', callId);
  } catch (e) {
    console.warn('[callkit-ev] sendCallHangup failed:', (e as Error).message);
  }
}

/**
 * P1-7 — route a Missed-call banner tap. Deep-link to the caller's local 1:1
 * thread (resolved from the payload's fromUserId) so the user can call back;
 * fall back to the Calls log when we don't know who called. Never opens the
 * incoming CallScreen — that call is already over.
 */
async function handleMissedCallTap(data: Record<string, string | undefined>): Promise<void> {
  try {
    const {navigationRef} = require('@navigation/navigationRef') as typeof import('@navigation/navigationRef');
    const navReady = navigationRef as unknown as {isReady?: () => boolean};
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (navReady?.isReady?.()) {break;}
      await new Promise(r => setTimeout(r, 100));
    }
    const nav = navigationRef as unknown as {navigate: (n: string, p?: unknown) => void};
    const fromUserId = data.fromUserId;
    let convId: string | undefined;
    let name: string | undefined;
    if (fromUserId) {
      try {
        const {resolveDirectConversation} = require('./mutedLookup') as typeof import('./mutedLookup');
        const resolved = await resolveDirectConversation(fromUserId);
        convId = resolved?.id;
        name = resolved?.name;
      } catch { /* fall through to the Calls log */ }
    }
    if (convId) {
      // B-85 — `initial: false` is LOAD-BEARING: without it, React
      // Navigation treats the nested `screen` as the stack's initial
      // route on first mount, seeding [Chat] alone — back then bubbles
      // to the tab navigator and lands on the Dashboard. With it, the
      // navigator's initialRouteName (MessengerHome) is seeded beneath.
      nav.navigate('Main', {
        screen: 'MessengerTab',
        params: {screen: 'Chat', initial: false, params: {conversationId: convId, name: name ?? '', isGroup: false}},
      });
    } else {
      nav.navigate('Main', {
        screen: 'MessengerTab',
        params: {screen: 'CallsLog'},
      });
    }
  } catch (e) {
    console.warn('[notifee] missed-call tap routing failed:', (e as Error).message);
  }
}

/**
 * Why: RNFirebase types a push's `data` as `{[k: string]: string | object}`;
 * our handlers only consume string fields, so drop non-strings instead of
 * casting (behavior-identical — object values were never read).
 */
function stringFields(data: Record<string, string | object>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') {out[k] = v;}
  }
  return out;
}

/**
 * P2-5 — full call-cancel teardown, shared by the killed/background FCM handler
 * and the FOREGROUND onMessage path. Dismisses the notifee ring, tears down the
 * system-UI (Telecom) display, tombstones the incoming-call cache so a queued
 * Accept can't resurrect a dead call, and (when the caller gave up unanswered)
 * leaves a Missed-call trace.
 */
async function handleCallCancel(data: Record<string, string | undefined>): Promise<void> {
  const callId = typeof data.callId === 'string' ? data.callId : '';
  if (!callId) {return;}
  try {
    const cn = require('./callNotification') as typeof import('./callNotification');
    await cn.dismissCallNotif(callId);
    try {
      const bridge = require('./callKitBridge') as typeof import('./callKitBridge');
      bridge.reportEnded(callId, 'remoteEnded');
    } catch { /* bridge inert — nothing to tear down */ }
    try {
      const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
      cache.clearIncomingCallPayload(callId); // tombstones the callId
    } catch { /* cache module unavailable */ }
    clearAcceptedCallId(callId);
    if (data.missed === '1') {
      const fromUserId = typeof data.fromUserId === 'string' && data.fromUserId ? data.fromUserId : undefined;
      let callerName = typeof data.callerName === 'string' ? data.callerName : undefined;
      if (!callerName && fromUserId) {
        try {
          const {resolveDirectPeerName} = require('./mutedLookup') as typeof import('./mutedLookup');
          callerName = (await resolveDirectPeerName(fromUserId)) ?? undefined;
        } catch { /* generic label */ }
      }
      await cn.showMissedCallNotif({
        callId,
        callerName,
        fromUserId,
        kind: (typeof data.callKind === 'string' ? data.callKind : 'voice') as import('./callNotification').CallNotifKind,
      });
    }
  } catch (e) {
    console.warn('[fcm] call-cancel handling failed:', (e as Error).message);
  }
}

/**
 * LM-N2 — kind → screen for a server-wake notification tap. Returns true when the
 * kind is a recognised server-event kind (tap consumed), false otherwise.
 *
 * Exactly ONE shell (client tabs / AgentNavigator / CpoNavigator) is mounted at a
 * time and route names are unique per shell, so navigating every candidate is
 * safe: at most one resolves; a miss is a React Navigation no-op warn. The client
 * booking kinds all land on BookingHome, whose focus-resume gate then routes to
 * the in-flight booking's live screen (searching / accepted / tracking / summary).
 */
// LB-N (deep-link) — a client booking wake taps DIRECTLY to the stage screen it
// refers to, using the hydrated bookingId, instead of only landing on BookingHome
// and hoping the focus-resume gate forwards (which `seenRef` can suppress for a
// booking the user already visited). Every target here needs only {bookingId}.
const CLIENT_STAGE_SCREEN: Record<string, string> = {
  'crew-assigned':        'LiveTracking',   // mission DISPATCHED — verify-code window
  'detail-enroute':       'LiveTracking',   // mission PICKUP — en route
  'detail-live':          'LiveTracking',   // mission LIVE — protection active
  'provider-accepted':    'LiveTracking',   // no mission yet — LiveTracking self-heals (shows "awaiting dispatch")
  'booking-completed':    'MissionComplete',
  'no-provider':          'NoDetail',
  'booking-redispatching':'FindingDetail',
  'agency-no-show':       'TripSummary',
  'refund-issued':        'TripSummary',
  'booking-rejected':     'TripSummary',
  'dispute-opened':       'TripSummary',
  'dispute-resolved':     'TripSummary',
  'booking-approved':     'OpsRoomReview',
  'payment-failed':       'BookingHome',
};

function routeServerWakeTap(kind: string, data: Record<string, string | undefined>): boolean {
  const rawId = data.bookingId;
  const bid = typeof rawId === 'string' && /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/.test(rawId) ? rawId : undefined;
  let candidates: Array<{name: string; params?: unknown}> = [];
  if (kind === 'dispatch-offer') {
    candidates = [{name: 'IncomingOffer'}];
  } else if (kind === 'mission-dispatched' || kind === 'mission-aborted') {
    candidates = [{name: 'CpoMission'}, {name: 'AgentDashboard'}];
  } else if (kind === 'mission-complete-requested') {
    candidates = [{name: 'OrgMissions'}];
  } else if (kind === 'sos-cpo-alert') {
    // Recipients are crew (CPO shell) AND the principal (client shell).
    candidates = [
      {name: 'CpoMission'},
      {name: 'SecureTab', params: {screen: bid ? 'LiveTracking' : 'BookingHome', params: bid ? {bookingId: bid} : undefined}},
    ];
  } else if (kind === 'payout-settled') {
    candidates = [{name: 'Earnings'}, {name: 'CpoMe'}];
  } else if (kind === 'agent-approved' || kind === 'agent-rejected') {
    candidates = [{name: 'AgentDashboard'}];
  } else if (kind === 'incident-submitted' || kind === 'incident-status') {
    // N-21 — Dept Chat v2 incident wakes: managers land on the departmental
    // shell; the submitter (CPO) on their mission. Try both — only one mounts.
    candidates = [{name: 'DepartmentChannels'}, {name: 'CpoMission'}];
  } else if (CLIENT_STAGE_SCREEN[kind]) {
    const screen = bid ? CLIENT_STAGE_SCREEN[kind] : 'BookingHome';
    candidates = [{name: 'SecureTab', params: {screen, params: bid ? {bookingId: bid} : undefined}}];
  } else {
    return false;
  }
  // Poll for nav-readiness so a COLD-START tap (app launched from the notification)
  // still deep-links once the container mounts, instead of silently dropping the
  // intent. Fire-and-forget — the caller only needs to know the kind was consumed.
  void (async () => {
    try {
      const {navigationRef} = require('@navigation/navigationRef') as typeof import('@navigation/navigationRef');
      const nav = navigationRef as unknown as {isReady?: () => boolean; navigate: (n: string, p?: unknown) => void};
      // Wait up to ~10s for the container to mount — a killed-app cold start (the
      // exact "close the app then tap the notification" case) can take several
      // seconds to boot the NavigationContainer on a large bundle; a 3s cap dropped
      // the deep-link on slow devices.
      for (let i = 0; i < 40; i++) {
        if (!nav.isReady || nav.isReady()) {break;}
        await new Promise(r => setTimeout(r, 250));
      }
      if (nav.isReady && !nav.isReady()) {return;} // gave up (~10s) — resume gates cover it
      for (const c of candidates) {
        try { nav.navigate(c.name, c.params); } catch { /* shell without this route */ }
      }
      console.log(`[notifee] server-wake tap routed kind=${kind}`, bid ?? data.missionId ?? '');
    } catch { /* nav not ready — the shell's own resume logic covers it */ }
  })();
  return true;
}

let notifeeHandlersInstalled = false;
function installNotifeeHandlers(): void {
  if (notifeeHandlersInstalled) {return;}
  notifeeHandlersInstalled = true;

  const cn = require('./callNotification') as typeof import('./callNotification');
  const {EventType, notifee, parseCallAction, dismissCallNotif} = cn;
  type NotifeeEvent = Parameters<Parameters<typeof notifee.onForegroundEvent>[0]>[0];

  const handle = async (event: NotifeeEvent, source: 'fg' | 'bg') => {
    const {type, detail} = event;
    if (type !== EventType.ACTION_PRESS && type !== EventType.PRESS) {return;}
    const data = (detail.notification?.data ?? {}) as Record<string, string | undefined>;
    // Audit PUSH-B3 (2026-07-02): a msg-wake TAP has no callId, so it used to
    // fall through to the OS default (open the app wherever it was). Deep-link
    // straight to the conversation so ChatScreen mounts and pulls the queued
    // envelopes immediately — shrinking the "empty thread until WS reconnects"
    // window on a killed-app tap. We deliberately do NOT decrypt in the
    // headless FCM VM (that reintroduces the 2nd-VM contention the team removed
    // for stability); the fast foreground pull on this navigation is the safe
    // path.
    if (data.kind === 'msg-wake') {
      const convId = data.conversationId || '';
      const pressId = detail.pressAction?.id ?? '';

      // N-10 — inline Mark-as-read. Works whenever the runtime is alive (warm
      // background); a no-op if it isn't (the banner is still dismissed).
      if (pressId.startsWith('read-') && convId) {
        try {
          const {getMessengerRuntime} = require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
          const rt = await getMessengerRuntime('production');
          (rt as unknown as {markRead?: (c: string) => void}).markRead?.(convId);
        } catch { /* runtime not up — banner dismiss below still applies */ }
        try {
          const {dismissMessageNotif} = require('./callNotification') as typeof import('./callNotification');
          await dismissMessageNotif(convId);
        } catch { /* notifee unavailable */ }
        return;
      }
      // N-10 — inline Reply. Sends the typed text through the normal outbox and
      // marks the thread read, all without opening the app.
      if (pressId.startsWith('reply-') && convId) {
        const input = (detail as unknown as {input?: string}).input;
        if (typeof input === 'string' && input.trim()) {
          try {
            const {getMessengerRuntime} = require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
            const rt = await getMessengerRuntime('production');
            await (rt as unknown as {sendText?: (c: string, t: string) => Promise<void>}).sendText?.(convId, input.trim());
            (rt as unknown as {markRead?: (c: string) => void}).markRead?.(convId);
            const {dismissMessageNotif} = require('./callNotification') as typeof import('./callNotification');
            await dismissMessageNotif(convId);
          } catch (e) {
            console.warn('[notifee] inline reply failed:', (e as Error).message);
          }
        }
        return;
      }

      // Body tap → deep-link to the thread. M-05 — only open a thread that
      // EXISTS locally (the old fallback minted a phantom 1:1). N-07/N-08 — the
      // Chat route REQUIRES `name` + `isGroup`; without them ChatScreen crashed
      // at render (`initials(undefined)` → "Chat hit an error"). Resolve both
      // from the store (or persisted slice on cold boot) and pass them.
      let exists = false;
      let name: string | undefined;
      let isGroup = false;
      if (convId) {
        try {
          const {useMessengerStore} = require('@/modules/messenger/store/messengerStore') as
            typeof import('@/modules/messenger/store/messengerStore');
          const conv = useMessengerStore.getState().conversations[convId];
          if (conv) {
            exists = true;
            name = conv.name;
            isGroup = conv.type === 'group' || conv.type === 'ops_channel';
          }
        } catch { /* store unavailable — fall through to the persisted check */ }
        if (!exists) {
          // Cold boot: the live store may not be hydrated yet — read name +
          // group-ness from the persisted owner slice before giving up.
          try {
            const {resolveConversationMeta} = require('./mutedLookup') as typeof import('./mutedLookup');
            const meta = await resolveConversationMeta(convId);
            if (meta) { exists = true; name = meta.name; isGroup = meta.isGroup; }
          } catch { exists = false; }
        }
      }
      try {
        const {navigationRef} = require('@navigation/navigationRef') as typeof import('@navigation/navigationRef');
        // N-09 — wait for the navigator on a cold-launch tap (the call path
        // already does this); otherwise the deep-link is a silent no-op.
        const navReady = navigationRef as unknown as {isReady?: () => boolean};
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) {
          if (navReady?.isReady?.()) {break;}
          await new Promise(r => setTimeout(r, 100));
        }
        const nav = navigationRef as unknown as {navigate: (n: string, p?: unknown) => void};
        if (convId && exists) {
          // B-85 — `initial: false` is LOAD-BEARING (see missed-call
          // handler above): it makes the messenger stack seed
          // MessengerHome BENEATH the deep-linked Chat so back returns
          // to the chat list instead of the Dashboard.
          nav.navigate('Main', {
            screen: 'MessengerTab',
            params: {screen: 'Chat', initial: false, params: {conversationId: convId, name: name ?? '', isGroup}},
          });
        } else {
          nav.navigate('Main', {
            screen: 'MessengerTab',
            params: {screen: 'MessengerHome'},
          });
        }
      } catch { /* nav not ready on cold boot — lands on home, the mount pull still runs */ }
      return;
    }
    // LM-N2 — server-wake TAP deep-links. Previously every non-chat/call tap fell
    // through to the OS default ("open the app wherever it was"), so an offer /
    // mission / payout / SOS notification never landed the user on the right
    // screen. Route by kind; each shell only mounts its own route names, so we
    // try candidates in order (React Navigation no-ops with a warn on a miss).
    if (typeof data.kind === 'string' && routeServerWakeTap(data.kind, data)) {return;}
    // P1-7 — a Missed-call banner also carries a callId, but it must NOT fall
    // into the CALL branch below (that opened a GHOST incoming CallScreen for a
    // dead call). Deep-link to the caller's 1:1 thread when known, else the
    // Calls log.
    if (data.kind === 'missed-call') {
      await handleMissedCallTap(data);
      return;
    }
    const callId = data.callId;
    if (!callId) {return;}

    const pressId = detail.pressAction?.id ?? '';
    const action  = parseCallAction(pressId);
    console.log(`[notifee] ${source} event press=${pressId} action=${action?.outcome ?? 'open'} callId=${callId}`);

    // Always dismiss the notif on any user interaction — the in-app
    // ring screen takes over from here (or the call's already over).
    await dismissCallNotif(callId);

    // Decline: send `call.hangup` to peer so the caller stops ringing
    // immediately instead of waiting for the 30s no-answer timeout,
    // then dismiss the notification. Group calls get `sfu.ring.decline`
    // — TODO when we have the SFU client wired (1:1 was the urgent
    // gap). Best-effort: if the WS isn't connected (cold launch into
    // notif tap), we silently fall through and the caller will see
    // no-answer, which is the same fail-soft behaviour as before.
    if (action?.outcome === 'decline') {
      try {

        const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
        const payload = cache.getIncomingCallPayload(callId);
        const reg = require('@/modules/messenger/runtime/transportRegistry') as typeof import('@/modules/messenger/runtime/transportRegistry');
        const tx = reg.getLiveTransport();
        if (data.isGroup === '1') {
          // Audit PUSH-B6 (2026-07-02): group-call decline was a no-op TODO —
          // the caller kept ringing until timeout. Send sfu.ring.decline so the
          // host stops ringing this recipient. The server's decline gate needs
          // the per-recipient ring roomToken (carried in the push data); when
          // absent (or WS down on cold launch) this falls through to no-answer,
          // the same fail-soft as before.
          const roomId    = data.roomId ?? payload?.roomId;
          const roomToken = data.roomToken;
          if (tx && roomId) {
            tx.send({
              event: 'sfu.ring.decline',
              data: {roomId, conversationId: data.conversationId ?? payload?.conversationId ?? '', ...(roomToken ? {roomToken} : {})},
            } as never);
            console.log('[notifee] group decline → sent sfu.ring.decline room=', roomId);
          } else {
            console.log('[notifee] group decline → no live transport / roomId, falling through to no-answer');
          }
          cache.clearIncomingCallPayload(callId);
          clearAcceptedCallId(callId);
        } else if (payload?.fromUserId) {
          if (tx) {
            tx.send({
              event: 'call.hangup',
              data: {
                callId,
                to: {userId: payload.fromUserId, deviceId: payload.remoteDeviceId ?? 1},
                reason: 'declined',
              },
            } as never);
            console.log('[notifee] decline → sent call.hangup callId=', callId);
          } else {
            console.log('[notifee] decline → no live transport, falling through to no-answer');
          }
          cache.clearIncomingCallPayload(callId);
          clearAcceptedCallId(callId);
        } else {
          console.log('[notifee] decline tapped — no payload, dismiss only');
        }
      } catch (e) {
        console.warn('[notifee] decline hangup failed:', (e as Error).message);
      }
      // Also dismiss any system-UI Telecom display that showed alongside
      // the notifee notif so both surfaces clear together.
      try {

        const bridge = require('./callKitBridge') as typeof import('./callKitBridge');
        bridge.reportEnded(callId, 'declined');
      } catch { /* bridge inactive — nothing to dismiss */ }
      return;
    }

    // Accept OR body tap → bring the app to foreground and navigate
    // to the right ring screen. The screen mounts and runs its own
    // accept logic on top of the live WS frames the gateway is
    // already streaming.
    //
    // Dedupe: a Telecom Accept event AND a notifee Accept tap can
    // both fire for the same callId on Android FullScreenIntent
    // builds. Without `markAccepted`, both navigation calls mount
    // CallScreen sequentially → the dispatcher's
    // `registerSignalling` overwrite-warns and the FIRST hook's
    // accept() may have already sent `call.answer`. The SECOND
    // accept() then sends ANOTHER `call.answer` → caller's
    // setRemoteDescription rejects on the duplicate and the call
    // sticks in have-local-offer.
    if (!markAccepted(callId)) {
      console.log('[notifee] navigate skipped (already accepted) callId=', callId);
      return;
    }
    try {

      const {navigationRef} = require('@navigation/navigationRef') as typeof import('@navigation/navigationRef');
      // Defer until nav is ready — when launched from a killed state
      // this fires before RootNavigator mounts, so we poll briefly.
      const waitReady = async (msMax: number): Promise<boolean> => {
        const t0 = Date.now();
        while (Date.now() - t0 < msMax) {
          if ((navigationRef as unknown as {isReady?: () => boolean})?.isReady?.()) {return true;}
          await new Promise(r => setTimeout(r, 100));
        }
        return false;
      };
      // P1-BR-2 — cold-launch nav can take 10–25 s; raise the wait to 20 s (the
      // poll loop is the retry). On abandon, clear the accept latch (P3) so a
      // follow-up Telecom answer for the same callId isn't silently dropped.
      const ready = await waitReady(20000);
      if (!ready) {
        console.warn('[notifee] nav not ready after 20s — abandoning route');
        clearAcceptedCallId(callId);
        return;
      }

      // P1-BR-2 — the notification's Answer button (accept-<callId>) means
      // "answer now"; pass autoAccept so the screen accepts once the offer SDP
      // lands (Wave 3 consumes it) instead of showing a second Accept button.
      // A body/full-screen tap (action === null) still lands on the ring UI.
      const autoAccept = action?.outcome === 'accept';
      const isGroup = data.isGroup === '1';
      if (isGroup) {
        (navigationRef as unknown as {navigate: (n: string, p?: unknown) => void}).navigate('Main', {
          screen: 'MessengerTab',
          params: {
            screen: 'IncomingGroupCallScreen',
            params: {
              roomId:         data.roomId ?? '',
              conversationId: data.conversationId ?? '',
              // P1-BR-1 — echo the per-recipient room token so the group accept
              // path can `sfu.join` the host's room (not create a new one).
              roomToken:      data.roomToken ?? '',
              callType:       data.kind === 'group-video' ? 'video' : 'voice',
              callerName:     data.callerName ?? 'Bravo contact',
              fromUserId:     data.fromUserId ?? '',
              autoAccept,
            },
          },
        });
        console.log('[notifee] navigated → IncomingGroupCallScreen room=', data.roomId);
      } else {
        (navigationRef as unknown as {navigate: (n: string, p?: unknown) => void}).navigate('Main', {
          screen: 'MessengerTab',
          params: {
            screen: 'CallScreen',
            params: {
              callType:       data.kind === 'video' ? 'video' : 'voice',
              isIncoming:     true,
              conversationId: data.conversationId ?? `direct:${data.fromUserId ?? ''}`,
              callId,
              remoteUserId:   data.fromUserId,
              remoteDeviceId: data.remoteDeviceId ? Number.parseInt(data.remoteDeviceId, 10) : 1,
              incomingSdp:    data.incomingSdp,
              autoAccept,
            },
          },
        });
        console.log('[notifee] navigated → CallScreen incoming callId=', callId);
      }
    } catch (e) {
      console.warn('[notifee] navigate failed:', (e as Error).message);
    }
  };

  notifee.onForegroundEvent(ev => { void handle(ev, 'fg'); });
  notifee.onBackgroundEvent(async ev => { await handle(ev, 'bg'); });

  // Cold-launch routing — when a notification tap LAUNCHES the app from a
  // killed state, the fg/bg event handlers above do NOT fire for the launching
  // notification; notifee surfaces it exactly once via getInitialNotification().
  // Feed it through the same handler as a synthetic PRESS so a killed-app tap
  // deep-links to the conversation (msg-wake) or the ring screen (call), rather
  // than landing on home. Previously this was never called, so a cold-launch
  // tap had no routing at all.
  void (async () => {
    try {
      const initial = await notifee.getInitialNotification();
      if (initial?.notification) {
        await handle(
          {
            type: EventType.PRESS,
            detail: {notification: initial.notification, pressAction: initial.pressAction},
          } as NotifeeEvent,
          'bg',
        );
      }
    } catch (e) {
      console.warn('[notifee] getInitialNotification routing failed:', (e as Error).message);
    }
  })();

  console.log('[notifee] event handlers installed');
}

export function stopFcmBootstrap(): void {
  unsubTokenRefresh?.();
  unsubTokenRefresh = null;
  unsubOnMessage?.();
  unsubOnMessage = null;
  started = false;
  // M-04 — stop the store-driven banner subscriber and clear its banners so
  // a sign-out doesn't leave the previous account's notifications behind.
  try {
    const {stopBackgroundMessageNotifier} = require('./backgroundMessageNotifier') as typeof import('./backgroundMessageNotifier');
    stopBackgroundMessageNotifier();
  } catch { /* notifier never started */ }
  // Teardown the CallKit/Telecom bridge so a re-login starts clean
  // (re-prompts for phone-account permission if it was revoked, and
  // drops any orphaned system-UI calls from the previous session).
  // Also drop the in-memory incoming-call cache for the same reason.
  try {

    const {teardownCallKit} = require('./callKitBridge') as typeof import('./callKitBridge');
    teardownCallKit();

    const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
    cache._resetIncomingCallCacheForTests(); // method name is "test" but applies just as well to a logout reset
  } catch { /* bridge inactive */ }
  // Tear down the Telecom event-handler subscription BEFORE clearing the guard,
  // otherwise the next login re-subscribes on top of still-live listeners and a
  // single Accept/End fires twice (double call.answer / double call.hangup).
  try { callKitUnsub?.(); } catch { /* already gone */ }
  callKitUnsub = null;
  callKitHandlersInstalled = false;
}

async function registerVoipToken(token: string): Promise<void> {
  // Round 5 / Security S3 — capture the wake key the server returns
  // and stash it in keychain so verifyVoipWake can validate inbound
  // VoIP push HMAC sigs.
  const resp = await registerToken('register-voip', token);
  if (resp && typeof resp === 'object' && typeof (resp as {wakeKeyB64?: unknown}).wakeKeyB64 === 'string') {
    try {

      const {storeVoipWakeKey} = require('./voipWakeVerify') as typeof import('./voipWakeVerify');

      const {useAuthStore} = require('@/store/authStore') as typeof import('@/store/authStore');
      const userId = useAuthStore.getState().user?.id ?? '';
      if (userId) {
        await storeVoipWakeKey(userId, '1', (resp as {wakeKeyB64: string}).wakeKeyB64);
        console.log('[fcm] VoIP wake key stored');
      }
    } catch (e) {
      console.warn('[fcm] VoIP wake key persist failed:', (e as Error).message);
    }
  }
  console.log('[fcm] VoIP token registered with messenger-service, len =', token.length);
}

async function registerDataToken(token: string): Promise<void> {
  await registerToken('register', token);
  console.log('[fcm] DATA token registered with messenger-service, len =', token.length);
}

async function registerToken(endpoint: 'register' | 'register-voip', token: string): Promise<unknown> {
  // Why: previously this returned null on missing access token AND threw on
  // 401 without retry, leaving the recipient with ZERO server-registered
  // push tokens. The user was then invisible to push.chat.sendChatWake —
  // every send to them hit `push.chat.no-tokens`. Now: (1) if no token
  // yet, attempt a refresh once before bailing; (2) on 401 from /push/*,
  // refresh-and-retry exactly once via the same single-flight chain
  // axios uses.
  const {refreshAccessTokenShared} = require('@services/api') as typeof import('@services/api');
  async function attempt(retried: boolean): Promise<unknown> {
    let access = await AsyncStorage.getItem('auth:access_token');
    if (!access) {
      if (retried) {return null;}
      try { await refreshAccessTokenShared(); } catch { return null; }
      access = await AsyncStorage.getItem('auth:access_token');
      if (!access) {return null;}
    }
    // signalDeviceId is hardcoded to 1 across the app (Phase-1 single-device
    // — see productionRuntime.ts default). The server's JwtHttpGuard
    // requires the X-Signal-Device-Id header on every authenticated POST,
    // so we set it explicitly even though there's no per-user value.
    const headers: Record<string, string> = {
      'Content-Type':       'application/json',
      'Authorization':      `Bearer ${access}`,
      'X-Signal-Device-Id': '1',
    };
    const res = await fetch(`${MSG_BASE_URL}/push/${endpoint}`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({platform: Platform.OS, token}),
    });
    if (res.status === 401 && !retried) {
      try { await refreshAccessTokenShared(); } catch { /* fall through to throw */ }
      return attempt(true);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[fcm] /push/${endpoint} failed`, res.status, body.slice(0, 200));
      throw new Error(`${endpoint} ${res.status}: ${body.slice(0, 120)}`);
    }
    // Round 5 / Security S3 — return the parsed JSON so callers (e.g.
    // registerVoipToken) can capture the per-device wake key the server
    // mints. Older /register endpoints just return `{ok: true}`.
    try { return await res.json(); } catch { return null; }
  }
  return attempt(false);
}

/**
 * Background message handler — must be set at module-top-level (NOT
 * inside React) so headless JS can pick it up when the app is killed.
 *
 * For voip-wake messages we fire a notifee call notification right
 * here so the user sees a heads-up + (on locked devices) the full-
 * screen ring UI. We do NOT depend on the WS being connected — the
 * notification payload carries everything the call screens need to
 * mount on tap (callId, callerName, kind, conversationId, optional
 * roomId/SDP).
 *
 * If the WS happens to be live too, the existing in-app ring handler
 * also fires; we de-dupe by callId in showIncomingCallNotif (notifee
 * tag stays unique per callId).
 */
// BS-MSG1 — the channel the server's chat-wake notifications target. Must
// exist before any `bravo-messages` notification (server-drawn or notifee)
// can show on Android 8+. Idempotent; safe to call repeatedly.
async function ensureMessagesChannel(): Promise<string> {
  try {
    const {default: notifee, AndroidImportance} = require('@notifee/react-native') as typeof import('@notifee/react-native');
    return await notifee.createChannel({
      id: 'bravo-messages',
      name: 'Messages',
      importance: AndroidImportance.HIGH,
      sound: 'default',
      // Keep identical to callNotification.ensureMessagesChannel — channel
      // settings are immutable after first create, so a drift here means
      // vibration silently depends on which install path ran first.
      vibration: true,
    });
  } catch (e) {
    console.warn('[fcm] ensureMessagesChannel failed:', (e as Error).message);
    return 'bravo-messages';
  }
}

// CRIT-5 — hydratePushEvent moved to ./serverWakeNotifications (shared by the
// warm + killed-app handlers). Import kept implicit via that module.

messaging().setBackgroundMessageHandler(async (remoteMessage) => {
  const data = remoteMessage?.data ?? {};
  console.log('[fcm] bg wake:', JSON.stringify(data));
  // N-02 — the caller hung up before this backgrounded device answered.
  // Dismiss any ring we drew and (when the caller gave up on an unanswered
  // call) leave a Missed-call trace, so a Doze-deferred ring can't keep ringing
  // after the call is over.
  if (data.kind === 'call-cancel' && typeof data.callId === 'string') {
    // P2-5 — full teardown (ring dismiss + Telecom reportEnded + cache
    // tombstone + optional missed-call trace), shared with the foreground path.
    await handleCallCancel(data as Record<string, string | undefined>);
    return;
  }
  if (data.kind === 'voip-wake' && typeof data.callId === 'string') {
    try {
      // Round 5 / Security S3 — verify the HMAC sig + nonce window
      // BEFORE displaying the ring notification. A captured/replayed
      // payload fails verification and the user does not ring-spam.

      const {verifyVoipWake} = require('./voipWakeVerify') as typeof import('./voipWakeVerify');

      const {useAuthStore} = require('@/store/authStore') as typeof import('@/store/authStore');
      const selfUserId = useAuthStore.getState().user?.id ?? '';
      const verdict = await verifyVoipWake({
        selfUserId,
        fields: {
          kind:     'voip-wake',
          callId:   data.callId as string,
          nonce:    typeof data.nonce === 'string' ? data.nonce : undefined,
          exp:      typeof data.exp === 'string' ? Number(data.exp) : (typeof data.exp === 'number' ? data.exp : undefined),
          sig:      typeof data.sig === 'string' ? data.sig : undefined,
        },
      });
      if (!verdict.ok) {
        console.warn(`[fcm] voip-wake DROPPED reason=${verdict.reason} call=${data.callId}`);
        return;
      }

      // §5 parity (Ranak-approved 2026-07-05, relaxes audit P1-N2): the
      // wake now carries the pseudonymous sender UUID + call kind (both
      // display-only and unsigned — ring admission stays HMAC-gated).
      // Resolve the caller's LOCAL contact name from the conversation
      // list so the ring is labeled instantly, WhatsApp-style; no
      // cleartext name ever rides FCM. Fallback stays 'Bravo contact'
      // (old server / lookup miss) and the WS `call.offer` frame still
      // refreshes the in-app UI with authoritative detail.
      const rawKind = typeof data.callKind === 'string' ? data.callKind : 'voice';
      const callKindStr: 'voice' | 'video' | 'group-voice' | 'group-video' =
        rawKind === 'video' || rawKind === 'group-voice' || rawKind === 'group-video' ? rawKind : 'voice';
      const fromUserId = typeof data.fromUserId === 'string' && data.fromUserId ? data.fromUserId : undefined;
      let callerName = 'Bravo contact';
      try {
        if (fromUserId) {
          const {useMessengerStore} = require('@/modules/messenger/store/messengerStore') as
            typeof import('@/modules/messenger/store/messengerStore');
          const convos = useMessengerStore.getState().conversations ?? {};
          for (const c of Object.values(convos)) {
            if (c.type === 'direct' && c.peer?.userId === fromUserId && c.name) {
              callerName = c.name;
              break;
            }
          }
        }
      } catch { /* store not hydrated (cold headless-ish context) — generic label */ }

      // Cache the payload BEFORE displaying any UI so an immediate
      // Telecom Accept / End tap (heads-up "Answer" before notifee
      // even renders) finds the entry. The cache is the same one
      // used by the Telecom event handlers. fromUserId/conversationId/
      // roomId fill in from the WS offer frame on reconnect.

      const cache = require('./incomingCallCache') as typeof import('./incomingCallCache');
      // Group rings reuse the roomId as the callId (gateway contract).
      const isGroupKind = callKindStr === 'group-voice' || callKindStr === 'group-video';
      // P1-BR-1 — the wake now carries conversationId + per-recipient roomToken
      // (both unsigned display/routing fields, NOT part of the HMAC). Thread them
      // so a group accept can sfu.join the host's room.
      const roomToken = typeof data.roomToken === 'string' ? data.roomToken : undefined;
      const conversationId = typeof data.conversationId === 'string' ? data.conversationId : undefined;
      const accepted = cache.setIncomingCallPayload({
        callId:         data.callId as string,
        callerName,
        kind:           callKindStr,
        fromUserId,
        conversationId,
        roomId:         isGroupKind ? (data.callId as string) : undefined,
        roomToken,
      });
      if (!accepted) {
        // Tombstoned (caller retried with same callId after a decline).
        // Skip UI display — repopulating it would expose stale SDP.
        console.warn('[fcm.bg] tombstoned callId — skipping UI for', data.callId);
        return;
      }

      // Fire BOTH ringers in parallel:
      //   notifee → covers Android baseline (lock-screen + heads-up).
      //   Telecom (Android) / CallKit (iOS) → adds system-call-UI on
      //     top, with bluetooth headset routing + recents integration.
      // De-dupe is by callId (notifee tag = `bravo-call-${callId}`,
      // Telecom uuid = callId). Both clear together on accept/end.

      const {showIncomingCallNotif} = require('./callNotification') as typeof import('./callNotification');

      const bridge = require('./callKitBridge') as typeof import('./callKitBridge');

      // Telecom's CallKitCallKind is 'voice' | 'video' — collapse the group
      // variants the same way the warm path (MainNavigator) does.
      try { bridge.reportIncomingCall({callId: data.callId as string, callerName, kind: callKindStr === 'video' || callKindStr === 'group-video' ? 'video' : 'voice'}); }
      catch (e) { console.warn('[fcm] callkit reportIncomingCall failed:', (e as Error).message); }

      await showIncomingCallNotif({
        callId:         data.callId as string,
        kind:           callKindStr,
        callerName,
        conversationId,
        fromUserId,
        roomId:         isGroupKind ? (data.callId as string) : undefined,
        roomToken,
      });
      console.log('[fcm] notifee + callkit ring displayed for callId =', data.callId);
    } catch (e) {
      console.warn('[fcm] failed to show call notif:', (e as Error).message);
    }
  } else if (data.kind === 'msg-wake') {
    // Chat-message wake. BS-MSG1 — DO NOT rely on the server's FCM
    // `notification` block to draw the banner: it targets the
    // `bravo-messages` channel, and if that channel doesn't exist yet
    // (fresh install, or a sender who isn't in the recipient's contacts
    // so no prior chat ever created it) Android silently drops it — which
    // is exactly why calls rang but messages showed nothing. Draw the
    // banner ourselves via notifee against a channel we guarantee exists.
    const explicitConvId = typeof data.conversationId === 'string' && data.conversationId ? data.conversationId : undefined;
    const senderUserId = typeof data.senderUserId === 'string' && data.senderUserId ? data.senderUserId : undefined;
    let notifierRunning = false;
    try {
      const {isBackgroundMessageNotifierRunning} = require('./backgroundMessageNotifier') as typeof import('./backgroundMessageNotifier');
      notifierRunning = isBackgroundMessageNotifierRunning();
    } catch { notifierRunning = false; }
    // P2-BR-5 — mute ONLY off the unambiguous explicit conversationId. A DM id
    // resolved from senderUserId is ambiguous (the sender may be posting to a
    // GROUP), so muting their 1:1 must not silence a group message.
    let muted = false;
    try {
      if (explicitConvId) {
        const {isConversationMuted} = require('./mutedLookup') as typeof import('./mutedLookup');
        muted = await isConversationMuted({conversationId: explicitConvId});
      }
    } catch { muted = false; }
    try {
      if (muted) {
        console.log('[fcm] msg-wake suppressed — conversation muted');
      } else if (notifierRunning) {
        // P1-8 — skip the FCM banner REGARDLESS of convId resolution; the store
        // notifier draws the correct conv-keyed banner after the pull below.
        // Drawing here off a sealed-sender wake would misattribute a group
        // message to the sender's 1:1 AND duplicate the notifier's banner.
        console.log('[fcm] msg-wake banner deferred to store notifier');
      } else {
        // No notifier alive — draw the banner ourselves (resolve the DM for
        // conv-keying / titling; N-12). B-65 — an explicit conversationId
        // (group wakes included) resolves its display name from the persisted
        // vault, so backgrounded GROUP messages banner with the group's name.
        const {resolveDirectConversation, resolveConversationMeta} = require('./mutedLookup') as typeof import('./mutedLookup');
        const resolved = explicitConvId
          ? {id: explicitConvId, name: (await resolveConversationMeta(explicitConvId))?.name}
          : (senderUserId ? await resolveDirectConversation(senderUserId) : null);
        const {showMessageNotif} = require('./callNotification') as typeof import('./callNotification');
        await showMessageNotif({conversationId: resolved?.id ?? undefined, senderUserId, title: resolved?.name});
      }
    } catch (e) {
      console.warn('[fcm] msg-wake notif failed:', (e as Error).message);
    }
    // Kick the in-app envelope poller so the recipient's local store has the
    // actual message before they tap through. P2-6 — if we deferred to the
    // notifier but it drew NOTHING (Doze pull failed, or the message was for the
    // active thread), post a fallback so a real message is never fully silent.
    try {
      const {getMessengerRuntime} = require('@/modules/messenger/runtime') as typeof import('@/modules/messenger/runtime');
      const {getMessagePostedGeneration} = require('./backgroundMessageNotifier') as typeof import('./backgroundMessageNotifier');
      const rt = await getMessengerRuntime('production');
      const genBefore = getMessagePostedGeneration();
      let pulled = false;
      if (rt && typeof (rt as unknown as {pullEnvelopes?: () => Promise<void>}).pullEnvelopes === 'function') {
        try { await (rt as unknown as {pullEnvelopes: () => Promise<void>}).pullEnvelopes(); pulled = true; }
        catch { pulled = false; }
      }
      if (notifierRunning && !muted && getMessagePostedGeneration() === genBefore) {
        const {showMessageNotif} = require('./callNotification') as typeof import('./callNotification');
        // Explicit conv → conv-keyed; else sender-keyed generic. NEVER the
        // ambiguous resolved DM (that would re-introduce the P1-8 misattribution).
        await showMessageNotif(explicitConvId ? {conversationId: explicitConvId} : {senderUserId});
        console.log('[fcm] msg-wake fallback banner (notifier drew nothing), pulled=', pulled);
      }
    } catch (e) {
      // Headless JS often can't bootstrap the full runtime — the foreground app
      // catches up via WS on next open.
      console.log('[fcm] msg-wake bg pull skipped:', (e as Error).message);
    }
  } else {
    // CRIT-5 — every other server-driven wake (booking-approved / agent-* /
    // mission-* / payout-settled / sos-cpo-alert) and opaque {eventId} wakes
    // are dispatched by the SHARED showServerWakeNotification(), the same
    // function the killed-app headless handler calls, so warm and killed paths
    // can never drift again.
    try {
      const {showServerWakeNotification} = require('./serverWakeNotifications') as typeof import('./serverWakeNotifications');
      // N-18 — warm background path: the app is alive, so record the in-app
      // bell row alongside the OS banner.
      const handled = await showServerWakeNotification(data as Record<string, unknown>, {recordActivity: true});
      if (!handled) {
        console.log('[fcm] unknown background wake kind, no action');
      }
    } catch (e) {
      console.warn('[fcm] server-wake notif failed:', (e as Error).message);
    }
  }
});
