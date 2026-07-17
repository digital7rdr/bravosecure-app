/**
 * GroupCallScreen — mediasoup SFU group call.
 *
 * Layout (apple-to-apple with the Bravo Group Call mockup):
 *
 *   ┌─────────────────────────────────┐
 *   │  ⌄    SIRAJUL VAI · 3 ON CALL   │  top bar
 *   │       HOST  · ●●● 53ms          │
 *   ├─────────────────────────────────┤
 *   │ ┌─────────────────────────────┐ │
 *   │ │  ● LIVE · HD       …        │ │  HERO tile — page 1 only,
 *   │ │                             │ │  shows the loudest live
 *   │ │      [active speaker]       │ │  speaker (audioLevels poll)
 *   │ │                             │ │
 *   │ │  ▼ Sirajul · HOST  ░░░░     │ │
 *   │ └─────────────────────────────┘ │
 *   │ ┌────────────┐  ┌────────────┐  │
 *   │ │  Ranak     │  │   You      │  │  2 small below hero
 *   │ └────────────┘  └────────────┘  │
 *   │            ─ ─ ─                │  pagination dots
 *   ├─────────────────────────────────┤
 *   │ ROOM 3A03FE · E2E · ● REC 04:38 │
 *   │ [MUTE][CAMERA][INVITE][END]     │  primary controls
 *   │ [SPK] [FX] [SHARE] [CHAT]       │  secondary controls
 *   └─────────────────────────────────┘
 *
 * Pages 2+ are equal-3 grids (no hero), advanced via horizontal swipe.
 *
 * Behaviours:
 *   • Page 1 hero auto-rotates to whoever has the highest audioLevel
 *     in the last 500 ms tick (Google Meet model).
 *   • Mute / Camera / End → useGroupCall handlers (no-op on iOS for FG).
 *   • Invite → contact picker → call.inviteUsers([userIds]) → fans
 *     fresh `sfu.ring` push notifications.
 *   • Speaker → port of CallScreen's audio-route picker (BT / earpiece /
 *     speaker / wired headset).
 *   • Effects, Share → toast for now (real impls can land later
 *     without changing the call surface).
 *   • Chat → side-sheet that posts plain messages into the conversation
 *     thread via runtime.sendText. The chat history shown inside the
 *     sheet reads from useMessengerStore so it stays consistent with
 *     ChatScreen.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, StatusBar, Platform,
  Pressable, Modal, ScrollView, FlatList, TextInput, KeyboardAvoidingView,
  DeviceEventEmitter, Animated, Easing, PanResponder, Dimensions, BackHandler,
  PermissionsAndroid, ActivityIndicator,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
// RTCView no longer used directly — FlexibleVideoTile owns the
// hero/small tile rendering. Kept the comment as a breadcrumb so
// future contributors don't reach for RTCView and re-introduce the
// remount-on-prop-change perf issue Round 1's tile cache fixed.
import InCallManager from 'react-native-incall-manager';
import type {MessengerScreenProps} from '@navigation/types';
import {useGroupCall} from '@/modules/messenger/webrtc/useGroupCall';
import {
  mergeAndSortTiles, applyHeroHold, paginateOthers, resolveTilePositions,
  buildRenderEntries, resolveTileOpacityAction, resolveMergedCache,
  isTerminalPopState, TERMINAL_POP_DELAY_MS, cameraOn,
  type MergedTile, type SelfTile, type HeroHoldState, type TileVisState,
  type SlotRect, type SlotRects, type TilePosition, type PageItem,
  type MergedCacheState,
} from '@/modules/messenger/webrtc/groupCallLayout';
import {useAuthStore} from '@store/authStore';
import {useMessengerStore} from '@/modules/messenger/store/messengerStore';
import type {LocalMessage} from '@/modules/messenger/store/types';
import {
  setGroupCallMinimized, getActiveGroupCall,
  markGroupAudioSessionStarted, clearGroupAudioSessionStarted,
  patchActiveGroupCall, groupCallElapsedSeconds,
} from '@/modules/messenger/runtime/groupCallRegistry';
import {getMessengerRuntime} from '@/modules/messenger/runtime';
import {safeStreamURL} from '@/modules/messenger/webrtc/safeStreamURL';
import FlexibleVideoTile from '@components/FlexibleVideoTile';
import {withScreenErrorBoundary} from '@modules/observability';
import NetworkLatencyChip from '@components/NetworkLatencyChip';
import {useKeyboardHeight} from '@hooks/useKeyboardHeight';

type Props = MessengerScreenProps<'GroupCallScreen'>;

// ─── Design tokens — obsidian "Rolex-meets-Palantir" palette, ────
// apple-to-apple with the Bravo Group Call mockup (vbg-group-call.jsx
// + Bravo design tokens). Deep obsidian background, platinum-cobalt
// accent, signal-green for live/E2E, restrained alert-red. Key names
// are preserved (tx1/tx2/tx3/ok/err/act…) so the existing style sheet
// maps over without churn; only the colour values change.
const C = {
  bg:    '#05070C',   // outermost obsidian (gradient end)
  bgDeep:'#0B0E14',   // sheet / modal surface
  surf1: 'rgba(255,255,255,0.07)', // ghost control fill
  surf2: '#13182A',   // hero tile base
  surf3: '#0F1422',   // small tile base
  bd:    'rgba(255,255,255,0.12)', // edge-light border
  bd2:   'rgba(255,255,255,0.08)', // hairline border
  tx1:   '#F2F4F8',   // primary text
  tx2:   'rgba(229,233,242,0.62)', // dim text
  tx3:   'rgba(180,188,204,0.45)', // mute text
  txFaint:'rgba(180,188,204,0.28)',
  ok:    '#4ADE80',   // signal green (live / E2E / speaking)
  warn:  '#F5B544',   // amber
  err:   '#F5485A',   // alert red
  errSoft:'#F5677A',  // softer red (muted mic glyph / leave hi)
  act:   '#5B8DEF',   // platinum-cobalt accent
  actSoft:'#A9C5FF',  // light cobalt (badges / icons on tint)
  glow:  '#A9C5FF',   // "YOU" + active-dot glow
  white: '#FFFFFF',
  inkOnWhite: '#0E1424', // icon colour on active (white) controls
  avA:   '#7264E0',   // hero avatar ring gradient (hi)
  avB:   '#4A3FB0',   // hero avatar ring gradient (lo)
};
const MONO = Platform.select({ios: 'Menlo', default: 'monospace'});

const {width: SCREEN_W} = Dimensions.get('window');
const PAGE_PADDING_H = 16;
const PAGE_W = SCREEN_W - PAGE_PADDING_H * 2;
const EMPTY_MESSAGES: LocalMessage[] = [];

// B-17 — the self tile is keyed on a FIXED tag for the whole call.
// Why: call.selfTag is null at mount and flips to the server tag async
// after sfu.join, so keying the tile on it changed the tile's identity
// mid-call — the render/retention/animation maps each caught the flip
// on different ticks and the self slot went blank. Server participant
// tags are UUID-derived, so the literal 'self' can never collide.
const SELF_TILE: SelfTile = {tag: 'self', isSelf: true};

type AudioRoute = 'BLUETOOTH' | 'SPEAKER_PHONE' | 'EARPIECE' | 'WIRED_HEADSET';

function GroupCallScreenInner({route, navigation}: Props) {
  const insets = useSafeAreaInsets();
  const kbHeight = useKeyboardHeight();
  const {conversationId, callType, roomId, direction, recipientUserIds, callerName, hostUserId, roomToken} = route.params;
  const isVideo = callType === 'video';
  const ownDisplayName = useAuthStore(s => s.user?.full_name ?? s.user?.email ?? 'Me');
  const ownerUserId    = useAuthStore(s => s.user?.id ?? null);
  // Hoist the conversations selector ABOVE the helpers that read it
  // (recipientNameFor / inviteCandidates / pending-1:1 banner). The
  // previous declaration order put `conversations` at the invite-picker
  // section, which TS5 strict-block-scoping correctly flagged as
  // "used before declaration" — runtime worked because of hoisting,
  // but the type checker can't see that.
  const conversations = useMessengerStore(s => s.conversations);

  const call = useGroupCall({
    roomId, conversationId, callType, direction,
    recipientUserIds, ownDisplayName, callerName, hostUserId, roomToken,
  });

  // Self-camera truth — keys on the LIVE local video track, never on
  // the static `isVideo` route param. An audio call upgraded mid-call
  // (toggleVideo) has a video track while callType stays 'voice'; the
  // old `isVideo && !isVideoOff` gate hid the user's own preview even
  // though peers received the video.
  const selfCameraOn = cameraOn(
    call.isVideoOff,
    call.localStream?.getVideoTracks().length ?? 0,
  );

  // BLUETOOTH_CONNECT must be granted BEFORE InCallManager starts.
  // Without it, InCallManager's onCreate registers no BT receiver
  // (logcat: `BT state=UNINITIALIZED`), `getAudioDeviceList` returns
  // [EARPIECE, SPEAKER_PHONE] only, and `chooseAudioRoute('BLUETOOTH')`
  // silently fails. Re-init after-the-fact does NOT help — InCallManager
  // captures permission state at start. We mirror CallScreen's
  // pattern: gate the audio-session effect on `btPermResolved`.
  // Fires unconditionally on Android API 31+; denial is recorded but
  // non-fatal (call still works on earpiece/speaker).
  const [btPermResolved, setBtPermResolved] = useState(Platform.OS !== 'android');
  // Why: Android 14+/targetSDK 34+ rejects startForeground(...microphone)
  // with SecurityException unless RECORD_AUDIO is granted at runtime
  // (logcat CallForegroundService.kt:75). Track this separately from the
  // BT permission so a BT denial doesn't block the call AND the FGS
  // start waits for the actual mic grant (+ CAMERA on video calls).
  const [micPermGranted, setMicPermGranted] = useState(Platform.OS !== 'android');
  useEffect(() => {
    if (Platform.OS !== 'android') {return;}
    const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : Number.parseInt(String(Platform.Version), 10);
    void (async () => {
      // Mic (always) + camera (video calls) — required BEFORE FGS start.
      try {
        const need = [
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          ...(isVideo ? [PermissionsAndroid.PERMISSIONS.CAMERA] : []),
        ];
        const r = await PermissionsAndroid.requestMultiple(need as never) as Record<string, string>;
        const allGranted = need.every(p => r[p] === PermissionsAndroid.RESULTS.GRANTED);
        setMicPermGranted(allGranted);
        if (!allGranted) {
          console.warn('[bravo.groupcall.mic] required permission denied — FGS will not start');
        }
      } catch (e) {
        console.warn('[bravo.groupcall.mic] mic/camera permission request failed:', (e as Error).message);
        setMicPermGranted(false);
      }
      // BT is independent — denial is non-fatal.
      if (apiLevel < 31) { setBtPermResolved(true); return; }
      try {
        const r = await PermissionsAndroid.request(
          'android.permission.BLUETOOTH_CONNECT' as never,
          {
            title: 'Bluetooth headset',
            message: 'Allow Bravo to detect Bluetooth headsets so you can route call audio through them.',
            buttonPositive: 'Allow',
            buttonNegative: 'Skip',
          },
        );
        if (r !== PermissionsAndroid.RESULTS.GRANTED) {
          console.warn('[bravo.groupcall.bt] BLUETOOTH_CONNECT denied — BT route picker disabled');
        }
      } catch (e) {
        console.warn('[bravo.groupcall.bt] permission request failed:', (e as Error).message);
      } finally {
        setBtPermResolved(true);
      }
    })();
  }, [isVideo]);

  // BS-FGS-CAMTYPE — the foreground service is started ONCE with the kind
  // derived from the STATIC `isVideo` route param. A voice call upgraded to
  // video mid-call therefore keeps a MICROPHONE-only service, and Android
  // 11+/14+ revokes while-in-use camera access the moment the app
  // backgrounds (peers' view of you freezes/goes black). This ref tracks the
  // last-asserted FGS kind so the sync effect below can re-foreground with
  // CAMERA when the camera actually turns on.
  const fgsKindRef = useRef<'voice' | 'video' | null>(null);

  // ─── Audio session lifecycle ────────────────────────────────
  useEffect(() => {
    if (!btPermResolved) {return;}  // wait for the BT permission prompt to settle
    if (!micPermGranted)  {return;}  // FGS start would crash without RECORD_AUDIO
    if (call.state !== 'joined') {return;}
    if (!call.roomId) {return;}
    const roomKey = call.roomId;
    if (!markGroupAudioSessionStarted(roomKey)) {
      console.log('[bravo.groupcall.audio] start skipped — already-started');
      return;
    }
    console.log(`[bravo.groupcall.audio] start media=${isVideo ? 'video' : 'audio'} room=${roomKey}`);

    const {startCallForegroundService, stopCallForegroundService} = require('@/modules/messenger/runtime/callForegroundService') as typeof import('@/modules/messenger/runtime/callForegroundService');
    startCallForegroundService({kind: isVideo ? 'video' : 'voice', peer: callerName ?? 'Group call'});
    fgsKindRef.current = isVideo ? 'video' : 'voice';
    // `auto: !isVideo` matches 1:1 CallScreen — voice calls let
    // InCallManager auto-manage the proximity sensor (screen off when
    // held to ear); video disables auto so the camera preview doesn't
    // black out when the user brings the phone close to their face.
    InCallManager.start({media: isVideo ? 'video' : 'audio', auto: !isVideo, ringback: ''});
    InCallManager.setKeepScreenOn(isVideo);
    if (isVideo) {
      // Video: disable proximity sensor outright + force speakerphone
      // so the loudest output reaches the user (parity with 1:1 video).
      try { InCallManager.stopProximitySensor(); } catch { /* ignore */ }
      try {
        (InCallManager as unknown as {chooseAudioRoute?: (r: string) => unknown}).chooseAudioRoute?.('SPEAKER_PHONE');
      } catch { /* ignore */ }
    } else {
      // Voice: route to earpiece initially (Android Telephony parity);
      // `auto: true` already wires the proximity sensor, so we only
      // need to set the default device here. User can flip to speaker
      // / BT through the route picker.
      try {
        (InCallManager as unknown as {chooseAudioRoute?: (r: string) => unknown}).chooseAudioRoute?.('EARPIECE');
      } catch { /* ignore */ }
    }
    return () => {
      const live = getActiveGroupCall();
      if (live?.keepAlive)            { return; }
      if (live && live.roomId === roomKey) { return; }
      try { InCallManager.stop(); } catch { /* ignore */ }
      stopCallForegroundService();
      clearGroupAudioSessionStarted(roomKey);
    };
  }, [btPermResolved, micPermGranted, call.state, isVideo, call.roomId, callerName]);

  // BS-FGS-CAMTYPE — keep the foreground-service type in lockstep with the
  // LIVE camera state (not the static route param). When the camera turns on
  // (incl. a voice→video upgrade), re-foreground with kind='video' so the
  // service carries FOREGROUND_SERVICE_TYPE_CAMERA and Android doesn't revoke
  // the camera on background. Re-foregrounding a running service is
  // idempotent (native onStartCommand re-runs goForeground).
  useEffect(() => {
    if (Platform.OS !== 'android') {return;}
    if (call.state !== 'joined' || !micPermGranted) {return;}
    const want: 'voice' | 'video' = selfCameraOn ? 'video' : 'voice';
    if (fgsKindRef.current === want) {return;}
    fgsKindRef.current = want;
    try {
      const {startCallForegroundService} = require('@/modules/messenger/runtime/callForegroundService') as typeof import('@/modules/messenger/runtime/callForegroundService');
      startCallForegroundService({kind: want, peer: callerName ?? 'Group call'});
    } catch { /* native module missing — ignore */ }
  }, [selfCameraOn, call.state, micPermGranted, callerName]);

  // ─── Audio route (Speaker button) ───────────────────────────
  const [audioRoutes, setAudioRoutes] = useState<AudioRoute[]>([]);
  // Fix #17: lazy-initialize from the live device list so the picker
  // reflects reality on the very first render. Previously we hard-coded
  // SPEAKER_PHONE / EARPIECE; if the user already had a BT headset
  // connected at mount, the icon read "Speaker" until onAudioDeviceChanged
  // fired the first transition (often 200-800 ms after mount).
  const [audioRoute,  setAudioRoute]  = useState<AudioRoute>(() => {
    try {
      const initial = (InCallManager as unknown as {getAudioDeviceList?: () => string})
        .getAudioDeviceList?.();
      if (typeof initial === 'string' && initial.length > 0) {
        const list = JSON.parse(initial) as string[];
        const valid = list.filter((d): d is AudioRoute => d === 'BLUETOOTH' || d === 'SPEAKER_PHONE' || d === 'EARPIECE' || d === 'WIRED_HEADSET');
        if (valid.length > 0) {return valid[0];}
      }
    } catch { /* ignore — fall through to media-type default */ }
    return isVideo ? 'SPEAKER_PHONE' : 'EARPIECE';
  });
  const [routePickerOpen, setRoutePickerOpen] = useState(false);
  // BT permission is now requested earlier (right above the audio
  // session effect) so it resolves BEFORE InCallManager.start() runs.
  // The old effect here used to run AFTER the audio session was
  // already initialised, leaving InCallManager's BT receiver stuck
  // in `BT state=UNINITIALIZED` for the lifetime of the call.

  // Tracks the user's preferred route so a BT SCO drop+reconnect re-
  // snaps to BT instead of stranding on EARPIECE. Mirrors the same
  // model used in CallScreen.tsx for 1:1 calls. null = no explicit
  // preference yet (initial mount); any value pinned by the user via
  // pickAudioRoute is honoured on every subsequent device-list change.
  const preferredRouteRef = useRef<AudioRoute | null>(null);
  // BS-CALL1 — re-apply the current route on screen-on (see CallScreen).
  // Mirrors `audioRoute` into a ref so the once-bound AppState listener
  // restores the right device after a proximity/lock blackout without a
  // stale closure. Populated by the effect just below.
  const reapplyRouteRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (call.state !== 'joined') {return;}
    // Seed the picker with the CURRENT device list before any change
    // event fires — without this, BT headsets paired BEFORE the call
    // boot don't appear in the picker until a manual replug, because
    // the change event only fires on transitions.
    try {
      const initial = (InCallManager as unknown as {getAudioDeviceList?: () => string})
        .getAudioDeviceList?.();
      if (typeof initial === 'string' && initial.length > 0) {
        const list = (JSON.parse(initial) as string[])
          .filter((d): d is AudioRoute => d === 'BLUETOOTH' || d === 'SPEAKER_PHONE' || d === 'EARPIECE' || d === 'WIRED_HEADSET');
        if (list.length > 0) {setAudioRoutes(list);}
      }
    } catch { /* native module may lack this method on iOS — fine */ }
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
      // Auto-restore preferred route when its underlying device pops
      // back into the available list (BT SCO reconnect, wired headset
      // replug). Without this branch, dropping a BT SCO link mid-call
      // strands audio on EARPIECE even after BT comes back. Two cases:
      //   1. No preference yet AND BT just appeared → snap to BT and
      //      pin the preference.
      //   2. Preference exists AND its device is in the new list AND
      //      OS-reported selectedAudioDevice differs → re-apply.
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
        console.log(`[bravo.groupcall.audio] auto-restore → ${target} (was ${sel})`);
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
  }, [call.state]);
  const pickAudioRoute = useCallback((next: AudioRoute) => {
    console.log(`[bravo.groupcall.audio] route → ${next}`);
    // Pin the user's explicit choice for the device-list-change handler
    // to honour on subsequent SCO drop+reconnect cycles.
    preferredRouteRef.current = next;
    // Optimistic UI: flip the picker shut + the visible icon BEFORE
    // the (Promise-returning) chooseAudioRoute resolves. The native
    // call takes 200-1200 ms when switching to BLUETOOTH because it
    // has to negotiate an SCO link; making the user stare at an
    // unresponsive sheet for that long is what feels "not smooth".
    setAudioRoute(next);
    setRoutePickerOpen(false);
    // Force-clear speakerphone before flipping to BT/EARPIECE — without
    // this, Android keeps the speakerphone forced on across the route
    // change AND the SCO connect, so for a short window audio plays
    // through both speaker and BT (creating the "double voice" /
    // "stutter" the user hears). Always-set is safe; chooseAudioRoute
    // re-asserts speaker afterward when next === SPEAKER_PHONE.
    try {
      (InCallManager as unknown as {setForceSpeakerphoneOn?: (on: boolean) => void})
        .setForceSpeakerphoneOn?.(false);
    } catch { /* ignore */ }
    void Promise.resolve(
      (InCallManager as unknown as {chooseAudioRoute?: (r: string) => Promise<unknown> | unknown})
        .chooseAudioRoute?.(next),
    ).catch(e => console.warn('[bravo.groupcall.audio] chooseAudioRoute failed:', e));
  }, []);

  // BS-CALL1 — keep the screen-on reapply closure pointed at the current
  // route. preferredRouteRef (explicit picker choice) wins; else the
  // visible audioRoute.
  useEffect(() => {
    const desired = preferredRouteRef.current ?? audioRoute;
    reapplyRouteRef.current = () => {
      try {
        (InCallManager as unknown as {setForceSpeakerphoneOn?: (on: boolean) => void}).setForceSpeakerphoneOn?.(false);
      } catch { /* ignore */ }
      try {
        (InCallManager as unknown as {chooseAudioRoute?: (r: string) => unknown}).chooseAudioRoute?.(desired);
      } catch { /* ignore */ }
      if (desired === 'SPEAKER_PHONE' || desired === 'EARPIECE') {
        try { InCallManager.setSpeakerphoneOn(desired === 'SPEAKER_PHONE'); } catch { /* ignore */ }
      }
    };
  }, [audioRoute]);

  // Camera-driven speaker auto-follow (WhatsApp behavior) — audio-
  // started calls only. Camera on while still on the earpiece →
  // loudspeaker, but ONLY when the user hasn't explicitly picked a
  // route; camera off → undo OUR auto-switch only, never the user's
  // choice. Also keeps the screen awake while the camera is live.
  const autoSpeakerRef  = useRef(false);
  const prevCameraOnRef = useRef(selfCameraOn);
  useEffect(() => {
    const prev = prevCameraOnRef.current;
    prevCameraOnRef.current = selfCameraOn;
    try { InCallManager.setKeepScreenOn(isVideo || selfCameraOn); } catch { /* ignore */ }
    if (isVideo || prev === selfCameraOn) {return;}
    if (selfCameraOn) {
      if (!preferredRouteRef.current && audioRoute === 'EARPIECE') {
        autoSpeakerRef.current = true;
        setAudioRoute('SPEAKER_PHONE');
        try { InCallManager.setSpeakerphoneOn(true); } catch { /* ignore */ }
      }
    } else if (autoSpeakerRef.current) {
      autoSpeakerRef.current = false;
      if (!preferredRouteRef.current) {
        setAudioRoute('EARPIECE');
        try { InCallManager.setSpeakerphoneOn(false); } catch { /* ignore */ }
      }
    }
  }, [selfCameraOn, isVideo, audioRoute]);

  // ─── Tile merging + speaker-priority sort ───────────────────
  // Speaker-priority swap is debounced: once a tile becomes hero, it
  // stays as hero for at least HERO_HOLD_MS even if another participant
  // briefly speaks louder. Without this hold, two people interrupting
  // each other rapidly causes the hero tile to flicker, which looks
  // janky and obscures both speakers' faces. Google Meet / Zoom use
  // a similar 1-2s hysteresis on their active-speaker swap.
  // Tuned from observed behavior on real calls:
  //   • 1500ms hold + 0.05 threshold caused the hero to flip every ~4s
  //     between two silent participants because mic background noise
  //     (breathing, keyboard, room hum) regularly crossed 0.05.
  //   • 3000ms hold + 0.15 threshold ignores ambient noise and keeps
  //     the hero on whoever is actually speaking — same "feel" as
  //     Google Meet / Zoom which use ~2.5–3s hysteresis.
  //
  // The pure layout math (merge → hero-hold → paginate) lives in
  // `groupCallLayout.ts` — see that file for branch-by-branch behaviour
  // notes and unit tests. This screen owns the React-reference-identity
  // layer (debounce cache below) and the ref write decision.
  const HERO_HOLD_MS = 3000;
  const SPEAKER_THRESHOLD = 0.15;
  const heroHoldRef = useRef<HeroHoldState | null>(null);
  // Fix #12: cache the previous merged result + the order signature so
  // we can return the SAME array reference when the sort order didn't
  // change. Otherwise a new array reference on every audioLevels tick
  // (every ~250 ms) propagates downstream as "merged changed" and
  // re-runs every dependent useMemo / re-renders every consumer — even
  // when the visible order is identical. The signature is the
  // tag-list joined string; ordering matters, so any reorder produces
  // a different sig and a fresh array, while audioLevel-only changes
  // (within an unchanged ordering) keep the same reference.
  // We also debounce noisy churn: once we have a stable order, we
  // ignore order changes for `MERGED_REFRESH_DEBOUNCE_MS` UNLESS the
  // loudest tag actually flipped (the only audible signal a user
  // would notice). 1.5 s mirrors WhatsApp's hero swap cadence.
  const MERGED_REFRESH_DEBOUNCE_MS = 1500;
  const mergedCacheRef = useRef<MergedCacheState | null>(null);
  // G-B (VIDEO_CALL_RENDER_ISSUES_HANDOFF §3) — a withheld (debounced)
  // update must schedule its own re-emit: in a silent call audioLevels
  // never tick, so nothing else re-runs this memo and the withheld tile
  // (e.g. a joiner's video arriving just after their audio) stayed
  // invisible forever. The tick state forces one recompute at expiry.
  const [mergedRecomputeTick, setMergedRecomputeTick] = useState(0);
  const mergedRecomputeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (mergedRecomputeTimerRef.current) {clearTimeout(mergedRecomputeTimerRef.current);}
  }, []);
  const merged: MergedTile[] = useMemo(() => {
    void mergedRecomputeTick; // dependency only — forces the deadline re-run
    const sorted = mergeAndSortTiles(call.remoteTiles, call.audioLevels);
    const now = Date.now();
    const {arr, nextHold} = applyHeroHold(sorted, heroHoldRef.current, {
      holdMs:    HERO_HOLD_MS,
      threshold: SPEAKER_THRESHOLD,
      now,
    });
    // Helper returns prev ref when the hold is unchanged → only write
    // the ref on a real transition. Avoids a phantom ref write every
    // 250 ms while two peers sit silent.
    if (nextHold !== heroHoldRef.current) {
      heroHoldRef.current = nextHold;
    }

    // Fix #12 + G-A/G-B: stable-ref short-circuit + debounce, extracted
    // to `resolveMergedCache` (groupCallLayout.ts) so it's unit-tested.
    // DATA changes (paused flip / rebuilt consumer / track appearing)
    // now bypass the debounce entirely (G-A: a camera toggle rides
    // producer-pause since GC-01 — presence-only sig swallowed it
    // forever in 2-party calls). Only pure ORDER churn is debounced,
    // and a withheld ordering hands back a deadline we honour with a
    // one-shot timer so silent calls still converge (G-B).
    const decision = resolveMergedCache(
      mergedCacheRef.current, arr, now, MERGED_REFRESH_DEBOUNCE_MS,
    );
    mergedCacheRef.current = decision.nextCache;
    if (decision.recomputeAtMs !== null && !mergedRecomputeTimerRef.current) {
      const delay = Math.max(16, decision.recomputeAtMs - now);
      mergedRecomputeTimerRef.current = setTimeout(() => {
        mergedRecomputeTimerRef.current = null;
        setMergedRecomputeTick(t => t + 1);
      }, delay);
    }
    return decision.arr;
  }, [call.remoteTiles, call.audioLevels, mergedRecomputeTick]);

  // ─── Pagination — 3 tiles per page; page 1 = hero(1) + 2 small ─
  // Total participant count = 1 (you) + remote count. Page 1 takes up
  // 3 slots (1 hero + 2 small). Page 2+ = 3 equal tiles.
  // Pure pagination math lives in `groupCallLayout.paginateOthers` —
  // see that helper + its tests for the chunk-boundary cases.
  const layout = useMemo(
    () => paginateOthers(merged, SELF_TILE),
    [merged],
  );
  const pages = layout.pages;
  const totalPages = pages.length;

  // ─── Fix #13 unified-grid restructure ───────────────────────────
  // Persistent-tile layer state. Read groupCallLayout.ts header for
  // the design — short version: chrome lives in absolutely-positioned
  // `<View key={tag}>` wrappers that survive role swaps, so the inner
  // FlexibleVideoTile (and the RTCView it owns) keeps decoder + EGL
  // surface identity across hero ↔ small transitions.
  //
  // Two concerns this layer owns:
  //
  //   1. SlotRects — invisible flexbox skeleton beneath the tile
  //      layer reports geometry of every slot via onLayout. Until
  //      first measurement we render tiles with `visible:false`
  //      (opacity 0, pointerEvents none) so they're mounted but
  //      undrawn. Stored in a ref + version counter so onLayout
  //      bursts coalesce into one render.
  //   2. Retained tiles — the layout helper only emits tags that
  //      are CURRENTLY in `merged`. A peer who briefly drops out
  //      (network blip, SFU reconnect) would have their RTCView
  //      torn down + remounted; the retention map keeps them in
  //      the tile layer with `visible:false` for RETENTION_TTL_MS,
  //      so a transient absence doesn't cost an EGL teardown.
  const RETENTION_TTL_MS = 5000;
  const slotRectsRef = useRef<SlotRects>({
    hero: null, small1: null, small2: null, grid: [],
  });
  // Page-local y of the small-row container — onLayout on a slot
  // reports y RELATIVE TO ITS IMMEDIATE PARENT (the row), so we add
  // this offset to convert into page-local coords for the resolver.
  const smallRowYRef = useRef(0);
  const [slotRectsVersion, setSlotRectsVersion] = useState(0);
  const bumpSlotRects = useCallback(() => {
    // setState callback form — guards against multiple onLayout fires
    // in one frame collapsing into a single re-render.
    setSlotRectsVersion(v => v + 1);
  }, []);
  // Retained tiles map: tag → {tile snapshot, lastSeenMs}. Updated
  // every render where the tag appears in `layout`; tags that haven't
  // been seen in RETENTION_TTL_MS get evicted on the next render
  // after the deadline. Refs (not state) — eviction triggers a
  // setState only if something was actually evicted.
  // B-17 — REMOTE tiles only. Self never enters retention: it is in
  // every `layout` unconditionally (paginateOthers appends it last), so
  // retaining it only created a second, evict-exempt source of truth
  // that went stale when the self key changed. Retention exists solely
  // to bridge a remote peer's transient absence without an RTCView
  // teardown.
  type RetainedRemote = {kind: 'remote'; tile: MergedTile; lastSeenMs: number};
  const retainedRef = useRef<Map<string, RetainedRemote>>(new Map());
  const [retentionTick, setRetentionTick] = useState(0);
  // Update retention map on every layout change. We mark tags
  // currently in `layout` as just-seen; we DON'T evict here — that
  // happens on a separate timer to avoid triggering re-renders inside
  // the layout pipeline. The map is the source of truth for which
  // tiles render in the tiles layer below.
  //
  // BS-024 fix: also depend on `call.remoteTiles` directly — the merged
  // cache returns a stable reference when the tag order is unchanged
  // (deliberately, to keep RTCView identity stable across audioLevels
  // ticks), so `layout` reference can stay frozen for the entire call.
  // Without the second dep, `lastSeenMs` never refreshed on a steady
  // 3-person call, the eviction timer below tripped at the 5 s mark,
  // and the tiles for active participants were dropped from the
  // retained map → "tiles appear, then disappear" symptom.
  useEffect(() => {
    const now = Date.now();
    const map = retainedRef.current;
    // Page 0 hero (if any).
    if (layout.hero) {
      map.set(layout.hero.tag, {kind: 'remote', tile: layout.hero, lastSeenMs: now});
    }
    // All page items (covers small slots + grid). Self is NOT retained
    // — see the RetainedRemote note above.
    for (const page of layout.pages) {
      for (const item of page) {
        if (item.kind === 'remote') {
          map.set(item.tile.tag, {kind: 'remote', tile: item.tile, lastSeenMs: now});
        }
      }
    }
  }, [layout, call.remoteTiles]);
  // Eviction timer — runs once per second, evicts entries older than
  // RETENTION_TTL_MS. Triggers a render via retentionTick bump only
  // when something was actually evicted, so steady-state calls don't
  // pay for this.
  //
  // BS-024 fix: belt-and-suspenders — at tick time, also refresh
  // `lastSeenMs` for any tag still present in the live `call.remoteTiles`
  // before checking eviction thresholds. The layout-effect above is
  // the primary refresh path; this is the safety net that makes
  // eviction strictly mean "tag has actually left the call", not
  // "the cached layout reference happens to be stable".
  const remoteTilesRef = useRef<typeof call.remoteTiles>(call.remoteTiles);
  useEffect(() => { remoteTilesRef.current = call.remoteTiles; }, [call.remoteTiles]);
  useEffect(() => {
    if (call.state !== 'joined') {return;}
    const id = setInterval(() => {
      const now = Date.now();
      const map = retainedRef.current;
      // Refresh lastSeenMs for any retained tag whose participantTag
      // still appears in the live remoteTiles. Anything not present is
      // a candidate for eviction once the TTL elapses.
      const liveTags = new Set<string>();
      for (const t of remoteTilesRef.current) { liveTags.add(t.participantTag); }
      let evicted = false;
      for (const [tag, entry] of map) {
        if (liveTags.has(tag)) {
          // Still on the call → keep retention timestamp fresh so a
          // stale layout reference can't trigger a wrong eviction.
          if (now - entry.lastSeenMs > 500) {
            map.set(tag, {...entry, lastSeenMs: now});
          }
          continue;
        }
        if (now - entry.lastSeenMs > RETENTION_TTL_MS) {
          map.delete(tag);
          evicted = true;
        }
      }
      if (evicted) {setRetentionTick(t => t + 1);}
    }, 1000);
    return () => clearInterval(id);
  }, [call.state]);
  // Build the position map for currently-in-layout tiles, then
  // overlay the retention map: tags that exist in retention but NOT
  // in layout are positioned off-screen with visible:false.
  const tilePositions = useMemo(() => {
    void slotRectsVersion; void retentionTick; // dep-only reads
    const positions = resolveTilePositions(layout, slotRectsRef.current, PAGE_W);
    // Augment with retained-but-absent tiles — keep mounted, hidden.
    for (const tag of retainedRef.current.keys()) {
      if (!positions[tag]) {
        positions[tag] = {
          role: 'small', x: 0, y: 0, width: 0, height: 0, page: 0, visible: false,
        };
      }
    }
    return positions;
  }, [layout, slotRectsVersion, retentionTick]);

  // B-17 structural fix — ONE render list, derived from `layout` on the
  // SAME tick positions are resolved. Previously the tiles layer
  // iterated retainedRef (mutated in an effect AFTER render) while
  // positions came from `layout` (computed IN render): any tick where
  // the two disagreed — e.g. the self tag flipping after sfu.join —
  // left a slot with a position but no rendered tile (blank cell).
  // Layout items render live data directly; retained entries are
  // appended ONLY for tags currently absent from layout (they render
  // hidden, purely to keep the RTCView mounted through a blip).
  const renderEntries = useMemo<PageItem[]>(() => {
    void retentionTick; // eviction must rebuild the list
    return buildRenderEntries(layout, retainedRef.current);
  }, [layout, retentionTick]);

  // ─── Hero crossfade animation (Fix: 2.5s fade-in when a tile ────
  // becomes the hero speaker for the first time or re-enters hero).
  // Each tile tag owns one Animated.Value for opacity. Non-hero tiles
  // snap to their target opacity instantly; only the hero-promotion
  // transition gets the slow 2500ms ease-in — that's the crossfade.
  const heroOpacityMap  = useRef<Map<string, Animated.Value>>(new Map());
  // B-17 — track (role, visible) per tag, not role alone. The old
  // role-only map had a one-way latch: hidden→setValue(0), but the
  // reverse transition (visible again, role unchanged) matched no
  // branch, so a tile that was ever hidden while keeping its role —
  // e.g. self landing in a not-yet-measured slot — stayed at opacity 0
  // for the rest of the call even though it was positioned correctly.
  // Decision logic is pure (resolveTileOpacityAction) and unit-tested.
  const prevTileStateRef = useRef<Map<string, TileVisState>>(new Map());

  useEffect(() => {
    const opMap   = heroOpacityMap.current;
    const prevMap = prevTileStateRef.current;
    const animations: Animated.CompositeAnimation[] = [];

    for (const [tag, pos] of Object.entries(tilePositions)) {
      // Get-or-create the Animated.Value for this tag.
      let anim = opMap.get(tag);
      if (!anim) {
        anim = new Animated.Value(0);
        opMap.set(tag, anim);
      }
      const next: TileVisState = {role: pos.role, visible: pos.visible};
      const action = resolveTileOpacityAction(prevMap.get(tag), next);

      if (action === 'hide') {
        anim.setValue(0);
      } else if (action === 'fadeInHero') {
        anim.setValue(0);
        animations.push(
          Animated.timing(anim, {
            toValue:         1,
            duration:        2500,
            easing:          Easing.out(Easing.cubic),
            useNativeDriver: false,
          }),
        );
      } else if (action === 'show') {
        anim.setValue(1);
      }
      // 'keep' — leave the animated value where it is.

      prevMap.set(tag, next);
    }

    // Clean up tags that left the call entirely.
    for (const tag of opMap.keys()) {
      if (!tilePositions[tag]) {
        opMap.delete(tag);
        prevMap.delete(tag);
      }
    }

    if (animations.length > 0) {
      Animated.parallel(animations).start();
    }
  }, [tilePositions]);

  const [pageIndex, setPageIndex] = useState(0);
  // Clamp on participant churn (someone leaves while we're on page 3).
  useEffect(() => {
    if (pageIndex > totalPages - 1) {setPageIndex(Math.max(0, totalPages - 1));}
  }, [totalPages, pageIndex]);

  // PanResponder for swipe-paging (no native lib needed; the gesture
  // is single-axis and short-throw so RN's PanResponder handles it
  // smoothly enough for a grid of 3-6 tiles).
  // Fix #13: under the unified-grid model, the entire stack of pages
  // is rendered simultaneously side-by-side and we translate the
  // wrapper by `-pageIndex * PAGE_W` (settled position) plus `swipeX`
  // (live gesture). Settled value is animated separately so flipping
  // pageIndex springs to the new page rather than snapping.
  const swipeX   = useRef(new Animated.Value(0)).current;
  const settledX = useRef(new Animated.Value(0)).current;
  const stackX   = useMemo(() => Animated.add(settledX, swipeX), [settledX, swipeX]);
  // Spring settledX to its new pageIndex anchor whenever pageIndex
  // changes. Without animation, the stack would snap at 60fps and
  // feel wrong on the page-change frame.
  useEffect(() => {
    Animated.spring(settledX, {
      toValue:        -pageIndex * PAGE_W,
      useNativeDriver: false,
      friction:        8,
    }).start();
  }, [pageIndex, settledX]);
  // Mirror pageIndex/totalPages into refs so the PanResponder closure
  // (created once at mount via useRef) can read the latest values
  // instead of the mount-time snapshot. This also fixes a pre-existing
  // bug where repeated swipes used stale pageIndex=0 from closure.
  const pageIndexRef = useRef(0);
  const totalPagesRef = useRef(1);
  useEffect(() => {pageIndexRef.current = pageIndex;}, [pageIndex]);
  useEffect(() => {totalPagesRef.current = totalPages;}, [totalPages]);
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: Animated.event([null, {dx: swipeX}], {useNativeDriver: false}),
      onPanResponderRelease: (_, g) => {
        const threshold = PAGE_W * 0.18;
        const cur       = pageIndexRef.current;
        const total     = totalPagesRef.current;
        let next = cur;
        if (g.dx < -threshold && cur < total - 1) {next = cur + 1;}
        else if (g.dx > threshold && cur > 0)     {next = cur - 1;}
        Animated.spring(swipeX, {toValue: 0, useNativeDriver: false, friction: 8}).start();
        if (next !== cur) {setPageIndex(next);}
      },
    }),
  ).current;

  // ─── Recording timer (mock — server doesn't expose REC state today) ─
  // For now we surface elapsed since join, formatted like 04:38. When
  // server adds a real recording flag we can swap this in.
  const [elapsed, setElapsed] = useState(0);
  // B-33 (Defect A) — anchor the duration to the registry's persistent
  // joinedAtMs so a minimize→restore (screen unmount→remount) RESUMES the
  // timer instead of resetting to 0:00. The old local useState counter reset
  // on every remount even when the call resumed correctly. Mirrors the
  // FloatingCallOverlay anchor; getActiveGroupCall is already imported above.
  useEffect(() => {
    if (call.state !== 'joined') {return;}
    const tick = (): void => {
      setElapsed(groupCallElapsedSeconds(getActiveGroupCall()?.joinedAtMs ?? null, Date.now()));
    };
    tick();                              // paint immediately — no 1s blank
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [call.state]);

  // ─── Ring status pills ──────────────────────────────────────
  // For each user the host dialed who hasn't joined yet, render a
  // pill showing 'Ringing' (within 30s of last ring), 'Re-ringing'
  // (after the host tapped Re-ring), or 'No answer' (>30s elapsed
  // and no answer). The pill exposes a Re-ring button to the host
  // when the state is 'No answer'.
  const RING_WINDOW_MS = 30_000;
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (call.state !== 'joined' || !call.ringStartedAt) {return;}
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [call.state, call.ringStartedAt]);
  // Renamed to underscore-prefix because the UI consumer was refactored
  // out (the invitee strip lives in the Invite modal now, not the room).
  // Kept the computation as a breadcrumb in case the room-side strip
  // returns; lint allows underscore-prefixed unused vars.
  const _pendingRecipients = useMemo(() => {
    if (!call.recipientUserIds || call.recipientUserIds.length === 0) {return [];}
    // Build the "already in room" set from BOTH identityByTag (the
    // primary source — populated when a peer's groupCallPresence
    // envelope arrives) AND remoteTiles' participantTags as a backup
    // for the brief window between SFU `participant.joined` and the
    // identity envelope landing. Without the backup, pending rows for
    // a freshly-joined peer can linger 200-500ms after they appear in
    // the grid — visible flicker that user reported.
    const joinedUserIds = new Set(
      Object.values(call.identityByTag).map(id => id.userId).filter((u): u is string => !!u),
    );
    return call.recipientUserIds.filter(uid => uid && uid !== ownerUserId && !joinedUserIds.has(uid));
  }, [call.recipientUserIds, call.identityByTag, ownerUserId]);
  const _ringStatusFor = useCallback((uid: string): 'ringing' | 'rering' | 'no-answer' => {
    if (!call.ringStartedAt) {return 'no-answer';}
    const elapsedMs = nowTick - call.ringStartedAt;
    if (elapsedMs >= RING_WINDOW_MS) {return 'no-answer';}
    return call.reRungUserIds?.has(uid) ? 'rering' : 'ringing';
  }, [call.ringStartedAt, call.reRungUserIds, nowTick]);
  const recipientNameFor = useCallback((uid: string): string => {
    // Look in conversations for a direct-chat name match.
    for (const c of Object.values(conversations)) {
      if (c.type === 'direct' && c.peer?.userId === uid && c.name) {return c.name;}
    }
    return uid.slice(0, 6).toUpperCase();
  }, [conversations]);
  const _handleReRing = useCallback((uid: string) => {
    void call.reRing([uid]).catch(e => Alert.alert('Re-ring failed', (e as Error).message));
  }, [call]);

  // ─── Incoming 1:1 banner — WhatsApp parity ──────────────────
  // While we're in this group call, MainNavigator's incoming-call
  // handler routes any 1:1 call.offer into incomingOneToOneBanner
  // instead of yanking us to CallScreen. Subscribe so we can render
  // an Accept/Decline overlay. Accept = endActiveGroupCall() then
  // navigate to CallScreen with the queued SDP. Decline = send
  // call.hangup back to the offerer + clear the slot.
  const [pendingOneToOne, setPendingOneToOne] = useState<
    import('@/modules/messenger/webrtc/incomingOneToOneBanner').PendingOneToOne | null
  >(null);
  useEffect(() => {

    const banner = require('@/modules/messenger/webrtc/incomingOneToOneBanner') as typeof import('@/modules/messenger/webrtc/incomingOneToOneBanner');
    return banner.onPendingOneToOneChange(setPendingOneToOne);
  }, []);
  const declineIncomingOneToOne = useCallback(() => {
    if (!pendingOneToOne) {return;}
    try {

      const reg = require('@/modules/messenger/runtime/transportRegistry') as typeof import('@/modules/messenger/runtime/transportRegistry');
      const tx = reg.getLiveTransport();
      tx?.send({
        event: 'call.hangup',
        data: {callId: pendingOneToOne.callId, to: pendingOneToOne.from, reason: 'declined'},
      } as never);
    } catch { /* fire-and-forget */ }

    const banner = require('@/modules/messenger/webrtc/incomingOneToOneBanner') as typeof import('@/modules/messenger/webrtc/incomingOneToOneBanner');
    banner.clearPendingOneToOne();
  }, [pendingOneToOne]);
  const acceptIncomingOneToOne = useCallback(() => {
    if (!pendingOneToOne) {return;}
    const data = pendingOneToOne;

    const banner = require('@/modules/messenger/webrtc/incomingOneToOneBanner') as typeof import('@/modules/messenger/webrtc/incomingOneToOneBanner');
    banner.clearPendingOneToOne();
    // Fix #15: AWAIT endActiveGroupCall before navigating to CallScreen.
    // Previously we fire-and-forgot the leave then immediately replaced
    // — the new CallScreen mounted while sfu.leave + transport teardown
    // were still running, which on Android occasionally surfaced as
    // "Transport closed unexpectedly" because the SFU socket was still
    // half-closing when the new PC tried to acquire mic capture
    // through the same shared AudioManager mode. Sequencing the leave
    // first lets InCallManager fully release before the 1:1 boot
    // re-acquires.

    const groupReg = require('@/modules/messenger/runtime/groupCallRegistry') as typeof import('@/modules/messenger/runtime/groupCallRegistry');
    void groupReg.endActiveGroupCall().then(() => {
      const oneToOneConvoId = `direct:${data.from.userId}`;
      navigation.replace('CallScreen', {
        callType:       data.kind,
        isIncoming:     true,
        conversationId: oneToOneConvoId,
        callId:         data.callId,
        remoteUserId:   data.from.userId,
        remoteDeviceId: data.from.deviceId,
        incomingSdp:    data.sdp,
      } as never);
    }).catch(() => {
      // If the leave path crashes mid-way, still navigate — the user
      // explicitly accepted; getting to the 1:1 is more important than
      // a perfectly-clean group-call teardown.
      const oneToOneConvoId = `direct:${data.from.userId}`;
      navigation.replace('CallScreen', {
        callType:       data.kind,
        isIncoming:     true,
        conversationId: oneToOneConvoId,
        callId:         data.callId,
        remoteUserId:   data.from.userId,
        remoteDeviceId: data.from.deviceId,
        incomingSdp:    data.sdp,
      } as never);
    });
  }, [pendingOneToOne, navigation]);

  // ─── Invite picker ──────────────────────────────────────────
  const [invitePickerOpen, setInvitePickerOpen] = useState(false);
  // (conversations is hoisted higher up — see the [conversations] decl
  // near ownerUserId. This selector intentionally not duplicated.)
  const inviteCandidates = useMemo(() => {
    return Object.values(conversations)
      .filter(c => c.type === 'direct')
      .map(c => ({
        userId:      c.peer?.userId ?? c.id.replace(/^direct:/, ''),
        displayName: c.name ?? 'Contact',
      }))
      .filter(c => c.userId && c.userId !== ownerUserId)
      // Drop anyone already in the room (we know them via identityByTag)
      .filter(c => !Object.values(call.identityByTag).some(id => id.userId === c.userId));
  }, [conversations, ownerUserId, call.identityByTag]);
  // Per-userId expiry timestamp for the "Ringing… 24s" live countdown
  // shown on each invite row's button. While `now < expiresAt` the
  // button is disabled and shows a countdown; after expiry it re-arms
  // so the host can ring again. Closing the modal does NOT cancel an
  // active countdown — that's deliberate, so a re-open shows the
  // correct remaining time.
  const INVITE_RING_WINDOW_MS = 30_000;
  // Fix #20: hydrate from the registry on mount so a minimize→restore
  // cycle (which unmounts and re-mounts GroupCallScreen) doesn't drop
  // active countdowns. Every setInviteRingExpiry call below mirrors
  // the new value back to the registry so the next mount can read it.
  const [inviteRingExpiry, _setInviteRingExpiry] = useState<Record<string, number>>(() => {
    try {
      const live = getActiveGroupCall();
      const stored = live?.inviteRingExpiry;
      if (stored) {
        // Drop already-expired entries so we don't render dead countdowns.
        const now = Date.now();
        const fresh: Record<string, number> = {};
        for (const [k, v] of Object.entries(stored)) {
          if (v > now) {fresh[k] = v;}
        }
        return fresh;
      }
    } catch { /* registry might be empty mid-boot — fine */ }
    return {};
  });
  // B-32 follow-up — the registry mirror used to run INSIDE this state updater
  // (`patchActiveGroupCall` → notify → FloatingCallOverlay setState), which React
  // flags as "Cannot update a component (FloatingCallOverlay) while rendering
  // GroupCallScreenInner" — a setState-in-render anti-pattern (dev-only warning,
  // surfaced on the invite path). Keep the updater pure; mirror to the registry
  // from an effect AFTER commit instead — the same value still reaches the
  // registry (just post-render), so minimize→restore reads it as before.
  const setInviteRingExpiry: typeof _setInviteRingExpiry = _setInviteRingExpiry;
  useEffect(() => {
    try { patchActiveGroupCall({inviteRingExpiry}); } catch { /* ignore */ }
  }, [inviteRingExpiry]);
  // Fix #14: single ticker that lives for the lifetime of the screen,
  // polling its own expiry map via a ref. The previous implementation
  // re-created the interval every time `inviteRingExpiry` changed —
  // and inviteRingExpiry mutates inside the interval itself (cleanup
  // pruning), which produced a race where the prune triggered the
  // effect's cleanup (clearInterval) AND the effect re-ran (creating
  // a new interval) on the same tick. Two intervals briefly coexisted,
  // double-bumping setNowTick and producing visibly jumpy countdowns.
  const inviteRingExpiryRef = useRef(inviteRingExpiry);
  useEffect(() => { inviteRingExpiryRef.current = inviteRingExpiry; }, [inviteRingExpiry]);
  useEffect(() => {
    // Idle until something is in the map, then tick at 1 Hz; the body
    // both bumps nowTick (forces re-render of countdown UI) and prunes
    // expired entries. Sleeps via early-return when the map is empty —
    // not free but cheap enough to run unconditionally for the screen
    // lifetime, which removes the start/stop race entirely.
    const t = setInterval(() => {
      const expiry = inviteRingExpiryRef.current;
      const now = Date.now();
      let active = false;
      for (const v of Object.values(expiry)) {
        if (v > now) { active = true; break; }
      }
      if (!active) {return;}
      setNowTick(now);
      setInviteRingExpiry(prev => {
        const cutoff = Date.now();
        let mutated = false;
        const next: Record<string, number> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (v > cutoff) {next[k] = v;}
          else {mutated = true;}
        }
        return mutated ? next : prev;
      });
    }, 1000);
    return () => clearInterval(t);
  }, []);
  // Drop the "Ringing… 24s" countdown the instant the invitee actually
  // joins the room. Without this, the picker row stays green-disabled
  // for the full 30s ring window even after their tile has appeared on
  // screen — visually inconsistent with WhatsApp where the ring button
  // re-arms the moment the callee picks up. We watch identityByTag (the
  // server emits an identity envelope per joined participant including
  // ourselves), pull out the joined userIds, and clear any matching key
  // from inviteRingExpiry. The inviteCandidates filter at line ~745
  // already drops joined users from the list, so this mostly affects
  // the case where the picker is OPEN and the join lands while the user
  // is staring at it; without the clear, the row would still show the
  // green pill until pruning ticks.
  useEffect(() => {
    const joinedUserIds = new Set(
      Object.values(call.identityByTag)
        .map(id => id.userId)
        .filter((u): u is string => typeof u === 'string' && u.length > 0),
    );
    if (joinedUserIds.size === 0) {return;}
    setInviteRingExpiry(prev => {
      let mutated = false;
      const next: Record<string, number> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (joinedUserIds.has(k)) {mutated = true;}
        else {next[k] = v;}
      }
      return mutated ? next : prev;
    });
  }, [call.identityByTag]);
  const handleInvite = useCallback((picked: {userId: string; displayName: string}) => {
    // Optimistic countdown — flip immediately so the button feedback
    // is instant. If the inviteUsers call fails we'll clear it.
    setInviteRingExpiry(prev => ({...prev, [picked.userId]: Date.now() + INVITE_RING_WINDOW_MS}));
    void (async () => {
      try {
        await call.inviteUsers([picked.userId]);
      } catch (e) {
        setInviteRingExpiry(prev => {
          const next = {...prev};
          delete next[picked.userId];
          return next;
        });
        Alert.alert('Invite failed', (e as Error).message);
      }
    })();
  }, [call]);

  // ─── Chat side-sheet ────────────────────────────────────────
  const [chatOpen, setChatOpen] = useState(false);
  // IMPORTANT: select the messages MAP entry as-is and apply the `?? []`
  // fallback OUTSIDE the selector. Returning a fresh `[]` from the
  // selector on every call breaks Zustand's `useSyncExternalStore`
  // snapshot caching and triggers "Maximum update depth exceeded" the
  // moment GroupCallScreen mounts for a brand-new conversation that
  // has no messages yet.
  const messagesMap = useMessengerStore(s => s.messages[conversationId]);
  const messagesForConv = messagesMap ?? EMPTY_MESSAGES;
  const [chatDraft, setChatDraft] = useState('');
  const sendChat = useCallback(() => {
    const text = chatDraft.trim();
    if (!text) {return;}
    setChatDraft('');
    void (async () => {
      try {
        const rt = await getMessengerRuntime('production');
        // sendText decides 1:1 vs group fan-out by reading the local
        // conversation's `type`. When the caller escalated from a 1:1
        // (Add Call → second person), `conversationId` is still
        // `direct:<peerUserId>` so the runtime falls into the 1:1 path
        // and demands a peer arg. We address that by routing per-peer
        // using the live call's identity registry — every remote
        // participant we know about gets the chat as a 1:1 send to
        // their own direct conversation. Same pattern WhatsApp uses
        // for in-call chat on escalated calls.
        const convoType = useMessengerStore.getState().conversations[conversationId]?.type;
        if (convoType === 'group' || convoType === 'ops_channel') {
          await rt.sendText(conversationId, text);
          return;
        }
        // Direct or unknown convo + multi-party call → fan-out.
        const peerIds = Array.from(new Set(
          Object.values(call.identityByTag)
            .map(id => id.userId)
            .filter((uid): uid is string => !!uid && uid !== ownerUserId),
        ));
        if (peerIds.length === 0) {
          // Single-peer call — send to the peer of this direct convo.
          await rt.sendText(conversationId, text);
          return;
        }
        // Fix #19: send to every peer in parallel with allSettled so a
        // single slow / failing peer doesn't block the others. The
        // sequential `await` loop was the worst case for fan-out: 6
        // peers × ~200 ms per send = >1 s before the message even
        // appeared as "sent" in the UI. allSettled keeps the same
        // partial-failure semantics (we count fulfilled vs rejected
        // and only throw if EVERY peer failed) but lets the network
        // work proceed concurrently.
        const results = await Promise.allSettled(
          peerIds.map(userId => rt.sendText(conversationId, text, {userId, deviceId: 1})),
        );
        let delivered = 0;
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            delivered += 1;
          } else {
            console.warn(`[bravo.groupcall.chat] send to ${peerIds[i]} failed:`, (r.reason as Error)?.message);
          }
        });
        if (delivered === 0) {
          throw new Error('all peers failed');
        }
      } catch (e) {
        console.warn('[bravo.groupcall.chat] send failed:', (e as Error).message);
      }
    })();
  }, [chatDraft, conversationId, call.identityByTag, ownerUserId]);

  // ─── Hangup / minimize ──────────────────────────────────────
  // Debounced — `call.leave()` is async (sfu.leave RTT ≥ 50ms on LAN,
  // 200-400ms on cellular), and the End button is fired N times by a
  // rapid double-tap. Each tap launched a separate promise chain;
  // when the first one resolved and called navigation.goBack() the
  // 2nd resolution would fire goBack again from a stale navigation
  // prop targeting an already-popped screen → React Navigation logs
  // "GO_BACK was not handled by any navigator" and may pop the
  // parent. The ref is sync so the second tap is a synchronous early-
  // return before any await fires.
  const hangupInFlightRef = useRef(false);
  const hangup = useCallback(async () => {
    if (hangupInFlightRef.current) {return;}
    hangupInFlightRef.current = true;
    try { await call.leave(); } catch { /* idempotent */ }
    navigation.goBack();
  }, [call, navigation]);
  const minimize = useCallback((): void => {
    setGroupCallMinimized(true);
    navigation.goBack();
  }, [navigation]);

  // ─── Flip camera (front ↔ back) ─────────────────────────────
  // Pure client-side capturer swap via useGroupCall.switchCamera →
  // track._switchCamera(). No backend, no renegotiation, no SFrame
  // re-attach (same track identity). Surfaces a gentle hint when the
  // camera is off / this is an audio call, where there's nothing to
  // flip.
  const handleFlipCamera = useCallback((): void => {
    if (!selfCameraOn) {
      Alert.alert('Camera is off', 'Turn your camera on to flip between the front and back lens.');
      return;
    }
    const flipped = call.switchCamera();
    if (!flipped) {
      Alert.alert('Can’t flip camera', 'No active camera to switch right now.');
    }
  }, [selfCameraOn, call]);

  // Round 7 / back-button audit fix #3 — track open modals so the
  // screen-level handler defers to the Modal's onRequestClose. Without
  // this, pressing back to dismiss the invite/route/chat sheet ALSO
  // minimizes the call.
  const groupModalsOpenRef = useRef(false);
  useEffect(() => {
    groupModalsOpenRef.current = invitePickerOpen || routePickerOpen || chatOpen;
  }, [invitePickerOpen, routePickerOpen, chatOpen]);

  // Hardware back → minimize, NOT hang up. Without this, Android back
  // would unmount GroupCallScreen and useGroupCall's cleanup would tear
  // the SFU pipeline down because keepAlive is false. Mirrors the same
  // BackHandler hook in the 1:1 CallScreen.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // Defer to Modal onRequestClose when a sheet is open — the modal
      // closes itself on Android back; consuming here would also
      // minimize the call (double action).
      if (groupModalsOpenRef.current) { return false; }
      // WhatsApp-style: back NEVER cuts a live group call — minimize it.
      // The FloatingCallOverlay keeps the SFU room running and tapping it
      // restores full screen. Covers joining (going), joined and
      // reconnecting; minimizing during joining keeps the half-built
      // pipeline alive via keepAlive (the join completes in the
      // background) instead of tearing it down — which is also what used
      // to leave a phantom tile for peers. Cancelling is an explicit
      // action (the End button).
      // WhatsApp-style: back NEVER cuts the call — minimize it to the
      // bubble for ANY live or connecting state. The registry is now seeded
      // EARLY (at boot step-2), so minimize() works even while
      // creating/joining/ringing, and useGroupCall's cleanup keeps the
      // boot/ring alive in the background (keepAlive). A no-answer/timeout
      // later flips the bubble to ended. Only the explicit End button cancels.
      if (
        call.state === 'creating' || call.state === 'joining' ||
        call.state === 'joined'   || call.state === 'reconnecting'
      ) {
        minimize();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  // Hook reads `call.state` + `call.leave` + minimize. The full `call`
  // object would over-invalidate on every group-call state diff
  // (mediasoup tile updates fire constantly during a call). Specific
  // slices are intentional.

  }, [call.state, call.leave, minimize]);

  // BS-022 — default-to-minimize on system swipe-back (or any silent
  // screen-pop) with a live joined call. Same threat as the 1:1
  // CallScreen path: Samsung S23 / OneUI gesture nav doesn't fire
  // `hardwareBackPress`, so without this the registry stays in
  // `isMinimized=false` and the FloatingCallOverlay never appears
  // even though the SFU room is still alive in the registry. The
  // user ends up trapped — chat tab taps re-route them back to the
  // group call screen via the resume path.
  //
  // Why `beforeRemove` instead of a useEffect cleanup: the SFU
  // teardown effect inside useGroupCall reads `keepAlive` to decide
  // whether to leave the room or keep it alive. React cleanups run
  // in REVERSE registration order, so a screen-level cleanup here
  // would run AFTER the SFU teardown — too late to save the room.
  // `beforeRemove` fires BEFORE any unmount cleanup, so the
  // setGroupCallMinimized(true) flip is visible to every downstream
  // teardown.
  useEffect(() => {
    const unsubscribe = (navigation as unknown as {
      addListener: (event: string, cb: (e: {preventDefault: () => void}) => void) => () => void;
    }).addListener('beforeRemove', () => {
      try {

        const reg = require('@/modules/messenger/runtime/groupCallRegistry') as typeof import('@/modules/messenger/runtime/groupCallRegistry');
        const live = reg.getActiveGroupCall();
        // WhatsApp-style: a swipe-back gesture must minimize the call, never
        // cut it — for connecting/ringing states too, not only joined. The
        // registry is seeded early (boot step-2), so setGroupCallMinimized
        // works throughout, and useGroupCall's cleanup keeps the boot/ring
        // alive (keepAlive). Tapping the overlay restores full screen; it
        // auto-dismisses on a terminal state.
        const liveStates = ['creating', 'joining', 'joined', 'reconnecting'];
        if (live && !live.isMinimized && liveStates.includes(call.state)) {
          console.log('[GroupCallScreen] silent screen-pop with live group call — defaulting to minimize');
          reg.setGroupCallMinimized(true);
        }
      } catch { /* registry / require may be unavailable in tests — ignore */ }
    });
    return unsubscribe;
    // navigation is stable; depend on call.state so we always read
    // the latest in the listener closure.
  }, [navigation, call.state]);

  // BS-GC1 — auto-pop on terminal "call is over" states. useGroupCall
  // sets state to 'ended-by-host' (host fired sfu.room.ended) or 'left'
  // (normal hangup / last-participant-out) and clears the registry, so
  // the FloatingCallOverlay vanishes — but the blocking-state UI below
  // only handles full/kicked/failed/unavailable. Without this, an
  // ended call falls through to the live call UI, shows "Connecting…"
  // forever, and the user is stranded with no exit but hardware back.
  // Mirror the 1:1 CallScreen's auto-dismiss. Guarded so a re-render
  // after the pop can't double-goBack onto the parent screen. The
  // beforeRemove minimize guard above is inert here (it only acts while
  // state === 'joined'), so this won't be hijacked into a minimize.
  const terminalPoppedRef = useRef(false);
  useEffect(() => {
    if (!isTerminalPopState(call.state)) {return;}
    if (terminalPoppedRef.current) {return;}
    terminalPoppedRef.current = true;
    // Small delay so the user perceives the call ended rather than the
    // screen vanishing mid-frame; matches the 1:1 ended path's feel.
    const t = setTimeout(() => {
      try { navigation.goBack(); } catch { /* already gone */ }
    }, TERMINAL_POP_DELAY_MS);
    return () => clearTimeout(t);
  }, [call.state, navigation]);

  // AppState lifecycle guard. When the OS backgrounds the app during an
  // active group call (user presses home, swipes through recents, etc.)
  // the JS context may freeze under Doze and the WebRTC engine may lose
  // surfaces / tracks. On `background → active` we trigger a forced
  // re-render via a tick counter so every <RTCView> remounts with a
  // freshly-computed `safeStreamURL` — dead native handles return null
  // and we render the avatar fallback instead of crashing through the
  // JNI bridge with `Cannot read property 'toURL' of null`.
  //
  // We also stamp the registry's `keepAlive=true` on background so a
  // race-y unmount during the freeze doesn't tear down the room.
  // ─── Audio-focus interruption handling ─────────────────────
  // Another app (most commonly an incoming WhatsApp call) requests
  // exclusive audio focus from Android. Our InCallManager auto-yields
  // on `AUDIOFOCUS_LOSS_TRANSIENT_EXCLUSIVE` but the JS side keeps
  // pumping audio frames into a closed AudioTrack — that's what
  // freezes the UI thread. Listen for the focus event, mute our local
  // audio track immediately, and surface a banner so the user
  // understands. Resume on `AUDIOFOCUS_GAIN`.
  //
  // This is the v1.0.13 "Option A" defensive guard. Full Telecom
  // ConnectionService integration (Option B) is queued for a future
  // milestone — that's the only proper fix that has Android queue
  // Bravo's call alongside WhatsApp's instead of letting WhatsApp
  // steal focus outright.
  const [audioInterrupted, setAudioInterrupted] = useState(false);
  // Fix #18: ref-mirror the call object so the focus listener (which
  // is registered for the lifetime of `call.state === 'joined'`) reads
  // the current isMuted/toggleMute every fire. The previous closure
  // captured the FIRST `call` value at the moment the effect ran; once
  // mute/unmute happened in JS state, `call.toggleMute` from the
  // closure pointed at a stale controller and silently no-op'd.
  const callRef = useRef(call);
  useEffect(() => { callRef.current = call; }, [call]);
  // BS-FOCUS-UNMUTE — true ONLY when WE auto-muted an already-unmuted user on
  // a focus LOSS. Used to auto-unmute on GAIN. A user who was already muted
  // (manual) at LOSS leaves this false, so we never override their choice.
  const autoMutedByFocusRef = useRef(false);
  useEffect(() => {
    if (call.state !== 'joined') {return;}
    const sub = DeviceEventEmitter.addListener('onAudioFocusChange', (data: {eventText?: string; eventCode?: number}) => {
      const code = data?.eventCode;
      // -1 = LOSS, -2 = LOSS_TRANSIENT, -3 = LOSS_TRANSIENT_CAN_DUCK
      // 1 = GAIN. Treat any LOSS variant as "interrupted".
      if (code === -1 || code === -2) {
        console.log(`[bravo.groupcall.audiofocus] LOSS (${data.eventText}) — muting local audio`);
        setAudioInterrupted(true);
        const c = callRef.current;
        if (c && !c.isMuted) {
          // Auto-mute so our outbound RTP doesn't keep firing into a
          // dead AudioRecord and stall the encoder. Remember it was OURS so
          // we can restore on GAIN.
          try { c.toggleMute(); autoMutedByFocusRef.current = true; } catch { /* ignore */ }
        }
      } else if (code === 1) {
        console.log('[bravo.groupcall.audiofocus] GAIN — resuming');
        setAudioInterrupted(false);
        // Auto-unmute ONLY if WE auto-muted on the matching LOSS. Without
        // this the user was left silently muted after a phone/WhatsApp call
        // ended (banner gone, no one could hear them). A pre-interruption
        // manual mute is preserved (ref is false → no unmute).
        if (autoMutedByFocusRef.current) {
          autoMutedByFocusRef.current = false;
          const c = callRef.current;
          if (c && c.isMuted) {
            try { c.toggleMute(); } catch { /* ignore */ }
          }
        }
      }
    });
    return () => sub.remove();

  }, [call.state]);

  const [, setAppStateTick] = useState(0);
  // Throttle the active-state render-tick. Without this, rapid lock/
  // unlock cycles (notification panel pull-down, brief Doze, etc.)
  // each fire a setAppStateTick → full GroupCallScreen re-render.
  // We only need ONE re-render per active-resume to refresh
  // safeStreamURL against current native handles; subsequent active
  // transitions inside a 1.2s window are redundant and just thrash.
  const lastAppStateTickRef = useRef(0);
  useEffect(() => {
    if (call.state !== 'joined') {return;}
    const {AppState} = require('react-native') as typeof import('react-native');
    const sub = AppState.addEventListener('change', (s: string) => {
      if (s === 'background' || s === 'inactive') {
        console.log('[bravo.groupcall.appstate] background → keepAlive=true');
        try {

          const reg = require('@/modules/messenger/runtime/groupCallRegistry') as typeof import('@/modules/messenger/runtime/groupCallRegistry');
          reg.patchActiveGroupCall({keepAlive: true});
        } catch { /* ignore */ }
      } else if (s === 'active') {
        // BS-CALL1 — restore audio route after a screen-off blackout (the
        // OS can silently flip earpiece↔speaker while the screen is off).
        setTimeout(() => { try { reapplyRouteRef.current(); } catch { /* ignore */ } }, 350);
        const now = Date.now();
        if (now - lastAppStateTickRef.current < 1200) {return;}
        lastAppStateTickRef.current = now;
        console.log('[bravo.groupcall.appstate] active → forcing tile re-render');
        // Bump tick to force a render pass — every safeStreamURL call
        // re-evaluates against current native handles, replacing dead
        // streams with the avatar fallback rather than crashing.
        setAppStateTick(t => t + 1);
      }
    });
    return () => sub.remove();
  }, [call.state]);

  const labelFor = useCallback((tag: string): string => {
    const id = call.identityByTag[tag];
    if (id?.displayName) {return id.displayName;}
    return tag.slice(0, 6).toUpperCase();
  }, [call.identityByTag]);

  // ─── B-37 — terminal teardown view ─────────────────────────
  // The instant leaveInternal flips a terminal state ('left'/'ended-by-
  // host'), swap the animated, clipping tile grid for a static "Call
  // ended" card so the grid leaves the React tree in ONE clean unmount.
  // Without this the grid kept re-rendering while native views were being
  // detached during teardown and Fabric crashed ("child already has a
  // parent"). The terminal-pop effect auto-dismisses the screen shortly
  // after (TERMINAL_POP_DELAY_MS).
  if (call.state === 'left' || call.state === 'ended-by-host') {
    return (
      <View style={[s.root, {paddingTop: insets.top}]}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={s.blockerBox}>
          <Icon name="phone-hangup" size={48} color={C.tx2} />
          <Text style={s.blockerTitle}>
            {call.state === 'ended-by-host' ? 'Call ended by host' : 'Call ended'}
          </Text>
        </View>
      </View>
    );
  }

  // ─── Blocking state UI ──────────────────────────────────────
  if (call.state === 'full' || call.state === 'kicked' || call.state === 'failed' || call.state === 'unavailable') {
    const stateLabel =
      call.state === 'full'     ? 'Call is full (6/6)' :
      call.state === 'kicked'   ? 'You were removed' :
      call.state === 'failed'   ? 'Call failed' :
                                  'Group call unavailable';
    return (
      <View style={[s.root, {paddingTop: insets.top}]}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={s.blockerBox}>
          <Icon
            name={call.state === 'full' ? 'account-multiple-remove' : call.state === 'kicked' ? 'account-cancel' : 'alert-circle-outline'}
            size={48}
            color={call.state === 'full' ? C.warn : C.err}
          />
          <Text style={s.blockerTitle}>{stateLabel}</Text>
          <TouchableOpacity style={s.blockerBtn} onPress={() => navigation.goBack()} activeOpacity={0.85}>
            <Text style={s.blockerBtnTxt}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ─── PersistentTile (Fix #13 unified-grid restructure) ──────
  // ONE persistent <View key={tag}> per participant tag. RTCView (via
  // FlexibleVideoTile) lives inside this wrapper for the lifetime of
  // the call — never unmounted on hero ↔ small role swap, never
  // unmounted on page swipe (off-screen tiles still occupy the
  // tiles-layer canvas via x-shift). Decoder + EGL surface identity
  // is preserved across all role transitions.
  //
  // Chrome (live pill, name pill, host-action button, mute dot, you
  // badge, avatar fallback) is rendered conditionally by `role`. It's
  // cheap to mount/unmount because none of it owns native handles.
  //
  // Camera-off path: the wrapper has explicit width but no fixed
  // height (height comes from FlexibleVideoTile's aspectRatio when
  // we have video; from the avatar block's intrinsic content height
  // when we don't). For a stable avatar tile size when no video, we
  // give the wrapper an explicit aspectRatio matching the typical
  // grid slot ratio (4:5 portrait) so it doesn't collapse to 0.
  const renderPersistentTile = (
    entry: PageItem,
    pos:   TilePosition,
  ): React.ReactElement => {
    // Remote tiles render LIVE layout data when the tag is in layout;
    // a tag that has gone absent renders its last retained snapshot
    // (hidden via visible:false) so the RTCView isn't torn down.
    const isSelf = entry.kind === 'self';
    const tag    = entry.tile.tag;
    const speaking = !isSelf && entry.tile.audioLevel > 0.05;

    // Stream URL — null if camera-off, paused, or absent.
    const videoUrl = isSelf
      ? (selfCameraOn ? safeStreamURL(call.localStream) : null)
      : (entry.tile.video && !entry.tile.video.paused
         ? safeStreamURL(entry.tile.video.stream)
         : null);

    // B-15 — a tile with a live (non-paused) video plane that is decoding
    // ZERO frames for >3s. Distinct from camera-off (handled by the
    // !videoUrl branch below). Self never stalls (local preview).
    const videoStalled = !isSelf && !!videoUrl && !!call.videoStalledTags[tag];

    const isHero = pos.role === 'hero';
    // Outer wrapper style: absolute position from resolver, width
    // explicit, height undefined so FlexibleVideoTile's aspectRatio
    // can drive it (camera-off path adds an explicit fallback ratio
    // via the inner avatar wrapper).
    // Opacity driven by the heroOpacityMap Animated.Value so hero
    // promotions crossfade over 2500ms instead of snapping.
    const tileOpacity = heroOpacityMap.current.get(tag) ?? (pos.visible ? 1 : 0);
    // BS-GC-BLACKVIDEO — pin the wrapper to the MEASURED slot height, not
    // just its width. Previously height was omitted here and left to
    // FlexibleVideoTile's aspectRatio (a 16:9 guess that resets on every
    // streamURL change). That let the RTCView SurfaceView oscillate
    // (placeholder → aspectRatio → slot) while the decoder's first
    // keyframe arrived, so Android's BLASTBufferQueue rejected the buffer
    // (active_size 4x2 / 1044x783 vs buffer 1044x587) and the tile latched
    // black. pos.height already carries the measured slot rect
    // (resolveTilePositions) — apply it so the surface is sized ONCE and
    // objectFit:'cover' crops the frame into it. Falls back to undefined
    // when the slot isn't measured yet (pos.height === 0) so the
    // aspectRatio cold-start path is preserved. No React-key change → the
    // Fix #13 RTCView/decoder/EGL identity across role swaps is untouched.
    const wrapperStyle = {
      position: 'absolute' as const,
      left:     pos.x,
      top:      pos.y,
      width:    pos.width,
      ...(pos.height > 0 ? {height: pos.height} : null),
      opacity:  tileOpacity,
    };
    const wrapperRound = isHero ? s.heroFlexWrap : s.smallFlexWrap;
    const speakingStyle = speaking ? s.heroSpeaking : null;

    return (
      <Animated.View
        key={tag}
        style={[wrapperRound, wrapperStyle, speakingStyle]}
        pointerEvents={pos.visible ? 'box-none' : 'none'}>
        {/* Video plane — FlexibleVideoTile keyed (no further key down
            inside; the OUTER View's key is what guarantees identity
            across role swaps). */}
        {videoUrl ? (
          <>
            <FlexibleVideoTile
              streamURL={videoUrl}
              mirror={isSelf}
              zOrder={0}
              containerStyle={isHero ? s.heroFlexInner : s.smallFlexInner}
            />
            {/* B-15 — video stall overlay: the stream is live but no frames
                are decoding (decrypt failure / SFU drop / encoder stall).
                Tells the user this is a broken stream, not a black tile. */}
            {videoStalled && (
              <View style={s.stallOverlay} pointerEvents="none">
                <Icon name="video-off-outline" size={isHero ? 28 : 20} color={C.tx2} />
                <Text style={[s.stallTxt, isHero && s.stallTxtHero]} numberOfLines={1}>
                  Video unavailable
                </Text>
              </View>
            )}
          </>
        ) : (
          // Camera-off path: explicit aspect so the absolute-positioned
          // wrapper has a deterministic height. 4:5 matches the legacy
          // gridThreeSlot ratio (9:12 ≈ 0.75) and the small-row's
          // 130px-height-on-176px-width (≈ 0.74); hero gets a 16:9-ish
          // taller block by overriding the ratio. The avatar itself is
          // the mockup's gradient-ring disc with centred initials.
          <View style={[
            s.tileAv,
            {aspectRatio: isHero ? 16 / 11 : 9 / 12},
          ]}>
            <LinearGradient
              colors={[C.avA, C.avB]}
              start={{x: 0.2, y: 0}}
              end={{x: 0.85, y: 1}}
              style={[s.avatarDisc, isHero ? s.avatarDiscHero : s.avatarDiscSmall]}>
              <Text style={[s.avatarInitials, isHero && s.avatarInitialsHero]}>
                {(isSelf ? ownDisplayName : labelFor(tag)).slice(0, 2).toUpperCase()}
              </Text>
            </LinearGradient>
          </View>
        )}
        {/* Speaking equalizer — top-right animated bars (mockup). Shown
            on any speaking remote tile, hero or small. */}
        {speaking && (
          <View style={s.eqWrap} pointerEvents="none">
            <AudioBars level={entry.tile.audioLevel} />
          </View>
        )}
        {/* Hero chrome — LIVE pill, host-action button, name plate. */}
        {isHero && !isSelf && (
          <>
            <View style={s.livePill}>
              <View style={s.liveDot} />
              <Text style={s.livePillTxt}>LIVE · HD</Text>
            </View>
            <TouchableOpacity
              style={s.heroMoreBtn}
              onLongPress={() => onTileLongPress(tag)}
              onPress={() => onTileLongPress(tag)}
              activeOpacity={0.75}>
              <Icon name="dots-horizontal" size={14} color={C.tx1} />
            </TouchableOpacity>
            <View style={[s.namePlate, s.namePlateHero]}>
              {/* CALL-24 — muted glyph on the hero too, same positive-
                  evidence rule as the small-tile plate below (audio
                  producer present AND paused). */}
              {entry.tile.audio?.paused
                ? <Icon name="microphone-off" size={13} color={C.errSoft} />
                : <View style={[s.nameDot, !speaking && s.nameDotIdle]} />}
              <Text style={[s.namePlateTxt, s.namePlateTxtHero]} numberOfLines={1}>{labelFor(tag)}</Text>
            </View>
          </>
        )}
        {/* Self chrome — YOU badge + name plate (muted → red mic glyph). */}
        {isSelf && (
          <>
            <View style={s.youBadge}>
              <Text style={s.youBadgeTxt}>YOU</Text>
            </View>
            <View style={s.namePlate}>
              {call.isMuted
                ? <Icon name="microphone-off" size={11} color={C.errSoft} />
                : <View style={s.nameDot} />}
              <Text style={s.namePlateTxt} numberOfLines={1}>You</Text>
            </View>
          </>
        )}
        {/* Remote-small chrome — name plate always; long-press overlay
            ONLY if host (long-press exposes mute/kick host actions).
            The overlay is a sibling under absolute-fill, so it doesn't
            interfere with the FlexibleVideoTile's own RTCView layout. */}
        {!isHero && !isSelf && (
          <>
            <View style={s.namePlate}>
              {/* Muted glyph only on positive evidence (audio producer
                  present AND paused). An absent audio producer is the
                  pre-consume window, not a mute — show the live dot. */}
              {entry.tile.audio?.paused
                ? <Icon name="microphone-off" size={11} color={C.errSoft} />
                : <View style={[s.nameDot, !speaking && s.nameDotIdle]} />}
              <Text style={s.namePlateTxt} numberOfLines={1}>{labelFor(tag)}</Text>
            </View>
            {call.isHost && (
              <TouchableOpacity
                style={StyleSheet.absoluteFill}
                activeOpacity={0.85}
                onLongPress={() => onTileLongPress(tag)}
                delayLongPress={350}
              />
            )}
          </>
        )}
      </Animated.View>
    );
  };

  // ─── Empty-state (page 0 with no participants except self) ───
  // Today's renderHeroBody had a `tile === null` branch that showed
  // "Waiting for others…". The new tiles layer iterates retained
  // tags only, so we render this empty card as a sibling that
  // appears whenever no remote tile occupies the hero slot.
  const renderEmptyHero = (heroRect: SlotRect | null): React.ReactElement | null => {
    if (layout.hero) {return null;}
    const style = heroRect
      ? {position: 'absolute' as const, left: heroRect.x, top: heroRect.y, width: heroRect.width, height: heroRect.height}
      : {opacity: 0 as const};
    return (
      <View style={[s.heroTile, s.heroEmpty, style]}>
        <Icon name="account-multiple" size={56} color={C.tx3} />
        <Text style={s.emptyTitle}>Waiting for others to join…</Text>
        <Text style={s.emptySub}>{recipientUserIds.length} member(s) being rung.</Text>
      </View>
    );
  };

  const onTileLongPress = (tag: string): void => {
    if (!call.isHost) {return;}
    const name = labelFor(tag);
    Alert.alert(name, 'Host action', [
      {text: 'Mute', onPress: () => { void call.muteParticipant(tag); }},
      {text: 'Remove', style: 'destructive', onPress: () => {
        Alert.alert(`Remove ${name}?`, 'They will be dropped from the call immediately.', [
          {text: 'Cancel', style: 'cancel'},
          {text: 'Remove', style: 'destructive', onPress: () => { void call.kickParticipant(tag); }},
        ]);
      }},
      {text: 'Cancel', style: 'cancel'},
    ], {cancelable: true});
  };

  const onCallCount = merged.length + 1;       // remotes + self
  const stateCaption =
    call.state === 'creating'      ? 'Creating…' :
    call.state === 'joining'       ? 'Joining…' :
    call.state === 'joined'        ? `${onCallCount} ON CALL${call.isHost ? ' · HOST' : ''}` :
                                     // 'left' / 'ended-by-host' render the
                                     // static "Call ended" card via the
                                     // terminal early-return above, so they
                                     // never reach this main-render caption.
                                     'Connecting…';

  // ─── Render ─────────────────────────────────────────────────
  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      {/* Obsidian backdrop — top-down gradient mirroring the mockup's
          `radial-gradient(ellipse 120% 70% at 50% 25%, #0E1426, #080B14
          65%, #05070C)`. A vertical LinearGradient is the closest
          dependency-free approximation; the cobalt glow lives in the
          header chip + accent chrome rather than the field. */}
      <LinearGradient
        colors={['#0E1426', '#080B14', '#05070C']}
        locations={[0, 0.65, 1]}
        start={{x: 0.5, y: 0}}
        end={{x: 0.5, y: 1}}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {/* Top bar — mockup header: grid chip · title + live meta · E2E pill.
          The minimize affordance moves onto the grid chip (tap it to
          background the call). The network-latency chip tucks to the far
          right below the E2E pill so we keep the real-time signal without
          crowding the badge. */}
      <View style={s.topBar}>
        <TouchableOpacity
          style={s.headerChip}
          onPress={minimize}
          activeOpacity={0.8}
          accessibilityLabel="Minimize call">
          <Icon name="view-grid-outline" size={20} color={C.actSoft} />
        </TouchableOpacity>
        <View style={s.headerMeta}>
          <Text style={s.title} numberOfLines={1}>{callerName ?? 'Group call'}</Text>
          <View style={s.headerSubRow}>
            {call.state === 'joined' ? (
              <>
                <View style={s.recDot} />
                <Text style={s.headerTimer}>{formatDuration(elapsed)}</Text>
                <View style={s.headerSep} />
                <Text style={s.headerJoined}>{onCallCount} joined</Text>
              </>
            ) : (
              <Text style={s.headerJoined}>{stateCaption}</Text>
            )}
          </View>
        </View>
        <View style={s.headerRight}>
          <View style={s.e2ePill}>
            <Icon name="lock" size={11} color={C.ok} />
            <Text style={s.e2ePillTxt}>E2E</Text>
          </View>
          <NetworkLatencyChip compact />
        </View>
      </View>

      {/* The pending-invitee list (Ringing… / No answer rows) is NO
          LONGER rendered inline above the grid in v1.0.13. It was
          spilling into hero/small tile layout space and confusing the
          host with phantom "Ringing" cards mixed with real participant
          tiles. Now it lives only inside the Invite modal (see below)
          where each row has a status pill + re-ring button.
          Inline ring-status indication is preserved via the small
          counter badge on the Invite control button instead. */}

      {/* Pages — Fix #13 unified-grid restructure.
          Two layers stacked over the same animated wrapper:
            (1) Skeleton — flexbox replicas of every page's slots,
                opacity 0 + pointerEvents none, ONLY there to measure
                each slot's rect via onLayout. Geometry is identical
                to today's individual-page render (same s.heroTile /
                s.smallRow / s.gridThree / s.gridThreeSlot styles)
                so the persistent tiles fall on exactly the same
                pixels as before.
            (2) Tiles — one persistent <View key={tag}> per retained
                participant, absolutely positioned from the resolver's
                output. Hero ↔ small role swaps animate via React's
                style-update path; RTCView (inside FlexibleVideoTile)
                never unmounts.
          The Animated.View wraps BOTH layers, so a swipe translates
          everything together (skeleton + tiles) by `stackX`.
          Wrapper width = PAGE_W × totalPages so all pages exist on
          a wide canvas; current page is centred via translateX. */}
      <View style={s.pageWrap} {...pan.panHandlers}>
      <Animated.View
        style={{
          // Inner stack: spans all pages side-by-side. translateX
          // anchors the active page; off-screen pages live to the
          // right and are clipped by the outer pageWrap's overflow.
          width:     PAGE_W * Math.max(1, totalPages),
          height:    '100%',
          transform: [{translateX: stackX}],
        }}>
        {/* Skeleton layer — invisible, measures slot rects. */}
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, {opacity: 0}]}>
          {/* Page 0 — hero + small row, identical to today's layout.
              onLayout reports coords RELATIVE TO PARENT, so a slot
              nested inside `smallRow` inside `page` reports y=0 (top
              of smallRow). We capture smallRow's own y separately
              and add it before storing the slot rects. */}
          <View style={[s.page, s.skeletonPage, {left: 0, width: PAGE_W}]}>
            <View
              style={s.heroTile}
              onLayout={e => {
                const {x, y, width, height} = e.nativeEvent.layout;
                slotRectsRef.current.hero = {x, y, width, height};
                bumpSlotRects();
              }}
            />
            <View
              style={s.smallRow}
              onLayout={e => {
                // Capture smallRow's page-local y; re-emit any
                // already-measured small1/small2 rects with the row
                // offset applied. (Slot onLayouts may fire before
                // this onLayout on first render.)
                const rowY = e.nativeEvent.layout.y;
                smallRowYRef.current = rowY;
                if (slotRectsRef.current.small1) {
                  const r = slotRectsRef.current.small1;
                  slotRectsRef.current.small1 = {x: r.x, y: rowY, width: r.width, height: r.height};
                }
                if (slotRectsRef.current.small2) {
                  const r = slotRectsRef.current.small2;
                  slotRectsRef.current.small2 = {x: r.x, y: rowY, width: r.width, height: r.height};
                }
                bumpSlotRects();
              }}>
              <View
                style={s.smallSlot}
                onLayout={e => {
                  const r = e.nativeEvent.layout;
                  // Use captured row y if available; else 0 (will be
                  // corrected when smallRow's onLayout fires).
                  const rowY = smallRowYRef.current;
                  slotRectsRef.current.small1 = {x: r.x, y: rowY, width: r.width, height: r.height};
                  bumpSlotRects();
                }}
              />
              <View
                style={s.smallSlot}
                onLayout={e => {
                  const r = e.nativeEvent.layout;
                  const rowY = smallRowYRef.current;
                  slotRectsRef.current.small2 = {x: r.x, y: rowY, width: r.width, height: r.height};
                  bumpSlotRects();
                }}
              />
            </View>
          </View>
          {/* Pages 1+ — equal-3 grid. We render up to (totalPages - 1)
              extra skeleton pages, each at left = p × PAGE_W. The
              resolver's `grid[i]` indexes into these pages.
              gridThree's children report y relative to gridThree
              (which is itself flex:1 inside the page). gridThree
              starts at page-local y=0 because s.page has no top
              padding, so y=0 is correct AS-IS for grid pages. */}
          {pages.slice(1).map((_, p) => {
            const pageNum = p + 1;
            return (
              <View
                key={`sk-p${pageNum}`}
                style={[s.page, s.skeletonPage, {left: pageNum * PAGE_W, width: PAGE_W}]}>
                <View style={s.gridThree}>
                  {[0, 1, 2].map(slot => (
                    <View
                      key={slot}
                      style={s.gridThreeSlot}
                      onLayout={e => {
                        const r = e.nativeEvent.layout;
                        // Ensure grid array is large enough.
                        while (slotRectsRef.current.grid.length < pageNum) {
                          slotRectsRef.current.grid.push([null, null, null]);
                        }
                        const rect: SlotRect = {x: r.x, y: r.y, width: r.width, height: r.height};
                        const triple = slotRectsRef.current.grid[pageNum - 1];
                        triple[slot] = rect;
                        bumpSlotRects();
                      }}
                    />
                  ))}
                </View>
              </View>
            );
          })}
        </View>

        {/* Tiles layer — absolute positioned persistent tiles. B-17:
            iterates renderEntries (layout-derived, same tick as
            tilePositions) — never the retained ref directly. */}
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          {renderEmptyHero(slotRectsRef.current.hero)}
          {renderEntries.map(entry => {
            const pos = tilePositions[entry.tile.tag];
            if (!pos) {return null;}
            return renderPersistentTile(entry, pos);
          })}
        </View>
      </Animated.View>
      </View>

      {/* Pagination dots */}
      {totalPages > 1 && (
        <View style={s.dots}>
          {Array.from({length: totalPages}).map((_, i) => (
            <View key={i} style={[s.dot, i === pageIndex && s.dotActive]} />
          ))}
        </View>
      )}

      {/* Spacer — reserves the floating-dock zone so the flex:1 page
          area (and its skeleton-measured tiles) stay clear of the
          absolutely-positioned glass dock below. Height ≈ utility row +
          dock + bottom inset. */}
      <View style={{height: 166 + insets.bottom}} pointerEvents="none" />

      {/* Footer — fading obsidian scrim + glass control dock, exactly
          matching the mockup. The dock holds five circular controls in
          one row (Mute · Video · Flip · Add · Leave); the active state
          fills the circle white with a dark glyph. A slim utility row
          (Speaker · Chat) sits above it so we keep audio-route and
          in-call chat without diverging from the mockup's hero dock. */}
      <LinearGradient
        colors={['transparent', 'rgba(5,7,12,0.7)', 'rgba(5,7,12,1)']}
        locations={[0, 0.18, 0.55]}
        pointerEvents="none"
        style={[s.footerScrim, {height: 224 + insets.bottom}]}
      />
      <View style={[s.footerWrap, {paddingBottom: insets.bottom + 18}]}>
        {/* Utility row — secondary affordances kept off the hero dock. */}
        <View style={s.utilityRow}>
          <UtilityBtn
            icon={audioRoute === 'BLUETOOTH' ? 'bluetooth-audio' : audioRoute === 'WIRED_HEADSET' ? 'headphones' : 'volume-high'}
            label="Speaker"
            onPress={() => setRoutePickerOpen(true)}
          />
          <View style={s.roomTag}>
            <Text style={s.roomTagTxt} numberOfLines={1}>
              ROOM <Text style={s.roomTagStrong}>{(call.roomId ?? '------').slice(-6).toUpperCase()}</Text>
            </Text>
          </View>
          <UtilityBtn icon="message-text-outline" label="Chat" onPress={() => setChatOpen(true)} />
        </View>

        {/* Glass control dock — the mockup's five-up row. */}
        <View style={s.dock}>
          <DockBtn
            Icon="microphone"
            iconOff="microphone-off"
            off={call.isMuted}
            label={call.isMuted ? 'Unmute' : 'Mute'}
            onPress={call.toggleMute}
          />
          <DockBtn
            Icon="video"
            iconOff="video-off"
            off={!selfCameraOn}
            active={selfCameraOn}
            label="Video"
            onPress={() => { void call.toggleVideo(); }}
          />
          <DockBtn
            Icon="camera-flip-outline"
            label="Flip"
            disabled={!selfCameraOn}
            onPress={handleFlipCamera}
          />
          <DockBtn
            Icon="account-plus-outline"
            label="Add"
            badge={inviteCandidates.length}
            onPress={() => setInvitePickerOpen(true)}
          />
          <DockBtn
            Icon="phone-hangup"
            label="Leave"
            leave
            onPress={() => { void hangup(); }}
          />
        </View>
      </View>

      {/* Self preview corner PiP intentionally OMITTED for group calls.
          The grid's "YOU"-labelled small tile already shows local video,
          so the floating corner box duplicated it and ate screen real
          estate. (Compare 1:1 calls where the PiP IS retained because
          the full-screen view is the remote's video, not ours.) */}

      {/* ── Audio interruption banner ────────────────────────────
          Shown when another app (WhatsApp/Telegram/Phone) grabs
          AUDIOFOCUS_LOSS. Tells the user their mic is muted until
          the other app releases focus. Auto-clears on GAIN. */}
      {audioInterrupted && (
        <View style={[s.audioInterruptBanner, {top: insets.top + 8}]} pointerEvents="none">
          <Icon name="phone-paused" size={14} color="#FCD34D" />
          <Text style={s.audioInterruptTxt} numberOfLines={1}>
            Paused — another call is using your audio
          </Text>
        </View>
      )}

      {/* ── Incoming 1:1 banner ──────────────────────────────────
          Shown when a 1:1 call.offer arrived while we're on this
          group call. Accept tears down the group call + navigates to
          CallScreen with the queued SDP. Decline sends call.hangup so
          the offerer doesn't keep ringing into the void. */}
      {pendingOneToOne && (
        <View style={[s.incomingBanner, {top: insets.top + 8}]} pointerEvents="box-none">
          <View style={s.incomingBannerInner}>
            <View style={s.incomingAvatar}>
              <Text style={s.incomingAvatarTxt}>
                {recipientNameFor(pendingOneToOne.from.userId).slice(0, 2).toUpperCase()}
              </Text>
            </View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.incomingName} numberOfLines={1}>
                {recipientNameFor(pendingOneToOne.from.userId)}
              </Text>
              <Text style={s.incomingSub} numberOfLines={1}>
                Incoming {pendingOneToOne.kind === 'video' ? 'video' : 'voice'} call
              </Text>
            </View>
            <TouchableOpacity
              style={[s.incomingBtn, s.incomingDeclineBtn]}
              onPress={declineIncomingOneToOne}
              activeOpacity={0.75}
              accessibilityLabel="Decline call">
              <Icon name="phone-hangup" size={16} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.incomingBtn, s.incomingAcceptBtn]}
              onPress={acceptIncomingOneToOne}
              activeOpacity={0.75}
              accessibilityLabel="Accept call (will leave group call)">
              <Icon name="phone" size={16} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Invite modal ─────────────────────────────────── */}
      <Modal visible={invitePickerOpen} transparent animationType="slide" onRequestClose={() => setInvitePickerOpen(false)}>
        <Pressable style={s.modalBackdrop} onPress={() => setInvitePickerOpen(false)}>
          <Pressable style={s.sheet}>
            <Text style={s.sheetTitle}>Invite to call</Text>
            <Text style={s.sheetHint}>Pick someone to ring into this room.</Text>
            {inviteCandidates.length === 0 ? (
              <Text style={s.sheetEmpty}>No other contacts to invite.</Text>
            ) : (
              <FlatList
                data={inviteCandidates}
                keyExtractor={c => c.userId}
                style={{maxHeight: 280}}
                extraData={inviteRingExpiry}
                renderItem={({item: c}) => {
                  const expiresAt = inviteRingExpiry[c.userId] ?? 0;
                  const remainingMs = expiresAt - nowTick;
                  const ringing = remainingMs > 0;
                  const remainingSec = ringing ? Math.ceil(remainingMs / 1000) : 0;
                  return (
                    <View style={s.sheetRow}>
                      <View style={s.avatar}><Text style={s.avatarTxt}>{c.displayName.slice(0, 2).toUpperCase()}</Text></View>
                      <View style={{flex: 1, minWidth: 0}}>
                        <Text style={s.sheetRowName} numberOfLines={1}>{c.displayName}</Text>
                        <Text style={s.sheetRowSub} numberOfLines={1}>{c.userId.slice(0, 12)}</Text>
                      </View>
                      <TouchableOpacity
                        style={[
                          s.inviteRingBtn,
                          ringing ? s.inviteRingBtnActive : s.inviteRingBtnIdle,
                        ]}
                        disabled={ringing}
                        onPress={() => handleInvite(c)}
                        activeOpacity={0.75}
                        accessibilityLabel={ringing ? `Ringing, ${remainingSec} seconds remaining` : 'Ring'}>
                        {ringing ? (
                          <Text style={s.inviteRingBtnTxt} numberOfLines={1}>
                            Ringing… {remainingSec}s
                          </Text>
                        ) : (
                          <>
                            <Icon name="phone" size={14} color="#fff" />
                            <Text style={s.inviteRingBtnTxt}>Ring</Text>
                          </>
                        )}
                      </TouchableOpacity>
                    </View>
                  );
                }}
              />
            )}
            <TouchableOpacity style={s.sheetCancel} onPress={() => setInvitePickerOpen(false)} activeOpacity={0.75}>
              <Text style={s.sheetCancelTxt}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Audio route picker ───────────────────────────── */}
      <Modal visible={routePickerOpen} transparent animationType="fade" onRequestClose={() => setRoutePickerOpen(false)}>
        <Pressable style={s.modalBackdrop} onPress={() => setRoutePickerOpen(false)}>
          <Pressable style={s.sheet}>
            <Text style={s.sheetTitle}>Audio output</Text>
            {(['SPEAKER_PHONE', 'EARPIECE', 'BLUETOOTH', 'WIRED_HEADSET'] as AudioRoute[])
              .filter(r => r === 'SPEAKER_PHONE' || r === 'EARPIECE' || audioRoutes.includes(r))
              .map(r => (
                <TouchableOpacity
                  key={r}
                  style={[s.sheetRow, audioRoute === r && {backgroundColor: 'rgba(91,141,239,0.12)'}]}
                  activeOpacity={0.75}
                  onPress={() => pickAudioRoute(r)}>
                  <Icon
                    name={r === 'BLUETOOTH' ? 'bluetooth-audio' : r === 'WIRED_HEADSET' ? 'headphones' : r === 'EARPIECE' ? 'phone' : 'volume-high'}
                    size={20}
                    color={audioRoute === r ? C.act : C.tx2}
                  />
                  <Text style={[s.sheetRowName, {marginLeft: 10}]}>
                    {r === 'SPEAKER_PHONE' ? 'Speaker' : r === 'EARPIECE' ? 'Earpiece' : r === 'BLUETOOTH' ? 'Bluetooth' : 'Wired headset'}
                  </Text>
                  {audioRoute === r && <Icon name="check" size={18} color={C.act} />}
                </TouchableOpacity>
              ))}
            <TouchableOpacity style={s.sheetCancel} onPress={() => setRoutePickerOpen(false)} activeOpacity={0.75}>
              <Text style={s.sheetCancelTxt}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Chat side-sheet ────────────────────────────────
          BS-026 fix: keep the nested-Pressable structure (matches the
          invite + route pickers above — the inner Pressable acts as a
          stop-propagation wall thanks to RN's responder system giving
          the innermost Pressable first claim on touches). Two real
          bugs fixed:
          1. `keyboardShouldPersistTaps="handled"` — without this, the
             FIRST tap after the keyboard appears dismisses the
             keyboard and is consumed by the ScrollView, so the next
             tap on Send / composer felt like "the input is stuck".
          2. `blurOnSubmit={false}` — TextInput defaults to dismissing
             the keyboard on each `Submit`. After typing+sending one
             message the keyboard closed; the user had to re-tap the
             composer to type again, which (combined with #1) felt
             like the chat had locked up. Keep the keyboard up so
             back-to-back sends are immediate. */}
      <Modal visible={chatOpen} transparent animationType="slide" onRequestClose={() => setChatOpen(false)}>
        {/* B-84 / KB-05 — Android Modal windows never resize for the IME
            and KAV has no Android behavior: lift the sheet manually. */}
        <KeyboardAvoidingView
          style={[{flex: 1}, Platform.OS === 'android' && {paddingBottom: kbHeight}]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={s.modalBackdrop} onPress={() => setChatOpen(false)}>
            {/* BS-028 — inner Pressable MUST have an onPress (even a
                 no-op) so it claims the responder. Without it, every
                 tap inside the sheet (TextInput focus, send-button
                 press, scroll gesture) bubbled up to the backdrop's
                 onPress, instantly closing the modal — felt to the
                 user like in-call chat "wasn't working". The same
                 nested-Pressable pattern is used in the invite picker
                 (which works) because Pressable there inherits a
                 captured event from the FlatList wrapper. */}
            <Pressable style={[s.sheet, {maxHeight: '85%'}]} onPress={() => { /* swallow taps */ }}>
              <View style={s.chatHeader}>
                <Icon name="message-text-outline" size={18} color={C.act} />
                <Text style={[s.sheetTitle, {marginBottom: 0}]}>In-call chat</Text>
                <TouchableOpacity onPress={() => setChatOpen(false)}>
                  <Icon name="close" size={20} color={C.tx2} />
                </TouchableOpacity>
              </View>
              <ScrollView
                style={{maxHeight: 320}}
                contentContainerStyle={{padding: 8}}
                keyboardShouldPersistTaps="handled">
                {messagesForConv.length === 0 ? (
                  <Text style={s.sheetEmpty}>No messages yet. Say hi.</Text>
                ) : (
                  messagesForConv.slice(-30).map(m => (
                    <View key={m.id} style={[s.chatBubble, m.sender_id === 'self' && s.chatBubbleSelf]}>
                      <Text style={s.chatBubbleTxt} numberOfLines={4}>
                        {m.type === 'text' ? m.content : `[${m.type}]`}
                      </Text>
                    </View>
                  ))
                )}
              </ScrollView>
              <View style={s.chatComposer}>
                <TextInput
                  style={s.chatInput}
                  value={chatDraft}
                  onChangeText={setChatDraft}
                  placeholder="Message…"
                  placeholderTextColor={C.tx3}
                  onSubmitEditing={sendChat}
                  returnKeyType="send"
                  blurOnSubmit={false}
                />
                <TouchableOpacity style={s.chatSend} onPress={sendChat} activeOpacity={0.85}>
                  <Icon name="send" size={18} color="#FFF" />
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* Weak-network recovery overlay. Shown when one of our mediasoup
          transports goes 'disconnected' mid-call; useGroupCall fires a
          server-side restartIce and flips state to 'reconnecting'. Auto-
          dismisses when both transports return to 'connected'; call
          ends 'failed' if the 30s budget exhausts. */}
      {call.state === 'reconnecting' && (
        <GroupReconnectingOverlay
          memberCount={onCallCount}
          onCancel={() => { void hangup(); }}
        />
      )}
    </View>
  );
}

