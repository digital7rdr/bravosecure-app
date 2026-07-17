/**
 * Multi-subscriber dispatcher for INCOMING group-call ring frames.
 *
 * Two callers want notifications:
 *   1. The navigation root — on `sfu.ring.incoming`, navigates to the
 *      ring screen so the user can accept/decline.
 *   2. The IncomingGroupCallScreen — on `sfu.ring.cancelled` /
 *      `sfu.ring.declined` for its own roomId, dismisses itself.
 *
 * A single-handler dispatcher couldn't serve both, so this is a tiny
 * pub-sub. Handlers receive ALL ring frames; they're expected to
 * filter by event + roomId themselves.
 */

export interface GroupCallRingPayload {
  roomId:         string;
  conversationId: string;
  callType:       'voice' | 'video';
  from:           {userId: string; deviceId: number};
  callerName:     string;
  // Audit P0-C2 / row #5 — per-recipient HMAC room-access token.
  // Recipient echoes back in sfu.join.roomToken AND sfu.ring.decline.
  // Empty / undefined on dev servers without SFU_ROOM_TOKEN_SECRET.
  roomToken?:     string;
  roomTokenExp?:  number;
}

export interface GroupCallRingHandler {
  onIncoming: (ring: GroupCallRingPayload) => void;
  onCancel:   (data: {roomId: string; conversationId: string}) => void;
  onDecline:  (data: {roomId: string; conversationId: string; from: {userId: string; deviceId: number}}) => void;
}

let handlers: GroupCallRingHandler[] = [];

/**
 * Register a handler. Returns an unregister function. Multiple
 * handlers may be registered simultaneously — every registered handler
 * receives every dispatched frame.
 */
export function setGroupCallRingHandler(h: GroupCallRingHandler | null): () => void {
  // A null registration is a no-op; return a shared no-op disposer so
  // the contract is explicit ("nothing was registered, nothing to undo")
  // rather than handing back a closure that captures null and silently
  // unregisters nothing.
  if (!h) {return () => {};}
  handlers = handlers.concat(h);
  return () => {
    handlers = handlers.filter(x => x !== h);
  };
}

/**
 * Round 2 fix: drop every registered handler. Wired into authStore.signOut
 * so a logout doesn't keep a closure into MainNavigator's incoming-ring
 * handler alive — without this, an `sfu.ring.incoming` frame that
 * arrives during the logout transition would surface a ringing UI on
 * the next user's login screen.
 */
export function clearAllGroupCallRingHandlers(): void {
  handlers = [];
  // Finding #8(b) — drop the per-roomId ring-dedup markers too so the next
  // user's identical-roomId ring (astronomically unlikely, but) isn't
  // silently suppressed by the prior session's state.
  seenIncomingRoomIds.clear();
}

/** Server-frame events this dispatcher handles. */
export const GROUP_RING_FRAME_EVENTS = new Set([
  'sfu.ring.incoming',
  'sfu.ring.cancelled',
  'sfu.ring.declined',
]);

// Finding #8(b) — `sfu.ring.incoming` can now REPLAY on reconnect (the
// server re-fans a still-pending ring after a WS reopen). Dedup by roomId
// so a replayed ring doesn't re-fire onIncoming (which would resurrect a
// ring surface the user already dismissed / declined). roomIds are unique
// per call, so once-per-roomId within a TTL is safe; a genuinely new call
// mints a new roomId and rings normally. Cleared on cancel/decline so an
// (unlikely) roomId reuse can still ring.
const seenIncomingRoomIds = new Map<string, number>();
const RING_DEDUP_TTL_MS = 60_000;

function ringAlreadySeen(roomId: string): boolean {
  const now = Date.now();
  // GC expired markers so the map can't grow unbounded across a session.
  for (const [rid, at] of seenIncomingRoomIds) {
    if (now - at > RING_DEDUP_TTL_MS) {seenIncomingRoomIds.delete(rid);}
  }
  const prev = seenIncomingRoomIds.get(roomId);
  if (prev !== undefined && now - prev <= RING_DEDUP_TTL_MS) {return true;}
  seenIncomingRoomIds.set(roomId, now);
  return false;
}

export function dispatchGroupRingFrame(frame: {event: string; data?: unknown}): boolean {
  // Idempotency gate runs even with zero handlers so the marker is set
  // before any handler could re-register mid-replay.
  if (frame.event === 'sfu.ring.incoming') {
    const rid = (frame.data as {roomId?: string} | undefined)?.roomId;
    if (rid && ringAlreadySeen(rid)) {return true;}
  } else if (frame.event === 'sfu.ring.cancelled' || frame.event === 'sfu.ring.declined') {
    const rid = (frame.data as {roomId?: string} | undefined)?.roomId;
    if (rid) {seenIncomingRoomIds.delete(rid);}
  }
  if (handlers.length === 0) {return false;}
  for (const h of handlers) {
    try {
      switch (frame.event) {
        case 'sfu.ring.incoming':
          h.onIncoming(frame.data as GroupCallRingPayload);
          break;
        case 'sfu.ring.cancelled':
          h.onCancel(frame.data as {roomId: string; conversationId: string});
          break;
        case 'sfu.ring.declined':
          h.onDecline(frame.data as {
            roomId: string; conversationId: string;
            from: {userId: string; deviceId: number};
          });
          break;
      }
    } catch { /* one bad handler must not block the others */ }
  }
  return true;
}
