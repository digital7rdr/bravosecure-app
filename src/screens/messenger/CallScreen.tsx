import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  StatusBar, Animated, Easing, Vibration, PermissionsAndroid, Platform,
  Modal, Pressable, PanResponder, Dimensions, AppState,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {CameraView} from 'expo-camera';
import {Audio} from 'expo-av';
import {RTCView} from 'react-native-webrtc';
import {BlurView} from '@react-native-community/blur';
import {BackHandler} from 'react-native';
import {patchActiveCall, setMinimized} from '@/modules/messenger/runtime/callRegistry';
import type {MessengerScreenProps} from '@navigation/types';
import {useMessengerStore, selectConversation} from '@/modules/messenger/store';
import {useAuthStore} from '@store/authStore';
import {useFocusEffect} from '@react-navigation/native';
import {useCall} from '@/modules/messenger/webrtc/useCall';
import {getLiveTransport, onTransport} from '@/modules/messenger/runtime/transportRegistry';
import type {IceServerConfig} from '@/modules/messenger/webrtc/types';
import {safeStreamURL} from '@/modules/messenger/webrtc/safeStreamURL';
import {resolveRemoteTile} from '@/modules/messenger/webrtc/remoteTileGate';
import {snapPipOffset} from '@/modules/messenger/webrtc/pipLayout';
import {MSG_BASE_URL} from '@utils/constants';
import InCallManager from 'react-native-incall-manager';
import {DeviceEventEmitter} from 'react-native';
// Hoisted to top so the useCall arg memo doesn't re-resolve the module on
// every render (was a synchronous `require(...)` inside the JSX call).
import {agoraStart} from '@/modules/messenger/webrtc/agoraStart';
import {withScreenErrorBoundary} from '@modules/observability';

type Props = MessengerScreenProps<'CallScreen'>;

/**
 * Audio-route helper. Prefers `InCallManager.chooseAudioRoute(route)`
 * which atomically updates AudioManager mode + speakerphone flag —
 * the only API that reliably switches routes mid-call on Android 13+.
 * Falls back to the legacy `setSpeakerphoneOn` for SPEAKER_PHONE /
 * EARPIECE on older builds where chooseAudioRoute may be missing.
 *
 * The bug this fixes: tapping the Speaker button or BT picker did
 * nothing once a video call had started. Reason — the call was
 * launched with `InCallManager.start({media: 'video'})`, which sets
 * an internal ForceSpeakerphoneOn flag that silently overrides
 * subsequent setSpeakerphoneOn() calls. chooseAudioRoute clears that
 * flag as part of the route change, so it actually takes.
 */
// Video-call backdrop — deep blue-black from the Bravo Video Call design
// (the radial vignette's dominant tone, #080B14, vs the old flat navy
// #0A1F3F). A solid fill stands in for the CSS radial gradient; it reads
// noticeably richer/darker behind the avatar + pulse rings. VISUAL ONLY.
const VC_BG = '#080B14';

// BS-CALL-CHOPPY — last route we actually pushed to the native layer.
// Several effects (speaker toggle, hold/resume, screen-on reapply, video
// upgrade, BT auto-snap) all converge on pickAudioRouteNative, and on a
// call with a Bluetooth headset paired they re-issue the SAME route within
// a few seconds of each other. Each redundant chooseAudioRoute('BLUETOOTH')
// tears down and re-establishes the SCO link (logcat: startSco/stopScoAudio
// → SCO_CONNECTED↔HEADSET_AVAILABLE churn), and every SCO renegotiation
// produces a burst of PCM output underruns (chk_out_pcm_underrun) — that's
// the choppy/stuttering audio. Skipping a route call that's already in
// effect eliminates the churn without changing any caller's logic; a real
// route change (different target) always goes through.
let lastAppliedRoute: 'SPEAKER_PHONE' | 'EARPIECE' | 'BLUETOOTH' | 'WIRED_HEADSET' | null = null;

function pickAudioRouteNative(route: 'SPEAKER_PHONE' | 'EARPIECE' | 'BLUETOOTH' | 'WIRED_HEADSET'): void {
  // Idempotence guard — see lastAppliedRoute above. Redundant re-issues of
  // the current route are the BT-SCO-flap source behind the audio underruns.
  if (route === lastAppliedRoute) {
    return;
  }
  lastAppliedRoute = route;
  // Try the modern API first. We fire BOTH paths in a defensive
  // belt-and-braces — chooseAudioRoute is the only API that reliably
  // switches BT or works mid-video-call, but for SPEAKER_PHONE /
  // EARPIECE on Android stacks where chooseAudioRoute returns a
  // Promise that rejects silently we still need setSpeakerphoneOn
  // to take effect. Worst case both run and the second one is a
  // no-op; that's cheaper than the bug where neither did anything.
  let chooseAttempted = false;
  try {
    const fn = (InCallManager as unknown as {chooseAudioRoute?: (r: string) => unknown})
      .chooseAudioRoute;
    if (typeof fn === 'function') {
      fn.call(InCallManager, route);
      chooseAttempted = true;
    }
  } catch { /* ignore — fall through */ }
  // For SPEAKER / EARPIECE always also flip the speakerphone flag —
  // it's the only thing that takes when the audio session is in
  // auto-mode (voice calls), where chooseAudioRoute is silently
  // overridden by InCallManager's auto-route logic.
  if (route === 'SPEAKER_PHONE' || route === 'EARPIECE') {
    try {
      InCallManager.setSpeakerphoneOn(route === 'SPEAKER_PHONE');
    } catch { /* ignore */ }
  }
  if (!chooseAttempted) {
    console.log('[bravo.callaudio] chooseAudioRoute missing on this build — used setSpeakerphoneOn only');
  }
}

