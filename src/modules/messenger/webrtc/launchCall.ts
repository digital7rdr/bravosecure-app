/**
 * One-call helper for every call-launch site in the app.
 *
 * Centralises peer-resolution + callId-generation so a screen doesn't
 * need to know about CallController, signalling, or dispatcher
 * internals — it just calls `launchCall(navigation, {conversationId,
 * callType})`.
 *
 * Routing rules:
 *   - 1:1 conversation              → CallScreen (existing WebRTC P2P)
 *   - 3+ member group / ops_channel → GroupCallScreen (mediasoup SFU)
 *
 * For groups we ALSO probe `/sfu/rooms/by-conversation/:cid` first so
 * the 2nd member tapping "call" joins the existing room instead of
 * creating a parallel ghost room. The server's createRoom is idempotent
 * by conversationId — this client probe is just a UX optimisation that
 * lets us pass `direction:'incoming'` (skip the ring) when there's
 * already a live call.
 */
import {useMessengerStore} from '../store/messengerStore';
import {useAuthStore} from '@store/authStore';
// SFU room registry is served by messenger-service (NOT auth-service).
// MSG_BASE_URL points at relay.94-136-184-52.sslip.io in staging.
import {MSG_BASE_URL} from '@utils/constants';
import {getActiveGroupCall, setActiveGroupCall} from '../runtime/groupCallRegistry';
import {getActiveCall, onActiveCallChange} from '../runtime/callRegistry';
import {clearRoomIdentities} from './groupCallIdentityRegistry';

interface LaunchOpts {
  conversationId: string;
  callType:       'voice' | 'video';
  remoteDeviceId?: number;
  // LIVE-MONITOR-CHAT (area 8 #4) — explicit group hint + participants for
  // callers that launch BEFORE the conversation is hydrated in messengerStore
  // (e.g. the mission Ops Room from AgentLiveTracker right after assignCrew).
  // Without these, isGroupConversation() returns false for an unhydrated room
  // → the call wrongly routes to the 1:1 path with remoteUserId undefined and
  // "call failed". Prefer these over the store lookup when provided.
  isGroup?:       boolean;
  participants?:  string[];   // member userIds (self is filtered out)
}

interface NavLike {
  navigate: (screen: string, params?: Record<string, unknown>) => void;
}

// Re-export for callers that want to evaluate the gate up front
// (e.g. to hide the dial button instead of just blocking the action).
export {blockReasonForOutgoingCall} from './callRoleGate';
import {blockReasonForOutgoingCall} from './callRoleGate';

