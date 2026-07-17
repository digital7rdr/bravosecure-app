/**
 * Active GROUP-call registry — singleton that owns a mediasoup SFU
 * call's lifecycle so the call survives `GroupCallScreen` unmount.
 *
 * Mirrors `callRegistry.ts` for 1:1 calls. Lifting the room handle +
 * local stream + transport refs out of the React hook lets the user
 * minimize the group call (FloatingCallOverlay), navigate elsewhere,
 * and come back without the room being torn down.
 *
 * The registry holds REFS only — it doesn't manage cleanup. `endActive`
 * is the only path that disposes the underlying mediasoup objects;
 * everything else is read/patch.
 */
import type {MediaStream, MediaStreamTrack} from 'react-native-webrtc';
import type {RemoteTile, GroupCallState, AudioLevelMap} from '../webrtc/useGroupCall';

export interface ActiveGroupCallState {
  roomId:           string;
  conversationId:   string;
  conversationName: string;
  callType:         'voice' | 'video';
  /** True when this user is the room host — drives moderation UI. */
  isHost:           boolean;
  /** Server-issued opaque tag for this client's participant slot. */
  selfTag:          string | null;
  state:            GroupCallState;
  localStream:      MediaStream | null;
  remoteTiles:      RemoteTile[];
  /** participantTag → identity, populated as identity envelopes arrive. */
  identityByTag:    Record<string, {displayName: string; userId?: string}>;
  /**
   * Live audio level per participantTag (0..1). Mirrored from the
   * useGroupCall hook's state on every meaningful change so the
   * minimized FloatingCallOverlay can compute "who's talking now"
   * without taking another ref to the hook.
   */
  audioLevels:      AudioLevelMap;
  audioTrack:       MediaStreamTrack | null;
  videoTrack:       MediaStreamTrack | null;
  isMuted:          boolean;
  isVideoOff:       boolean;
  isMinimized:      boolean;
  /**
   * When true, the screen unmount path should NOT run leave() — the user
   * is just navigating away while the call continues. The floating
   * overlay's end button or the leave-on-last-out path clears it.
   */
  keepAlive:        boolean;
  /** Bound by the hook so the overlay's hangup button can tear down. */
  leave:            (() => Promise<void>) | null;
  /** Bound by the hook so the overlay can toggle audio. */
  toggleMute:       (() => void) | null;
  /**
   * Bound by the hook so the overlay can toggle video. Kept in sync
   * via the same registry-mirror effect as `leave` and `toggleMute`
   * so the overlay always invokes the freshest closure (each useCallback
   * remint captures the current localStream — without sync, a stale
   * binding would acquire a fresh camera but never splice it into the
   * live MediaStream the overlay is rendering).
   */
  toggleVideo:      (() => Promise<void>) | null;
  /** Wall-clock when state first became 'joined' — drives the duration timer. */
  joinedAtMs:       number | null;
  /**
   * userId → expiresAtMs map for the host's outbound invite countdowns.
   * Lives on the registry so the timing survives GroupCallScreen
   * minimize → restore (the screen unmounts and re-mounts; without this
   * the countdown would reset to 0 every restore). Optional so existing
   * callers don't break — undefined means "no invites in flight".
   */
  inviteRingExpiry?: Record<string, number>;
}

let active: ActiveGroupCallState | null = null;
let listeners: Array<(s: ActiveGroupCallState | null) => void> = [];

function notify(): void {
  // Fix #15: snapshot before iterating — a listener can splice the
  // array via its disposer during the callback, and iterating the
  // live array would then skip later entries.
  const snapshot = [...listeners];
  for (const l of snapshot) {
    try { l(active); } catch { /* one bad listener mustn't block the rest */ }
  }
}

export function getActiveGroupCall(): ActiveGroupCallState | null {
  return active;
}

/**
 * B-33 (Defect A) — duration-timer source of truth. The GroupCallScreen timer
 * must derive from the registry's persistent `joinedAtMs` (which survives a
 * minimize→restore / unmount→remount), NOT a local useState counter that
 * resets to 0 on every remount. Mirrors FloatingCallOverlay's anchor. A
 * null/absent anchor (not yet joined) reads 0; a future timestamp clamps to 0.
 */
export function groupCallElapsedSeconds(
  joinedAtMs: number | null | undefined,
  nowMs: number,
): number {
  if (!joinedAtMs) {return 0;}
  return Math.max(0, Math.round((nowMs - joinedAtMs) / 1000));
}

