/**
 * In-memory cache of inbound calls that have been reported to the
 * system call UI (CallKit on iOS, Telecom on Android) but not yet
 * answered or hung up.
 *
 * Why this exists:
 *   When the user taps Accept / End from the system UI (lock-screen
 *   call screen, Telecom incoming-call sheet), the bridge fires an
 *   event that only carries the `callUUID`. Bravo's accept / decline
 *   flows need the full payload — caller name, callKind, conversation
 *   id, optional SDP — to navigate to the right screen and send the
 *   right `call.hangup` / `call.answer` frame to the peer.
 *
 *   Notifee-driven Accept/Decline taps already have the payload (it
 *   lives in the notification's `data` block). For Telecom-driven
 *   events we need a separate cache, populated by the same handler
 *   that displays the system UI and consumed by the event handlers.
 *
 * Lifetime:
 *   Entry added when reportIncomingCall fires (FCM bg handler or
 *   in-app `setIncomingCallHandler` in MainNavigator).
 *   Entry removed when:
 *     - User accepts: handler navigates → CallScreen, then clears.
 *     - User declines: handler sends call.hangup → clears.
 *     - Peer hangs up first: callDispatcher routes the inbound
 *       call.hangup → bridge clears via clearByCallId.
 *     - 60s TTL elapses (defensive — guards against orphaned entries
 *       if a path forgets to clear; a real ring is < 30s anyway).
 */

export interface CachedIncomingCall {
  callId:         string;
  callerName:     string;
  /** 'voice' | 'video' | 'group-voice' | 'group-video' */
  kind:           string;
  fromUserId?:    string;
  remoteDeviceId?: number;
  /** For 1:1 with WS-delivered offer; absent on FCM-only paths. */
  incomingSdp?:   string;
  /** For group calls. */
  roomId?:        string;
  /** P1-BR-1 — per-recipient SFU room token echoed to sfu.join on group accept. */
  roomToken?:     string;
  conversationId?: string;
  cachedAtMs:     number;
}

const TTL_MS = 60 * 1000;
/**
 * Once a callId has been consumed (accepted / declined / peer-hung-up)
 * we record it in a tombstone set so a buggy/duplicate-retrying caller
 * resending the SAME callId can't repopulate the slot with stale SDP.
 * Without this a user who declined call X and then a millisecond later
 * received another wake for callId=X (caller's retry) would see the
 * stale incoming-offer payload from the first attempt — and CallScreen
 * would try to apply outdated remote SDP on accept.
 *
 * Tombstones are kept slightly longer than the live TTL so a delayed
 * rewake can't slip through during the window between "consumed" and
 * "expired".
 */
const TOMBSTONE_TTL_MS = 90 * 1000;
const cache = new Map<string, CachedIncomingCall>();
const tombstones = new Map<string, number>();

function gc(now: number): void {
  for (const [id, entry] of cache) {
    if (now - entry.cachedAtMs > TTL_MS) {cache.delete(id);}
  }
  for (const [id, t] of tombstones) {
    if (now - t > TOMBSTONE_TTL_MS) {tombstones.delete(id);}
  }
}

export function setIncomingCallPayload(p: Omit<CachedIncomingCall, 'cachedAtMs'>): boolean {
  const now = Date.now();
  gc(now);
  // Refuse to repopulate a tombstoned slot. Caller should regenerate
  // callId on retry. Returning false lets the FCM bg handler log the
  // collision and skip the re-display path.
  if (tombstones.has(p.callId)) {
    console.warn(`[incomingCallCache] reject set for tombstoned callId=${p.callId.slice(0, 8)}`);
    return false;
  }
  cache.set(p.callId, {...p, cachedAtMs: now});
  return true;
}

export function getIncomingCallPayload(callId: string): CachedIncomingCall | null {
  gc(Date.now());
  return cache.get(callId) ?? null;
}

export function clearIncomingCallPayload(callId: string): void {
  if (cache.delete(callId)) {
    tombstones.set(callId, Date.now());
  } else {
    // Even if the entry was already gone, tombstone it so a late
    // re-set is rejected — covers the "peer hung up before we saw
    // the offer" race.
    tombstones.set(callId, Date.now());
  }
}

/** Test-only — drop everything. */
export function _resetIncomingCallCacheForTests(): void {
  cache.clear();
  tombstones.clear();
}