function genCallId(): string {
  // Round 2 / Security audit fix: never fall back to Math.random().
  // The original code used Math.random() if crypto.randomUUID was
  // missing — but the RN polyfill chain doesn't always populate that
  // helper, so the weak fallback fired in production. Predictable
  // callIds let an attacker who can guess them issue spurious
  // call.hangup / call.ice frames against an active call.
  // Use crypto.randomUUID when available; otherwise fall back to
  // crypto.getRandomValues — both libsignal and groupClient already
  // depend on getRandomValues, so it's guaranteed to exist on every
  // boot path that reaches this function.
  const c = (globalThis as {crypto?: {randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array}}).crypto;
  if (c?.randomUUID) {return c.randomUUID();}
  if (!c?.getRandomValues) {
    // Should be unreachable — polyfills.ts boots before any caller —
    // but throwing is safer than silently emitting a guessable id.
    throw new Error('genCallId: no CSPRNG available (crypto.getRandomValues missing)');
  }
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Resolve the peer userId for a 1:1 or first-other-member for a group. */
export function resolvePeerForCall(conversationId: string): string | null {
  const s = useMessengerStore.getState();
  const ownId = useAuthStore.getState().user?.id;
  const convo = s.conversations[conversationId];
  if (!convo) {
    if (conversationId.startsWith('direct:')) {return conversationId.slice('direct:'.length);}
    return null;
  }
  if (convo.peer?.userId) {return convo.peer.userId;}
  const others = (convo.participants ?? []).filter(p => p && p !== 'self' && p !== ownId);
  return others[0] ?? null;
}

/** Other (non-self) members of the conversation. */
function otherMembers(conversationId: string): string[] {
  const s = useMessengerStore.getState();
  const ownId = useAuthStore.getState().user?.id;
  const convo = s.conversations[conversationId];
  return (convo?.participants ?? []).filter(p => p && p !== 'self' && p !== ownId);
}

/**
 * True when the conversation has 2+ other members (3+ total) — mesh
 * WebRTC degrades fast and we route through the SFU instead.
 */
export function isGroupConversation(conversationId: string): boolean {
  const s = useMessengerStore.getState();
  const convo = s.conversations[conversationId];
  if (!convo) {return false;}
  if (convo.type === 'group' || convo.type === 'ops_channel') {return true;}
  return otherMembers(conversationId).length >= 2;
}

/**
 * Best-effort probe for an in-progress room for this conversation.
 * Returns null on any error — the caller will create a fresh room
 * (the server's createRoom is itself idempotent by conversationId,
 * so worst case is a tiny extra round-trip).
 *
 * Audit P0-C2 / row #5 (C1) — also reads `roomToken` (server mints a
 * per-caller HMAC alongside the discovered roomId). Without this the
 * 2nd-member-joins-existing-call path would have a roomId but no
 * token, and `sfu.join` would reject with `room_token_required` the
 * moment ops sets `SFU_ROOM_TOKEN_SECRET`.
 */
async function findLiveRoom(conversationId: string): Promise<{roomId: string; roomToken?: string} | null> {
  try {
    // fetchWithRefresh handles auth attach + 401 auto-refresh. Without
    // it, a stale token here would silently return null (probe error
    // swallowed below), which then sends launchCall down the "create
    // new room" path — which 401s for the same reason. Observed as
    // "call failed" on every re-entry until the next /auth/refresh on
    // an unrelated screen.
    const {fetchWithRefresh} = require('@/services/api') as typeof import('@/services/api');
    const res = await fetchWithRefresh(
      `${MSG_BASE_URL}/sfu/rooms/by-conversation/${encodeURIComponent(conversationId)}`,
      {headers: {'X-Signal-Device-Id': '1'}},
    );
    if (!res.ok) {return null;}
    const body = await res.json() as {roomId: string | null; roomToken?: string};
    if (!body.roomId) {return null;}
    return {roomId: body.roomId, roomToken: body.roomToken};
  } catch {
    return null;
  }
}

// ── CALL-17 — 1:1 double-tap / concurrent-dial guard ─────────────────
// launchCall mints a fresh callId per invocation, so a fast double-tap
// on the dial button rang the peer TWICE (two CallScreens, two offers).
// The callRegistry is the source of truth for a live call, but it only
// populates once useCall's boot registers the controller — this latch
// covers the tap→registration window. Released when the registry takes
// over (active call appears), and by a watchdog for aborted boots
// (permission denied / instant back) so a failed launch can't wedge
// future calls.
let oneToOneLaunchInFlight = false;
let oneToOneLaunchWatchdog: ReturnType<typeof setTimeout> | null = null;
const ONE_TO_ONE_LAUNCH_WATCHDOG_MS = 10_000;

export function isOneToOneLaunchBlocked(): boolean {
  return oneToOneLaunchInFlight || getActiveCall() !== null;
}

export function releaseOneToOneLaunchLatch(): void {
  oneToOneLaunchInFlight = false;
  if (oneToOneLaunchWatchdog) {
    clearTimeout(oneToOneLaunchWatchdog);
    oneToOneLaunchWatchdog = null;
  }
}

function latchOneToOneLaunch(): void {
  oneToOneLaunchInFlight = true;
  const unsub = onActiveCallChange(s => {
    // Fires synchronously with the CURRENT (null — we just checked)
    // state on register; release only once the call actually lands.
    if (s) { unsub(); releaseOneToOneLaunchLatch(); }
  });
  if (oneToOneLaunchWatchdog) {clearTimeout(oneToOneLaunchWatchdog);}
  oneToOneLaunchWatchdog = setTimeout(() => {
    unsub();
    releaseOneToOneLaunchLatch();
  }, ONE_TO_ONE_LAUNCH_WATCHDOG_MS);
}

export function launchCall(nav: NavLike, opts: LaunchOpts): void {
  // Role gate — CP Agents must not start outgoing 1:1 calls to
  // individual users. Evaluated before any nav so the agent gets a
  // visible reason rather than an apparent silent failure.
  const role = useAuthStore.getState().user?.role;
  const convo = useMessengerStore.getState().conversations[opts.conversationId];
  // Area 8 #4 — prefer the explicit hint (set by callers that launch before the
  // room is hydrated) over the store-derived classification.
  const groupCall = opts.isGroup ?? isGroupConversation(opts.conversationId);
  const reason = blockReasonForOutgoingCall(role, convo?.type ?? (opts.isGroup ? 'group' : undefined), groupCall);
  if (reason) {
    try {
      const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
      Alert.alert('Call not allowed', reason);
    } catch {
      console.warn('[bravo.launchcall] blocked:', reason);
    }
    return;
  }

  // Group calls (3+) bypass the 1:1 path entirely — mesh WebRTC dies
  // around 5 participants, so we route everything that isn't a 1:1
  // through mediasoup.
  if (groupCall) {
    // Area 8 #4 — recipients from the store if hydrated, else from the explicit
    // participants hint (mission Ops Room launched before materialization).
    const ownId = useAuthStore.getState().user?.id;
    const fromStore = otherMembers(opts.conversationId);
    const recipientUserIds = fromStore.length > 0
      ? fromStore
      : (opts.participants ?? []).filter(p => p && p !== 'self' && p !== ownId);
    const groupConvo = useMessengerStore.getState().conversations[opts.conversationId];
    const callerName = groupConvo?.name ?? 'Group';

    // Fire the room probe in the background. If it returns a live room
    // before the screen mounts, we navigate as `incoming` to skip the
    // ring; otherwise navigate fresh as `outgoing` to ring everyone.
    void findLiveRoom(opts.conversationId).then(live => {
      // Defensive cleanup of stale registry state from a PREVIOUS
      // call. After a 6-person call fully ends, leaveInternal in the
      // last hook instance might race the navigation pop and leave
      // the registry holding the old room's refs. The next call's
      // useGroupCall boot would then see `existing` and try to adopt
      // refs that point at closed mediasoup transports — symptom is
      // a black tile grid that never shows anyone. Clear here so the
      // boot path falls through to a fresh build cleanly.
      const liveRoomId = live?.roomId ?? null;
      const stale = getActiveGroupCall();
      if (stale && (!liveRoomId || stale.roomId !== liveRoomId)) {
        console.log(`[bravo.launchcall] clearing stale registry roomId=${stale.roomId}`);
        clearRoomIdentities(stale.roomId);
        setActiveGroupCall(null);
      }
      nav.navigate('GroupCallScreen', {
        conversationId:   opts.conversationId,
        callType:         opts.callType,
        // Live room → join straight in, no ring. Fresh → ring everyone.
        direction:        liveRoomId ? 'incoming' : 'outgoing',
        roomId:           liveRoomId ?? undefined,
        recipientUserIds,
        callerName,
        // Audit row #5 (C1) — token from GET /sfu/rooms/by-conversation.
        // Without it the joiner would hit room_token_required at
        // sfu.join once SFU_ROOM_TOKEN_SECRET is set.
        roomToken:        live?.roomToken,
      });
    });
    return;
  }

  // 1:1 path.
  // CALL-17 — reject when a 1:1 call is already live/pending (registry)
  // or another launch is mid-boot (latch). Without this, a double-tap
  // minted two callIds and rang the peer twice.
  if (isOneToOneLaunchBlocked()) {
    try {
      const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
      Alert.alert('Call in progress', 'Finish the current call before starting a new one.');
    } catch {
      console.warn('[bravo.launchcall] blocked — a call is already in progress or launching');
    }
    return;
  }
  const peer = resolvePeerForCall(opts.conversationId);
  // Only latch when we actually dial — an unresolvable peer never boots
  // a controller, so a latch would just block the retry for nothing.
  if (peer) {latchOneToOneLaunch();}
  nav.navigate('CallScreen', {
    conversationId: opts.conversationId,
    callType:       opts.callType,
    isIncoming:     false,
    remoteUserId:   peer ?? undefined,
    remoteDeviceId: opts.remoteDeviceId ?? 1,
    callId:         peer ? genCallId() : undefined,
  });
}