/**
 * Full-screen recovery overlay for group calls. Same WhatsApp-style
 * UX as the 1:1 path: dark scrim + center card with a spinner and a
 * 30s budget counter. Triggered when useGroupCall sees a mediasoup
 * transport `connectionstatechange === 'disconnected'`; auto-dismisses
 * when both transports return to 'connected'.
 */
function GroupReconnectingOverlay(props: {
  memberCount: number;
  onCancel:    () => void;
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
    <View style={s.reconnectScrim} pointerEvents="auto">
      <View style={s.reconnectCard}>
        <View style={s.reconnectIcon}>
          <Icon name="account-multiple" size={28} color="#FFFFFF" />
        </View>
        <Text style={s.reconnectTitle}>Group call · {props.memberCount} on call</Text>
        <View style={s.reconnectStatusRow}>
          <ActivityIndicator size="small" color={C.warn} />
          <Text style={s.reconnectStatusTxt}>Reconnecting…</Text>
        </View>
        <Text style={s.reconnectCounter}>{elapsed}s of 30s</Text>
        <Text style={s.reconnectHint}>
          Network blip detected. Trying to restore the call.
          {remaining > 0 ? ` Giving up in ${remaining}s if it does not recover.` : ''}
        </Text>
        <TouchableOpacity
          style={s.reconnectCancelBtn}
          onPress={props.onCancel}
          activeOpacity={0.75}>
          <Text style={s.reconnectCancelTxt}>Leave call</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Round 4 / Architecture audit fix: wrap the screen in a per-screen
// ErrorBoundary so a crash inside GroupCallScreen (e.g. mediasoup
// transport thrash, RTCView native bridge throw) doesn't unmount the
// app. The user sees a Retry/Back card; navigator state survives.
const GroupCallScreen = withScreenErrorBoundary(GroupCallScreenInner, 'Group call');
export default GroupCallScreen;

// ─── Sub-components ────────────────────────────────────────────────

/**
 * Glass-dock control — a 52px circle with a mono uppercase caption,
 * matching the mockup's `GControl`. States:
 *   • active  → white-filled circle, dark glyph (e.g. Video on)
 *   • off     → ghost circle, swaps to the `iconOff` glyph (e.g. Mute,
 *               Camera off) and tints the caption muted-red-ish via the
 *               `off` flag styling
 *   • leave   → red radial-style gradient circle (End/Leave)
 *   • disabled→ dimmed + non-interactive (Flip while camera off)
 */
type IconName = React.ComponentProps<typeof Icon>['name'];

function DockBtn(props: {
  Icon: IconName;
  iconOff?: IconName;
  label: string;
  active?: boolean;
  off?: boolean;
  leave?: boolean;
  disabled?: boolean;
  badge?: number;
  onPress: () => void;
}): React.ReactElement {
  const glyph = props.off && props.iconOff ? props.iconOff : props.Icon;
  const iconColor = props.leave ? '#fff' : props.active ? C.inkOnWhite : C.tx1;
  return (
    <TouchableOpacity
      style={s.dockSlot}
      onPress={props.onPress}
      activeOpacity={0.8}
      disabled={props.disabled}>
      {props.leave ? (
        <LinearGradient
          colors={[C.errSoft, C.err, '#C21F37']}
          start={{x: 0.35, y: 0.2}}
          end={{x: 0.7, y: 1}}
          style={[s.dockCircle, s.dockLeave]}>
          <Icon name={props.Icon} size={24} color="#fff" />
        </LinearGradient>
      ) : (
        <View style={[
          s.dockCircle,
          props.active && s.dockCircleActive,
          props.disabled && s.dockCircleDisabled,
        ]}>
          <Icon name={glyph} size={22} color={iconColor} />
          {props.badge && props.badge > 0 ? (
            <View style={s.dockBadge}><Text style={s.dockBadgeTxt}>{props.badge > 9 ? '9+' : props.badge}</Text></View>
          ) : null}
        </View>
      )}
      <Text style={[
        s.dockLbl,
        props.active && s.dockLblActive,
        props.leave  && s.dockLblLeave,
        props.disabled && s.dockLblDisabled,
      ]}>{props.label}</Text>
    </TouchableOpacity>
  );
}

/** Slim utility affordance above the dock — icon + small caption. */
function UtilityBtn(props: {icon: IconName; label: string; onPress: () => void}): React.ReactElement {
  return (
    <TouchableOpacity style={s.utilSlot} onPress={props.onPress} activeOpacity={0.7}>
      <Icon name={props.icon} size={15} color={C.tx2} />
      <Text style={s.utilLbl}>{props.label}</Text>
    </TouchableOpacity>
  );
}

/**
 * Tiny meter that scales with audioLevel — 3 vertical bars next to a
 * speaker's name pill. Animation is 60 fps via Animated.spring so it
 * tracks the 500 ms poll smoothly.
 */
function AudioBars({level}: {level: number}): React.ReactElement {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(anim, {toValue: level, useNativeDriver: false, friction: 5, tension: 60}).start();
  }, [level, anim]);
  const h = (mult: number): Animated.AnimatedInterpolation<number> =>
    anim.interpolate({inputRange: [0, 1], outputRange: [3, 14 * mult]});
  return (
    <View style={s.bars}>
      <Animated.View style={[s.bar, {height: h(0.7)}]} />
      <Animated.View style={[s.bar, {height: h(1)}]} />
      <Animated.View style={[s.bar, {height: h(0.5)}]} />
    </View>
  );
}

