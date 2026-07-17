/**
 * Active-call registry — singleton that owns a 1:1 call's lifecycle so
 * the call survives CallScreen unmount. The previous design created the
 * RTCPeerConnection + media stream inside the useCall hook, so any
 * navigation away from CallScreen tore the call down. To support
 * Messenger-style minimization we lift those refs here, and have
 * CallScreen + useCall consult the registry on mount: if an active
 * call already exists they REUSE its state instead of starting fresh.
 *
 * The registry keeps no React state — it's a tiny pub/sub. Any view
 * that wants to render minimized-call UI subscribes via
 * `onActiveCallChange` (mirrors the transport-registry pattern used
 * elsewhere in this module).
 */
import type {CallController} from '../webrtc/callController';
import type {CallSignalling} from '../webrtc/signallingClient';
import type {CallKind, CallState} from '../webrtc/types';
import type {SessionAddress} from '@bravo/messenger-core';
import type {MediaStream, MediaStreamTrack} from '../webrtc/peerConnectionFactory';

export interface ActiveCallState {
  callId:           string;
  conversationId:   string;
  peer:             SessionAddress;
  peerName:         string;
  kind:             CallKind;
  direction:        'incoming' | 'outgoing';
  /** Set after the user accepts/dials and the controller is built. */
  controller:       CallController | null;
  signalling:       CallSignalling | null;
  unregister:       (() => void) | null;
  localStream:      MediaStream | null;
  remoteStream:     MediaStream | null;
  audioTrack:       MediaStreamTrack | null;
  videoTrack:       MediaStreamTrack | null;
  state:            CallState;
  isMinimized:      boolean;
  /**
   * Audit CALL-N11 (2026-07-02): local + remote media toggle state, persisted
   * so a minimize→restore rehydrates them instead of resetting to defaults.
   * Without these: a locally-muted mic rendered as unmuted after restore
   * (peer hears nothing, user sees nothing wrong); the peer's camera-off
   * placeholder was replaced by a frozen RTCView; and restoring with the
   * local camera off drove toggleVideo down the full SDP-upgrade path, adding
   * a DUPLICATE video m-line. `facing` keeps PiP mirroring / next-flip
   * direction correct after restoring a rear-camera call.
   */
  isMuted?:         boolean;
  isVideoOff?:      boolean;
  remoteVideoOff?:  boolean;
  remoteMuted?:     boolean;
  facing?:          'user' | 'environment';
  /**
   * When true, CallScreen unmount should NOT tear down the controller
   * or local media — the user is just navigating away while the call
   * continues. Cleared by the floating overlay's hangup or by a
   * controller state transition to 'ended' / 'failed'.
   */
  keepAlive:        boolean;
  /**
   * Wall-clock when the controller transitioned to 'connected'. Used
   * by CallScreen's duration timer so minimizing the call (which
   * unmounts CallScreen) doesn't reset the elapsed counter to 0 on
   * restore — it just re-derives elapsed = Date.now() - connectedAtMs.
   */
  connectedAtMs:    number | null;
}

let active: ActiveCallState | null = null;
let listeners: Array<(state: ActiveCallState | null) => void> = [];

function notify(): void {
  // Fix #15: snapshot before iterating. A listener can mutate the
  // `listeners` array via its returned-disposer (e.g. an overlay
  // unsubscribing itself on call.end). Iterating the live array
  // would skip subsequent entries when an earlier listener splices.
  const snapshot = [...listeners];
  for (const l of snapshot) {
    try { l(active); } catch { /* one listener's failure must not block the others */ }
  }
}

export function getActiveCall(): ActiveCallState | null {
  return active;
}

/**
 * Audit CALL-N15 (2026-07-02): callIds whose slot was cleared recently. The
 * overlay's restore navigates with the OLD callId; if the call ends between
 * the overlay's getActiveCall() check and useCall's boot effect, the boot
 * finds no call to adopt and would fall through to a FRESH startOutgoing —
 * silently re-dialing the peer. A fresh dial always mints a NEW callId, so
 * "this callId ended moments ago" is a reliable ghost-redial marker.
 */
const recentlyEnded = new Map<string, number>();
const RECENTLY_ENDED_WINDOW_MS = 2 * 60 * 1000;

export function wasRecentlyEnded(callId: string): boolean {
  const at = recentlyEnded.get(callId);
  if (at === undefined) {return false;}
  if (Date.now() - at > RECENTLY_ENDED_WINDOW_MS) { recentlyEnded.delete(callId); return false; }
  return true;
}

/**
 * Replace the active-call slot. Pass `null` to clear (call ended). The
 * caller is responsible for tearing down any controller / streams BEFORE
 * clearing if they want clean shutdown — the registry only holds refs.
 */
export function setActiveCall(next: ActiveCallState | null): void {
  // CALL-N15 — record the outgoing slot's callId on clear/replace so a
  // stale restore navigation can't ghost-redial it. Prune opportunistically.
  if (active && active.callId !== next?.callId) {
    const now = Date.now();
    for (const [id, at] of recentlyEnded) { if (now - at > RECENTLY_ENDED_WINDOW_MS) {recentlyEnded.delete(id);} }
    recentlyEnded.set(active.callId, now);
  }
  active = next;
  notify();
}

export function patchActiveCall(patch: Partial<ActiveCallState>): void {
  if (!active) {return;}
  active = {...active, ...patch};
  notify();
}

export function setMinimized(min: boolean): void {
  if (!active) {return;}
  active = {...active, isMinimized: min, keepAlive: min};
  notify();
}