function CallScreenInner({route, navigation}: Props) {
  const {callType, isIncoming, conversationId, callId, remoteUserId, remoteDeviceId, incomingSdp, autoAccept} = route.params;
  const insets = useSafeAreaInsets();
  // Tracks whether the component is still mounted. Several async
  // continuations (Alert.alert + setState in the upgrade-to-video
  // catch path, the BS-021 peerAddedVideo effect, the audio-permission
  // request, etc.) can resolve AFTER the user hangs up and the screen
  // unmounts. Without this guard the alerts pop up over the parent
  // screen ("Could not turn on video" appearing on the chat thread
  // 5 s after a hung-up call). Set to false in cleanup; checked
  // before every Alert.alert / setState in those async branches.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);
  // Mount-time call kind from the route — the SETUP logic below
  // (camera permission boot, audio-route default, foreground service
  // kind) keys off this and MUST NOT re-run if the call upgrades
  // mid-stream. A separate `isVideoUI` further down (after liveCall
  // is constructed) ORs in "did the live call gain a video track?"
  // and drives the layout choice between voice column vs. video grid.
  const isVideo = callType === 'video';

  const convo = useMessengerStore(selectConversation(conversationId));
  const peerName = convo?.name ?? 'Contact';
  const peerInitials = peerName.split(' ').map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() || 'B';

  // ── Real WebRTC engine wiring ────────────────────────────
  //
  // Mode = 'live' when the route carries a callId + the live socket
  // is up + we know the peer SessionAddress. Otherwise we fall back to
  // 'demo' (the prior fake state machine) so opening the screen from
  // older callsites doesn't crash. Once every callsite supplies callId
  // the demo branch can be removed.
  // Subscribe to the live transport so this screen rebinds the moment
  // the WS opens. Plain useMemo would freeze in the "null" state if the
  // socket wasn't open at mount time — leaving the call stuck on
  // peer={demo} forever even after reconnect.
  const [transport, setTransport] = useState(() => getLiveTransport());
  useEffect(() => onTransport(setTransport), []);

  // Patch the call registry with the bits CallScreen has but the
  // boot effect didn't (conversationId for routing on restore, the
  // human-readable name for the overlay). The registry is created in
  // useCall once tracks land — we just augment it here.
  useEffect(() => {
    if (!callId) {return;}
    patchActiveCall({conversationId, peerName});
  }, [callId, conversationId, peerName]);

  // Hardware back button → minimize the call instead of hanging up.
  // Sets keepAlive so useCall's unmount cleanup doesn't tear down the
  // controller; the FloatingCallOverlay then takes over rendering.
  // Returning true from the listener swallows the back event so React
  // Navigation doesn't pop us — but we also kick a navigation.goBack
  // ourselves AFTER the registry is in keep-alive mode, which is what
  // pops CallScreen and reveals the underlying screen.
  // AppState lifecycle guard — when the OS backgrounds the app during
  // an active call, mark keepAlive so cleanup paths don't tear down,
  // and on `→ active` force a tile re-render so dead native MediaStream
  // handles fall through to safeStreamURL's null path (avatar fallback)
  // instead of crashing through the JNI bridge. Same pattern as the
  // GroupCallScreen guard. Independent of the screen-on flag effect.
  // Fix #11: ONE consolidated AppState listener for the whole screen.
  // Three concerns previously each ran their own listener:
  //   (a) keep-alive on background → so cleanup paths don't tear down
  //   (b) throttled tile re-render on `→ active` → so dead native
  //       MediaStream handles fall through to safeStreamURL's null path
  //   (c) re-arm WindowManager FLAG_KEEP_SCREEN_ON for video calls
  // Multiple listeners means each fires its own native bridge call on
  // every transition, AND the second listener's cleanup couldn't see
  // the first's keepAlive write order. Consolidating gives us
  // deterministic ordering and halves the bridge cost on lock/unlock.
  const [, setAppStateTick] = useState(0);
  const lastAppStateTickRef = useRef(0);
  // Set by the audio-session effect when this is a video call so the
  // unified listener knows to re-arm setKeepScreenOn(true). Mirrored
  // through a ref so the listener doesn't have to rebind on isVideo.
  const videoArmedRef = useRef(false);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s: string) => {
      if (s === 'background' || s === 'inactive') {
        try {

          const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
          reg.patchActiveCall({keepAlive: true});
        } catch { /* ignore */ }
      } else if (s === 'active') {
        // (c) re-arm screen-on first — cheap native call, runs on every
        // active even if we throttle the tile-render below.
        if (videoArmedRef.current) {
          try { InCallManager.setKeepScreenOn(true); } catch { /* ignore */ }
        }
        // BS-CALL1 — restore the user's audio route. While the screen was
        // off (proximity during a voice call, or a manual lock) Android can
        // silently re-route audio (earpiece↔speaker). Without this the route
        // never comes back. Slightly delayed so it lands AFTER the OS has
        // finished its own post-unlock device re-evaluation.
        setTimeout(() => { try { reapplyRouteRef.current(); } catch { /* ignore */ } }, 350);
        // (b) Throttle — rapid lock/unlock cycles otherwise spam re-renders.
        const now = Date.now();
        if (now - lastAppStateTickRef.current < 1200) {return;}
        lastAppStateTickRef.current = now;
        setAppStateTick(t => t + 1);
      }
    });
    return () => sub.remove();
  }, []);

  // Audio-focus interruption guard. Mirrors GroupCallScreen — when
  // another app (incoming WhatsApp call, etc.) requests AUDIOFOCUS_LOSS
  // we mute the mic so we don't keep pumping RTP into a closed
  // AudioRecord (the symptom that froze the JS thread before we wired
  // this). User sees a "Paused" banner; we auto-clear on GAIN.
  const [audioInterrupted, setAudioInterrupted] = useState(false);
  // Ref-mirror liveCall so the focus listener + back-handler (registered
  // ONCE) always read the current state/handlers instead of capturing
  // the first render's snapshot. Without this, audio-focus events
  // fired during/after a state transition called a stale toggleMute
  // that pointed at a torn-down PC, throwing inside the JNI bridge.
  // Initialised to null and synced after `liveCall` is declared below
  // (TS hoisting won't let us pass `liveCall` to useRef up here).
  const liveCallRef = useRef<ReturnType<typeof useCall> | null>(null);
  const liveCallStateRef = useRef<string>('connecting');
  // A5 focus-gain-no-unmute — true ONLY when WE auto-muted an already-unmuted
  // user on a focus LOSS, so the GAIN branch can restore them. A user who was
  // already muted (manual) at LOSS leaves this false, so we never override
  // their choice. Mirrors GroupCallScreen's BS-FOCUS-UNMUTE.
  const autoMutedByFocusRef = useRef(false);
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('onAudioFocusChange', (data: {eventText?: string; eventCode?: number}) => {
      const code = data?.eventCode;
      if (code === -1 || code === -2) {
        console.log(`[bravo.callaudio] focus LOSS (${data.eventText}) — muting`);
        setAudioInterrupted(true);
        const lc = liveCallRef.current;
        if (lc && !lc.isMuted) {
          // Remember the mute was OURS so we can restore it on GAIN.
          try { lc.toggleMute(); autoMutedByFocusRef.current = true; } catch { /* ignore */ }
        }
      } else if (code === 1) {
        console.log('[bravo.callaudio] focus GAIN');
        setAudioInterrupted(false);
        // Auto-unmute ONLY if WE auto-muted on the matching LOSS — otherwise
        // a transient interruption (GSM call, alarm) left the caller silently
        // muted with the banner gone and no signal. A pre-interruption manual
        // mute is preserved (ref false → no unmute).
        if (autoMutedByFocusRef.current) {
          autoMutedByFocusRef.current = false;
          const lc = liveCallRef.current;
          if (lc && lc.isMuted) {
            try { lc.toggleMute(); } catch { /* ignore */ }
          }
        }
      }
    });
    return () => sub.remove();
  }, []);

  // Hardware back button:
  //   • If the call is CONNECTED → minimize (FloatingCallOverlay takes over
  //     rendering, the call keeps running). This is the WhatsApp/Messenger
  //     pattern — back ≠ end-call once the call is live.
  //   • If we're still in 'connecting' / 'calling' / 'ringing' → minimizing
  //     would strand the FloatingCallOverlay over a never-completed call.
  //     Hang up and let the goBack fall through normally so React
  //     Navigation pops us cleanly. (Returning false from the handler
  //     lets the system handle the back press as a regular pop.)
  // Round 7 / back-button audit fix #3 — track open modals via a ref so
  // the screen-level BackHandler can defer to the Modal's own
  // onRequestClose. Without this, pressing back while the "Add to call"
  // picker, the call route picker, or the in-call dialpad is open
  // closes the modal AND minimizes the call in one tap (two unrelated
  // actions in a single press). The ref is sync'd from the modal state
  // by a separate useEffect placed AFTER the modal state declarations
  // (see "modalsOpenRef sync" further down).
  const modalsOpenRef = useRef(false);
  // CALL-07 — latest-decline ref so the mount-time BackHandler (empty
  // deps) always invokes the current declineCall closure, not the first
  // render's. Synced by an effect next to declineCall's definition.
  const declineCallRef = useRef<() => void>(() => {});
  // CALLS-1to1 (#2) — guarantee End ENDS the call AND pops the screen even when
  // liveCall.state never reaches 'ended' (boot window: the controller isn't
  // built yet, so hangup() can't drive state). dismissedRef de-dupes the endCall
  // watchdog goBack against the auto-dismiss effect; tearingDown freezes the
  // heavy RTCView subtree BEFORE the pop so the native tree can't crash
  // ("child already has a parent") collapsing in the same commit (B-37 pattern).
  const dismissedRef = useRef(false);
  const [tearingDown, setTearingDown] = useState(false);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // Defer to the active Modal's onRequestClose — RN dispatches
      // BOTH events, so returning false here lets the modal close
      // and prevents the screen-level minimize from also firing.
      if (modalsOpenRef.current) { return false; }
      // WhatsApp-style: back NEVER cuts a live call — minimize it. The
      // FloatingCallOverlay shows the live state ('Calling…' / 'Ringing…' /
      // 'Connecting…' / 'On call') and tapping it restores full screen; it
      // auto-dismisses when the call reaches a terminal state. Covers
      // outgoing (calling/connecting), incoming (ringing) and active
      // (connected/reconnecting) — not only connected. Cancelling is an
      // explicit action (the End button), exactly like WhatsApp.
      const st = liveCallStateRef.current;
      // CALL-07 — back on an UNANSWERED incoming ring must DECLINE, not
      // minimize: minimizing left the caller ringing out the full 45s
      // timeout with no one on this end ever coming back to answer.
      // Outgoing-ringing ('calling') and connected keep the WhatsApp
      // minimize behaviour below.
      if (isIncoming && st === 'ringing') {
        declineCallRef.current();
        return true;
      }
      // Minimize ANY non-terminal live call — including the 'idle' boot window
      // of an outgoing call (state sits at 'idle' until startOutgoing flips it
      // to 'calling', a multi-second TURN+getUserMedia wait). Back in that
      // window used to fall through and CUT the call; gate on an actual active
      // registry call so a genuinely call-less screen still pops normally.
      try {
        const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        const live = reg.getActiveCall();
        if (live && st !== 'ended' && st !== 'failed') {
          setMinimized(true);
          try { (navigation as unknown as {goBack: () => void}).goBack(); } catch { /* ignore */ }
          return true;
        }
      } catch { /* registry unavailable (tests) — fall through to normal pop */ }
      // No live call (ended / failed / none) → normal pop.
      try { (navigation as unknown as {goBack: () => void}).goBack(); } catch { /* ignore */ }
      return true;
    });
    return () => sub.remove();
    // navigation is stable (set by React Navigation); we rebind only on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // BS-022 — default-to-minimize on ANY silent screen pop with a live
  // connected call.
  //
  // The hardware-back-press path above explicitly calls
  // setMinimized(true) BEFORE goBack(). But on Samsung S23 / OneUI the
  // system swipe-back gesture pops the native-stack screen WITHOUT
  // dispatching `hardwareBackPress`, so without this `beforeRemove`
  // listener the registry stays in `isMinimized=false` when CallScreen
  // unmounts. The audio session cleanup runs with no `keepAlive` flag,
  // the FloatingCallOverlay never appears (renders only when
  // `isMinimized=true`), but the call CONTROLLER stays in the registry
  // — leaving the user trapped: tapping a chat re-routed CallScreen
  // via the resume path, the FG service re-mounted, and they bounced
  // straight back to the call UI.
  //
  // Why `beforeRemove` instead of a useEffect cleanup: setMinimized
  // also flips `keepAlive=true`, and the audio-session cleanup at
  // line ~600 reads `keepAlive` to decide whether to stop InCallManager.
  // React runs cleanups in REVERSE registration order, so a cleanup
  // declared HERE (high in the file) would run AFTER the audio
  // cleanup — too late to influence keepAlive. `beforeRemove` fires
  // BEFORE any unmount cleanup, so the keepAlive flip is visible to
  // every downstream cleanup.
  //
  // setMinimized is idempotent + null-safe so the hardware-back, fail,
  // and explicit-hangup paths are unaffected: `setMinimized(true)`
  // either already ran (back-press) or `endActiveCall(s)` cleared the
  // registry first (fail/hangup) and the no-active-call early-out
  // makes the call a no-op.
  useEffect(() => {
    const unsubscribe = (navigation as unknown as {
      addListener: (event: string, cb: (e: unknown) => void) => () => void;
    }).addListener('beforeRemove', () => {
      try {

        const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        const live = reg.getActiveCall();
        // WhatsApp-style: a swipe-back gesture (which doesn't fire
        // hardwareBackPress on OneUI) must minimize a live call, never cut
        // it — for every non-terminal state, not just connected. The
        // overlay shows the live state and tapping it restores full screen;
        // it auto-dismisses when the call reaches a terminal state.
        const liveStates = ['idle', 'calling', 'ringing', 'connecting', 'connected', 'reconnecting'];
        if (live && !live.isMinimized && liveStates.includes(live.state)) {
          console.log('[CallScreen] silent screen-pop with live call — defaulting to minimize');
          reg.setMinimized(true);
        }
      } catch { /* registry / require may be unavailable in tests — ignore */ }
    });
    return unsubscribe;
    // navigation is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const peerUserId     = remoteUserId ?? convo?.peer?.userId;
  const liveMode       = !!(callId && transport && peerUserId);
  // Presence for the peer-offline banner shown during outgoing
  // ringing — gives the caller an early signal that the other side
  // probably won't pick up. Uses the same `presence` map ChatScreen +
  // MessengerHomeScreen read; the original draft typo'd
  // `s.peerPresence` and crashed every CallScreen mount with
  // "Cannot convert undefined value to object" because that field
  // doesn't exist on the persisted store shape.
  const _peerPresence = useMessengerStore(s2 =>
    peerUserId ? s2.presence[peerUserId] : undefined);
  const [iceServers, setIceServers] = useState<IceServerConfig[] | null>(null);

  // Pull TURN credentials before we let the hook open the PC. The
  // endpoint already exists on messenger-service. Caching them per
  // mount is fine — they're TTL-bounded server-side.
  useEffect(() => {
    if (!liveMode) {return;}
    let cancelled = false;
    void (async () => {
      try {
        // TurnController lives on messenger-service (port 3100), not
        // auth-service (3001). Hitting API_BASE_URL here returns 404 →
        // catch falls through to plain STUN, and any network with AP
        // isolation (or just symmetric NAT) can never establish ICE.
        //
        // The relay's JwtHttpGuard ALSO requires `X-Signal-Device-Id`
        // (Phase-1 single-device → always "1"). Omitting it is what
        // produced the `turn 400` warning we kept seeing — token was
        // valid but the device-id check threw BadRequest.
        //
        // Use fetchWithRefresh so an expired access-token drives the
        // SAME single-flight /auth/refresh path the axios interceptor
        // uses. Without this, a TURN fetch initiated >15 minutes after
        // login (or after Doze froze the JS context past the access
        // TTL) hits a stale token, silently falls back to STUN-only,
        // and every cross-NAT call gets stuck "connecting".
        const {fetchWithRefresh} = require('@/services/api') as typeof import('@/services/api');
        const res = await fetchWithRefresh(`${MSG_BASE_URL}/webrtc/turn-credentials`, {
          headers: {
            'X-Signal-Device-Id': '1',
          },
        });
        if (!res.ok) {throw new Error(`turn ${res.status}`);}
        const body = await res.json() as {urls: string[]; username: string; credential: string};
        if (cancelled) {return;}
        // Defensive STUN: the new server prepends a public STUN URL
        // into `body.urls` itself, but older deployments only return
        // TURN URLs. Force-include a public STUN as a separate auth-
        // free entry so the engine ALWAYS gets srflx candidates, even
        // when TURN is bricked (DNS gone, allocate-perm fails, EC2
        // down). Without this, a single bad TURN config takes every
        // cross-NAT call with it — same-LAN works (host candidates
        // suffice), different-LAN dies in 'connecting' because no
        // candidate pair ever succeeds. Two separate entries is the
        // safe form: a stuns: URL accidentally tagged with the TURN
        // username/credential is harmless (the spec says STUN ignores
        // them), but mixing is brittle across RN-WebRTC versions.
        const hasStun = body.urls.some(u => u.startsWith('stun:') || u.startsWith('stuns:'));
        const ice: IceServerConfig[] = [
          {urls: body.urls, username: body.username, credential: body.credential},
        ];
        if (!hasStun) {ice.unshift({urls: 'stun:stun.l.google.com:19302'});}
        setIceServers(ice);
      } catch (e) {
        // Fall back to plain STUN. B-41: this is only meaningful because
        // the 1:1 transport policy now defaults to 'all' (peerConnection.ts).
        // Under the old relay-only policy this fallback was DEAD — relay-only
        // discards host/srflx candidates, so a STUN-only iceServers list
        // produced zero usable candidates and the call hung forever on
        // "Answering…". With 'all', same-LAN + non-symmetric-NAT calls still
        // connect via host/srflx when TURN creds can't be fetched.
        if (!cancelled) {setIceServers([{urls: 'stun:stun.l.google.com:19302'}]);}
        console.warn('[CallScreen] TURN creds fetch failed — falling back to STUN-only (host/srflx via iceTransportPolicy=all):', (e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [liveMode]);

  // Memoize the useCall arg on stable scalars so we don't rebuild the
  // entire option object every render. Before this, every parent
  // re-render handed useCall a fresh object, which the hook compared
  // by reference for "did the call config change?" — so internal
  // effects (PC boot, mic/cam acquire) thrashed on every keystroke or
  // network tick. We key on the primitive identifiers; iceServers and
  // transport are stable once initially set, but we still include them
  // so a TURN refresh or transport reconnect can rebind the hook.
  const incomingSdpKey = !!incomingSdp;
  const callArgs = useMemo(() => {
    if (liveMode && iceServers && transport && peerUserId) {
      return {
        callId:      callId!,
        peer:        {userId: peerUserId, deviceId: remoteDeviceId ?? 1},
        kind:        callType,
        direction:   (isIncoming ? 'incoming' : 'outgoing') as 'incoming' | 'outgoing',
        incomingSdp: isIncoming ? incomingSdp : undefined,
        transport,
        iceServers,
        // ICE fails after 12s → boot Agora as the relay path. Token
        // fetch + engine init both live in agoraStart (top-level import
        // so we don't re-resolve the module on every render).
        agoraStart,
      };
    }
    // Pass benign defaults when not live yet — the hook short-circuits
    // on its own boot effect because tracks/PC never get attached.
    return {
      callId: callId ?? 'demo', peer: {userId: 'demo', deviceId: 1},
      kind: callType, direction: 'outgoing' as const,
      transport: transport as never, iceServers: iceServers ?? [],
    };
    // Deps are intentionally minimal scalars — incomingSdpKey is the
    // boolean presence (the SDP itself is set once and never changes
    // identity for the same call), and `transport` / `iceServers` are
    // stable refs that flip identity only on real reconnect / TURN
    // refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, peerUserId, remoteDeviceId, callType, isIncoming, incomingSdpKey, liveMode, transport, iceServers]);
  const liveCall = useCall(callArgs);
  // Sync the ref-mirrors declared above (Fix #2 + #3). Refs are stable
  // across renders so the listeners that read these always see the
  // latest snapshot without rebinding their subscribers.
  useEffect(() => { liveCallRef.current = liveCall; }, [liveCall]);
  useEffect(() => { liveCallStateRef.current = liveCall.state; }, [liveCall.state]);

  // Drive the legacy local UI state from the hook so the existing
  // animations/buttons keep working without rewriting the whole screen.
  // Setters route to the hook's track-level controls. Existing
  // legacy call sites use updater-style (`m => !m`) which we just
  // collapse to a toggle since both toggleMute / toggleVideo are
  // already toggles.
  const isMuted     = liveCall.isMuted;
  const setIsMuted  = (_: boolean | ((m: boolean) => boolean)) => liveCall.toggleMute();
  const isCameraOn  = !liveCall.isVideoOff;
  /**
   * Render-time call kind. Starts as `isVideo` (the route param) and
   * flips to true the moment a local video track or peer-video event
   * arrives — so a successful mid-call voice→video upgrade swaps to
   * the video grid layout without remounting the screen. We also stay
   * in video mode after a peer flips their camera (peerAddedVideo)
   * so their incoming video tile has somewhere to render.
   *
   * Once true, stays true for the rest of the call: turning the local
   * camera off via toggleVideo flips `isCameraOn`, not `isVideoUI` —
   * the m-line stays in the SDP and the remote tile / chrome stays
   * in video layout.
   */
  const isVideoUI = isVideo
    || liveCall.peerAddedVideo
    || ((liveCall.localStream?.getVideoTracks().length ?? 0) > 0);
  /**
   * Camera button handler. Two paths:
   *
   *   • The call already has a video track (initial video call, or a
   *     prior successful upgrade): toggleVideo() flips the track's
   *     enabled flag and fires the BS-021 advisory so the peer's
   *     UI updates the camera-on indicator.
   *
   *   • The call is voice-only (no video track yet): kick off the
   *     mid-call SDP renegotiation pipeline. We pre-request the
   *     Android CAMERA permission first because RN-WebRTC's
   *     getUserMedia does not auto-prompt for it (unlike iOS).
   *     Permission denial → user-facing Alert; renegotiation
   *     failure → user-facing Alert that names the failure mode so
   *     they can decide whether to retry or fall back to ending
   *     and starting a fresh video call. Successful upgrade is
   *     silent — the screen re-renders with video-mode UI as the
   *     hook's localStream / kind state propagates.
   */
  const setIsCameraOn = (_: boolean | ((c: boolean) => boolean)) => {
    const flipped = liveCall.toggleVideo();
    if (flipped) {return;}
    // Voice-only call → mid-call upgrade. Guard against double-tap
    // via the hook's isUpgrading flag (the controller has its own
    // coalesce too, but the hook flag means the button-tap is a
    // visible no-op without ANY work).
    if (liveCall.isUpgrading) {return;}
    void (async () => {
      try {
        // RN-WebRTC's getUserMedia({video:true}) on Android does NOT
        // automatically prompt for android.permission.CAMERA the way
        // iOS does — it expects the app to have requested it via
        // PermissionsAndroid first, otherwise it rejects with a
        // SecurityException-shaped error that's hard to surface
        // meaningfully. Pre-request here so the OS permission dialog
        // pops cleanly BEFORE we touch the WebRTC engine.
        if (Platform.OS === 'android') {
          const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
          if (!isMountedRef.current) {return;}
          if (r !== PermissionsAndroid.RESULTS.GRANTED) {
            Alert.alert(
              'Camera permission required',
              'Bravo Secure needs camera access to turn on video during a call. Grant access in Settings and try again.',
              [{text: 'OK'}],
            );
            return;
          }
        }
        await liveCall.upgradeToVideo();
        if (!isMountedRef.current) {return;}
        // Success — the hook's setLocalStream + isVideoOff state
        // updates have already propagated; nothing else to do here.
        // The peer's BS-021 advisory has been fired, so when their
        // own UI re-renders they'll see camera-on.
      } catch (e) {
        const msg = (e as Error)?.message ?? 'unknown error';
        // Specific messages for the cases users can actually act on;
        // generic message for everything else with the raw error in
        // a trailing line so support can debug from a screenshot.
        let title = 'Could not turn on video';
        let body  = 'Something went wrong adding video to this call. End the call and start a fresh video call to continue.';
        if (/no reanswer within/i.test(msg)) {
          title = 'Peer didn\'t respond';
          body  = 'Your contact\'s app didn\'t reply to the video upgrade. They may be on an older version of Bravo Secure. Ask them to update, or end this call and start a fresh video call.';
        } else if (/getUserMedia|permission|NotAllowedError/i.test(msg)) {
          title = 'Camera unavailable';
          body  = 'Bravo Secure couldn\'t access your camera. Another app may be using it, or permission was denied.';
        } else if (/glare|signaling|state/i.test(msg)) {
          title = 'Try again';
          body  = 'Both sides tried to change the call at the same time. Wait a moment and tap Camera again.';
        }
        if (!isMountedRef.current) {return;}
        Alert.alert(title, body + `\n\n(${msg})`, [{text: 'OK'}]);
      }
    })();
  };

  // Mid-call: peer turned ON their camera (we received call.reoffer).
  // One-shot informational Alert with a "Turn on yours too" button so
  // the user can reciprocate without hunting for the Camera button.
  // We deliberately do NOT auto-acquire their camera — privacy.
  const peerAddedVideoNoticedRef = useRef(false);
  useEffect(() => {
    if (!liveCall.peerAddedVideo) {return;}
    if (peerAddedVideoNoticedRef.current) {return;}
    peerAddedVideoNoticedRef.current = true;
    // If we already have video (either it was a video call from the
    // start, or we just upgraded ourselves first), nothing to prompt.
    if (!liveCall.isVideoOff && liveCall.localStream?.getVideoTracks().length) {return;}
    // BS-021 race: peer can turn on video at the exact moment we hang
    // up. liveCall.peerAddedVideo flips, this effect runs, but the
    // screen is mid-unmount. Without the guard, the alert pops over
    // the parent screen (chat thread) seconds after the call ended.
    if (!isMountedRef.current || hangupInFlightRef.current) {return;}
    Alert.alert(
      `${peerName} turned on video`,
      'Tap "Turn on mine" to share your camera too. The call audio stays connected either way.',
      [
        {text: 'Stay on audio'},
        {text: 'Turn on mine', onPress: () => setIsCameraOn(true)},
      ],
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveCall.peerAddedVideo]);
  const cameraFacing: 'front' | 'back' = liveCall.facing === 'user' ? 'front' : 'back';
  const setCameraFacing = (_: 'front' | 'back' | ((f: 'front' | 'back') => 'front' | 'back')) => { void liveCall.flipCamera(); };

  const [isSpeaker, setIsSpeaker] = useState(isVideo);
  const [isOnHold, setIsOnHold] = useState(false);
  const [isBlurred, setIsBlurred] = useState(false);
  const [dialpadOpen, setDialpadOpen] = useState(false);
  const [dialedDigits, setDialedDigits] = useState('');
  const [callDuration, setCallDuration] = useState(0);
  /** Picker for "Add" button — escalates 1:1 → group via the SFU path. */
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  const currentUserId = useAuthStore(s => s.user?.id ?? null);
  // BS-CALL-ADHOC — the host's OWN display name. On escalation the joiner's
  // ring must show who is calling (the host), not the host's local label for
  // the peer (`conversations[direct:<peer>].name`), which resolves to the
  // wrong contact on the joiner's device.
  const ownDisplayName = useAuthStore(s => s.user?.full_name ?? s.user?.email ?? 'Caller');
  // Fix #9: subscribe to conversations via the Zustand selector so the
  // Add-picker actually re-renders when the store mutates. The
  // previous implementation read `useMessengerStore.getState().conversations`
  // inside an IIFE in the render body — that's a one-shot read that
  // bypasses the subscription, so a conversation added DURING an open
  // call (e.g. the peer just texted us mid-call so a new conversation
  // appeared in the home list) would not show up in the picker until
  // CallScreen unmounted+remounted.
  const conversationsForPicker = useMessengerStore(s => s.conversations);
  const addPickerCandidates = useMemo(() => {
    const ownerId = currentUserId;
    return Object.values(conversationsForPicker)
      .filter(c => c.type === 'direct')
      .map(c => ({
        userId:      c.peer?.userId ?? c.id.replace(/^direct:/, ''),
        displayName: c.name ?? 'Contact',
      }))
      .filter(c => c.userId
        && c.userId !== ownerId
        && c.userId !== remoteUserId);
  }, [conversationsForPicker, currentUserId, remoteUserId]);
  /**
   * Video-call chrome auto-hide. Messenger UX: once the call is
   * connected the top bar + control row fade out after a few seconds
   * so the remote video can fill the screen; tapping anywhere on the
   * background brings them back. Voice calls don't get this — there's
   * no media to "see through" so chrome stays visible.
   */
  const [chromeVisible, setChromeVisible] = useState(true);

  // Audio routing — driven by InCallManager's onAudioDeviceChanged
  // event so we react to BT pair/unpair, wired-headset plug/unplug,
  // etc. live during the call. Without this state, the only way the
  // user could hear audio on a Bluetooth headset was to have it paired
  // BEFORE the call started; pairing mid-call left them on the
  // earpiece. The audioRoutes list also drives a small picker so users
  // with multiple BT devices (car kit + AirPods) can choose.
  type AudioRoute = 'BLUETOOTH' | 'SPEAKER_PHONE' | 'EARPIECE' | 'WIRED_HEADSET';
  const [audioRoutes, setAudioRoutes] = useState<AudioRoute[]>([]);
  const [audioRoute, setAudioRoute] = useState<AudioRoute | ''>('');
  const [routePickerOpen, setRoutePickerOpen] = useState(false);

  // Round 7 / back-button audit fix #3 — modalsOpenRef sync (the ref is
  // declared near the BackHandler effect higher up; we mutate it here
  // now that all three modal state vars are declared).
  useEffect(() => {
    modalsOpenRef.current = addPickerOpen || routePickerOpen || dialpadOpen;
  }, [addPickerOpen, routePickerOpen, dialpadOpen]);
  // Track whether we've ever auto-snapped to BT in this call. The
  // moment a BT device shows up we route to it; if the SCO link drops
  // mid-call (common on cheap headsets), the OS falls back to EARPIECE
  // — when SCO comes back, we restore whichever route the user was
  // last on (BT if they picked it, or BT-by-default if they never
  // touched the picker since BT was already up).
  //
  // `preferredRouteRef` records the user's intent. Initial state: null
  // (no explicit preference yet) → auto-snap to BT the moment it shows.
  // After the user touches the picker, it pins to whatever they chose;
  // we honour that pin on every subsequent device-list change so a BT
  // SCO drop+reconnect re-snaps to BT instead of stranding on EARPIECE.
  const preferredRouteRef = useRef<AudioRoute | null>(null);
  // BS-CALL1 — holds a closure that re-applies the CURRENT desired audio
  // route. Kept in a ref so the AppState listener (bound once, []) can
  // re-apply the route on screen-on WITHOUT capturing a stale `isSpeaker`.
  // Populated by the speaker-toggle effect below, which always sees fresh
  // state. Fixes "screen off → audio output flips and never restores".
  const reapplyRouteRef = useRef<() => void>(() => {});

  // Map the hook's CallState to the legacy 'connecting'|'connected'|'ended'
  // so all the animation effects below keep their existing checks.
  const callState: 'connecting' | 'connected' | 'ended' =
    liveCall.state === 'connected' ? 'connected'
    : liveCall.state === 'ended' || liveCall.state === 'failed' ? 'ended'
    : 'connecting';
  // True only for an incoming call that hasn't been accepted yet — drives
  // the ringing UI with Answer / Decline buttons + repeating vibration.
  // P1-BR-2 — when the user already answered from the notification
  // (autoAccept), suppress the ring surface entirely (no ringtone, no
  // second Accept button); the auto-accept effect below picks up as soon
  // as the offer SDP lands, and the status shows "Answering…/Connecting…".
  const isRinging = isIncoming && liveCall.state === 'ringing' && !autoAccept;

  // P1-BR-2 — auto-accept the incoming call once its offer SDP is present.
  // The offer may be here at mount (warm tap) OR replay later over the
  // reconnecting WS (killed-app answer) — in the latter case incomingSdpKey
  // flips true, the useCall boot re-runs, and the controller reaches
  // 'ringing' with the offer applied, at which point this fires. accept()
  // is guarded to run at most once per mount so a re-render can't double it.
  const autoAcceptedRef = useRef(false);
  useEffect(() => {
    if (!autoAccept || !isIncoming) {return;}
    if (autoAcceptedRef.current) {return;}
    // Gate on the offer being present: incomingSdpKey guarantees useCall
    // built the controller + ran handleIncomingOffer, so accept() will
    // find a pendingOfferSdp instead of no-opping the latch.
    if (!incomingSdpKey) {return;}
    if (liveCall.state !== 'ringing') {return;}
    autoAcceptedRef.current = true;
    console.log('[bravo.call] autoAccept — answering incoming call from notification');
    // B-62 — accept() failing here used to strand the call: with autoAccept
    // set, the ring UI is suppressed (isRinging above), so "retry via the
    // ring UI" was unreachable and the call sat in 'ringing'/'connecting'
    // forever behind an "Answering…" label. Retry once (a cold-boot mic/FGS
    // grant can settle within a second of the activity resuming), then end
    // the call as failed so every teardown path runs and the caller stops
    // ringing.
    void liveCall.accept().catch((e1: unknown) => {
      console.warn('[WEBRTC] accept-failed (autoAccept, attempt 1):', (e1 as Error)?.message ?? e1);
      setTimeout(() => {
        if (liveCall.state !== 'ringing') {return;}
        void liveCall.accept().catch((e2: unknown) => {
          console.warn('[WEBRTC] accept-failed (autoAccept, attempt 2) — ending call:', (e2 as Error)?.message ?? e2);
          try { liveCall.hangup(); } catch { /* already terminal */ }
        });
      }, 1500);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAccept, isIncoming, incomingSdpKey, liveCall.state]);
  const [permGranted, setPermGranted] = useState<'pending' | 'granted' | 'denied'>('pending');
  // CALL-14 — ref mirror so the failed-alert effect (keyed on call
  // state, not permission state) reads the latest verdict without
  // re-firing the alert when the permission prompt settles late.
  const permGrantedRef = useRef(permGranted);
  useEffect(() => { permGrantedRef.current = permGranted; }, [permGranted]);

  // Haptic feedback at every meaningful state transition. Keeps the user
  // informed without forcing them to read the status text:
  //   • connected      → success thump (40ms)
  //   • ended (clean)  → short closure tap (15ms)
  //   • failed         → triple buzz so it's distinguishable from a normal
  //                      hang-up — this is "something went wrong".
  useEffect(() => {
    if (callState === 'connected')              {Vibration.vibrate(40);}
    else if (liveCall.state === 'ended')        {Vibration.vibrate(15);}
    else if (liveCall.state === 'failed')       {Vibration.vibrate([0, 80, 60, 80, 60, 80]);}
  }, [callState, liveCall.state]);

  // Outgoing call: tiny "sent" buzz the moment the offer leaves the device,
  // so the caller has tactile confirmation the SDP went out before any
  // network round-trip. Only fires for outgoing.
  useEffect(() => {
    if (!isIncoming && liveCall.state === 'connecting') {Vibration.vibrate(12);}
  }, [isIncoming, liveCall.state]);

  // Ringtone for incoming calls. We DELIBERATELY do not use
  // InCallManager.startRingtone('_DEFAULT_'): its content-resolver
  // path fails with FileNotFoundException on Android 14+ Pixels
  // (logcat: "Error setting data source via ContentResolver" →
  // ENOENT), which silently swallowed all incoming-call audio.
  // Bravo ships its own WAV asset; see runtime/bravoTones.ts.
  // Vibration stays as a hardware-guaranteed fallback for silent mode.
  useEffect(() => {
    if (!isRinging) {return;}

    const tones = require('@/modules/messenger/runtime/bravoTones') as typeof import('@/modules/messenger/runtime/bravoTones');
    void tones.startRingtone();
    Vibration.vibrate([0, 800, 1200, 800], true);
    return () => {
      void tones.stopRingtone();
      Vibration.cancel();
    };
  }, [isRinging]);

  // Ringback tone for OUTGOING calls — the "calling…" beep the caller
  // hears while waiting for the callee to pick up. Same reason as
  // above for not using InCallManager.startRingback.
  useEffect(() => {
    const isOutgoingRinging = !isIncoming && liveCall.state === 'calling';
    if (!isOutgoingRinging) {return;}

    const tones = require('@/modules/messenger/runtime/bravoTones') as typeof import('@/modules/messenger/runtime/bravoTones');
    // Voice call → ringback through the earpiece (caller holds the phone
    // to their ear, system-dialer convention); video call → speaker. This
    // also keeps expo-av's speakerphone re-applies aligned with the route
    // the call wants, so answering lands on the correct output.
    void tones.startRingback(!isVideo);
    return () => {
      void tones.stopRingback();
    };
  }, [isIncoming, liveCall.state, isVideo]);

  // The "have we started the audio session yet?" flag lives on the
  // module-scoped callRegistry, NOT a useRef. Reason: when Android
  // shows the mic/camera permission dialog on the first call, RN
  // reports a quick pause/resume cycle that remounts CallScreen.
  // A useRef-based guard would reset to false on the second mount,
  // we'd call InCallManager.start() again after the first mount's
  // cleanup already stopped it, and the session would be dead.
  // Keying by callId lets the second mount see "already started"
  // and skip both start AND the unmount-stop, so the session lives
  // across the remount. Logcat tag: [bravo.callaudio].

  // Audio session lifecycle for the active call — InCallManager.start() does:
  //   • acquires the proximity wake-lock (screen turns OFF when held to ear,
  //     ON when pulled away — Android Telephony parity)
  //   • routes audio through earpiece by default (or speakerphone for video)
  //   • auto-mutes background audio (music/podcast) for the call duration
  //   • acquires a CPU wake-lock so Doze can't drop our WS during the call
  // Stop on unmount restores all of the above.
  useEffect(() => {
    if (!liveMode) {return;}
    // Why: Android 14+/targetSDK 34+ rejects startForeground(...microphone)
    // with SecurityException unless RECORD_AUDIO is already granted at
    // runtime. The permission-request effect below runs in parallel, so
    // without this gate the FGS fires before the prompt resolves and the
    // process crashes (logcat: CallForegroundService.kt:75 SecurityException).
    // Wait until the prompt has settled. On iOS permGranted is forced to
    // 'granted' synchronously so this is effectively a no-op there.
    if (permGranted !== 'granted') {return;}
    // For INCOMING calls, defer the audio session start until the user
    // actually accepts. Calling InCallManager.start() while the call is
    // still 'ringing' puts the device in MODE_IN_COMMUNICATION, which
    // routes the ringtone (startRingtone below) through the in-call
    // audio stream — quiet, often through the earpiece — instead of
    // the loud RINGER stream. That's why the callee couldn't hear the
    // ringtone: the audio session had already taken over before the
    // user even saw the incoming-call screen.
    //
    // Outgoing calls don't have this problem because there's no
    // ringtone on the offerer side — only the ringback tone, which
    // SHOULD play through the in-call stream.
    if (isIncoming && liveCall.state === 'ringing') {return;}
    // Audit CALL-N6 (2026-07-02): never (re)start the audio session on a
    // terminal call. endActiveCall clears the audioSessionStartedFor flag
    // while CallScreen is still mounted, so a state change to ended/failed
    // re-runs THIS effect and markAudioSessionStarted returns true again —
    // fully restarting InCallManager + the FG service on a dead call (audible
    // route pop, FG notification flash, and up to 4s of zombie session on a
    // 'failed' call while the alert shows). The real stop happens at unmount.
    if (liveCall.state === 'ended' || liveCall.state === 'failed') {return;}
    // Single-fire guard, keyed by callId on the module-scoped registry
    // so it survives the permission-dialog remount (Android pauses +
    // resumes the activity → RN remounts CallScreen → naive useRef
    // would reset). markAudioSessionStarted returns false on second
    // call for the same callId, so we know to skip start AND skip
    // the unmount-stop in the cleanup branch below.

    const {markAudioSessionStarted} = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
    const cidForGuard = callId ?? `pending-${liveCall.callId ?? 'noid'}`;
    if (!markAudioSessionStarted(cidForGuard)) {
      console.log('[bravo.callaudio] start skipped — already-started for', cidForGuard);
      return;
    }
    console.log(`[bravo.callaudio] start media=${isVideo ? 'video' : 'audio'} state=${liveCall.state}`);
    // Foreground service FIRST — without it Android 14+ suspends mic/
    // camera capture seconds after the screen turns off. WhatsApp /
    // Signal model. JS no-op on iOS.

    const {startCallForegroundService} = require('@/modules/messenger/runtime/callForegroundService') as typeof import('@/modules/messenger/runtime/callForegroundService');
    startCallForegroundService({kind: isVideo ? 'video' : 'voice', peer: peerName || 'Bravo Secure'});
    preferredRouteRef.current = null;
    // Reset the idempotence guard so this call's FIRST route push always
    // lands (a prior call may have left lastAppliedRoute set). See the
    // BS-CALL-CHOPPY note on pickAudioRouteNative.
    lastAppliedRoute = null;
    // `auto: true` lets InCallManager auto-manage the proximity sensor
    // — correct for voice calls (turn screen off when held to ear) but
    // wrong for VIDEO calls (you'd black out your own preview every
    // time you bring the phone close to your face). Disable auto-prox
    // for video so the screen stays on regardless of what the
    // proximity sensor reads. setKeepScreenOn alone wasn't enough
    // because the sensor was overriding the wake-lock.
    InCallManager.start({media: isVideo ? 'video' : 'audio', auto: !isVideo, ringback: ''});
    InCallManager.setKeepScreenOn(isVideo);   // video: stay awake; voice: let proximity sensor turn it off
    if (isVideo) {
      try { InCallManager.stopProximitySensor(); } catch { /* ignore */ }
    }
    // Re-arm keep-screen-on aggressively for video calls. A single
    // setKeepScreenOn call sets WindowManager FLAG_KEEP_SCREEN_ON,
    // but Android clears it on configuration changes (rotation,
    // multi-window transitions, picture-in-picture) and some OEMs
    // also drop it on AppState foreground transitions. The result
    // was the screen dimming/locking 30s into a video call.
    // Fix #11: the AppState rebind path lives in the consolidated
    // listener at the top of the component (videoArmedRef). Here we
    // only own the periodic 5s re-arm tick so the flag is never stale
    // for more than 5 seconds even if no AppState transition fires.
    let armTick: ReturnType<typeof setInterval> | null = null;
    if (isVideo) {
      const arm = () => { try { InCallManager.setKeepScreenOn(true); } catch { /* ignore */ } };
      arm();
      videoArmedRef.current = true;
      // 2s (was 5s): on a stock Pixel the screen-off timeout fired inside
      // the 5s gap before a re-arm could land. 2s keeps FLAG_KEEP_SCREEN_ON
      // fresh well inside any OEM/stock screen-off timeout.
      armTick = setInterval(arm, 2_000);
    }
    // Initial route — set the media-type default deterministically:
    // EARPIECE for voice, SPEAKER_PHONE for video. The previous code
    // tried `chooseAudioRoute('BLUETOOTH')` first and used its return
    // value to decide if BT was taken — but that function returns a
    // Promise (or some truthy object), so the `if` always evaluated
    // true even with no BT paired, and the audio session was left in
    // whatever AudioManager state the no-op BT switch produced (often
    // speakerphone-on for voice calls). The onAudioDeviceChanged
    // listener below handles mid-call BT pair: when BLUETOOTH first
    // appears in the device list it auto-snaps once. So we never need
    // to reach for BT eagerly here.
    pickAudioRouteNative(isVideo ? 'SPEAKER_PHONE' : 'EARPIECE');
    setAudioRoute(isVideo ? 'SPEAKER_PHONE' : 'EARPIECE');
    setIsSpeaker(isVideo);
    return () => {
      if (armTick) {clearInterval(armTick);}
      // Fix #11: the AppState listener now lives at the top of the
      // component; clear the flag so it stops re-arming after the
      // audio session tears down.
      videoArmedRef.current = false;
      // Three-way decision on cleanup:
      //  1. keepAlive (minimize)         → leave everything running
      //  2. registry still owns this call → permission-dialog remount;
      //     the second mount will reuse the live session, so don't
      //     stop. The actual stop happens via endActiveCall() when the
      //     call truly ends.
      //  3. registry empty or different call → the call ended, tear
      //     down audio session + FG service + clear the started flag.

      const {getActiveCall, clearAudioSessionStarted} = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
      const live = getActiveCall();
      if (live?.keepAlive) {
        console.log('[bravo.callaudio] cleanup skipped — keepAlive (minimized)');
        return;
      }
      if (live && live.callId === cidForGuard) {
        console.log('[bravo.callaudio] cleanup skipped — registry still owns call (remount)');
        return;
      }
      console.log('[bravo.callaudio] stop');
      try { InCallManager.stop(); } catch { /* ignore */ }
      // Tear down the foreground service — leaving it running would
      // keep the persistent notification visible and waste a slot in
      // Android's foreground-service quota.

      const {stopCallForegroundService} = require('@/modules/messenger/runtime/callForegroundService') as typeof import('@/modules/messenger/runtime/callForegroundService');
      stopCallForegroundService();
      clearAudioSessionStarted(cidForGuard);
    };
    // Re-fire if liveCall.state moves out of 'ringing' (incoming
    // accept) — that's when we want the audio session to start. Also
    // re-fire if isIncoming flips for any reason. permGranted is in
    // the deps so the effect re-runs the moment the OS dialog resolves
    // to 'granted' (FGS start was gated above). callId/peerName are
    // intentionally captured once at session start; re-binding would
    // tear down the live audio session on rename.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveMode, isVideo, isIncoming, liveCall.state, permGranted]);

  // BS-CALL-UPGRADE-PROX — disable the proximity sensor + keep the screen
  // on the moment a VOICE call gains video (mid-call camera upgrade, or
  // the peer turning their camera on). The main audio-session effect above
  // captures `isVideo` ONCE at mount (re-binding it would tear down the
  // live session), so a call that STARTS as voice keeps the proximity
  // sensor armed even after it becomes a video call — holding the phone to
  // your face then blanks the screen, and the route stays on the earpiece
  // (which also makes echo far more likely). Device logs confirmed this:
  // `start media=audio` fired, then `upgradeToVideo` ran, but
  // stopProximitySensor()/setKeepScreenOn(true) never did because they
  // live inside the `if (isVideo)` blocks of the mount-time effect.
  //
  // This effect keys off `isVideoUI` (the LIVE "does the call have video?"
  // flag), so it fires on upgrade. It is a no-op for calls that started as
  // video (the main effect already armed everything; re-arming is
  // idempotent) and for calls that never gain video (`isVideoUI` stays
  // false). We also re-arm setKeepScreenOn on a short tick while video is
  // live, mirroring the main effect, so an OS flag-drop can't re-sleep us.
  const videoUpgradeArmedRef = useRef(false);
  useEffect(() => {
    if (!liveMode || !isVideoUI) {return;}
    // One-time UPGRADE setup (proximity off + speaker route) — only when the
    // call GAINED video mid-session, not when it started as video (the
    // mount-time effect already did this; videoArmedRef+isVideo marks that).
    if (!(videoArmedRef.current && isVideo)) {
      console.log('[bravo.callaudio] video upgrade detected — disabling proximity, keeping screen on, routing to speaker');
      try { InCallManager.stopProximitySensor(); } catch { /* ignore */ }
      try { InCallManager.setKeepScreenOn(true); } catch { /* ignore */ }
      videoArmedRef.current = true;
      videoUpgradeArmedRef.current = true;
      // Route to speaker on upgrade ONLY if the user hasn't already pinned an
      // explicit route (BT/wired/earpiece) — honour their choice if they have.
      if (preferredRouteRef.current === null) {
        pickAudioRouteNative('SPEAKER_PHONE');
        setAudioRoute('SPEAKER_PHONE');
        setIsSpeaker(true);
      }
    }
    // Audit CALL-N7 (2026-07-02): the keep-screen-on re-arm tick now lives
    // HERE, keyed purely on isVideoUI, so it runs for BOTH started-as-video
    // AND upgraded calls. Previously the started-as-video tick lived inside
    // the audio-session effect, whose cleanup fired on the first dep change
    // (and on the permission-dialog remount) clearing armTick — and this
    // upgrade effect early-returned for started-as-video calls — so nothing
    // re-armed FLAG_KEEP_SCREEN_ON and the screen dimmed/locked mid-call.
    const arm = () => { try { InCallManager.setKeepScreenOn(true); } catch { /* ignore */ } };
    arm();
    const tick = setInterval(arm, 2_000);
    return () => { clearInterval(tick); };
  }, [liveMode, isVideoUI, isVideo]);

  // P2-BR-7 — re-foreground the call FGS with the CAMERA service type the
  // moment this 1:1 call gains video (voice→video upgrade, or the local
  // camera toggled on). Android 14 revokes while-in-use camera capture when
  // the app backgrounds unless the running foreground service declares
  // FOREGROUND_SERVICE_TYPE_CAMERA. The mount-time audio-session effect
  // starts the FGS with the kind captured at mount, so a call that STARTED
  // as voice keeps a mic-only FGS after upgrade and would lose the camera
  // on background. Mirrors GroupCallScreen's fgsKind re-foreground.
  // Idempotent: native onStartCommand re-runs goForeground with the new type.
  const fgsKindRef = useRef<'voice' | 'video'>(isVideo ? 'video' : 'voice');
  useEffect(() => {
    if (Platform.OS !== 'android') {return;}
    if (!liveMode) {return;}
    if (liveCall.state !== 'connected') {return;}
    if (permGranted !== 'granted') {return;}
    // B-69 — ratchet UP only: once the FGS holds the camera type, keep it for
    // the call's lifetime. Downgrading on camera-off and re-upgrading on
    // camera-on thrashed the FGS type (192→128→192 within 1.4 s on the
    // 2026-07-10 Pixel-7a log), and a camera-typed-FGS drop mid-capture can
    // stall the stream (black video). Holding CAMERA while the camera is off
    // is harmless — the type is a capability declaration, not an in-use flag.
    if (!isCameraOn || fgsKindRef.current === 'video') {return;}
    fgsKindRef.current = 'video';
    try {
      const {startCallForegroundService} = require('@/modules/messenger/runtime/callForegroundService') as typeof import('@/modules/messenger/runtime/callForegroundService');
      startCallForegroundService({kind: 'video', peer: peerName || 'Bravo Secure'});
    } catch { /* native module missing — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- peerName is a display-only label read at fire time; a stale value is harmless and adding it would needlessly restart the FGS
  }, [isCameraOn, liveCall.state, liveMode, permGranted]);

  // Live audio-device change listener. The native module emits
  // `onAudioDeviceChanged` whenever a BT headset connects/disconnects
  // or a wired headset is plugged/unplugged. Payload is
  //   { availableAudioDeviceList: '["BLUETOOTH","EARPIECE",...]',
  //     selectedAudioDevice:      'EARPIECE' }
  // (note: availableAudioDeviceList is a JSON-encoded string, not an
  // array — that's the module's API quirk).
  //
  // Two behaviors:
  //  1. Update local state so the picker UI reflects what's available
  //     and which is currently active.
  //  2. Auto-snap to BT the FIRST time it appears, so users who pair
  //     their headset mid-call don't have to manually switch routes.
  //     We only snap once — if the user manually picks EARPIECE after
  //     auto-snap, subsequent BT-list-change events don't override
  //     their choice.
  useEffect(() => {
    if (!liveMode) {return;}
    // Seed the picker with the CURRENT device list on mount — without
    // this, headsets paired BEFORE the call boot don't appear in the
    // picker until a manual replug, because onAudioDeviceChanged only
    // fires on transitions. Native module exposes a synchronous
    // getAudioDeviceList() returning a JSON string; iOS lacks it.
    try {
      const initial = (InCallManager as unknown as {getAudioDeviceList?: () => string})
        .getAudioDeviceList?.();
      if (typeof initial === 'string' && initial.length > 0) {
        const seed = (JSON.parse(initial) as string[])
          .filter((d): d is AudioRoute => d === 'BLUETOOTH' || d === 'SPEAKER_PHONE' || d === 'EARPIECE' || d === 'WIRED_HEADSET');
        if (seed.length > 0) {setAudioRoutes(seed);}
      }
    } catch { /* native module may lack this on iOS — fine */ }
    const sub = DeviceEventEmitter.addListener('onAudioDeviceChanged', (data: {availableAudioDeviceList?: string; selectedAudioDevice?: string}) => {
      let list: AudioRoute[] = [];
      try {
        list = (JSON.parse(data?.availableAudioDeviceList ?? '[]') as string[])
          .filter((d): d is AudioRoute => d === 'BLUETOOTH' || d === 'SPEAKER_PHONE' || d === 'EARPIECE' || d === 'WIRED_HEADSET');
      } catch { list = []; }
      setAudioRoutes(list);
      if (data?.selectedAudioDevice && (data.selectedAudioDevice === 'BLUETOOTH' || data.selectedAudioDevice === 'SPEAKER_PHONE' || data.selectedAudioDevice === 'EARPIECE' || data.selectedAudioDevice === 'WIRED_HEADSET')) {
        setAudioRoute(data.selectedAudioDevice);
      }
      // Route restoration on device-list change. Two cases:
      //
      // 1. No explicit preference yet (initial mount, or user never
      //    touched the picker) AND BT just became available → snap to
      //    BT once. Future picker changes set preferredRouteRef.
      //
      // 2. Explicit preference exists (user picked BT/SPK/EAR earlier)
      //    AND that preferred device is in the freshly-emitted list AND
      //    the OS-reported selectedAudioDevice is something else →
      //    re-apply the preference. This is the BT-drop-reconnect fix:
      //    SCO link briefly disconnects, OS falls back to EARPIECE, then
      //    BT comes back available a moment later — without this branch
      //    the audio stays on EARPIECE until the user manually re-picks.
      const sel = data?.selectedAudioDevice;
      if (preferredRouteRef.current === null) {
        if (list.includes('BLUETOOTH')) {
          preferredRouteRef.current = 'BLUETOOTH';
          try {
            (InCallManager as unknown as {chooseAudioRoute?: (r: string) => Promise<unknown> | unknown})
              .chooseAudioRoute?.('BLUETOOTH');
          } catch { /* ignore */ }
        }
      } else if (
        list.includes(preferredRouteRef.current)
        && sel !== preferredRouteRef.current
      ) {
        const target = preferredRouteRef.current;
        try {
          (InCallManager as unknown as {setForceSpeakerphoneOn?: (on: boolean) => void})
            .setForceSpeakerphoneOn?.(false);
        } catch { /* ignore */ }
        try {
          (InCallManager as unknown as {chooseAudioRoute?: (r: string) => Promise<unknown> | unknown})
            .chooseAudioRoute?.(target);
        } catch { /* ignore */ }
      }
    });
    return () => sub.remove();
  }, [liveMode]);

  // Manual route change — used by the picker UI. Wraps the async
  // chooseAudioRoute call so callers can await success and the picker
  // closes only after the route actually flips.
  const pickAudioRoute = useCallback((nextRoute: AudioRoute) => {
    // Pin the user's explicit choice so the device-list-change handler
    // restores it on the next BT SCO drop+reconnect cycle (instead of
    // stranding on EARPIECE the way the old "auto-snap once" model did).
    preferredRouteRef.current = nextRoute;
    // Optimistic UI flip — chooseAudioRoute resolves 200-1200 ms later
    // when switching to BLUETOOTH (SCO link negotiation). Painting the
    // sheet closed + the new icon immediately is what makes the swap
    // feel "smooth" to the user instead of "the button is dead".
    setAudioRoute(nextRoute);
    setRoutePickerOpen(false);
    // Force-clear speakerphone before flipping so we don't briefly
    // play through both speaker AND BT during the SCO connect window
    // (the source of the "double voice / stutter" complaint). Always
    // safe — chooseAudioRoute re-enables speaker afterward when the
    // target is SPEAKER_PHONE.
    try {
      (InCallManager as unknown as {setForceSpeakerphoneOn?: (on: boolean) => void})
        .setForceSpeakerphoneOn?.(false);
    } catch { /* ignore */ }
    void Promise.resolve(
      (InCallManager as unknown as {chooseAudioRoute?: (r: string) => Promise<unknown> | unknown})
        .chooseAudioRoute?.(nextRoute),
    ).catch(e => console.warn('[bravo.callaudio] chooseAudioRoute failed:', e));
  }, []);

  // Speaker toggle in the UI flips between SPEAKER_PHONE and EARPIECE.
  // Use chooseAudioRoute (via pickAudioRouteNative helper) — the only
  // Android API that reliably switches routes mid-call once the audio
  // session has been started with media='video'. setSpeakerphoneOn
  // alone is silently overridden by the session's ForceSpeakerphoneOn
  // flag on Android 13+, which is why the Speaker button felt dead
  // during video calls. Also mirror the audioRoute state so the picker
  // UI reflects the actual route the user is now on.
  // Fix #5: re-apply the route ONCE after we leave 'ringing'. The
  // listener above bails while ringing (correct — would silence the
  // ringtone), but if isSpeaker was toggled DURING ringing (or even
  // pre-mount via the initial-state's `isVideo` default), the deps
  // satisfied the check before the bail, so the route never landed
  // post-accept. We mark "needs reapply" while ringing and consume
  // the flag exactly once when state moves out of ringing.
  const speakerNeedsReapplyRef = useRef(false);
  const routeGuardCallStateRef = useRef<string | null>(null);
  useEffect(() => {
    if (!liveMode) {return;}
    // Don't touch audio routing during the incoming-ringing window —
    // the system ringer is playing through the RINGER stream and we
    // mustn't switch the device into call mode yet (would silence
    // the ringtone). Routing kicks in once the user accepts.
    if (isIncoming && liveCall.state === 'ringing') {
      speakerNeedsReapplyRef.current = true;
      routeGuardCallStateRef.current = liveCall.state;
      return;
    }
    // Why: the ringback/ringtone player (expo-av) flips speakerphone ON
    // when it acquires audio focus, so after any call-state transition
    // lastAppliedRoute's belief may be stale — the device can sit on
    // loudspeaker while the UI says earpiece, and the guard would skip
    // the corrective re-apply. Drop the guard once per state transition
    // so this application always reaches the hardware; same-state runs
    // (user toggles, screen-on/hold reapplies) keep the guard and the
    // BS-CALL-CHOPPY SCO-churn fix intact.
    if (routeGuardCallStateRef.current !== liveCall.state) {
      routeGuardCallStateRef.current = liveCall.state;
      lastAppliedRoute = null;
    }
    // The route the user actually wants right now: an explicit picker
    // choice (BT / wired / spk / ear) wins; otherwise it's the speaker
    // toggle. Capture it in the reapply closure so screen-on can restore
    // it after the OS flips the route during a proximity/lock blackout.
    const desired: AudioRoute = preferredRouteRef.current ?? (isSpeaker ? 'SPEAKER_PHONE' : 'EARPIECE');
    reapplyRouteRef.current = () => {
      pickAudioRouteNative(desired);
      setAudioRoute(desired);
    };
    // Re-apply unconditionally if we were just unblocked by the state
    // transition, even if isSpeaker hadn't toggled (so the value gets
    // a fresh chooseAudioRoute call after the system ringer stops).
    pickAudioRouteNative(desired);
    setAudioRoute(desired);
    speakerNeedsReapplyRef.current = false;
  }, [isSpeaker, liveMode, isIncoming, liveCall.state]);

  // Hold = mute the local mic + force-speaker-off so the peer hears
  // nothing AND we hear nothing. Resume restores both. Without this
  // wiring the Hold button was purely cosmetic — it flipped a state
  // value but didn't affect audio. WhatsApp/Telegram use the same model.
  useEffect(() => {
    if (!liveMode) {return;}
    if (isOnHold) {
      // Suspend mic capture by disabling the audio track. The PC keeps
      // the transport alive (so resume is instant), but no media frames
      // are produced. Same for any inbound: route to earpiece (quietest)
      // so the user doesn't hear noise leaking from the held side.
      try { liveCall.toggleMute(); } catch { /* ignore */ }   // mute mic
      pickAudioRouteNative('EARPIECE');
    } else {
      // On resume, only un-mute if the user hasn't independently muted
      // (the flag flips back through the hook). isMuted reflects the
      // controller state, so checking it avoids a double-toggle.
      if (isMuted) {
        try { liveCall.toggleMute(); } catch { /* ignore */ }
      }
      pickAudioRouteNative(isSpeaker ? 'SPEAKER_PHONE' : 'EARPIECE');
    }
    // intentional: only react to hold state. mute/speaker change paths
    // own their own effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnHold, liveMode]);

  // Single source of truth for the call-record append is the
  // unmount-cleanup effect below (search "cleanup-fire call record").
  // Reasoning: the previous implementation had TWO effects appending a
  // record — one keyed on `liveCall.state === 'ended'` and one on
  // unmount. They would race on rapid hangup → unmount: the state
  // effect fired, the cleanup effect saw `callRecordedRef.current ===
  // true` and bailed (good); but for unmounts that happened BEFORE the
  // state ever transitioned to 'ended' (back-press during connecting,
  // OS-killed activity), only the cleanup effect ran. Keeping just the
  // cleanup path means classification logic lives in one place.
  const callRecordedRef = useRef(false);

  // Track the live duration in a ref so the unmount-cleanup below can
  // see the actual time the call was connected — not zero. Without this
  // a brief connection that ended via unmount (e.g., back-press during
  // the 1-second window between handshake completing and 'ended' frame
  // arriving) was falsely recorded as 'missed' or 'declined' rather
  // than 'answered · 1s'.
  const callDurationRef = useRef(callDuration);
  useEffect(() => { callDurationRef.current = callDuration; }, [callDuration]);

  // Single-source-of-truth call-record append (see Fix #4). Runs ONLY
  // on unmount so it covers every termination path: clean hangup,
  // remote hangup, back-press, app-killed, nav reset. Reads the latest
  // state via refs (callDurationRef, liveCallRef) so the snapshot is
  // accurate regardless of how the call ended.
  // Classification rules:
  //   • liveCall.state === 'failed' → 'failed'
  //   • registry.connectedAtMs set OR callDuration > 0 → 'answered'
  //     (the registry's connectedAtMs is stamped from the controller's
  //     iceConnectionState/connectionState transition, so it's true
  //     even if the UI duration counter hadn't ticked yet)
  //   • else: incoming → 'missed', outgoing → 'declined'
  useEffect(() => {
    return () => {
      if (callRecordedRef.current || !conversationId) {return;}
      callRecordedRef.current = true;
      const liveDuration = callDurationRef.current;
      let everConnected = liveDuration > 0;
      try {

        const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        if (reg.getActiveCall()?.connectedAtMs !== undefined && reg.getActiveCall()?.connectedAtMs !== null) {everConnected = true;}
      } catch { /* registry is optional */ }
      const finalState = liveCallRef.current?.state;
      const outcomeAtUnmount: 'answered' | 'missed' | 'declined' | 'failed' =
        finalState === 'failed'
          ? 'failed'
          : everConnected
            ? 'answered'
            : (isIncoming ? 'missed' : 'declined');
      const peerForRecord = convo?.peer ?? {userId: peerUserId ?? '', deviceId: remoteDeviceId ?? 1};
      const recordId = `call-${callId ?? Date.now().toString(36)}`;
      console.log('[CallScreen] cleanup-fire call record', {
        conversationId, recordId, outcomeAtUnmount, duration: liveDuration, finalState,
      });
      useMessengerStore.getState().appendMessage(conversationId, {
        id:              recordId,
        conversation_id: conversationId,
        sender_id:       isIncoming ? peerForRecord.userId : 'self',
        type:            'call',
        content:         '',
        status:          'sent',
        is_encrypted:    false,
        created_at:      new Date().toISOString(),
        peer:            peerForRecord,
        call_meta: {
          kind:      callType,
          direction: isIncoming ? 'incoming' : 'outgoing',
          outcome:   outcomeAtUnmount,
          duration:  liveDuration,
        },
      });
    };
    // Empty deps so cleanup runs only on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Surface call failures so the user isn't stranded on a blank screen.
  useEffect(() => {
    if (liveCall.state === 'failed') {
      // B-05 — a 'failed' call is ALWAYS a network/transport drop (the WS
      // to the relay died, or ICE couldn't restart). It is NEVER an
      // encryption failure: every call DTLS-verifies before it can reach
      // this state. The old copy ("Could not establish a secure
      // connection") made a server/network problem look like a crypto bug.
      // Also auto-dismiss after a short beat so the user isn't stranded
      // behind the popup if they never tap OK.
      let done = false;
      const dismiss = () => { if (done) {return;} done = true; navigation.goBack(); };
      // CALL-14 — a mic/camera permission denial also lands here as
      // 'failed' (getUserMedia rejects → useCall boot fails). Showing
      // the generic "Connection lost" copy blamed the network for a
      // local permission problem. Give actionable guidance instead.
      if (permGrantedRef.current === 'denied') {
        Alert.alert(
          isVideo ? 'Microphone & camera permission required' : 'Microphone permission required',
          `Bravo Secure needs ${isVideo ? 'microphone and camera' : 'microphone'} access to make calls. ` +
          'Enable it in Settings → Apps → Bravo Secure → Permissions, then try again.',
          [{text: 'OK', onPress: dismiss}],
        );
      } else {
        Alert.alert(
          'Call ended',
          'Connection lost — couldn’t reconnect. Please try again.',
          [{text: 'OK', onPress: dismiss}],
        );
      }
      const t = setTimeout(dismiss, 4000);
      return () => clearTimeout(t);
    } else if (liveCall.state === 'ended') {
      // Auto-dismiss whenever the call ends — covers both "peer hung up
      // before we ever connected" AND "peer hung up mid-call". 50ms delay so
      // the appendMessage useEffect above gets to commit its store update
      // before this screen unmounts. dismissedRef de-dupes against the endCall
      // watchdog so the two paths can't both pop (the 2nd lands on the parent).
      const t = setTimeout(() => {
        if (dismissedRef.current) {return;}
        dismissedRef.current = true;
        navigation.goBack();
      }, 50);
      return () => clearTimeout(t);
    }
    // isVideo is a route-derived const — inert in deps, satisfies the lint.
  }, [liveCall.state, navigation, callDuration, isVideo]);

  useEffect(() => {
    void (async () => {
      if (Platform.OS !== 'android') { setPermGranted('granted'); return; }
      // BLUETOOTH_CONNECT (Android 12+, API 31): InCallManager's BT
      // route discovery returns an empty device list without it, so
      // chooseAudioRoute('BLUETOOTH') silently fails AND the route
      // picker UI never opens because audioRoutes stays []. PermissionsAndroid
      // exposes it as the literal string on platforms below 31, so guard
      // by Platform.Version. We treat denial as non-fatal — the call still
      // works on the earpiece/speaker, just not BT.
      const needed = [
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        ...(isVideo ? [PermissionsAndroid.PERMISSIONS.CAMERA] : []),
      ];
      const optional: string[] = [];
      const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : Number.parseInt(String(Platform.Version), 10);
      if (apiLevel >= 31) {
        optional.push('android.permission.BLUETOOTH_CONNECT');
      }
      try {
        const results = await PermissionsAndroid.requestMultiple([...needed, ...optional] as never);
        const ok = needed.every(p => results[p] === PermissionsAndroid.RESULTS.GRANTED);
        setPermGranted(ok ? 'granted' : 'denied');
        // BT denial is non-blocking — log and continue.
        if (apiLevel >= 31 && results['android.permission.BLUETOOTH_CONNECT'] !== PermissionsAndroid.RESULTS.GRANTED) {
          console.warn('[CallScreen] BLUETOOTH_CONNECT not granted — BT route picker will be unavailable');
        }
      } catch {
        setPermGranted('denied');
      }
    })();
  }, [isVideo]);

  // Debounce the End / Decline buttons so a rapid double-tap can't fire
  // two `liveCall.hangup()` + `navigation.goBack()` cycles. Without this
  // ref the second goBack pops the PARENT screen — user lands two
  // screens deep with no idea why. We also surface it to the
  // `beforeRemove` listener (BS-022 minimise gesture) below so a swipe-
  // back during a hangup doesn't briefly minimise to a registry that's
  // about to clear (FloatingCallOverlay flicker).
  //
  // Single dismissal path: endCall does NOT call navigation.goBack()
  // directly. liveCall.hangup() flips controller state to 'ended' →
  // useCall.onState fires → liveCall.state becomes 'ended' → the
  // auto-dismiss effect at the top of this file pops the screen with
  // a 50ms delay (giving appendMessage time to commit the call-record
  // bubble first). The previous code called BOTH paths and the second
  // goBack landed on the parent screen ~50ms after CallScreen unmounted,
  // popping it too. The flag on `endingNow` is read by the beforeRemove
  // gesture handler below so a swipe-back during a hangup doesn't
  // minimise into a registry that's about to clear.
  const hangupInFlightRef = useRef(false);
  const endCall = () => {
    if (hangupInFlightRef.current) {return;}
    hangupInFlightRef.current = true;
    setTearingDown(true); // freeze the RTCView tree before the pop
    Vibration.vibrate([0, 80, 60, 80]);
    try { liveCall.hangup(); } catch { /* idempotent */ }
    // Belt-and-suspenders teardown — idempotent, and covers the boot-window
    // case where the controller is null so hangup() can't flip state to 'ended'.
    try {
      const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
      reg.endActiveCall('ended', 'local');
    } catch { /* ignore */ }
    // Watchdog: if state never reaches 'ended' (so the auto-dismiss effect never
    // fires), force the pop. dismissedRef de-dupes against that effect.
    setTimeout(() => {
      if (dismissedRef.current) {return;}
      dismissedRef.current = true;
      try { (navigation as unknown as {goBack: () => void}).goBack(); } catch { /* ignore */ }
    }, 800);
  };
  const declineCall = () => {
    if (hangupInFlightRef.current) {return;}
    hangupInFlightRef.current = true;
    setTearingDown(true);
    Vibration.cancel();
    try { liveCall.decline(); } catch { /* idempotent */ }
    // Auto-dismiss effect handles navigation.goBack().
  };
  // CALL-07 — keep the BackHandler's decline path on the latest closure.
  useEffect(() => { declineCallRef.current = declineCall; });

  // Minimise = go back to Chat without ending the call. Silent (no buzz).
  const minimise = () => navigation.goBack();

  /**
   * Escalate the active 1:1 call to a group call by adding `pickedUserId`
   * as a third participant. We end the P2P leg first, then route through
   * the SFU path (`launchCall`-equivalent) with both the original peer
   * AND the picked user in the recipient list. The original peer's
   * existing CallScreen tears down on the call.hangup signal we just
   * fired, then their app rings via `sfu.ring.incoming` like any group
   * call invite. The newcomer rings the same way.
   */
  const escalateToGroupCall = (picked: {userId: string; displayName: string}): void => {
    console.log('[add-call] escalate picked=', picked.userId, 'name=', picked.displayName, 'remoteUserId=', remoteUserId, 'conversationId=', conversationId);
    if (!remoteUserId) {
      console.warn('[add-call] aborted — no remoteUserId on this call');
      Alert.alert('Add failed', 'Original call peer is unknown.');
      return;
    }
    setAddPickerOpen(false);
    Vibration.vibrate(20);
    try { liveCall.hangup(); } catch { /* best effort */ }
    // Use a synthetic conversation id so the SFU room key doesn't
    // collide with the underlying 1:1 conversation. The chat history
    // bubble for the group call still lands on the original
    // conversation via the `conversationId` param if you pass it —
    // here we keep them isolated so the bubble doesn't pollute the
    // 1:1 thread mid-conversation.
    const groupConvoId = conversationId; // keep the bubble on the same chat
    const ownerId = currentUserId;
    const recipientUserIds = Array.from(new Set(
      [remoteUserId, picked.userId].filter(uid => uid && uid !== ownerId),
    ));
    // BS-CALL-ADHOC — advertise the HOST's own name to the ring. Using the
    // local conversation name here sent the host's label for the OTHER party,
    // so the joiner saw the wrong (often their own saved) name on the
    // incoming call. The host's display name is unambiguous on every device.
    const callerLabel = ownDisplayName;
    console.log('[add-call] navigating → GroupCallScreen recipients=', recipientUserIds, 'caller=', callerLabel);
    navigation.replace('GroupCallScreen', {
      conversationId:   groupConvoId,
      callType,
      direction:        'outgoing',
      recipientUserIds,
      callerName:       callerLabel,
    });
  };

  // Hide the root tab bar while the call is live — immersive feel.
  // MessengerNavigator (native stack) lives directly inside MainNavigator
  // (bottom tab), so the stack's direct parent IS the tab navigator.
  // Fix #44: useFocusEffect instead of useEffect. With plain useEffect,
  // the parent tab navigator may not be reachable on the very first
  // mount (the screen is still being attached to the stack), so the
  // initial setOptions is a no-op against `undefined`. useFocusEffect
  // fires after the screen is actually focused, which is when the
  // parent chain is reliably resolvable.
  useFocusEffect(
    useCallback(() => {
      const tabNav = navigation.getParent();
      tabNav?.setOptions({tabBarStyle: {display: 'none'}});
      return () => tabNav?.setOptions({tabBarStyle: undefined});
    }, [navigation]),
  );

  // (Removed dead expo-av Audio.setAudioModeAsync effect — it was
  // listed under [isSpeaker] but its body never read isSpeaker, so it
  // was a no-op that fired on every speaker toggle. Worse, expo-av
  // and react-native-incall-manager fight for AudioManager mode on
  // Android, so calling Audio.setAudioModeAsync mid-call could
  // silently undo the route InCallManager.chooseAudioRoute just set.
  // Speaker routing now flows entirely through pickAudioRouteNative
  // in the [isSpeaker] effect above.)

  // Haptic feedback on any control toggle — every button feels physical.
  const tap = (fn: () => void) => () => { Vibration.vibrate(12); fn(); };

  // Pulse rings for voice call
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  // Waveform bars
  const bars = useRef(Array.from({length: 11}, () => new Animated.Value(0.2))).current;

  useEffect(() => {
    if (callState !== 'connected') {return;}
    if (isOnHold) {return;} // Pause the clock while held — matches expectation.
    // Anchor the timer to callRegistry.connectedAtMs so the displayed
    // duration survives CallScreen unmount/remount across minimize.
    // The previous code stored callDuration purely in local state, so
    // minimizing (which unmounts CallScreen) lost the count and the
    // restore showed 0:00. Re-derive on every tick from the registry's
    // wall-clock anchor (set in useCall.onState when state hits
    // 'connected') so the timer just keeps counting.

    const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
    // Fix #7: once the registry's wall-clock anchor lands we must
    // ALWAYS prefer it over the local-fallback counter — drift between
    // the two paths produced jumpy values when the anchor flipped from
    // null → set mid-call (e.g. ICE took 2.5 s, the local fallback had
    // already advanced to 3, then the anchor landed and we needed to
    // snap to ~2 to match the peer). `anchored` latches true the first
    // time we read a startMs so subsequent null reads (registry briefly
    // cleared during a transition) don't fall back to the local
    // counter and double-tick.
    let anchored = false;
    const tick = (): void => {
      const startMs = reg.getActiveCall()?.connectedAtMs;
      if (startMs) {
        anchored = true;
        setCallDuration(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
      } else if (!anchored) {
        // Local fallback — only used in the brief window before useCall
        // stamps connectedAtMs. Once anchored we never come back here.
        setCallDuration(d => d + 1);
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [callState, isOnHold]);

  useEffect(() => {
    // Pulse rings always loop (decorative, independent of mic state).
    const loops: Animated.CompositeAnimation[] = [];
    const createPulse = (anim: Animated.Value, delay: number) => {
      // Fix #10: explicitly reset to 0 at the start of each loop
      // iteration. Without the reset Animated.loop replays the
      // sequence in place, but the underlying value never returns to 0
      // — it stays at 1 (the toValue from the previous iteration), so
      // the second iteration's `timing(...toValue:1)` is a no-op and
      // the ring stops pulsing after one cycle. duration:0 snap is the
      // canonical fix (see VoiceCallScreen.tsx:36-48 for the same
      // pattern).
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(anim, {toValue:0, duration:0, useNativeDriver:true}),
          Animated.delay(delay),
          Animated.timing(anim, {toValue:1, duration:2400, easing:Easing.out(Easing.ease), useNativeDriver:true}),
        ]),
      );
      loops.push(loop);
      loop.start();
    };
    createPulse(ring1, 0);
    createPulse(ring2, 900);

    // Idle waveform — quiet baseline motion so bars aren't flat before we get
    // the first mic reading. Real mic levels will override once recording starts.
    bars.forEach((bar, i) => {
      const delay = [0, 100, 200, 300, 150, 50, 200, 300, 200, 100, 0][i] || 0;
      const loop = Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(bar, {toValue:0.35, duration:550, easing:Easing.inOut(Easing.ease), useNativeDriver:true}),
          Animated.timing(bar, {toValue:0.2,  duration:550, easing:Easing.inOut(Easing.ease), useNativeDriver:true}),
        ]),
      );
      loops.push(loop);
      loop.start();
    });

    return () => {
      loops.forEach(l => l.stop());
    };
  }, [ring1, ring2, bars]);

  // ── Live mic level → waveform bars (voice call only) ──────────────────
  // When the call is connected and the user hasn't muted, sample the device
  // microphone every 100ms and drive the bar heights off the actual audio
  // level. Gives the same "this is really listening to me" feel as WhatsApp.
  //
  // Round 2 / Battery audit: gate the poll on AppState=active. When the
  // user backgrounds the app during a voice call (the most common path),
  // the bars aren't visible so the poll just burns battery — opening a
  // SECOND Audio.Recording on top of the WebRTC mic capture, hopping
  // the JNI bridge 10 times per second, and re-rendering 11 Animated
  // values each tick. Pause the poll until the app comes back to
  // foreground.
  const [appIsActiveForMicPoll, setAppIsActiveForMicPoll] = useState(
    () => AppState.currentState === 'active',
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      setAppIsActiveForMicPoll(s === 'active');
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (isVideo) {return;}
    if (callState !== 'connected') {return;}
    if (permGranted !== 'granted') {return;}
    if (isMuted) {return;}
    if (!appIsActiveForMicPoll) {return;}

    let recording: Audio.Recording | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    void (async () => {
      try {
        await Audio.setAudioModeAsync({allowsRecordingIOS: true, playsInSilentModeIOS: true});
        const rec = new Audio.Recording();
        await rec.prepareToRecordAsync({
          ...Audio.RecordingOptionsPresets.LOW_QUALITY,
          isMeteringEnabled: true,
        });
        await rec.startAsync();
        if (cancelled) { await rec.stopAndUnloadAsync().catch(() => {}); return; }
        recording = rec;
        pollTimer = setInterval(() => {
          void (async () => {
            try {
              const st = await rec.getStatusAsync();
              // `metering` is dB: roughly [-60, 0]. Map to [0.15, 1.0].
              const db = (st as {metering?: number}).metering ?? -60;
              const norm = Math.max(0, Math.min(1, (db + 60) / 60));
              bars.forEach(bar => {
                // Randomise per-bar so all 11 don't move in lockstep.
                const jitter = 0.7 + Math.random() * 0.6;
                bar.setValue(Math.max(0.15, Math.min(1, norm * jitter)));
              });
            } catch { /* ignore transient poll errors */ }
          })();
        }, 100);
      } catch {
        // Mic access denied or recording failed — fall back to idle loop.
      }
    })();

    return () => {
      cancelled = true;
      if (pollTimer) {clearInterval(pollTimer);}
      if (recording) {recording.stopAndUnloadAsync().catch(() => {});}
    };
  }, [isVideo, callState, permGranted, isMuted, bars, appIsActiveForMicPoll]);

  // Chrome auto-hide for video calls. Fires only once the call is
  // CONNECTED — during ringing/connecting the user needs the buttons
  // visible (Decline, Mute, etc.). 3.5s after the last show, fade out.
  // The picker modals reset the timer so the chrome doesn't snap away
  // mid-interaction.
  useEffect(() => {
    // Use isVideoUI (not isVideo) so a successful mid-call upgrade
    // engages the auto-hide chrome behaviour without remount.
    if (!isVideoUI) {return;}
    if (callState !== 'connected') { setChromeVisible(true); return; }
    if (addPickerOpen || routePickerOpen || dialpadOpen) { setChromeVisible(true); return; }
    if (!chromeVisible) {return;}
    const timer = setTimeout(() => {
      setChromeVisible(false);
      console.log('[bravo.callchrome] auto-hide');
    }, 3500);
    return () => clearTimeout(timer);
  }, [isVideoUI, callState, chromeVisible, addPickerOpen, routePickerOpen, dialpadOpen]);

  const toggleChrome = useCallback(() => {
    setChromeVisible(v => {
      console.log(`[bravo.callchrome] toggle ${v ? 'visible→hidden' : 'hidden→visible'}`);
      return !v;
    });
  }, []);

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = String(s % 60).padStart(2, '0');
    return `${String(m).padStart(2, '0')}:${sec}`;
  };

  const BAR_HEIGHTS = [16, 26, 36, 28, 44, 32, 44, 28, 36, 24, 16];

  // ── Draggable PiP ───────────────────────────────────────
  // Animated.ValueXY tracks the user-driven offset from the PiP's
  // resting position (bottom-right). PanResponder owns the gestures;
  // on release we clamp the position into the visible viewport so the
  // tile can never be flung off-screen.
  const PIP_W = 108;
  const PIP_H = 148;
  const win = Dimensions.get('window');
  const pipPan = useRef(new Animated.ValueXY({x: 0, y: 0})).current;
  // Fix #8: track Animated.Value's value via a listener instead of
  // poking the private `_value` field. The private-field path is
  // guaranteed to read-of-stale on iOS Hermes once Reanimated 3 lands
  // (the field is a getter that calls into a JSI-backed accessor and
  // can be torn down between native and JS frames). The listener is
  // the public, supported way and gives us the same per-frame value.
  const pipPanValueRef = useRef({x: 0, y: 0});
  // Distance threshold (squared, to avoid sqrt) above which we treat
  // a gesture as a real drag instead of a tap. Mirrors the standard
  // 4 dp slop used elsewhere in the app.
  const TAP_SLOP_SQ = 16;
  const pipGrantPosRef = useRef<{x: number; y: number} | null>(null);
  useEffect(() => {
    const idX = pipPan.x.addListener(({value}) => { pipPanValueRef.current.x = value; });
    const idY = pipPan.y.addListener(({value}) => { pipPanValueRef.current.y = value; });
    return () => {
      pipPan.x.removeListener(idX);
      pipPan.y.removeListener(idY);
    };
  }, [pipPan]);
  const pipResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        const x = pipPanValueRef.current.x;
        const y = pipPanValueRef.current.y;
        pipGrantPosRef.current = {x, y};
        pipPan.setOffset({x, y});
        pipPan.setValue({x: 0, y: 0});
      },
      onPanResponderMove: Animated.event([null, {dx: pipPan.x, dy: pipPan.y}], {useNativeDriver: false}),
      onPanResponderRelease: () => {
        pipPan.flattenOffset();
        // Tap-through detection — if the finger barely moved between
        // grant and release, treat as a tap. CallScreen's PiP equivalent
        // of the floating-overlay tap-to-restore is "show the call
        // chrome" — for the user this is the gesture that resurfaces
        // controls without forcing them to hunt for the empty area
        // outside the PiP.
        const start = pipGrantPosRef.current;
        const end = pipPanValueRef.current;
        if (start) {
          const ddx = end.x - start.x;
          const ddy = end.y - start.y;
          if (ddx * ddx + ddy * ddy < TAP_SLOP_SQ) {
            // Tap → toggle chrome (parity with the underlying tap-catcher).
            try { setChromeVisible(v => !v); } catch { /* ignore */ }
            pipGrantPosRef.current = null;
            return;
          }
        }
        pipGrantPosRef.current = null;
        // Parity plan §6 (G5) — spring to the NEAREST CORNER (WhatsApp
        // behavior) instead of parking mid-screen wherever the finger
        // stopped. The PiP resting position is bottom:140, right:16;
        // snapPipOffset maps the release offset to the closest of the
        // four corner rails, staying clear of the header chrome (top)
        // and the control row (bottom).
        const restingLeft = win.width - PIP_W - 16;
        const restingTop  = win.height - PIP_H - 140;
        const snapped = snapPipOffset({
          winW: win.width, winH: win.height,
          pipW: PIP_W, pipH: PIP_H,
          restingLeft, restingTop,
          dx: pipPanValueRef.current.x,
          dy: pipPanValueRef.current.y,
          margin: 16, topInset: 120, bottomInset: 140,
        });
        Animated.spring(pipPan, {
          toValue: snapped,
          useNativeDriver: false, friction: 7, tension: 80,
        }).start();
      },
    }),
  ).current;

  // Fix #43: lift the Add-picker Modal out of both return-trees into a
  // single shared expression. Previously it was duplicated byte-for-byte
  // inside the video and voice JSX subtrees because each branch is a
  // separate `return (...)` — meaning a Modal placed in one didn't exist
  // in the other and `setAddPickerOpen(true)` had nothing to listen for
  // it. The cost of keeping two copies in sync is now fixed: any future
  // change to the picker UI lives in exactly one place.
  const addPickerModal = (
    <Modal
      visible={addPickerOpen}
      transparent
      animationType="slide"
      onRequestClose={() => setAddPickerOpen(false)}>
      <Pressable style={styles.dialpadBackdrop} onPress={() => setAddPickerOpen(false)}>
        <Pressable style={styles.addPickerSheet}>
          <Text style={styles.addPickerTitle}>Add to call</Text>
          <Text style={styles.addPickerHint}>
            Pick someone to invite. Your current 1:1 will end and a fresh
            group call rings everyone (including {peerName || 'your peer'}).
          </Text>
          <View style={styles.addPickerList}>
            {addPickerCandidates.length === 0 ? (
              <Text style={styles.addPickerEmpty}>
                No other contacts to add. Start a chat with someone first.
              </Text>
            ) : (
              addPickerCandidates.map(c => (
                <TouchableOpacity
                  key={c.userId}
                  style={styles.addPickerRow}
                  activeOpacity={0.75}
                  onPress={() => escalateToGroupCall(c)}>
                  <View style={styles.addPickerAvatar}>
                    <Text style={styles.addPickerAvatarTxt}>
                      {c.displayName.slice(0, 2).toUpperCase()}
                    </Text>
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={styles.addPickerName} numberOfLines={1}>{c.displayName}</Text>
                    <Text style={styles.addPickerSub} numberOfLines={1}>{c.userId.slice(0, 12)}</Text>
                  </View>
                  <Icon name="phone-plus" size={18} color="#5B8DEF" />
                </TouchableOpacity>
              ))
            )}
          </View>
          <TouchableOpacity
            style={styles.addPickerCancel}
            onPress={() => setAddPickerOpen(false)}
            activeOpacity={0.75}>
            <Text style={styles.addPickerCancelTxt}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );

  if (isVideoUI) {
    return (
      <View style={styles.videoRoot}>
        <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
        {/* Background gradient simulation */}
        <View style={styles.videoBg} />
        {/* Top + bottom gradient overlays — these are dark scrims that
            sit ABOVE the remote video to make the chrome (top bar +
            bottom controls) legible. When the user taps to hide the
            chrome, the scrims must hide WITH it; otherwise they keep
            darkening the remote's face for no reason and the user
            sees a permanent vignette over the call. Tied to the same
            chromeVisible flag so the fade is in lockstep with the
            controls — no separate animation needed. */}
        {chromeVisible && (
          <>
            <View style={styles.videoTopGrad} pointerEvents="none" />
            <View style={styles.videoBottomGrad} pointerEvents="none" />
          </>
        )}

        {audioInterrupted && (
          <View style={[styles.audioInterruptBanner, {top: insets.top + 8}]} pointerEvents="none">
            <Icon name="phone-paused" size={14} color="#FCD34D" />
            <Text style={styles.audioInterruptTxt} numberOfLines={1}>
              Paused — another call is using your audio
            </Text>
          </View>
        )}

        {chromeVisible && (
        /* Top bar */
        <View style={[styles.videoTopBar, {paddingTop: insets.top + 8}]}>
          <View>
            <View style={{flexDirection: 'row', alignItems: 'center'}}>
              <Text style={styles.videoName}>{peerName}</Text>
              {/* Audit CALL-N14 — surface the peer's muted state (remoteMuted
                  was plumbed but never rendered). */}
              {liveCall.remoteMuted && callState === 'connected' && (
                <Icon name="microphone-off" size={16} color="#F87171" style={{marginLeft: 8}} />
              )}
            </View>
            <View style={styles.connectedRow}>
              <View style={[styles.connectedDot, callState !== 'connected' && {backgroundColor: '#fbbf24'}]} />
              <Text style={styles.connectedText}>
                {
              isRinging
                ? `Incoming ${callType === 'video' ? 'video ' : ''}call…`
                : callState === 'connecting'
                  ? (isIncoming ? 'Answering…' : 'Calling…')
                  : callState === 'ended'
                    ? 'Ended'
                    : `Connected · ${formatDuration(callDuration)}`
            }
              </Text>
            </View>
          </View>
          <View style={styles.videoTopRight}>
            {/* Signal bars */}
            <View style={styles.signalBars}>
              {[6, 9, 12, 15].map((h, i) => (
                <View key={i} style={[styles.sigBar, {height: h}]} />
              ))}
              <View style={[styles.sigBar, {height: 18, opacity: 0.2}]} />
            </View>
            {/* AES badge — now reports live DTLS-SRTP cipher when secure */}
            <View style={styles.aesBadge}>
              <Icon name="lock" size={11} color="#4ade80" />
              <Text style={styles.aesText}>
                {liveCall.dtls?.srtpCipher
                  ? `${liveCall.dtls.srtpCipher.replace(/_/g, ' ')}`
                  : 'DTLS-SRTP'}
              </Text>
            </View>
            {/* Live call quality strip — RTT / jitter / packet-loss */}
            {callState === 'connected' && (
              <View style={styles.qualityStrip}>
                <Text style={[styles.qualityKey, {color: liveCall.stats.rttMs === null ? '#7E8AA6' : liveCall.stats.rttMs < 100 ? '#00C853' : liveCall.stats.rttMs < 250 ? '#FFC107' : '#FF3B3B'}]}>
                  {liveCall.stats.rttMs !== null ? `${liveCall.stats.rttMs}ms` : '—'}
                </Text>
                <Text style={styles.qualityLbl}>RTT</Text>
                {liveCall.stats.packetLossPct !== null && (
                  <>
                    <Text style={[styles.qualityKey, {color: liveCall.stats.packetLossPct < 2 ? '#00C853' : liveCall.stats.packetLossPct < 5 ? '#FFC107' : '#FF3B3B'}]}>
                      {liveCall.stats.packetLossPct}%
                    </Text>
                    <Text style={styles.qualityLbl}>LOSS</Text>
                  </>
                )}
              </View>
            )}
          </View>
        </View>
        )}

        {/* Remote avatar (center) — only shown while we don't yet have
            a remote video track. The moment the peer's stream lands we
            drop this overlay so the call goes full-screen video. */}
        {!liveCall.remoteStream && (
          <View style={styles.videoAvatarWrap} pointerEvents="none">
            {/* Pulse rings while ringing/calling/connecting — stop once
                the peer's media lands (this whole overlay unmounts then). */}
            {callState !== 'connected' && <PulseRings size={300} />}
            <View style={styles.videoAvatar}>
              <View style={styles.videoAvatarInner} />
              <Text style={styles.videoAvatarText}>{peerInitials}</Text>
            </View>
          </View>
        )}

        {/* BS-CALL3 — removed the call-variant offline warning (video flow).
            See the voice-flow note above: no red "may be offline" bar during
            an unanswered call; ringing stays calm and ends cleanly. */}

        {/* Remote video — fills the screen behind chrome when the peer's
            stream lands. zOrder=0 keeps it on the underlying surface so
            the PiP (zOrder=1) can layer on top on Android.
            BS-021: when the peer flips their camera off, the RN-WebRTC
            SurfaceView keeps painting the LAST decoded frame because
            RTP just stops — there's no tear-down signal at the native
            layer. We mirror the peer's `cameraOff` state via the
            `call.media-state` advisory and swap in a placeholder so
            the receiver can tell intentional disable from a frozen
            connection. The remote stream stays attached (audio keeps
            flowing); only the video tile renders the placeholder. */}
        {(() => {
          // CALLS-1to1 (#2) — during teardown freeze the heavy RTCView subtree
          // to a stable, constant-keyed placeholder so the native tree can't
          // crash ("child already has a parent") collapsing in the same commit
          // as the screen pop.
          if (tearingDown) {return <View key="remote-teardown" style={StyleSheet.absoluteFill} />;}
          // Audit CALL-N2 (2026-07-02): only mount the RTCView when the remote
          // actually HAS a live video track and hasn't toggled it off. An
          // audio-only remote stream still yields a valid streamURL, so the old
          // `remoteUrl && !remoteVideoOff` gate mounted a full-screen BLACK
          // SurfaceView whenever the peer stayed on audio (e.g. you upgrade a
          // voice call to video and they decline) — the user saw only their PiP
          // on black. `remoteHasVideo` was built for exactly this but was only
          // used as the RTCView key, never as the mount gate.
          if (!liveMode || !isVideoUI) {return null;}
          // O-E/O-F — the mount decision lives in resolveRemoteTile
          // (webrtc/remoteTileGate.ts) so this screen and the minimized
          // FloatingCallOverlay render the same audited CALL-N2 gate,
          // and the remount key carries the remote video TRACK id (a
          // replaced track with an unchanged stream id must rebind).
          const gate = resolveRemoteTile({
            remoteVideoOff:  !!liveCall.remoteVideoOff,
            remoteHasVideo:  !!liveCall.remoteHasVideo,
            hasRemoteStream: !!liveCall.remoteStream,
            streamURL:       safeStreamURL(liveCall.remoteStream),
            videoTrackId:    liveCall.remoteStream?.getVideoTracks?.()[0]?.id ?? null,
          });
          if (gate.kind === 'camera-off') {
            return (
              <View style={[StyleSheet.absoluteFill, styles.remoteCameraOff]}>
                <View style={styles.remoteCameraOffAvatar}>
                  <Icon name="account" size={56} color="#94A3B8" />
                </View>
                <Text style={styles.remoteCameraOffLabel}>Camera off</Text>
                <Text style={styles.remoteCameraOffSubtle} numberOfLines={1}>
                  {peerName}
                </Text>
              </View>
            );
          }
          if (gate.kind === 'avatar') {
            // Remote is connected on audio but has no video track: peer
            // avatar full-screen instead of a black tile. (During ringing
            // — no remoteStream — the gate returns 'none' and we fall
            // through to the centre avatar overlay.)
            return (
              <View style={[StyleSheet.absoluteFill, styles.remoteCameraOff]}>
                <View style={styles.remoteCameraOffAvatar}>
                  <Text style={styles.videoAvatarText}>{peerInitials}</Text>
                </View>
                <Text style={styles.remoteCameraOffSubtle} numberOfLines={1}>
                  {peerName}
                </Text>
              </View>
            );
          }
          if (gate.kind === 'none') {return null;}
          return (
            <RTCView
              // B-16 (both halves) — remount when video ARRIVES and when
              // the remote video track is REPLACED (same stream id →
              // unchanged streamURL; only a key change rebinds the
              // native renderer).
              key={`remote-${gate.remountKey}`}
              streamURL={gate.streamURL}
              style={StyleSheet.absoluteFill}
              objectFit="cover"
              mirror={false}
              zOrder={0}
            />
          );
        })()}

        {/* Tap-catcher — toggles chrome visibility. Sits above the
            remote video but below PiP and the chrome rows; only active
            once the call is connected so users can't accidentally hide
            the Decline button while ringing. */}
        {callState === 'connected' && (
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={toggleChrome}
          />
        )}

        {/* PiP — real local camera preview, draggable. zOrder=1 forces
            this SurfaceView to render ABOVE the remote view on Android;
            without it, the PiP was being painted under the remote video
            and looked empty even when the local stream was live. */}
        <Animated.View
          style={[
            styles.pip,
            {bottom: 140, right: 16, transform: pipPan.getTranslateTransform()},
          ]}
          {...pipResponder.panHandlers}>
          {(() => {
            // CALLS-1to1 (#2) — freeze the local PiP to a stable, constant-keyed
            // placeholder during teardown (same crash-avoidance as the remote tile).
            if (tearingDown) {return <View key="local-teardown" style={styles.pipFill} />;}
            // Compute the URL ONCE so the conditional and the prop see
            // the same value. The previous code called safeStreamURL
            // twice — once to gate the branch, once to feed RTCView —
            // and on a stream identity churn the two calls could return
            // different values (e.g. the gate saw a live URL but the
            // prop saw '' on the next microtask), causing the PiP to
            // mount RTCView with an empty streamURL.
            const localUrl = liveMode && isCameraOn ? safeStreamURL(liveCall.localStream) : null;
            return localUrl ? (
            <>
              {/* QA Fix #10: key by isCameraOn so RTCView unmounts +
                  remounts cleanly when the camera toggles. Without this
                  key, on some Android stacks (Pixel/MIUI/OneUI) the
                  native SurfaceView holds onto the last decoded frame
                  even after track.enabled flips to false — the prop
                  change alone doesn't tear down the underlying
                  SurfaceTexture, so the user sees their own video
                  "stuck" until the call ends. Forcing a remount on
                  off→on AND on→off transitions guarantees a fresh
                  SurfaceView. (We're inside the `localUrl != null`
                  branch here so isCameraOn is always true at this
                  point — the key flips when localUrl flips to/from
                  null which remounts the entire branch anyway, but the
                  explicit key documents the dependency.) */}
              <RTCView
                key={`local-${isCameraOn ? 'on' : 'off'}`}
                streamURL={localUrl}
                style={styles.pipFill}
                objectFit="cover"
                mirror={cameraFacing === 'front'}
                zOrder={1}
              />
              {/* Real native blur — was a translucent overlay before
                  which only darkened the frame; not actually a blur.
                  BlurView's blurType='dark' + amount tunes a Gaussian
                  blur in native code. */}
              {isBlurred && (
                <BlurView
                  style={styles.pipFill}
                  blurType="dark"
                  blurAmount={20}
                  reducedTransparencyFallbackColor="#0F172A"
                  pointerEvents="none"
                />
              )}
            </>
          ) : !liveMode && permGranted === 'granted' && isCameraOn ? (
            <>
              <CameraView style={styles.pipFill} facing={cameraFacing} />
              {isBlurred && (
                <BlurView
                  style={styles.pipFill}
                  blurType="dark"
                  blurAmount={20}
                  reducedTransparencyFallbackColor="#0F172A"
                  pointerEvents="none"
                />
              )}
            </>
          ) : (
            // Camera off / no perm — show an avatar disc with the peer's
            // initials instead of a "video-off" generic icon, matching
            // WhatsApp/FaceTime UX. The disc fills the PiP so the user
            // immediately sees who they're calling and that their own
            // camera is off (the local PiP normally shows their face).
            <View style={[styles.pipFill, styles.pipAvatarWrap]}>
              <View style={styles.pipAvatar}>
                <Text style={styles.pipAvatarLabel}>{peerInitials}</Text>
              </View>
              {!isCameraOn && (
                <Icon
                  name="video-off"
                  size={16}
                  color="#94A3B8"
                  style={styles.pipAvatarBadge}
                />
              )}
            </View>
          );
          })()}
        </Animated.View>

        {/* Controls. During incoming-video ringing we replace the
            in-call control row with a clean Answer / Decline pair —
            same UX as the voice incoming flow. The user couldn't tell
            from the previous layout that they had to tap the small red
            End button to decline because there was no Answer button at
            all; only an "End" implied "you're already in a call". */}
        {isRinging ? (
          <View style={[styles.videoControls, {paddingBottom: insets.bottom + 28}]}>
            <View style={styles.ringActions}>
              <View style={styles.ringSlot}>
                <TouchableOpacity
                  style={[styles.ringBtn, styles.ringDecline]}
                  activeOpacity={0.85}
                  onPress={declineCall}>
                  <Icon name="phone-hangup" size={30} color="#FFF" />
                </TouchableOpacity>
                <Text style={styles.ringBtnLabel}>Decline</Text>
              </View>
              <View style={styles.ringSlot}>
                <TouchableOpacity
                  style={[styles.ringBtn, styles.ringAccept]}
                  activeOpacity={0.85}
                  onPress={() => { Vibration.cancel(); void liveCall.accept(); }}>
                  <Icon name="video" size={30} color="#FFF" />
                </TouchableOpacity>
                <Text style={styles.ringBtnLabel}>Accept</Text>
              </View>
            </View>
          </View>
        ) : chromeVisible ? (
          <View style={[styles.videoControls, {paddingBottom: insets.bottom + 24}]}>
            <View style={styles.ctrlTray}>
              {/* Tier 1 — call toggles (Mute / Video / BT-Speaker / Blur).
                  Two-tier glass tray per the Bravo Video Call design. Each
                  button keeps its exact existing wiring; only the layout +
                  styling changed. */}
              <View style={styles.ctrlTierRow}>
                {[
                  {icon:isMuted ? 'microphone-off' : 'microphone', label:'Mute',  active:isMuted, onPress:tap(() => setIsMuted(m => !m))},
                  {icon:isCameraOn ? 'video' : 'video-off',        label:isCameraOn ? 'Video' : 'Video off', active:!isCameraOn, isOff:!isCameraOn, onPress:tap(() => setIsCameraOn(c => !c))},
                  // Audio-route button — tap toggles speaker/earpiece; if a
                  // BT/wired headset is available, tap (or long-press) opens
                  // the picker. Identical logic to before; just relocated.
                  {
                    icon: audioRoute === 'BLUETOOTH'    ? 'bluetooth-audio'
                        : audioRoute === 'WIRED_HEADSET' ? 'headphones'
                        : audioRoute === 'SPEAKER_PHONE' ? 'volume-high'
                        : isSpeaker ? 'volume-high' : 'volume-medium',
                    label: audioRoute === 'BLUETOOTH' ? 'BT'
                         : audioRoute === 'WIRED_HEADSET' ? 'Wired'
                         : 'Speaker',
                    active: audioRoute === 'BLUETOOTH' || audioRoute === 'WIRED_HEADSET' || isSpeaker,
                    onPress: tap(() => {
                      const hasExternalRoute = audioRoutes.some(r => r === 'BLUETOOTH' || r === 'WIRED_HEADSET');
                      if (hasExternalRoute) {setRoutePickerOpen(true);}
                      else {setIsSpeaker(s => !s);}
                    }),
                    onLongPress: () => setRoutePickerOpen(true),
                  },
                  {icon:isBlurred ? 'blur' : 'blur-off',           label:'Blur',  active:isBlurred, onPress:tap(() => setIsBlurred(b => !b))},
                ].map(btn => (
                  <View key={btn.label} style={styles.ctrlBtnWrap}>
                    <TouchableOpacity
                      style={[
                        styles.ctrlToggle,
                        btn.active && styles.ctrlToggleActive,
                        btn.isOff && styles.ctrlCircleOff,
                      ]}
                      onPress={btn.onPress}
                      onLongPress={(btn as {onLongPress?: () => void}).onLongPress}
                      activeOpacity={0.8}>
                      <Icon
                        name={btn.icon}
                        size={21}
                        color={btn.isOff ? '#F87171' : btn.active ? '#0E1424' : '#FFF'}
                      />
                    </TouchableOpacity>
                    <Text style={[styles.ctrlLabel, btn.active && {color:'#FFF'}, btn.isOff && {color:'#F87171'}]}>{btn.label}</Text>
                  </View>
                ))}
              </View>

              {/* divider */}
              <View style={styles.ctrlTrayDivider} />

              {/* Tier 2 — Flip + dominant End Call pill + Add */}
              <View style={styles.ctrlTier2}>
                <View style={styles.ctrlBtnWrap}>
                  <TouchableOpacity
                    style={styles.ctrlUtil}
                    onPress={tap(() => setCameraFacing(f => f === 'front' ? 'back' : 'front'))}
                    activeOpacity={0.8}>
                    <Icon name="camera-flip" size={20} color="#B8C2D9" />
                  </TouchableOpacity>
                  <Text style={styles.ctrlLabel}>Flip</Text>
                </View>

                <TouchableOpacity style={styles.endPill} onPress={endCall} activeOpacity={0.85}>
                  <Icon name="phone-hangup" size={20} color="#FFF" />
                  <Text style={styles.endPillText}>End Call</Text>
                </TouchableOpacity>

                <View style={styles.ctrlBtnWrap}>
                  <TouchableOpacity
                    style={styles.ctrlUtil}
                    onPress={tap(() => { console.log('[add-call] tap Add — opening picker, callType=', callType); setAddPickerOpen(true); })}
                    activeOpacity={0.8}>
                    <Icon name="account-plus" size={20} color="#B8C2D9" />
                  </TouchableOpacity>
                  <Text style={styles.ctrlLabel}>Add</Text>
                </View>
              </View>
            </View>
          </View>
        ) : null}

        {/* Fix #43: shared Add-picker — see definition above the
            isVideo branch (single source of truth). */}
        {addPickerModal}
      </View>
    );
  }

  // Voice call
  return (
    <View style={styles.voiceRoot}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {/* Top row */}
      <View style={[styles.voiceTopRow, {paddingTop: insets.top + 8}]}>
        <TouchableOpacity style={styles.minimiseBtn} onPress={tap(minimise)} activeOpacity={0.7}>
          <Icon name="chevron-down" size={14} color="#B8C7E0" />
          <Text style={styles.minimiseText}>Minimise</Text>
        </TouchableOpacity>
        <View style={styles.encBadgeVoice}>
          <Icon name="video-off" size={12} color="#F87171" />
          <View>
            <Text style={styles.encBadgeLine}>AES-256</Text>
            <Text style={styles.encBadgeLine}>Encrypted</Text>
          </View>
        </View>
      </View>

      {/* BS-CALL3 — removed the call-variant "may be offline" warning
          banner. It read as an error/alarm mid-dial (red wifi-off strip).
          WhatsApp shows a calm "Ringing…" and, on no answer, ends quietly
          (the ring-timeout already does end('ended') + a missed-call row).
          No scary bar during an unanswered call. */}

      {/* Avatar with pulse rings */}
      <View style={styles.voiceAvatarSection}>
        <View style={styles.pulseWrap}>
          {[ring1, ring2].map((anim, i) => (
            <Animated.View key={i} style={[
              styles.pulseRing,
              {
                opacity: anim.interpolate({inputRange:[0,0.5,1], outputRange:[0.5,0.35,0]}),
                transform: [{scale: anim.interpolate({inputRange:[0,1], outputRange:[0.9,1.7]})}],
              },
            ]} />
          ))}
          <View style={styles.voiceAvatar}>
            <View style={styles.voiceAvatarInner} />
            <Text style={styles.voiceAvatarText}>{peerInitials}</Text>
          </View>
        </View>

        <Text style={styles.voiceName}>{peerName}</Text>

        <View style={styles.connectedRow}>
          <View style={[
            styles.connectedDot,
            callState === 'connected'
              ? {shadowColor:'#22c55e', shadowOpacity:1, shadowRadius:6, elevation:2}
              : {backgroundColor: '#fbbf24'},
          ]} />
          <Text style={styles.connectedText}>
            {
              isRinging
                ? `Incoming ${callType === 'video' ? 'video ' : ''}call…`
                : callState === 'connecting'
                  ? (isIncoming ? 'Answering…' : 'Calling…')
                  : callState === 'ended'
                    ? 'Ended'
                    : `Connected · ${formatDuration(callDuration)}`
            }
          </Text>
        </View>
        <Text style={styles.callSubtitle}>Encrypted Voice Call · WebRTC</Text>
      </View>

      {/* Waveform — contained band, centred between the avatar block and
          the control tray by the flex spacers on either side. */}
      <View style={styles.waveSpacer} pointerEvents="none" />
      <View style={styles.waveformWrap}>
        {bars.map((bar, i) => (
          <Animated.View key={i} style={[
            styles.waveBar,
            {height: BAR_HEIGHTS[i], transform: [{scaleY: bar}]},
          ]} />
        ))}
      </View>
      <View style={styles.waveSpacer} pointerEvents="none" />

      {/* Controls. During incoming-ringing we hide mute/speaker/hold/keypad —
          they confuse users into thinking the call is already live. The
          ringing UI is a pure Answer / Decline affordance like the OS dialer. */}
      <View style={[styles.voiceControls, {paddingBottom: insets.bottom + 16}]}>
        {!isRinging && (
          <View style={styles.voiceTray}>
          <View style={styles.voiceCtrlRow}>
            {[
              {id:'mute',    icon:isMuted ? 'microphone-off' : 'microphone',                label:'Mute',    active:isMuted,   onPress:tap(() => setIsMuted(m => !m))},
              // Audio route button: tap = toggle speaker (legacy
              // behavior). Long-press = open multi-route picker so users
              // with several BT devices can pick one. The icon
              // reflects the active route, not the legacy isSpeaker
              // boolean — that way "BT" shows when routed to a headset.
              {id:'speaker',
                icon: audioRoute === 'BLUETOOTH' ? 'bluetooth-audio'
                  : audioRoute === 'WIRED_HEADSET' ? 'headphones'
                  : audioRoute === 'SPEAKER_PHONE' ? 'volume-high'
                  : isSpeaker ? 'volume-high' : 'volume-medium',
                label: audioRoute === 'BLUETOOTH' ? 'BT'
                  : audioRoute === 'WIRED_HEADSET' ? 'Wired'
                  : 'Speaker',
                active: audioRoute === 'BLUETOOTH' || audioRoute === 'WIRED_HEADSET' || isSpeaker,
                onPress: tap(() => {
                  // Open the multi-route picker only if there's a real
                  // CHOICE beyond plain earpiece/speaker — i.e. a BT
                  // headset or wired headset is currently available.
                  // The previous threshold `audioRoutes.length >= 2`
                  // misfired: every Android device always exposes BOTH
                  // EARPIECE and SPEAKER_PHONE in the route list, so
                  // length was always ≥ 2 and the picker opened on
                  // every tap — making the speaker button feel
                  // unresponsive (user dismisses picker without
                  // choosing, nothing changes).
                  const hasExternalRoute = audioRoutes.some(r => r === 'BLUETOOTH' || r === 'WIRED_HEADSET');
                  if (hasExternalRoute) {setRoutePickerOpen(true);}
                  else {setIsSpeaker(s => !s);}
                }),
                onLongPress: () => setRoutePickerOpen(true),
              },
              {id:'hold',    icon:isOnHold ? 'play-circle-outline' : 'pause-circle-outline', label:isOnHold ? 'Resume' : 'Hold', active:isOnHold, onPress:tap(() => setIsOnHold(h => !h))},
              // QA Fix #9: Camera button on the voice-call row. Tapping
              // kicks off the mid-call SDP renegotiation pipeline
              // (call.reoffer / call.reanswer); see setIsCameraOn for
              // the upgrade flow. Disabled visually + functionally
              // while a renegotiation is in progress so a fast
              // double-tap can't fire two upgrades. Label flips to
              // "Adding…" so the user knows something IS happening
              // (the camera permission prompt + SDP round-trip can
              // take a couple seconds on cellular).
              //
              // Replaced the Keypad button (DTMF dialing isn't wired
              // in Bravo — never PSTN-bridged) so we don't outgrow
              // the 5-slot row.
              {id:'camera',  icon: liveCall.isUpgrading ? 'progress-clock' : 'video',  label: liveCall.isUpgrading ? 'Adding…' : 'Camera',  active:false,     onPress:tap(() => { if (!liveCall.isUpgrading) {setIsCameraOn(c => !c);} })},
              {id:'add',     icon:'account-plus',                                            label:'Add',     active:false,     onPress:tap(() => { console.log('[add-call] tap Add — opening picker, callType=', callType); setAddPickerOpen(true); })},
            ].map(btn => (
              <View key={btn.id} style={styles.voiceCtrlBtn}>
                <TouchableOpacity
                  style={[styles.ctrlCircleVoice, btn.active && styles.ctrlCircleActive]}
                  onPress={btn.onPress}
                  onLongPress={(btn as {onLongPress?: () => void}).onLongPress}
                  activeOpacity={0.8}>
                  <Icon name={btn.icon} size={20} color="#B8C7E0" />
                </TouchableOpacity>
                <Text style={styles.voiceCtrlLabel}>{btn.label}</Text>
              </View>
            ))}
          </View>
          {/* divider + dominant End button inside the glass tray (design) */}
          <View style={styles.voiceTrayDivider} />
          <TouchableOpacity style={styles.endBtnVoice} onPress={endCall} activeOpacity={0.85}>
            <Icon name="phone-hangup" size={28} color="#FFF" />
          </TouchableOpacity>
          </View>
        )}

        {/* Audio route picker — modal-style overlay shown when user
            taps the speaker button with multiple routes available, or
            long-presses it. Lists every available route with the
            currently-active one highlighted. */}
        {routePickerOpen && audioRoutes.length > 0 && (
          <View style={styles.routePickerBackdrop}>
            <TouchableOpacity
              style={StyleSheet.absoluteFillObject}
              onPress={() => setRoutePickerOpen(false)}
              activeOpacity={1}
            />
            <View style={styles.routePickerSheet}>
              <Text style={styles.routePickerTitle}>Audio output</Text>
              {audioRoutes.map(r => {
                const label = r === 'BLUETOOTH' ? 'Bluetooth headset'
                  : r === 'SPEAKER_PHONE' ? 'Speaker'
                  : r === 'WIRED_HEADSET' ? 'Wired headset'
                  : 'Earpiece';
                const icon = r === 'BLUETOOTH' ? 'bluetooth-audio'
                  : r === 'SPEAKER_PHONE' ? 'volume-high'
                  : r === 'WIRED_HEADSET' ? 'headphones'
                  : 'phone';
                const active = audioRoute === r;
                return (
                  <TouchableOpacity
                    key={r}
                    style={[styles.routeRow, active && styles.routeRowActive]}
                    onPress={() => pickAudioRoute(r)}
                    activeOpacity={0.7}>
                    <Icon name={icon} size={22} color={active ? '#5B8DEF' : '#B8C7E0'} />
                    <Text style={[styles.routeLabel, active && {color: '#5B8DEF'}]}>{label}</Text>
                    {active && <Icon name="check" size={20} color="#5B8DEF" />}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {isRinging ? (
          <View style={styles.ringActions}>
            <View style={styles.ringSlot}>
              <TouchableOpacity
                style={[styles.ringBtn, styles.ringDecline]}
                activeOpacity={0.85}
                onPress={declineCall}>
                <Icon name="phone-hangup" size={30} color="#FFF" />
              </TouchableOpacity>
              <Text style={styles.ringBtnLabel}>Decline</Text>
            </View>
            <View style={styles.ringSlot}>
              <TouchableOpacity
                style={[styles.ringBtn, styles.ringAccept]}
                activeOpacity={0.85}
                onPress={() => { Vibration.cancel(); void liveCall.accept(); }}>
                <Icon name={isVideo ? 'video' : 'phone'} size={30} color="#FFF" />
              </TouchableOpacity>
              <Text style={styles.ringBtnLabel}>Accept</Text>
            </View>
          </View>
        ) : null /* non-ringing End now lives inside the glass tray above */}

        <View style={styles.homeIndicator} />
      </View>

      {/* Fix #43: shared Add-picker — see definition above the
          isVideo branch (single source of truth). */}
      {addPickerModal}

      {/* DTMF dialpad */}
      <Modal visible={dialpadOpen} transparent animationType="slide" onRequestClose={() => setDialpadOpen(false)}>
        <Pressable style={styles.dialpadBackdrop} onPress={() => setDialpadOpen(false)}>
          <Pressable style={styles.dialpadSheet}>
            <View style={styles.dialpadDisplay}>
              <Text style={styles.dialpadDigits}>{dialedDigits || '—'}</Text>
            </View>
            <View style={styles.dialpadGrid}>
              {['1','2','3','4','5','6','7','8','9','*','0','#'].map(k => (
                <TouchableOpacity
                  key={k}
                  style={styles.dialpadKey}
                  activeOpacity={0.6}
                  onPress={() => { Vibration.vibrate(20); setDialedDigits(d => (d + k).slice(-16)); }}>
                  <Text style={styles.dialpadKeyText}>{k}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.dialpadActions}>
              <TouchableOpacity onPress={() => setDialedDigits('')} activeOpacity={0.7}>
                <Text style={styles.dialpadClear}>Clear</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setDialpadOpen(false)} activeOpacity={0.7}>
                <Text style={styles.dialpadClose}>Close</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Weak-network recovery overlay. Shown when ICE goes
          'disconnected' mid-call; controller transitions state to
          'reconnecting' and fires an ICE-restart reoffer behind the
          scenes. Auto-dismisses when iceConnectionState returns to
          'connected' (typical 2–6s); call ends with 'failed' if the
          30s reconnect budget exhausts. */}
      {liveCall.state === 'reconnecting' && (
        <ReconnectingOverlay
          peerName={peerName}
          peerInitials={peerInitials}
          onCancel={() => { void liveCall.hangup(); }}
        />
      )}
    </View>
  );
}

/**
 * Full-screen overlay shown while a 1:1 call is recovering from an ICE
 * disconnect (weak-network handover, brief packet-loss spike). Mirrors
 * the WhatsApp recovery UX: peer chrome stays visible underneath, a
 * dark scrim + center card communicate the state, and an elapsed
 * counter reaches 30s before the controller's budget timer ends the
 * call as failed.
 */
/**
 * Animated pulse rings radiating from the ringing avatar — three
 * staggered rings that scale-up + fade-out on a loop, giving a real
 * "calling out" feel (per the Bravo Video Call design). Purely
 * decorative: runs only while the call is pre-connect (calling /
 * ringing / connecting) and stops once media lands. Uses the JS-driver
 * for opacity+scale together (RN can't run both on the native driver
 * for a non-transform style); the rings are cheap (3 views) so the
 * cost is negligible.
 */
function PulseRings({size = 300}: {size?: number}) {
  const rings = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;
  useEffect(() => {
    const loops = rings.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 1100),
          Animated.timing(v, {toValue: 1, duration: 3300, easing: Easing.out(Easing.ease), useNativeDriver: true}),
        ]),
      ),
    );
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, [rings]);
  return (
    <View pointerEvents="none" style={{position: 'absolute', width: size, height: size, alignItems: 'center', justifyContent: 'center'}}>
      {rings.map((v, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            width: size, height: size, borderRadius: size / 2,
            borderWidth: 1.5, borderColor: 'rgba(167,139,250,0.55)',
            opacity: v.interpolate({inputRange: [0, 0.15, 1], outputRange: [0, 0.5, 0]}),
            transform: [{scale: v.interpolate({inputRange: [0, 1], outputRange: [0.45, 1]})}],
          }}
        />
      ))}
    </View>
  );
}

function ReconnectingOverlay(props: {
  peerName:     string;
  peerInitials: string;
  onCancel:     () => void;
}): React.ReactElement {
  const [elapsed, setElapsed] = useState(0);
  const t0Ref = useRef(Date.now());
  useEffect(() => {
    t0Ref.current = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - t0Ref.current) / 1000));
    }, 250);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, 30 - elapsed);
  return (
    <View style={styles.reconnectScrim} pointerEvents="auto">
      <View style={styles.reconnectCard}>
        <View style={styles.reconnectAvatar}>
          <Text style={styles.reconnectAvatarTxt}>{props.peerInitials}</Text>
        </View>
        <Text style={styles.reconnectPeerName} numberOfLines={1}>{props.peerName}</Text>
        <View style={styles.reconnectStatusRow}>
          <ActivityIndicator size="small" color="#FBBF24" />
          <Text style={styles.reconnectStatusTxt}>Reconnecting…</Text>
        </View>
        <Text style={styles.reconnectCounter}>
          {elapsed}s of 30s
        </Text>
        <Text style={styles.reconnectHint}>
          Trying to restore the call.
          {remaining > 0 ? ` Giving up in ${remaining}s if the network does not recover.` : ''}
        </Text>
        <TouchableOpacity
          style={styles.reconnectCancelBtn}
          onPress={props.onCancel}
          activeOpacity={0.75}>
          <Text style={styles.reconnectCancelTxt}>End call</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Round 4 / Architecture audit fix: wrap the screen's render tree in
// a per-screen ErrorBoundary so a crash inside CallScreen (e.g. a
// degraded RN-WebRTC build throwing inside an RTCView callback)
// doesn't unmount the whole app — the user sees an in-screen error
// card with Retry + Back instead of the global recovery screen.
const CallScreen = withScreenErrorBoundary(CallScreenInner, 'Call');
export default CallScreen;

const styles = StyleSheet.create({
  // ── Video Call ──
  videoRoot: {flex:1, backgroundColor: VC_BG},
  videoBg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: VC_BG,
  },
  videoTopGrad: {
    position:'absolute', top:0, left:0, right:0, height:160, zIndex:1,
    backgroundColor:'rgba(0,0,0,0.5)',
  },
  videoBottomGrad: {
    position:'absolute', bottom:0, left:0, right:0, height:200, zIndex:1,
    backgroundColor:'rgba(0,0,0,0.7)',
  },
  videoTopBar: {
    position:'absolute', top:0, left:0, right:0, zIndex:10,
    flexDirection:'row', justifyContent:'space-between', alignItems:'flex-start',
    paddingHorizontal:16,
  },
  videoName: {color:'#FFF', fontSize:13, fontWeight:'800', letterSpacing:2, textTransform:'uppercase'},
  connectedRow: {flexDirection:'row', alignItems:'center', gap:6, marginTop:3},
  connectedDot: {width:6, height:6, borderRadius:3, backgroundColor:'#22c55e'},
  connectedText: {color:'#22c55e', fontSize:10, fontWeight:'800', letterSpacing:2, textTransform:'uppercase'},
  videoTopRight: {alignItems:'flex-end', gap:6},
  signalBars: {flexDirection:'row', alignItems:'flex-end', gap:3},
  sigBar: {width:3, borderRadius:1, backgroundColor:'rgba(255,255,255,0.9)'},
  aesBadge: {flexDirection:'row', alignItems:'center', gap:4, paddingHorizontal:10, paddingVertical:4, borderRadius:99, backgroundColor:'rgba(34,197,94,0.15)', borderWidth:1, borderColor:'rgba(34,197,94,0.3)'},
  aesText: {color:'#4ade80', fontSize:9, fontWeight:'800', letterSpacing:1.5, textTransform:'uppercase'},
  qualityStrip: {flexDirection:'row', alignItems:'center', gap:5, paddingHorizontal:8, paddingVertical:4, borderRadius:99, backgroundColor:'rgba(19,24,42,0.85)', borderWidth:1, borderColor:'rgba(255,255,255,0.12)'},
  qualityKey: {fontSize:10, fontWeight:'800', letterSpacing:0.4, fontFamily:Platform.select({ios:'Menlo', default:'monospace'})},
  qualityLbl: {color:'#7E8AA6', fontSize:8.5, fontWeight:'700', letterSpacing:1.4, fontFamily:Platform.select({ios:'Menlo', default:'monospace'})},

  videoAvatarWrap: {
    position:'absolute', top:0, left:0, right:0, bottom:60,
    zIndex:5, alignItems:'center', justifyContent:'center',
  },
  // Premium ringing avatar — 168px violet disc with a glow halo + inner
  // highlight, matching the Bravo Video Call design (was a flat 110px
  // circle). The pulse rings radiate from behind it.
  videoAvatar: {
    width:168, height:168, borderRadius:84,
    backgroundColor:'#4A3FB0', borderWidth:1, borderColor:'rgba(167,139,250,0.5)',
    alignItems:'center', justifyContent:'center', overflow:'hidden',
    shadowColor:'#7C5AD6', shadowOpacity:0.5, shadowRadius:40, shadowOffset:{width:0, height:0}, elevation:16,
  },
  // Top-left radial highlight so the disc reads as lit, not flat.
  videoAvatarInner: {
    position:'absolute', top:-30, left:-30, width:150, height:150, borderRadius:75,
    backgroundColor:'rgba(150,130,235,0.55)',
  },
  videoAvatarText: {color:'#FFF', fontSize:52, fontWeight:'700', letterSpacing:1},

  // BS-021 — remote camera-off placeholder. Same dark backdrop the
  // full-screen video uses so the swap is seamless. Avatar circle +
  // explicit "Camera off" label so the user knows the disable was
  // intentional rather than a frozen connection.
  remoteCameraOff: {
    backgroundColor: VC_BG,
    alignItems: 'center',
    justifyContent: 'center',
  },
  remoteCameraOffAvatar: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: 'rgba(148,163,184,0.16)',
    borderWidth: 2, borderColor: 'rgba(148,163,184,0.32)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 18,
  },
  remoteCameraOffLabel: {
    color: '#E2E8F0',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  remoteCameraOffSubtle: {
    color: '#94A3B8',
    fontSize: 13,
    marginTop: 6,
    paddingHorizontal: 24,
    textAlign: 'center',
  },

  pip: {
    // Modern PiP — bigger, rounder, drop-shadow so it feels like
    // floating glass. The previous tile was tiny and abutted the edge.
    position:'absolute', width:108, height:148, borderRadius:18,
    borderWidth:2, borderColor:'rgba(255,255,255,0.28)',
    backgroundColor:'#0F1422', alignItems:'center', justifyContent:'center',
    overflow:'hidden',  // RTCView fills + clips to the rounded radius
    zIndex:20,
    shadowColor:'#000', shadowOpacity:0.45, shadowRadius:18, shadowOffset:{width:0, height:8}, elevation:14,
  },
  // PiP content fill — extends UNDER the 2px border so the camera frame
  // reaches the rounded edge with no inset gap. `StyleSheet.absoluteFill`
  // pins children to the PADDING box (inside the border), which on Android
  // left a thin uneven "padding" band between the video and the border.
  // Negative insets of -2 (matching borderWidth) push the fill out to the
  // border box; `overflow:hidden` on the parent clips it to the radius.
  pipFill: {position:'absolute', top:-2, left:-2, right:-2, bottom:-2},

  videoControls: {
    position:'absolute', bottom:0, left:0, right:0, zIndex:20,
    paddingHorizontal:16, paddingTop:16,
  },
  // Glass control tray — the Bravo Video Call design wraps the controls
  // in a rounded translucent panel with a hairline border + lift shadow,
  // so the dock reads as floating glass over the call backdrop instead
  // of a flat bottom row.
  ctrlTray: {
    borderRadius:28, paddingVertical:16, paddingHorizontal:16,
    backgroundColor:'rgba(22,28,42,0.72)',
    borderWidth:1, borderColor:'rgba(255,255,255,0.1)',
    shadowColor:'#000', shadowOpacity:0.4, shadowRadius:24, shadowOffset:{width:0, height:-6}, elevation:18,
  },
  // Tier 1 — toggle row (Mute / Video / BT / Blur), evenly spaced.
  ctrlTierRow: {flexDirection:'row', alignItems:'flex-start', justifyContent:'space-between'},
  // 56px round toggle; white-filled when active (design's on-state).
  ctrlToggle: {
    width:56, height:56, borderRadius:28, alignItems:'center', justifyContent:'center',
    backgroundColor:'rgba(255,255,255,0.07)', borderWidth:1, borderColor:'rgba(255,255,255,0.12)',
  },
  ctrlToggleActive: {
    backgroundColor:'#FFFFFF', borderColor:'#FFFFFF',
    shadowColor:'#FFF', shadowOpacity:0.18, shadowRadius:22, shadowOffset:{width:0, height:8}, elevation:8,
  },
  ctrlTrayDivider: {height:1, marginVertical:16, marginHorizontal:8, backgroundColor:'rgba(255,255,255,0.1)'},
  // Tier 2 — Flip · End Call (dominant) · Add.
  ctrlTier2: {flexDirection:'row', alignItems:'center', justifyContent:'space-between', gap:12},
  ctrlUtil: {
    width:50, height:50, borderRadius:25, alignItems:'center', justifyContent:'center',
    backgroundColor:'rgba(255,255,255,0.05)', borderWidth:1, borderColor:'rgba(255,255,255,0.1)',
  },
  endPill: {
    flex:1, height:58, borderRadius:20, flexDirection:'row', alignItems:'center', justifyContent:'center', gap:12,
    backgroundColor:'#D32339', borderWidth:1, borderColor:'rgba(255,255,255,0.18)',
    shadowColor:'#D32339', shadowOpacity:0.5, shadowRadius:24, shadowOffset:{width:0, height:12}, elevation:12,
  },
  endPillText: {color:'#FFF', fontSize:16, fontWeight:'700', letterSpacing:1},
  ctrlRow: {flexDirection:'row', justifyContent:'space-between', alignItems:'center'},
  ctrlBtnWrap: {alignItems:'center'},
  ctrlCircleVideo: {
    width:40, height:40, borderRadius:20, alignItems:'center', justifyContent:'center',
    backgroundColor:'rgba(0,0,0,0.55)', borderWidth:1, borderColor:'rgba(255,255,255,0.15)',
  },
  ctrlCircleActive: {backgroundColor:'rgba(91,141,239,0.35)', borderColor:'rgba(91,141,239,0.5)'},
  // Camera-OFF visual: red tint + label so the user can tell at a
  // glance their video isn't going out. Replaces the v1.0.10 behaviour
  // where the only difference was a tiny `video` vs `video-off` icon
  // glyph that users couldn't distinguish at small button size.
  ctrlCircleOff: {backgroundColor:'rgba(248,113,113,0.18)', borderColor:'rgba(248,113,113,0.55)'},
  // Audio interruption banner — same shape as the GroupCallScreen
  // banner. Surfaced when AUDIOFOCUS_LOSS fires (incoming WhatsApp/etc).
  audioInterruptBanner: {
    position: 'absolute', left: 12, right: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: 'rgba(180,83,9,0.92)',
    borderWidth: 1, borderColor: 'rgba(252,211,77,0.45)',
    borderRadius: 12, zIndex: 60,
    elevation: 6, shadowColor: '#000', shadowOpacity: 0.3,
    shadowRadius: 6, shadowOffset: {width: 0, height: 3},
  },
  audioInterruptTxt: {color:'#FEF3C7', fontSize: 11, fontWeight: '700', flex: 1},
  ctrlCircleBlue: {backgroundColor:'rgba(91,141,239,0.35)', borderColor:'rgba(91,141,239,0.5)'},
  endBtnVideo: {
    width:40, height:40, borderRadius:20, alignItems:'center', justifyContent:'center',
    backgroundColor:'#DC2626', borderWidth:1, borderColor:'rgba(220,38,38,0.5)',
    shadowColor:'#DC2626', shadowOpacity:0.5, shadowRadius:10, elevation:4,
  },
  ctrlLabel: {color:'rgba(255,255,255,0.5)', fontSize:10, fontWeight:'800', letterSpacing:1.5, textTransform:'uppercase', marginTop:6},

  // ── Voice Call ──
  voiceRoot: {
    flex:1,
    // Deep indigo-black from the Bravo Audio Call design (radial
    // #11122A→#0A0B14→#05060B; solid mid-tone stands in for the gradient).
    backgroundColor:'#0A0B14',
  },
  voiceTopRow: {
    flexDirection:'row', justifyContent:'space-between', alignItems:'center',
    paddingHorizontal:16, paddingBottom:12,
  },
  minimiseBtn: {
    flexDirection:'row', alignItems:'center', gap:6,
    paddingHorizontal:12, paddingVertical:6, borderRadius:99,
    backgroundColor:'rgba(255,255,255,0.07)', borderWidth:1, borderColor:'rgba(255,255,255,0.1)',
  },
  minimiseText: {color:'#B8C7E0', fontSize:10, fontWeight:'800', letterSpacing:2, textTransform:'uppercase'},
  encBadgeVoice: {
    flexDirection:'row', alignItems:'center', gap:6,
    paddingHorizontal:10, paddingVertical:6, borderRadius:99,
    backgroundColor:'rgba(153,27,27,0.2)', borderWidth:1, borderColor:'rgba(239,68,68,0.28)',
  },
  encBadgeLine: {color:'#F87171', fontSize:9, fontWeight:'800', letterSpacing:2, textTransform:'uppercase', lineHeight:12},

  voiceAvatarSection: {alignItems:'center', paddingTop:16},
  pulseWrap: {position:'relative', alignItems:'center', justifyContent:'center', marginBottom:24, width:150, height:150},
  pulseRing: {
    position:'absolute', width:150, height:150, borderRadius:75,
    borderWidth:1.5, borderColor:'rgba(167,139,250,0.45)',
  },
  // Premium 132px violet disc + glow + outline ring, matching the video
  // call avatar so both call screens share one visual language.
  voiceAvatar: {
    width:132, height:132, borderRadius:66,
    backgroundColor:'#4A3FB0', overflow:'hidden',
    borderWidth:1, borderColor:'rgba(167,139,250,0.5)',
    alignItems:'center', justifyContent:'center',
    shadowColor:'#7C5AD6', shadowOpacity:0.5, shadowRadius:40, shadowOffset:{width:0, height:0}, elevation:14,
  },
  voiceAvatarInner: {
    position:'absolute', top:-24, left:-24, width:120, height:120, borderRadius:60,
    backgroundColor:'rgba(150,130,235,0.55)',
  },
  voiceAvatarText: {color:'#FFF', fontSize:42, fontWeight:'700', letterSpacing:1},
  voiceName: {
    color:'#FFF', fontSize:28, fontWeight:'800', letterSpacing:3.5,
    textTransform:'uppercase', textAlign:'center', lineHeight:34, marginBottom:12,
  },
  callSubtitle: {color:'#7E8AA6', fontSize:9.5, fontWeight:'600', letterSpacing:2, textTransform:'uppercase', marginTop:4},

  // Contained waveform band — matches the Bravo Audio Call design's
  // fixed 56px-tall strip. Previously this was `flex:1`, which stretched
  // the row across the whole mid-screen; when the call was idle/quiet the
  // 11 short bars collapsed into a single faint horizontal line floating
  // in the empty space (the stray "slide bar"). A fixed height keeps it a
  // tidy band; sibling flex spacers (see render) absorb the slack and
  // keep the control tray pinned to the bottom.
  waveformWrap: {
    height:56,
    flexDirection:'row', alignItems:'center', justifyContent:'center',
    gap:5, opacity:0.75,
  },
  waveSpacer: {flex:1},
  // Violet bar matching the design's #B7BEFF→#7C5AD6 gradient (mid-tone).
  waveBar: {width:3.5, borderRadius:3, backgroundColor:'#9B86E6', transformOrigin:'bottom'},

  voiceControls: {paddingHorizontal:16},
  // Glass control tray — matches the video call dock + the Bravo Audio
  // Call design: rounded translucent panel holding the toggle row, a
  // divider, and the dominant End button.
  voiceTray: {
    borderRadius:28, paddingVertical:16, paddingHorizontal:16,
    backgroundColor:'rgba(22,28,42,0.7)',
    borderWidth:1, borderColor:'rgba(255,255,255,0.1)',
    shadowColor:'#000', shadowOpacity:0.4, shadowRadius:24, shadowOffset:{width:0, height:-6}, elevation:18,
  },
  voiceTrayDivider: {height:1, marginVertical:16, marginHorizontal:8, backgroundColor:'rgba(255,255,255,0.1)'},
  voiceCtrlRow: {flexDirection:'row', justifyContent:'space-between', alignItems:'flex-start', paddingHorizontal:2},
  voiceCtrlBtn: {alignItems:'center', gap:8},
  ctrlCircleVoice: {
    width:60, height:60, borderRadius:30, alignItems:'center', justifyContent:'center',
    // Glass-look — soft translucent fill, hairline border, subtle inner glow.
    backgroundColor:'rgba(255,255,255,0.06)',
    borderWidth:1, borderColor:'rgba(255,255,255,0.10)',
  },
  voiceCtrlLabel: {color:'#9CA8C0', fontSize:10, fontWeight:'700', letterSpacing:1.6, textTransform:'uppercase'},

  // Audio-route picker — modal-style sheet overlaid on the call UI
  // when the user wants to switch between BT / speaker / earpiece /
  // wired headset. Tapping outside the sheet closes it.
  routePickerBackdrop: {
    position:'absolute', top:0, left:0, right:0, bottom:0,
    backgroundColor:'rgba(0,0,0,0.55)',
    justifyContent:'flex-end',
  },
  routePickerSheet: {
    backgroundColor:'#0F172A',
    borderTopLeftRadius:20, borderTopRightRadius:20,
    paddingHorizontal:20, paddingTop:20, paddingBottom:32,
    borderTopWidth:1, borderColor:'rgba(255,255,255,0.10)',
  },
  routePickerTitle: {color:'#F1F5F9', fontSize:14, fontWeight:'700', letterSpacing:1.6, textTransform:'uppercase', marginBottom:14},
  routeRow: {flexDirection:'row', alignItems:'center', gap:14, paddingVertical:14, paddingHorizontal:12, borderRadius:12},
  routeRowActive: {backgroundColor:'rgba(91,141,239,0.12)'},
  routeLabel: {flex:1, color:'#E2E8F0', fontSize:15, fontWeight:'600'},

  endBtnVoice: {
    alignSelf:'center',
    width:76, height:76, borderRadius:38, alignItems:'center', justifyContent:'center',
    backgroundColor:'#E0314A',
    shadowColor:'#D32339', shadowOpacity:0.55, shadowRadius:28, shadowOffset:{width:0, height:10}, elevation:12,
    borderWidth:1, borderColor:'rgba(255,255,255,0.2)',
  },
  // Incoming-call answer/decline pair — shown only while liveCall.state === 'ringing'.
  ringActions: {
    flexDirection:'row', justifyContent:'space-evenly',
    alignSelf:'stretch', paddingHorizontal:24, marginBottom:16, marginTop:8,
  },
  ringSlot: {alignItems:'center', gap:10},
  ringBtnLabel: {
    color:'rgba(255,255,255,0.85)', fontSize:11, fontWeight:'700',
    letterSpacing:1.2, textTransform:'uppercase',
  },
  ringBtn: {
    width:76, height:76, borderRadius:38,
    alignItems:'center', justifyContent:'center',
    elevation:12,
    borderWidth:1.5, borderColor:'rgba(255,255,255,0.18)',
  },
  ringAccept: {
    backgroundColor:'#10B981',
    shadowColor:'#10B981', shadowOpacity:0.7, shadowRadius:28, shadowOffset:{width:0, height:8},
  },
  ringDecline: {
    backgroundColor:'#EF4444',
    shadowColor:'#EF4444', shadowOpacity:0.7, shadowRadius:28, shadowOffset:{width:0, height:8},
  },
  homeIndicator: {alignSelf:'center', width:110, height:4, borderRadius:2, backgroundColor:'rgba(255,255,255,0.15)', marginTop:8},

  // Blur overlay for the PiP camera when "Blur" is active in video call.
  blurOverlay: {...StyleSheet.absoluteFillObject, backgroundColor:'rgba(15,23,42,0.55)', borderRadius:8},

  // Local PiP avatar fallback — shown when the camera is off, perm
  // denied, or no live stream. Mirrors WhatsApp/FaceTime UX: a centered
  // initials disc instead of a generic "video-off" icon.
  pipAvatarWrap: {alignItems:'center', justifyContent:'center', backgroundColor:'#0F172A'},
  pipAvatar: {
    width:48, height:48, borderRadius:24,
    alignItems:'center', justifyContent:'center',
    backgroundColor:'#1E293B',
    borderWidth:1.5, borderColor:'rgba(255,255,255,0.12)',
  },
  pipAvatarLabel: {color:'#F1F5F9', fontSize:18, fontWeight:'700', letterSpacing:1.2},
  pipAvatarBadge: {position:'absolute', bottom:6, right:6, opacity:0.9},

  // DTMF dialpad modal
  dialpadBackdrop: {flex:1, backgroundColor:'rgba(0,0,0,0.7)', justifyContent:'flex-end'},
  dialpadSheet:    {backgroundColor:'#0B0E14', paddingTop:20, paddingHorizontal:20, paddingBottom:32, borderTopLeftRadius:20, borderTopRightRadius:20, borderTopWidth:1, borderColor:'rgba(255,255,255,0.08)'},
  dialpadDisplay:  {alignItems:'center', minHeight:44, justifyContent:'center', marginBottom:16, backgroundColor:'rgba(255,255,255,0.07)', borderRadius:10, paddingVertical:10},
  dialpadDigits:   {color:'#FFFFFF', fontSize:24, fontWeight:'700', letterSpacing:4},
  dialpadGrid:     {flexDirection:'row', flexWrap:'wrap', justifyContent:'space-between'},
  dialpadKey:      {width:'30%', aspectRatio:1.2, alignItems:'center', justifyContent:'center', backgroundColor:'rgba(91,141,239,0.10)', borderRadius:14, marginBottom:12},
  dialpadKeyText:  {color:'#FFFFFF', fontSize:26, fontWeight:'600'},
  dialpadActions:  {flexDirection:'row', justifyContent:'space-between', marginTop:4},
  dialpadClear:    {color:'#fca5a5', fontSize:14, fontWeight:'700', paddingVertical:10, paddingHorizontal:12},
  dialpadClose:    {color:'#5B8DEF', fontSize:14, fontWeight:'700', paddingVertical:10, paddingHorizontal:12},

  // ── Add-to-call picker (1:1 → group escalation sheet) ──
  addPickerSheet:    {backgroundColor:'#0B0E14', paddingTop:20, paddingHorizontal:20, paddingBottom:28, borderTopLeftRadius:20, borderTopRightRadius:20, borderTopWidth:1, borderColor:'rgba(255,255,255,0.08)', maxHeight:'72%'},
  addPickerTitle:    {color:'#FFFFFF', fontSize:17, fontWeight:'800', letterSpacing:0.4, marginBottom:6},
  addPickerHint:     {color:'#B8C7E0', fontSize:12, lineHeight:17, marginBottom:14},
  addPickerList:     {gap:8, paddingBottom:8},
  addPickerEmpty:    {color:'#7E8AA6', fontSize:13, textAlign:'center', paddingVertical:32, fontStyle:'italic'},
  addPickerRow:      {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:12, paddingVertical:10, borderRadius:12, backgroundColor:'rgba(91,141,239,0.08)', borderWidth:1, borderColor:'rgba(91,141,239,0.2)'},
  addPickerAvatar:   {width:38, height:38, borderRadius:19, backgroundColor:'#13182A', alignItems:'center', justifyContent:'center', borderWidth:1, borderColor:'rgba(255,255,255,0.14)'},
  addPickerAvatarTxt:{color:'#FFFFFF', fontSize:13, fontWeight:'800', letterSpacing:0.6},
  addPickerName:     {color:'#FFFFFF', fontSize:14, fontWeight:'700'},
  addPickerSub:      {color:'#7E8AA6', fontSize:11, marginTop:2},
  addPickerCancel:   {marginTop:10, alignItems:'center', paddingVertical:12, borderRadius:12, backgroundColor:'rgba(255,255,255,0.05)'},
  addPickerCancelTxt:{color:'#B8C7E0', fontSize:13, fontWeight:'700', letterSpacing:0.5},

  // ── Reconnecting overlay (weak-network recovery) ──
  reconnectScrim: {
    position:'absolute', top:0, left:0, right:0, bottom:0,
    backgroundColor:'rgba(5,7,12,0.92)',
    alignItems:'center', justifyContent:'center',
    zIndex:200, elevation:200,
  },
  reconnectCard: {
    width:'82%', maxWidth:340,
    backgroundColor:'#13182A',
    borderWidth:1, borderColor:'rgba(255,255,255,0.14)',
    borderRadius:18, paddingVertical:26, paddingHorizontal:22,
    alignItems:'center', gap:10,
    shadowColor:'#000', shadowOffset:{width:0,height:8},
    shadowOpacity:0.45, shadowRadius:18, elevation:18,
  },
  reconnectAvatar: {
    width:64, height:64, borderRadius:32,
    backgroundColor:'rgba(255,255,255,0.08)',
    borderWidth:2, borderColor:'#FBBF24',
    alignItems:'center', justifyContent:'center',
    marginBottom:4,
  },
  reconnectAvatarTxt: {
    color:'#FFFFFF', fontSize:20, fontWeight:'800', letterSpacing:0.8,
  },
  reconnectPeerName: {
    color:'#FFFFFF', fontSize:16, fontWeight:'700', letterSpacing:0.3,
    maxWidth:'100%',
  },
  reconnectStatusRow: {
    flexDirection:'row', alignItems:'center', gap:8, marginTop:8,
  },
  reconnectStatusTxt: {
    color:'#FBBF24', fontSize:13, fontWeight:'700', letterSpacing:0.6,
  },
  reconnectCounter: {
    color:'#7E8AA6', fontSize:11, fontWeight:'600', letterSpacing:0.6,
    marginTop:2, fontFamily: Platform.select({ios:'Menlo', default:'monospace'}),
  },
  reconnectHint: {
    color:'#B8C7E0', fontSize:12, lineHeight:18, textAlign:'center',
    marginTop:10, paddingHorizontal:4,
  },
  reconnectCancelBtn: {
    marginTop:14, paddingHorizontal:22, paddingVertical:11,
    borderRadius:14, backgroundColor:'#E53935',
  },
  reconnectCancelTxt: {
    color:'#FFFFFF', fontSize:13, fontWeight:'800', letterSpacing:0.6,
  },
});