// ─── helpers ───────────────────────────────────────────────────────
function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── styles ────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg},
  blockerBox: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14},
  blockerTitle: {color: C.tx1, fontSize: 18, fontWeight: '800'},
  blockerBtn: {marginTop: 12, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, backgroundColor: C.surf1, borderWidth: 1, borderColor: C.bd2},
  blockerBtnTxt: {color: C.tx1, fontSize: 13, fontWeight: '700', letterSpacing: 0.4},

  topBar: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
  },
  // Grid-icon chip (mockup) — cobalt-tinted rounded square. Doubles as
  // the minimize affordance.
  headerChip: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: 'rgba(91,141,239,0.16)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  headerMeta:  {flex: 1, minWidth: 0},
  title:       {color: C.tx1, fontSize: 16.5, fontWeight: '700', letterSpacing: -0.2},
  headerSubRow:{flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4},
  recDot:      {width: 6, height: 6, borderRadius: 3, backgroundColor: C.err},
  headerTimer: {color: C.tx1, fontSize: 10.5, fontWeight: '700', letterSpacing: 1, fontFamily: MONO},
  headerSep:   {width: 3, height: 3, borderRadius: 1.5, backgroundColor: C.txFaint},
  headerJoined:{color: C.tx3, fontSize: 10, letterSpacing: 0.5, fontFamily: MONO},
  headerRight: {alignItems: 'flex-end', gap: 6},
  // E2E pill — green-tinted lock badge (mockup).
  e2ePill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    backgroundColor: 'rgba(74,222,128,0.08)',
    borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)',
  },
  e2ePillTxt: {color: C.ok, fontSize: 9, fontWeight: '700', letterSpacing: 1, fontFamily: MONO},

  // Invitee strip — WhatsApp-style "Calling…" rows with a green
  // phone button per name. Replaces the older Ringing/Re-ringing
  // status-pill strip.
  inviteeStrip:    {gap: 8, paddingHorizontal: 14, paddingVertical: 8},
  inviteeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16,
    backgroundColor: 'rgba(22,47,84,0.55)',
    borderWidth: 1, borderColor: C.bd2,
    minWidth: 200,
  },
  inviteeAvatar: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center', justifyContent: 'center',
  },
  inviteeAvatarTxt: {color: C.tx1, fontSize: 11, fontWeight: '700', letterSpacing: 0.4},
  inviteeMeta:     {flex: 1, minWidth: 0},
  inviteeName:     {color: C.tx1, fontSize: 12, fontWeight: '700'},
  inviteeStatus:   {color: C.tx2, fontSize: 10, fontWeight: '600', marginTop: 1},
  inviteeCallBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#00C853', // WhatsApp-style green
    alignItems: 'center', justifyContent: 'center',
  },
  inviteeCallBtnDisabled: {
    backgroundColor: 'rgba(0,200,83,0.32)',
  },

  // Incoming 1:1 banner — shown while in a group call when someone
  // dials this user 1:1. Accept = leave group + jump to CallScreen.
  incomingBanner: {
    position: 'absolute', left: 12, right: 12,
    zIndex: 50,
  },
  incomingBannerInner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(11,14,20,0.96)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)',
    borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10,
    shadowColor: '#000', shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.35, shadowRadius: 10, elevation: 8,
  },
  incomingAvatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center', justifyContent: 'center',
  },
  incomingAvatarTxt: {color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.4},
  incomingName:      {color: '#fff', fontSize: 13, fontWeight: '700'},
  incomingSub:       {color: 'rgba(255,255,255,0.65)', fontSize: 11, marginTop: 2},
  incomingBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  incomingDeclineBtn: {backgroundColor: '#E53935'},
  incomingAcceptBtn:  {backgroundColor: '#00C853'},

  // Audio interruption banner — shown when another app stole audio
  // focus (incoming WhatsApp call, etc.). Mic is auto-muted; user
  // sees a yellow-amber pill explaining why their voice isn't
  // transmitting. Auto-clears when focus returns.
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
  audioInterruptTxt: {color: '#FEF3C7', fontSize: 11, fontWeight: '700', flex: 1},

  // Invite-modal Ring button — shows "Ring" idle, then flips to a
  // disabled "Ringing… 24s" countdown for INVITE_RING_WINDOW_MS,
  // then re-arms.
  inviteRingBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, height: 36, borderRadius: 18,
    minWidth: 80, justifyContent: 'center',
  },
  inviteRingBtnIdle:   {backgroundColor: '#00C853'},
  inviteRingBtnActive: {backgroundColor: 'rgba(0,200,83,0.32)'},
  inviteRingBtnTxt:    {color: '#fff', fontSize: 11, fontWeight: '700'},

  pageWrap: {flex: 1, paddingHorizontal: PAGE_PADDING_H, overflow: 'hidden'},
  page:     {flex: 1, gap: 12},
  // Fix #13 unified-grid restructure — skeleton pages live as absolute
  // siblings inside pageWrap so they all measure simultaneously. The
  // skeleton wrapper is invisible (opacity 0) and pointerEvents-none.
  skeletonPage: {position: 'absolute', top: 0, bottom: 0},

  // Hero tile (page 1)
  heroTile: {
    flex: 1.6,
    borderRadius: 22, overflow: 'hidden',
    backgroundColor: C.surf2, borderWidth: 1, borderColor: C.bd2,
    position: 'relative',
  },
  // Flexible-aspect hero variant — used when the tile has a live
  // video. Drops `flex: 1.6` so the wrapper can adopt the inner
  // FlexibleVideoTile's `aspectRatio` and bend with the source video.
  // `alignSelf: stretch` lets the wrapper fill the row width so the
  // computed height is `width / aspectRatio`. Keeps the rest of the
  // hero chrome (LIVE pill, name pill) absolutely positioned on top.
  heroFlexWrap: {
    width: '100%', alignSelf: 'stretch',
    borderRadius: 22, overflow: 'hidden',
    backgroundColor: C.surf2, borderWidth: 1, borderColor: C.bd2,
    position: 'relative',
  },
  // BS-GC-BLACKVIDEO — height:'100%' so the tile fills the wrapper's now-
  // pinned measured height (see renderPersistentTile). When the wrapper has
  // an explicit height the inner View fills it and FlexibleVideoTile's
  // aspectRatio becomes a no-op fallback; when the wrapper is unmeasured
  // (no height) '100%' resolves to 0 and aspectRatio drives cold-start as
  // before. RTCView (absoluteFill) then fills a stable, non-oscillating box.
  heroFlexInner: {width: '100%', height: '100%'},
  // Flexible-aspect variant for the small-tile slots on page 1 and
  // the equal-3 grid on page 2+. Drops `flex: 1` so the inner aspect
  // ratio drives height. `width: '100%'` makes it fill the slot
  // horizontally; height becomes `slotWidth / aspectRatio`.
  smallFlexWrap: {
    width: '100%',
    borderRadius: 18, overflow: 'hidden',
    backgroundColor: C.surf3, borderWidth: 1, borderColor: C.bd2,
    position: 'relative',
  },
  smallFlexInner: {width: '100%', height: '100%'},
  heroEmpty: {alignItems: 'center', justifyContent: 'center', gap: 10, borderRadius: 22},
  emptyTitle: {color: C.tx1, fontSize: 14, fontWeight: '700'},
  emptySub:   {color: C.tx3, fontSize: 12},
  // Speaking → signal-green border + green glow (mockup).
  heroSpeaking: {borderWidth: 2, borderColor: C.ok, shadowColor: C.ok, shadowOpacity: 0.6, shadowRadius: 14, elevation: 12},

  // LIVE · HD pill — top-left dark glass with red dot (mockup).
  livePill: {
    position: 'absolute', top: 12, left: 12, zIndex: 5,
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 9, paddingVertical: 5, borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.5)', borderWidth: 1, borderColor: C.bd2,
  },
  liveDot: {width: 6, height: 6, borderRadius: 3, backgroundColor: C.err},
  livePillTxt: {color: C.tx1, fontSize: 9, fontWeight: '800', letterSpacing: 0.6, fontFamily: MONO},

  heroMoreBtn: {
    position: 'absolute', top: 12, right: 12, zIndex: 5,
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)', borderWidth: 1, borderColor: C.bd2,
  },

  // Camera-off avatar block — gradient-ring disc + centred initials.
  tileAv: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.surf3,
  },
  // B-15 — "Video unavailable" overlay over a live-but-frameless tile.
  stallOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(5,7,12,0.55)', gap: 6,
  },
  stallTxt:     {color: C.tx2, fontSize: 11, fontWeight: '600'},
  stallTxtHero: {fontSize: 13},
  avatarDisc: {
    borderRadius: 999, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  avatarDiscHero:  {width: 110, height: 110},
  avatarDiscSmall: {width: 64, height: 64},
  avatarInitials:  {color: '#fff', fontSize: 24, fontWeight: '700'},
  avatarInitialsHero: {fontSize: 38},

  // Name plate — bottom-left glass pill: dot/mic glyph + name (mockup).
  namePlate: {
    position: 'absolute', left: 10, bottom: 10, zIndex: 5,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.5)', borderWidth: 1, borderColor: C.bd2,
    maxWidth: '85%',
  },
  namePlateHero: {left: 12, bottom: 12, paddingHorizontal: 11, paddingVertical: 5},
  nameDot:    {width: 6, height: 6, borderRadius: 3, backgroundColor: C.ok, shadowColor: C.ok, shadowOpacity: 0.9, shadowRadius: 4},
  nameDotIdle:{backgroundColor: C.tx3, shadowOpacity: 0},
  namePlateTxt:    {color: '#fff', fontSize: 11.5, fontWeight: '600', maxWidth: 130},
  namePlateTxtHero:{fontSize: 13},

  // Speaking equalizer — top-right animated bars (mockup).
  eqWrap: {position: 'absolute', top: 12, right: 12, zIndex: 6},

  // Small-tile row (page 1)
  // flex:1 fills remaining space below hero — eliminates the black gap
  // that appeared when height:130 undershot the allocated flex space.
  smallRow:  {flexDirection: 'row', gap: 12, flex: 1},
  // B-19 — fill the row's half-slot by flex instead of deriving height from
  // aspectRatio. `flex:1` (stretch to the row) and `aspectRatio:9/12` (height
  // = width × 1.33) fought each other: the aspect-derived height overflowed
  // the fixed flex:1 row height, so the measured slot was too tall and the
  // real video tile's bottom name-plate got clipped by pageWrap
  // overflow:'hidden'. The video uses objectFit:'cover' to fill; the
  // camera-off avatar keeps its own aspectRatio (s.tileAv), so it's unaffected.
  smallSlot: {flex: 1},

  // Equal-3 grid (page 2+)
  gridThree: {flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 12},
  // B-19 — 3 × 31.8% + two 12px gaps = 95.4% + 24px, which exceeds PAGE_W on
  // every phone (it only fits at PAGE_W ≳ 522), so with flexWrap the 3rd slot
  // wrapped to a 2nd row (2-over-1 instead of 3-across). Derive the width from
  // the live PAGE_W so 3 slots + 2 gaps fit exactly on any device; floor to
  // avoid a sub-pixel overflow re-triggering the wrap.
  gridThreeSlot: {width: Math.floor((PAGE_W - 24) / 3), aspectRatio: 9 / 12},

  youBadge: {
    position: 'absolute', top: 10, left: 10, zIndex: 5,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
    backgroundColor: 'rgba(91,141,239,0.18)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
  },
  youBadgeTxt: {color: C.actSoft, fontSize: 9, fontWeight: '800', letterSpacing: 0.8, fontFamily: MONO},

  bars: {flexDirection: 'row', alignItems: 'flex-end', gap: 2.5, height: 16},
  bar:  {width: 3, backgroundColor: C.ok, borderRadius: 2},

  dots: {flexDirection: 'row', justifyContent: 'center', gap: 5, paddingVertical: 8},
  dot:  {width: 16, height: 3, borderRadius: 2, backgroundColor: 'rgba(169,197,255,0.2)'},
  dotActive: {backgroundColor: C.glow, width: 22},

  pip: {
    position: 'absolute', width: 76, height: 102, borderRadius: 12, overflow: 'hidden',
    backgroundColor: C.surf3, borderWidth: 1, borderColor: C.bd,
    elevation: 8,
  },

  // Footer — fading obsidian scrim + glass dock (mockup).
  footerScrim: {position: 'absolute', left: 0, right: 0, bottom: 0},
  footerWrap:  {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 8, gap: 12},

  // Utility row — Speaker · Room tag · Chat, above the hero dock.
  utilityRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  utilSlot:   {flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingVertical: 6, paddingHorizontal: 8},
  utilLbl:    {color: C.tx2, fontSize: 11, fontWeight: '600'},
  roomTag:    {flex: 1, alignItems: 'center'},
  roomTagTxt: {color: C.tx3, fontSize: 9.5, fontFamily: MONO, letterSpacing: 0.8},
  roomTagStrong: {color: C.tx2, fontWeight: '700'},

  // Glass control dock — the five-up row.
  dock: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 4,
    paddingHorizontal: 16, paddingVertical: 16, borderRadius: 28,
    backgroundColor: 'rgba(19,24,42,0.78)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  dockSlot:   {flex: 1, alignItems: 'center', gap: 8},
  dockCircle: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: C.surf1, borderWidth: 1, borderColor: C.bd,
    alignItems: 'center', justifyContent: 'center', position: 'relative',
  },
  dockCircleActive:   {backgroundColor: C.white, borderColor: C.white},
  dockCircleDisabled: {opacity: 0.4},
  dockLeave: {borderColor: 'rgba(255,255,255,0.2)'},
  dockLbl:   {color: C.tx2, fontSize: 9, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', fontFamily: MONO},
  dockLblActive:   {color: C.tx1},
  dockLblLeave:    {color: C.errSoft},
  dockLblDisabled: {color: C.txFaint},
  dockBadge: {
    position: 'absolute', top: -2, right: -2,
    minWidth: 16, height: 16, borderRadius: 8,
    backgroundColor: C.act, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
    borderWidth: 1, borderColor: C.bg,
  },
  dockBadgeTxt: {color: '#FFF', fontSize: 9, fontWeight: '800'},

  // Sheets / modals
  modalBackdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end'},
  sheet: {
    backgroundColor: C.bgDeep, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 16, paddingBottom: 28,
    borderTopWidth: 1, borderTopColor: C.bd2,
  },
  sheetTitle: {color: C.tx1, fontSize: 14, fontWeight: '800', letterSpacing: 0.4, marginBottom: 4},
  sheetHint:  {color: C.tx3, fontSize: 12, marginBottom: 12},
  sheetEmpty: {color: C.tx3, fontSize: 12, textAlign: 'center', padding: 24},
  sheetRow:   {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 10},
  sheetRowName: {color: C.tx1, fontSize: 13, fontWeight: '700'},
  sheetRowSub:  {color: C.tx3, fontSize: 11, marginTop: 2, fontFamily: MONO},
  sheetCancel: {marginTop: 10, padding: 12, alignItems: 'center'},
  sheetCancelTxt: {color: C.tx2, fontSize: 13, fontWeight: '700'},
  avatar: {width: 36, height: 36, borderRadius: 18, backgroundColor: C.surf2, borderWidth: 1, borderColor: C.bd2, alignItems: 'center', justifyContent: 'center'},
  avatarTxt: {color: C.tx1, fontSize: 11, fontWeight: '800', fontFamily: MONO},

  // Chat
  chatHeader: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8},
  chatBubble: {
    backgroundColor: C.surf2, borderWidth: 1, borderColor: C.bd2,
    borderRadius: 12, padding: 10, marginBottom: 6, alignSelf: 'flex-start', maxWidth: '80%',
  },
  chatBubbleSelf: {backgroundColor: 'rgba(91,141,239,0.16)', borderColor: 'rgba(91,141,239,0.4)', alignSelf: 'flex-end'},
  chatBubbleTxt: {color: C.tx1, fontSize: 13, lineHeight: 18},
  chatComposer: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.bd2},
  chatInput: {
    flex: 1, color: C.tx1, fontSize: 13,
    backgroundColor: C.surf2, borderWidth: 1, borderColor: C.bd2,
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
  },
  chatSend: {width: 40, height: 40, borderRadius: 20, backgroundColor: C.act, alignItems: 'center', justifyContent: 'center'},

  // ── Reconnecting overlay (weak-network recovery) ──
  reconnectScrim: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(5,7,12,0.94)',
    alignItems: 'center', justifyContent: 'center',
    zIndex: 200, elevation: 200,
  },
  reconnectCard: {
    width: '82%', maxWidth: 340,
    backgroundColor: C.surf2,
    borderWidth: 1, borderColor: C.bd,
    borderRadius: 18, paddingVertical: 24, paddingHorizontal: 22,
    alignItems: 'center', gap: 8,
    shadowColor: '#000', shadowOffset: {width: 0, height: 8},
    shadowOpacity: 0.5, shadowRadius: 18, elevation: 18,
  },
  reconnectIcon: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: C.surf1, borderWidth: 2, borderColor: C.warn,
    alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  reconnectTitle: {
    color: C.tx1, fontSize: 14, fontWeight: '700',
    letterSpacing: 0.4, marginTop: 2,
  },
  reconnectStatusRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8,
  },
  reconnectStatusTxt: {
    color: C.warn, fontSize: 13, fontWeight: '700', letterSpacing: 0.6,
  },
  reconnectCounter: {
    color: C.tx3, fontSize: 11, fontWeight: '600',
    letterSpacing: 0.6, marginTop: 2, fontFamily: MONO,
  },
  reconnectHint: {
    color: C.tx2, fontSize: 12, lineHeight: 18, textAlign: 'center',
    marginTop: 8, paddingHorizontal: 4,
  },
  reconnectCancelBtn: {
    marginTop: 14, paddingHorizontal: 22, paddingVertical: 11,
    borderRadius: 14, backgroundColor: C.err,
  },
  reconnectCancelTxt: {
    color: '#FFFFFF', fontSize: 13, fontWeight: '800', letterSpacing: 0.6,
  },
});