export function onActiveCallChange(cb: (state: ActiveCallState | null) => void): () => void {
  listeners.push(cb);
  // Fire once so subscribers get current state on register — same
  // contract as transportRegistry.
  try { cb(active); } catch { /* ignore */ }
  return () => { listeners = listeners.filter(l => l !== cb); };
}

/**
 * Hard-end the call: hang up via controller, stop local tracks, clear
 * the slot. Safe to call multiple times. Used by the floating overlay's
 * end button and by the controller's 'ended' / 'failed' state.
 */
/**
 * Call-id-keyed flag for "this call's audio session has been started
 * via InCallManager.start()". Survives across CallScreen remounts (the
 * permission-prompt remount in particular: when the OS pops a mic/cam
 * permission dialog, RN reports a quick activity-pause-resume cycle
 * which re-mounts the screen). A useRef-based guard inside the screen
 * resets to `false` on each fresh mount, so the second mount calls
 * InCallManager.start() AGAIN — but it had already been stopped by
 * the first mount's cleanup, so the session ends up dead. This module-
 * scoped record outlives the screen's lifecycle and lets us answer
 * "have we already started for THIS callId?" correctly.
 */
const audioSessionStartedFor = new Set<string>();

export function markAudioSessionStarted(callId: string): boolean {
  if (audioSessionStartedFor.has(callId)) {return false;}
  audioSessionStartedFor.add(callId);
  return true;
}

export function clearAudioSessionStarted(callId: string): void {
  audioSessionStartedFor.delete(callId);
}

/**
 * Source of the end. 'local' means the user pressed End (this device
 * or via floating-overlay button), 'remote' means peer/server ended,
 * 'failed' means ICE/DTLS gave up. Used to map to CallKit/Telecom's
 * end-reason taxonomy so iOS Recents shows the right glyph (locally
 * declined vs. remote ended). Defaults to 'remote' for backwards
 * compatibility with call sites that pre-date this parameter.
 */
export function endActiveCall(
  reason: 'ended' | 'failed' = 'ended',
  source: 'local' | 'remote' = 'remote',
): void {
  if (!active) {return;}
  const endedCallId = active.callId;
  // Round 7 / WebRTC audit fix W7 — stop the local mic and camera
  // BEFORE calling controller.hangup. Previously the order was reversed,
  // so when a user pressed End there was a 50-200ms window where
  // hangup() was sending the call.hangup frame + tearing down the peer
  // connection while the mic and camera were still actively capturing.
  // On Android the camera LED was visibly on past the End tap. Stopping
  // tracks first releases the device immediately, well before the WS
  // round-trip for hangup completes.
  try { active.audioTrack?.stop(); } catch { /* ignore */ }
  try { active.videoTrack?.stop(); } catch { /* ignore */ }
  try { active.controller?.hangup(reason); } catch { /* ignore */ }
  try { active.unregister?.(); } catch { /* ignore */ }
  // Audit CALL-N5 (2026-07-02): stop the InCallManager audio session here.
  // CallScreen's audio-effect cleanup is the ONLY other place that stops it,
  // and that cleanup can't run while the screen is unmounted (call minimized).
  // So ending a minimized call from the floating overlay — or the peer
  // hanging up while minimized — used to leave the device pinned in
  // MODE_IN_COMMUNICATION (voice routing + proximity behaviour) indefinitely.
  // Idempotent; safe even when CallScreen already stopped it.
  try {
    const InCallManager = require('react-native-incall-manager').default as {stop: () => void};
    InCallManager.stop();
  } catch { /* native module missing (iOS/tests) — fine */ }
  audioSessionStartedFor.delete(endedCallId);
  active = null;
  notify();
  // Drop CallKit/Telecom system UI + the cached incoming-call payload
  // so the system call sheet doesn't linger after a floating-overlay
  // End tap (the path that runs while keepAlive=true and CallScreen's
  // own onState=ended cleanup has already been skipped).
  try {

    const {reportEnded} = require('../push/callKitBridge') as typeof import('../push/callKitBridge');

    const cache = require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
    // Map (reason × source) → CallKit endedReason. iOS Recents glyph
    // and Android call-log row depend on this being right:
    //   - reason='failed'                → 'failed'
    //   - source='local'                 → 'declined' (local hangup)
    //   - source='remote'                → 'remoteEnded'
    const endedReason: 'failed' | 'declined' | 'remoteEnded' =
      reason === 'failed' ? 'failed'
        : source === 'local' ? 'declined'
        : 'remoteEnded';
    reportEnded(endedCallId, endedReason);
    cache.clearIncomingCallPayload(endedCallId);
    // notifee is a separate surface from CallKit/Telecom — reportEnded
    // does NOT clear it. An FCM-woken call ended via the overlay would
    // otherwise leave the looping full-screen notifee ring up until TTL.
    try {
      const cn = require('../push/callNotification') as typeof import('../push/callNotification');
      void cn.dismissCallNotif(endedCallId);
    } catch { /* notifee unavailable (tests / iOS) */ }
  } catch { /* bridge inactive */ }
  // Stop the foreground service whenever the call's hard-ended (via
  // the floating overlay's end button, controller failure, or an
  // explicit hangup). CallScreen's unmount cleanup also calls stop()
  // but it skips when keepAlive is true — and the overlay's End is
  // exactly the path that runs while keepAlive is true. Without this
  // call, the FG notification would linger after the user ends a
  // minimized call.

  try {

    const {stopCallForegroundService} = require('./callForegroundService') as typeof import('./callForegroundService');
    stopCallForegroundService();
  } catch { /* native module missing on iOS — fine */ }
}