/**
 * B-33 (Defect B) — non-destructive roster seed for a same-room SFU rejoin.
 * When the hook falls through to the fresh-boot path for a room that is STILL
 * in the registry (e.g. a local track ended so the adopt gate failed), seed
 * the new registry snapshot from the prior entry so the user doesn't see an
 * empty grid while live consume re-attaches. A genuinely different room (or no
 * prior call) starts empty. The subsequent consume / identity-envelope flow
 * overwrites with live data either way — this only changes the INITIAL seed.
 */
export function seedRosterForRepublish(
  prior: ActiveGroupCallState | null,
  roomId: string,
  selfTag: string,
  ownDisplayName: string,
): Pick<ActiveGroupCallState, 'remoteTiles' | 'identityByTag'> {
  const sameRoom = !!prior && prior.roomId === roomId;
  return {
    remoteTiles: sameRoom ? prior!.remoteTiles : [],
    identityByTag: sameRoom
      ? {...prior!.identityByTag, [selfTag]: {displayName: ownDisplayName}}
      : {[selfTag]: {displayName: ownDisplayName}},
  };
}

/**
 * B-08 — decide whether an incoming `sfu.ring.incoming` frame should
 * trigger a navigation to IncomingGroupCallScreen.
 *
 * Why: the server fans the ring to every recipient's userRoom, and a
 * duplicate ring (server re-fan-out, the host's own ring echoing back,
 * or a presence/ring race) used to navigate unconditionally — unmounting
 * an in-progress GroupCallScreen whose unmount cleanup then called
 * leaveInternal(), aborting the very join in progress. Suppress the
 * navigation when the user is already in/joining THIS room (active call
 * registry) or already sitting on the ring/call screen for it. A
 * genuinely distinct room (different roomId) must still ring.
 */
export function shouldNavigateForRing(
  ringRoomId:          string,
  activeRoomId:        string | null,
  currentRouteName:    string | undefined,
  currentRouteRoomId:  string | undefined,
): boolean {
  if (activeRoomId && activeRoomId === ringRoomId) {return false;}
  if (
    (currentRouteName === 'GroupCallScreen' ||
      currentRouteName === 'IncomingGroupCallScreen') &&
    currentRouteRoomId === ringRoomId
  ) {
    return false;
  }
  return true;
}

export function setActiveGroupCall(next: ActiveGroupCallState | null): void {
  active = next;
  notify();
}

export function patchActiveGroupCall(patch: Partial<ActiveGroupCallState>): void {
  if (!active) {return;}
  active = {...active, ...patch};
  notify();
}

export function setGroupCallMinimized(min: boolean): void {
  if (!active) {return;}
  active = {...active, isMinimized: min, keepAlive: min};
  notify();
}

export function onActiveGroupCallChange(cb: (s: ActiveGroupCallState | null) => void): () => void {
  listeners.push(cb);
  try { cb(active); } catch { /* ignore */ }
  return () => { listeners = listeners.filter(l => l !== cb); };
}

/**
 * Hard-end the group call — invokes the bound leave() (which sends
 * sfu.leave and tears the mediasoup objects down) then clears the slot.
 * Safe to call multiple times.
 */
/** RoomId-keyed audio-session-started flag — see callRegistry.ts. */
const audioSessionStartedFor = new Set<string>();

export function markGroupAudioSessionStarted(roomId: string): boolean {
  if (audioSessionStartedFor.has(roomId)) {return false;}
  audioSessionStartedFor.add(roomId);
  return true;
}

export function clearGroupAudioSessionStarted(roomId: string): void {
  audioSessionStartedFor.delete(roomId);
}

export async function endActiveGroupCall(): Promise<void> {
  if (!active) {return;}
  const leave = active.leave;
  audioSessionStartedFor.delete(active.roomId);
  active = null;
  notify();
  if (leave) {
    try { await leave(); } catch { /* swallow */ }
  }
  // Drop the foreground service. Same reasoning as endActiveCall in
  // callRegistry.ts — the floating overlay's End button is the path
  // that hits us while CallScreen's unmount cleanup is skipping
  // because keepAlive is true.

  try {

    const {stopCallForegroundService} = require('./callForegroundService') as typeof import('./callForegroundService');
    stopCallForegroundService();
  } catch { /* native module missing on iOS — fine */ }
}
