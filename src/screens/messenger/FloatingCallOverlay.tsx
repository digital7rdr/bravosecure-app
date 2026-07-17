/**
 * FloatingCallOverlay — global "minimized call" UI.
 *
 * Mounted once at App.tsx so it can render over any screen the user
 * navigates to while a call is active. Subscribes to the
 * `callRegistry` singleton and shows nothing unless there's an active
 * call AND it's been minimized.
 *
 * Two layouts:
 *  - audio: a slim top-of-screen bar with caller name, duration,
 *           tap-to-restore, and an end-call button
 *  - video: a draggable floating card (Messenger / FaceTime style)
 *           with the remote video preview, tap-to-restore, end button
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Animated, PanResponder, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {RTCView} from 'react-native-webrtc';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import {navigationRef} from '@navigation/navigationRef';
import {endActiveCall, getActiveCall, onActiveCallChange, setMinimized, type ActiveCallState} from '@/modules/messenger/runtime/callRegistry';
import {
  endActiveGroupCall, getActiveGroupCall, onActiveGroupCallChange, setGroupCallMinimized,
  patchActiveGroupCall,
  type ActiveGroupCallState,
} from '@/modules/messenger/runtime/groupCallRegistry';
import {safeStreamURL} from '@/modules/messenger/webrtc/safeStreamURL';
import {resolveRemoteTile} from '@/modules/messenger/webrtc/remoteTileGate';

export default function FloatingCallOverlay(): React.ReactElement | null {
  const [active, setActive] = useState<ActiveCallState | null>(null);
  const [groupActive, setGroupActive] = useState<ActiveGroupCallState | null>(null);
  // Local re-render tick driven by the registry. We can't rely on the
  // ActiveCallState reference identity changing, because patchActiveCall
  // sometimes mutates without swapping the object.
  useEffect(() => onActiveCallChange(setActive), []);
  useEffect(() => onActiveGroupCallChange(setGroupActive), []);

  // BS-MINBUBBLE — minimized-window SFU watchdog. While a group call is
  // minimized, NO useGroupCall hook is mounted (this overlay is a pure
  // registry consumer), so server control frames that arrive during the
  // minimize window are otherwise dropped: a host End / kick would leave the
  // bubble stuck forever over a dead call, and a peer who LEAVES would stay a
  // frozen phantom tile after restore. This watchdog runs ONLY while
  // minimized and: tears the registry down on room.ended / kicked, and drops
  // a leaver's tile. `registerSfuHandler` is additive (a Set), so it never
  // clobbers the live hook's handler; `endActiveGroupCall` is idempotent.
  const minimizedRoomId = groupActive?.isMinimized ? groupActive.roomId : null;
  useEffect(() => {
    if (!minimizedRoomId) {return;}
    const {registerSfuHandler} = require('@/modules/messenger/webrtc/sfuDispatcher') as typeof import('@/modules/messenger/webrtc/sfuDispatcher');
    return registerSfuHandler(minimizedRoomId, (frame) => {
      if (frame.event === 'sfu.room.ended' || frame.event === 'sfu.kicked') {
        void endActiveGroupCall();
      } else if (frame.event === 'sfu.participant.left') {
        const tag = (frame.data as {participantTag?: string})?.participantTag;
        const live = getActiveGroupCall();
        if (live && tag) {
          const tiles = live.remoteTiles.filter(t => t.participantTag !== tag);
          const ident = {...live.identityByTag};
          delete ident[tag];
          patchActiveGroupCall({remoteTiles: tiles, identityByTag: ident});
        }
      }
    });
  }, [minimizedRoomId]);

  // Duration counter — ticks for both 1:1 ('connected') and group ('joined').
  const [duration, setDuration] = useState(0);
  // Fix #22: re-evaluate the wall-clock anchor on EVERY tick (not just
  // at effect-rebind time). The previous code branched once based on
  // whether `startMs` was set at the moment the effect ran — so if the
  // overlay mounted BEFORE the underlying call hit connected/joined
  // (anchor still null), we fell into the local-fallback path and
  // never switched to the wall-clock even after the anchor landed.
  // Reading the registry on every tick is cheap and gives us a single
  // source of truth that auto-snaps to wall-clock the moment the
  // anchor lands.
  useEffect(() => {
    const oneOnOneOn = active?.state === 'connected';
    const groupOn    = groupActive?.state === 'joined';
    if (!oneOnOneOn && !groupOn) { setDuration(0); return; }
    let localFallback = 0;
    let anchored = false;
    const tick = (): void => {
      // Re-read every tick — `active` and `groupActive` here are the
      // closure captures from when the effect ran, but their `.connectedAtMs`
      // / `.joinedAtMs` fields are mutated in place by the registry's
      // patchActiveCall (the registry mutates not just swaps for these
      // fields), so reading through the closure is safe and current.
      const startMs = groupOn
        ? groupActive?.joinedAtMs ?? null
        : active?.connectedAtMs ?? null;
      if (startMs) {
        anchored = true;
        setDuration(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
      } else if (!anchored) {
        // Local fallback only while the anchor is still null. Once
        // anchored we never come back here (latched).
        localFallback += 1;
        setDuration(localFallback);
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [active, groupActive, active?.state, active?.connectedAtMs, groupActive?.state, groupActive?.joinedAtMs]);

  // Drag state for the video card — see useDraggablePan above.
  const {pan, panHandlers} = useDraggablePan();

  // Round 2 / Perf audit: stable streamURL cache for the 1:1 video path.
  // The ref MUST be declared before any early-return below, otherwise
  // hooks-order would change between renders and React would crash.
  // We compute the URL conditionally inside the if-isVideo branch later.
  const oneToOneUrlRef = useRef<string | null>(null);

  // Group call takes precedence — only one floating overlay visible at
  // a time. (Two simultaneous calls is a UX disaster anyway and
  // useGroupCall / useCall both check the registry on boot to bail.)
  if (groupActive?.isMinimized) {
    return <GroupOverlay state={groupActive} duration={duration} />;
  }

  // B-64 — show the overlay not only for explicitly-minimized calls but for
  // ANY live in-progress 1:1 call whose CallScreen isn't the focused route:
  // an auth-gate swap can unmount the whole Main tree (user parked on the
  // OTP screen with a call running behind it), leaving no End control
  // anywhere. Restricted to post-answer states so the ring/dial surfaces
  // (which own 'ringing'/'calling') don't get a duplicate overlay flash.
  // The registry's 1 Hz duration patch re-renders us, so a route change is
  // picked up within a second even though we don't subscribe to navigation.
  const orphanedLive = ((): boolean => {
    if (!active || active.isMinimized) {return false;}
    if (active.state !== 'connecting' && active.state !== 'connected' && active.state !== 'reconnecting') {return false;}
    try {
      const ref = navigationRef as unknown as {isReady?: () => boolean; getCurrentRoute?: () => {name?: string} | undefined};
      if (!ref?.isReady?.()) {return true;}   // nav not ready (auth gate) — call is unreachable, show End
      return ref.getCurrentRoute?.()?.name !== 'CallScreen';
    } catch { return false; }
  })();

  if (!active) {return null;}
  if (!active.isMinimized && !orphanedLive) {return null;}

  const isVideo = active.kind === 'video';
  const peerName = active.peerName || 'Contact';
  const restore = (): void => {
    // Fix #24: re-check the registry BEFORE touching minimized state.
    // Between this overlay's render and the user's tap, the underlying
    // call may have been ended on another path (peer hung up, fail
    // event, manual end via the floating End button). Navigating to
    // CallScreen with stale `active` params would mount it for a call
    // that no longer exists.
    if (!getActiveCall()) {return;}
    // Bring CallScreen back to the foreground via the global
    // navigation ref so this overlay (mounted OUTSIDE the navigator
    // tree) can route. CallScreen on remount sees the active call
    // already in the registry and resumes the existing controller +
    // streams instead of starting a new call.
    //
    // P3 — CONFIRM navigation dispatched before hiding the overlay. The
    // old order flipped minimized=false FIRST, so a cross-tab navigate
    // that wasn't ready (or threw) hid the overlay AND failed to route,
    // stranding a live call with no UI to return to. Only clear the
    // minimized flag once the navigate call has actually been issued.
    try {
      const ref = navigationRef as unknown as {isReady: () => boolean; navigate: (name: string, params?: unknown) => void};
      if (!ref?.isReady?.()) {return;}   // overlay stays up; user can retap
      ref.navigate('CallScreen', {
        callType:       active.kind,
        isIncoming:     active.direction === 'incoming',
        conversationId: active.conversationId,
        callId:         active.callId,
        remoteUserId:   active.peer.userId,
        remoteDeviceId: active.peer.deviceId,
      });
      setMinimized(false);
    } catch { /* nav failed — leave the overlay up so the call isn't stranded */ }
  };
  // 'local' source so CallKit / Telecom logs the end correctly as a
  // user-initiated hangup (declined glyph in iOS Recents) rather than
  // a remote-ended one.
  const hangup = (): void => endActiveCall('ended', 'local');

  // Round 2 / Perf audit: stable streamURL cache for the 1:1 video path.
  // Mirrors the GroupOverlay `lastUrlRef` pattern at line 325. Without
  // this, the IIFE called `safeStreamURL(active.remoteStream)` on every
  // render — and `patchActiveCall({duration, …})` mutates the
  // surrounding `active` object every second. The result was that the
  // RTCView's streamURL prop got a fresh string identity each tick,
  // forcing a JNI hop on the native side and occasionally swapping the
  // EGL surface mid-call. With the ref cache the prop only flips
  // identity when the underlying stream actually changes. The ref
  // itself is declared above the early returns so hooks-order stays
  // stable across renders; only the cache update happens here.
  const computedOneToOneUrl = isVideo ? safeStreamURL(active.remoteStream) : null;
  if (computedOneToOneUrl !== oneToOneUrlRef.current) {
    oneToOneUrlRef.current = computedOneToOneUrl;
  }
  const oneToOneVideoUrl = oneToOneUrlRef.current;
  // B-16 — remount the remote tile when the peer's video track arrives
  // (mid-call audio→video upgrade) so a same-stream-id upgrade rebinds
  // the native renderer instead of staying black. Mirrors CallScreen.
  const oneToOneRemoteHasVideo = (active.remoteStream?.getVideoTracks?.().length ?? 0) > 0;
  // O-E (VIDEO_CALL_RENDER_ISSUES_HANDOFF §4) — the minimized card never
  // got the CALL-N2 gate: it mounted the RTCView off streamURL alone, so
  // an audio-only or camera-off peer rendered a BLACK card. Share the
  // audited decision with CallScreen via resolveRemoteTile.
  const overlayGate = resolveRemoteTile({
    remoteVideoOff:  !!active.remoteVideoOff,
    remoteHasVideo:  oneToOneRemoteHasVideo,
    hasRemoteStream: !!active.remoteStream,
    streamURL:       oneToOneVideoUrl,
    videoTrackId:    active.remoteStream?.getVideoTracks?.()[0]?.id ?? null,
  });

  if (isVideo) {
    // Floating draggable card with remote video. Default origin is
    // top-right — pan moves it from there.
    return (
      <Animated.View
        style={[styles.videoCard, {transform: pan.getTranslateTransform()}]}
        {...panHandlers}>
        <TouchableOpacity activeOpacity={0.9} onPress={restore} style={StyleSheet.absoluteFill}>
          {overlayGate.kind === 'video' ? (
            <RTCView
              key={`overlay-remote-${overlayGate.remountKey}`}
              streamURL={overlayGate.streamURL}
              style={StyleSheet.absoluteFill}
              objectFit="cover"
              mirror={false}
              zOrder={2}
            />
          ) : overlayGate.kind === 'camera-off' ? (
            <View style={[StyleSheet.absoluteFill, styles.videoCardPlaceholder]}>
              <Icon name="video-off" size={20} color="#94A3B8" />
            </View>
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.videoCardPlaceholder]}>
              <Icon name="phone" size={20} color="#94A3B8" />
            </View>
          )}
          <View style={styles.videoCardFooter}>
            <Text numberOfLines={1} style={styles.videoCardName}>{peerName}</Text>
            <Text style={styles.videoCardTimer}>{formatDuration(duration)}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={hangup} style={styles.videoCardHangup} hitSlop={{top:8, left:8, right:8, bottom:8}}>
          <Icon name="phone-hangup" size={14} color="#fff" />
        </TouchableOpacity>
      </Animated.View>
    );
  }

  // Audio: a top bar across the screen.
  return (
    <View style={styles.audioBar} pointerEvents="box-none">
      <TouchableOpacity activeOpacity={0.85} onPress={restore} style={styles.audioBarTap}>
        <View style={styles.audioBarDot} />
        <Text numberOfLines={1} style={styles.audioBarTitle}>
          {active.state === 'connected' ? 'On call' : active.state === 'calling' ? 'Calling…' : active.state === 'ringing' ? 'Ringing…' : 'Connecting…'} · {peerName}
        </Text>
        {active.state === 'connected' && (
          <Text style={styles.audioBarTimer}>{formatDuration(duration)}</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity onPress={hangup} style={styles.audioBarHangup} hitSlop={{top:8, left:8, right:8, bottom:8}}>
        <Icon name="phone-hangup" size={16} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

/**
 * Fix #23: shared draggable-pan hook. Both the 1:1 audio/video card
 * and the group video card are draggable, and they used to each
 * declare their own `pan` Animated.ValueXY + `responder` PanResponder
 * — fine in isolation, but if both early-return paths somehow
 * mounted simultaneously (e.g. between a registry write and the
 * render that consumes it) two responders would compete for the same
 * gesture. Single source means whichever overlay is visible owns the
 * drag exclusively.
 *
 * We also use a value-listener pattern (Fix #8 from CallScreen) to
 * read the live offset on grant rather than poking `_value`.
 */
function useDraggablePan(): {pan: Animated.ValueXY; panHandlers: ReturnType<typeof PanResponder.create>['panHandlers']} {
  const pan = useRef(new Animated.ValueXY({x: 0, y: 0})).current;
  const valueRef = useRef({x: 0, y: 0});
  useEffect(() => {
    const idX = pan.x.addListener(({value}) => { valueRef.current.x = value; });
    const idY = pan.y.addListener(({value}) => { valueRef.current.y = value; });
    return () => {
      pan.x.removeListener(idX);
      pan.y.removeListener(idY);
    };
  }, [pan]);
  const responder = useMemo(
    () => PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  (_e, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
      onPanResponderMove: Animated.event([null, {dx: pan.x, dy: pan.y}], {useNativeDriver: false}),
      onPanResponderRelease: () => pan.flattenOffset(),
      onPanResponderGrant: () => {
        const {x, y} = valueRef.current;
        pan.setOffset({x, y});
        pan.setValue({x: 0, y: 0});
      },
    }),
    [pan],
  );
  return {pan, panHandlers: responder.panHandlers};
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Floating overlay for an active group SFU call. Audio-only group call
 * is a top bar (mirrors 1:1); video group call shows a draggable PiP
 * card with the first remote video tile — GroupCallScreen sorts tiles
 * by audioLevel so [0] is the loudest speaker, which is the same
 * "show whoever is talking" model WhatsApp uses for its mini-window.
 * Falls back to the audio bar when no remote video is available yet.
 */
function GroupOverlay({state, duration}: {state: ActiveGroupCallState; duration: number}): React.ReactElement {
  const restore = (): void => {
    // Fix #24: see 1:1 restore for full reasoning. If the group call
    // was ended (host left, kicked, etc.) between this overlay's
    // render and the user's tap, bail out before navigating.
    setGroupCallMinimized(false);
    if (!getActiveGroupCall()) {return;}
    try {
      const ref = navigationRef as unknown as {isReady: () => boolean; navigate: (name: string, params?: unknown) => void};
      if (ref?.isReady?.()) {
        ref.navigate('GroupCallScreen', {
          conversationId:   state.conversationId,
          callType:         state.callType,
          direction:        'incoming', // resume path — never re-rings
          roomId:           state.roomId,
          recipientUserIds: [],         // resume doesn't re-broadcast
          callerName:       state.conversationName,
        });
      }
    } catch { /* swallow */ }
  };
  const hangup = (): void => { void endActiveGroupCall(); };

  // Active-speaker tracking — pick the participant with the highest
  // audioLevel. Hero-hold debounce prevents rapid back-and-forth
  // flicker when two people interrupt each other; mirrors the hold
  // logic GroupCallScreen uses for its hero tile.
  // Fix #21: bumped HERO_HOLD_MS from 1.2s to 3s to match
  // GroupCallScreen — the previous 1.2s window let the overlay's
  // RTCView remount on rapid alternation between speakers, which
  // tears down the EGL surface and produces a one-frame black flash.
  // 3s of stickiness means the overlay PiP and the full-screen hero
  // tile track the SAME speaker through the same hold window.
  const HERO_HOLD_MS = 3000;
  const heroHoldRef = useRef<{tag: string; until: number} | null>(null);
  const activeTag = useMemo<string | null>(() => {
    const levels = state.audioLevels ?? {};
    // Build a candidate list ordered by audio level. Exclude self —
    // the overlay should show whoever's speaking on the other side,
    // not bounce to "you" when you talk.
    const candidates = Object.entries(levels)
      .filter(([tag]) => tag !== state.selfTag)
      .sort((a, b) => b[1] - a[1]);
    const naturalHero = candidates[0]?.[0]
      ?? state.remoteTiles.find(t => t.participantTag !== state.selfTag)?.participantTag
      ?? null;
    const now = Date.now();
    const pinned = heroHoldRef.current;
    if (pinned && pinned.until > now && pinned.tag !== naturalHero) {
      return pinned.tag;
    }
    if (naturalHero) {
      heroHoldRef.current = {tag: naturalHero, until: now + HERO_HOLD_MS};
    }
    return naturalHero;
  }, [state.audioLevels, state.remoteTiles, state.selfTag]);

  const activeName = useMemo<string>(() => {
    if (!activeTag) {return state.conversationName ?? 'Group call';}
    return state.identityByTag?.[activeTag]?.displayName
      ?? activeTag.slice(0, 6).toUpperCase();
  }, [activeTag, state.identityByTag, state.conversationName]);

  // Active speaker's video tile (only used in video-call PiP). Falls
  // back to ANY remote video tile if the active speaker doesn't have
  // a video producer (camera off) — better to show *some* live face
  // than a black card.
  const activeVideoTile = useMemo(() => {
    if (state.callType !== 'video') {return null;}
    // Skip paused video tiles — RTCView would otherwise show the last
    // decoded frame (frozen) instead of falling back to the audio bar.
    const isLiveVideo = (t: typeof state.remoteTiles[number]): boolean =>
      t.kind === 'video' && !t.paused;
    if (activeTag) {
      const t = state.remoteTiles.find(rt => rt.participantTag === activeTag && isLiveVideo(rt));
      if (t) {return t;}
    }
    return state.remoteTiles.find(isLiveVideo) ?? null;
  // The hook is keyed on the specific state slices it reads (callType,
  // remoteTiles, activeTag). Adding the full `state` would over-invalidate
  // — every connection-state flip would force a recompute and trigger a
  // re-render storm during call setup. Round 10 audit verified this.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.callType, state.remoteTiles, activeTag]);

  // Fix #23: shared draggable pan — see useDraggablePan above.
  const {pan, panHandlers} = useDraggablePan();

  // Fix #21: track previous activeVideoUrl in a ref + only re-update
  // the rendered URL when it actually changes. safeStreamURL can
  // return semantically-identical URLs across audioLevels ticks (the
  // underlying MediaStream is the same; .toURL() is stable for a
  // given native track) — but it occasionally returns a fresh string
  // when the JNI call goes through a new bridge frame. Holding the
  // last-known string means the RTCView's streamURL prop only flips
  // identity when the active speaker actually changes, not on every
  // 250ms audioLevels tick.
  const computedUrl = activeVideoTile ? safeStreamURL(activeVideoTile.stream) : null;
  const lastUrlRef = useRef<string | null>(null);
  // Only re-stamp when the URL actually changed (including → null). The
  // second half of the old condition was a no-op tautology.
  if (computedUrl !== lastUrlRef.current) {
    lastUrlRef.current = computedUrl;
  }
  const activeVideoUrl = lastUrlRef.current;
  if (state.callType === 'video' && activeVideoUrl) {
    return (
      <Animated.View
        style={[styles.videoCard, {transform: pan.getTranslateTransform()}]}
        {...panHandlers}>
        <TouchableOpacity activeOpacity={0.9} onPress={restore} style={StyleSheet.absoluteFill}>
          {/* Fix #21: key by activeTag so React preserves RTCView
              identity when the same participant continues to be the
              active speaker across renders. When the speaker changes
              we WANT a fresh RTCView (new track means new EGL
              surface), so the key flip is correct. */}
          <RTCView
            key={activeTag ?? 'no-speaker'}
            streamURL={activeVideoUrl}
            style={StyleSheet.absoluteFill}
            objectFit="cover"
            mirror={false}
            zOrder={2}
          />
          <View style={styles.videoCardFooter}>
            <Text numberOfLines={1} style={styles.videoCardName}>{activeName}</Text>
            <Text style={styles.videoCardTimer}>{formatDuration(duration)}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={hangup} style={styles.videoCardHangup} hitSlop={{top:8, left:8, right:8, bottom:8}}>
          <Icon name="phone-hangup" size={14} color="#fff" />
        </TouchableOpacity>
      </Animated.View>
    );
  }

  // Audio path (or video before any tile is available) — slim bar
  // shows JUST the active speaker's name. Joining-phase fallback
  // shows the conversation name so the user knows what call this is.
  const titleText = state.state === 'joined'
    ? activeName
    : `${state.conversationName ?? 'Group call'} · joining…`;
  return (
    <View style={styles.audioBar} pointerEvents="box-none">
      <TouchableOpacity activeOpacity={0.85} onPress={restore} style={styles.audioBarTap}>
        <View style={styles.audioBarDot} />
        <Text numberOfLines={1} style={styles.audioBarTitle}>{titleText}</Text>
        {state.state === 'joined' && (
          <Text style={styles.audioBarTimer}>{formatDuration(duration)}</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity onPress={hangup} style={styles.audioBarHangup} hitSlop={{top:8, left:8, right:8, bottom:8}}>
        <Icon name="phone-hangup" size={16} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  // Audio bar — pinned to the top, full width, semi-translucent. The
  // outer wrapper uses `pointerEvents="box-none"` so it only catches
  // touches on its actual children (the tap area + hangup button) and
  // lets the rest of the screen receive touches.
  audioBar: {
    position:'absolute', top:0, left:0, right:0,
    flexDirection:'row', alignItems:'center',
    paddingTop:44, paddingBottom:10, paddingHorizontal:16,
    backgroundColor:'rgba(16,185,129,0.96)',
    elevation:14, shadowColor:'#000', shadowOpacity:0.25, shadowRadius:6, shadowOffset:{width:0, height:2},
    zIndex:1000,
  },
  audioBarTap: {flex:1, flexDirection:'row', alignItems:'center', gap:10},
  audioBarDot: {width:8, height:8, borderRadius:4, backgroundColor:'#FFFFFF'},
  audioBarTitle: {flex:1, color:'#FFFFFF', fontSize:13, fontWeight:'700'},
  audioBarTimer: {color:'rgba(255,255,255,0.9)', fontSize:12, fontVariant:['tabular-nums']},
  audioBarHangup: {
    width:32, height:32, borderRadius:16, alignItems:'center', justifyContent:'center',
    backgroundColor:'rgba(0,0,0,0.25)', marginLeft:12,
  },

  // Video card — floating, draggable, top-right anchored.
  videoCard: {
    position:'absolute', top:60, right:14,
    width:120, height:170, borderRadius:16, overflow:'hidden',
    backgroundColor:'#0F172A',
    borderWidth:1.5, borderColor:'rgba(255,255,255,0.18)',
    elevation:18, shadowColor:'#000', shadowOpacity:0.45, shadowRadius:14, shadowOffset:{width:0, height:6},
    zIndex:1000,
  },
  videoCardPlaceholder: {alignItems:'center', justifyContent:'center', backgroundColor:'#1E293B'},
  videoCardFooter: {
    position:'absolute', bottom:0, left:0, right:0,
    paddingHorizontal:10, paddingVertical:8,
    backgroundColor:'rgba(0,0,0,0.55)',
    flexDirection:'row', justifyContent:'space-between', alignItems:'center', gap:8,
  },
  videoCardName:  {color:'#F1F5F9', fontSize:11, fontWeight:'700', flex:1},
  videoCardTimer: {color:'rgba(255,255,255,0.9)', fontSize:10, fontVariant:['tabular-nums']},
  videoCardHangup: {
    position:'absolute', top:6, right:6,
    width:28, height:28, borderRadius:14, alignItems:'center', justifyContent:'center',
    backgroundColor:'#EF4444',
    elevation:6,
  },
});
