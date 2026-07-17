/**
 * Singleton dispatcher that routes inbound call.* frames from the
 * messenger transport to the right surface.
 *
 *   • Active CallSignalling instances register themselves on mount
 *     so call.answer / call.ice / call.hangup frames are delivered
 *     to the running call (matched by callId).
 *   • An incoming `call.offer` with no matching signalling triggers
 *     the `incomingOffer` callback so the host (navigation root) can
 *     wake up the CallScreen with direction='incoming'.
 *
 * Kept tiny — anything more elaborate belongs in a real signalling
 * server, which is the messenger-service's job, not the client's.
 */
import type {
  ServerCallOffer, ServerCallAnswer, ServerCallIce, ServerCallHangup,
  ServerCallMediaState, ServerCallReOffer, ServerCallReAnswer, ServerFrame,
} from '@bravo/messenger-core';
import type {CallSignalling} from './signallingClient';

type IncomingHandler = (offer: ServerCallOffer['data']) => void;

/**
 * Audit S7 — caller-identity verifier. Wired by the navigation root
 * (which holds the live runtime + authority pubkey) so the dispatcher
 * can synchronously gate any inbound `call.offer` on the signed AAD
 * BEFORE waking the CallScreen. Returns a promise so the caller can
 * await verifySenderCert (XEd25519 over Curve25519 — async).
 *
 *   { ok: true }    — verification passed (or rolled-out fail-open).
 *   { ok: false }   — verification failed; offer is rejected and a
 *                     `call.hangup{reason:'failed'}` is fired back.
 *
 * When unset (e.g. before MainNavigator wires it on boot), inbound
 * offers fall through to the legacy unauthenticated path. This is
 * intentional during the rollout window so the app boots even if the
 * authority key env var is missing in a dev build; production builds
 * MUST install a verifier.
 */
type CallOfferVerifier = (offer: ServerCallOffer['data']) => Promise<{ok: true} | {ok: false; reason: string}>;

const active = new Map<string, CallSignalling>();
let onIncoming: IncomingHandler | null = null;
let verifyOfferAuth: CallOfferVerifier | null = null;

// ── Pre-registration frame queue ───────────────────────────────────
// For INCOMING calls, the timeline is:
//   T0:        call.offer arrives → onIncoming fires → CallScreen mounts
//   T0+10ms:   call.ice candidates start arriving from the offerer
//   T0+~500ms: useCall finishes getUserMedia and calls registerSignalling()
// All ICE candidates that land between T0+10ms and T0+500ms have nowhere
// to go — there's no signalling registered for this callId yet. Without
// this queue they were silently dropped here, so the answerer's engine
// never received the offerer's remote candidates, never started ICE
// checks, and the call hung in 'have-remote-offer' until the user
// hung up. Coturn's view: offerer sends binding requests via TURN
// (peer rp > 0 on answerer's session), answerer never responds (sp=0).
//
// Fix: queue any non-offer frame for an unknown callId, drain into the
// signalling the moment it registers. TTL guards against leaks if the
// signalling never registers (e.g., user dismisses the incoming offer).
const FRAME_TTL_MS = 30_000;
type QueuedFrame = {frame: ServerFrame; at: number};
const pending = new Map<string, QueuedFrame[]>();

function gcExpiredPending(): void {
  const cutoff = Date.now() - FRAME_TTL_MS;
  for (const [callId, frames] of pending) {
    const fresh = frames.filter(q => q.at >= cutoff);
    if (fresh.length === 0) {pending.delete(callId);}
    else if (fresh.length !== frames.length) {pending.set(callId, fresh);}
  }
}

export function registerSignalling(callId: string, sig: CallSignalling): () => void {
  // Refuse silent overwrite. If a prior CallSignalling was registered
  // for this callId (legitimate cause: a fast remount of CallScreen
  // before the old hook's cleanup ran, or a defensive re-register after
  // accept) we'd otherwise leave two CallSignalling instances both
  // listening to the SAME frames — both their controllers fight for
  // the same call and the call enters a permanently confused state.
  // Warn loudly so this shows up in production logs, then run any
  // teardown the previous one exposes (none today, but the path is
  // there for the future).
  const prev = active.get(callId);
  if (prev && prev !== sig) {
    console.warn(`[bravo.callDispatcher] registerSignalling overwriting existing entry callId=${callId.slice(0, 8)} — possible double-mount of CallScreen`);
    const prevWithTeardown = prev as unknown as {teardown?: () => void};
    if (typeof prevWithTeardown.teardown === 'function') {
      try { prevWithTeardown.teardown(); } catch { /* ignore */ }
    }
  }
  active.set(callId, sig);
  // Drain any frames that arrived during the setup window.
  const queued = pending.get(callId);
  if (queued && queued.length > 0) {
    pending.delete(callId);
    for (const q of queued) {
      try { sig.ingest(q.frame); } catch { /* one bad frame must not block the rest */ }
    }
  }
  return () => { if (active.get(callId) === sig) {active.delete(callId);} };
}

export function setIncomingCallHandler(h: IncomingHandler | null): void {
  onIncoming = h;
}

/**
 * Audit S7 — install the caller-identity verifier. MainNavigator calls
 * this once the messenger runtime is built (so the verifier has access
 * to the live identity store + cert authority pubkey).
 */
export function setCallOfferVerifier(v: CallOfferVerifier | null): void {
  verifyOfferAuth = v;
}

/**
 * CALL-16 — idempotent "Missed call" chat-bubble append, shared by the
 * `call.missed` replay path and the no-controller `call.hangup` path
 * (caller cancelled while we were still ringing via notifee/CallKit).
 * The stable `missed-<callId>` id makes appendMessage's dedup
 * idempotent across a reconnect replay. Returns the conversation id on
 * success so callers can look up the convo (e.g. for the notif name),
 * or null when the store isn't available (tests / early boot).
 */
function appendMissedCallBubble(d: {
  callId: string;
  from:   {userId: string; deviceId: number};
  kind?:  'voice' | 'video';
  at?:    number;
}): string | null {
  try {
    const store = require('../store/messengerStore') as typeof import('../store/messengerStore');
    const state = store.useMessengerStore.getState();
    const convoId = store.resolveDirectConversationIdFromState(state, d.from.userId);
    state.appendMessage(convoId, {
      id:              `missed-${d.callId}`,
      conversation_id: convoId,
      sender_id:       d.from.userId,
      type:            'call',
      content:         '',
      status:          'delivered',
      is_encrypted:    true,
      created_at:      new Date(d.at ?? Date.now()).toISOString(),
      peer:            d.from,
      call_meta:       {kind: d.kind === 'video' ? 'video' : 'voice', direction: 'incoming', outcome: 'missed', duration: 0},
    });
    return convoId;
  } catch {
    return null;
  }
}

/**
 * B-64 — hard-end a live registry session the server has declared dead.
 * Covers the 2026-07-10 zombie: the killed-app answer path builds a
 * controller + starts the FGS, the answer never registers server-side,
 * and when the caller gives up the resulting `call.missed` / unmatched
 * `call.hangup` used to leave the wedged session (and its unclearable
 * ongoing-call notification) running forever. No-op when the callIds
 * don't match or the session is already terminal.
 */
function endZombieSession(callId: string, via: string): void {
  try {
    const reg = require('../runtime/callRegistry') as typeof import('../runtime/callRegistry');
    const live = reg.getActiveCall();
    if (live && live.callId === callId && live.state !== 'ended' && live.state !== 'failed') {
      console.warn(`[bravo.callDispatcher] ${via} for a live call cid=${callId.slice(0, 8)} state=${live.state} — ending zombie session`);
      reg.endActiveCall('failed', 'remote');
    }
  } catch { /* registry unavailable (tests) — best effort */ }
}

/**
 * Called from the runtime's WS frame handler. Anything that isn't a
 * call.* frame is ignored; everything else is routed to the matching
 * registered signalling, or — for offers without a match — punted to
 * the global incoming handler.
 */
export function dispatchCallFrame(frame: ServerFrame): boolean {
  // Audit SFU-12 (2026-07-02): `call.missed` isn't in the typed ServerFrame
  // union (it's a dynamic server event), so handle it BEFORE the typed switch.
  // A 1:1 offer expired while we were offline (the caller gave up); there's no
  // live call to route, so append a "Missed call" record to the caller's
  // thread instead of losing it silently. Stable id makes appendMessage's
  // dedup idempotent across a reconnect replay.
  if ((frame as {event: string}).event === 'call.missed') {
    const f = frame as unknown as {data: {callId: string; from: {userId: string; deviceId: number}; kind?: 'voice' | 'video'; at?: number}};
    // B-64 — the server just declared this call dead. If a live-but-wedged
    // session still exists for it (2026-07-10 zombie: answer lost, controller
    // stuck in 'connecting', FGS notification unclearable), hard-end it so
    // the FGS notif, InCallManager, and registry all clear.
    endZombieSession(f.data.callId, 'call.missed');
    const convoId = appendMissedCallBubble(f.data);
    if (convoId) {
      // Post a persistent "Missed call" notification so a backgrounded user
      // sees it after the ring auto-dismisses (WhatsApp/Signal parity).
      try {
        const store = require('../store/messengerStore') as typeof import('../store/messengerStore');
        const convo = store.useMessengerStore.getState().conversations[convoId];
        const cn = require('../push/callNotification') as typeof import('../push/callNotification');
        void cn.showMissedCallNotif({
          callId: f.data.callId,
          callerName: convo?.name,
          kind: f.data.kind === 'video' ? 'video' : 'voice',
        });
      } catch { /* notifee unavailable — best effort */ }
    }
    return true;
  }
  switch (frame.event) {
    case 'call.offer': {
      const f = frame as ServerCallOffer;
      const sig = active.get(f.data.callId);
      if (sig) { sig.ingest(f); return true; }
      // Audit S7 — caller-identity verification BEFORE waking the host.
      // Verifier is async (XEd25519 verify chain); we fire-and-forget
      // here because dispatchCallFrame must stay sync to match the
      // transport's frame loop. On verification failure we log + drop;
      // the caller times out on their watchdog and the user never
      // sees a forged incoming call surface.
      if (verifyOfferAuth) {
        const verifier = verifyOfferAuth;
        const handler  = onIncoming;
        const callIdLog = f.data.callId.slice(0, 8);
        const fromLog   = `${f.data.from.userId.slice(0, 8)}/${f.data.from.deviceId}`;
        void verifier(f.data).then(result => {
          if (!result.ok) {
            console.warn(`[bravo.callDispatcher] call.offer REJECTED cid=${callIdLog} from=${fromLog} reason=${result.reason}`);
            return;
          }
          if (handler) {handler(f.data);}
        }).catch(err => {
          console.warn(`[bravo.callDispatcher] call.offer verifier threw cid=${callIdLog} — dropping:`, (err as Error).message);
        });
        return true;
      }
      // No verifier installed — legacy fallback (rollout window).
      if (onIncoming) {onIncoming(f.data);}
      return true;
    }
    case 'call.answer': {
      const f = frame as ServerCallAnswer;
      const sig = active.get(f.data.callId);
      if (sig) { sig.ingest(f); return true; }
      // Queue — the controller might be in mid-setup.
      gcExpiredPending();
      const arr = pending.get(f.data.callId) ?? [];
      arr.push({frame: f, at: Date.now()});
      pending.set(f.data.callId, arr);
      return true;
    }
    case 'call.ice': {
      const f = frame as ServerCallIce;
      const sig = active.get(f.data.callId);
      if (sig) { sig.ingest(f); return true; }
      // Queue — see comment on `pending` above. ICE candidates from the
      // offerer land here BEFORE the answerer's CallScreen finishes
      // setup; without queueing they were dropped and the call hung.
      gcExpiredPending();
      const arr = pending.get(f.data.callId) ?? [];
      arr.push({frame: f, at: Date.now()});
      pending.set(f.data.callId, arr);
      return true;
    }
    case 'call.hangup': {
      const f = frame as ServerCallHangup;
      const sig = active.get(f.data.callId);
      if (sig) { sig.ingest(f); return true; }
      // No controller registered yet — the call is still RINGING via
      // notifee / CallKit (the offer woke them but the user hasn't
      // accepted, so useCall never mounted). The caller cancelled (or
      // another device picked up). Without dismissing here, the looping
      // full-screen notifee ring keeps firing until its TTL and tapping
      // Answer would mount a CallScreen for a peer who already left.
      // Tear down both surfaces + the cached payload.
      const cid = f.data.callId;
      try {
        const cn = require('../push/callNotification') as typeof import('../push/callNotification');
        void cn.dismissCallNotif(cid);
      } catch { /* notifee unavailable (tests / iOS) */ }
      try {
        const {reportEnded} = require('../push/callKitBridge') as typeof import('../push/callKitBridge');
        reportEnded(cid, f.data.reason === 'failed' ? 'failed' : 'remoteEnded');
      } catch { /* bridge inactive */ }
      // B-64 — a controller can exist in the registry even when no signalling
      // is registered with the dispatcher (accept wedged mid-boot on the
      // killed-app answer path). The hangup would otherwise never reach it.
      endZombieSession(cid, 'call.hangup');
      // The caller cancelled while we were still ringing (no controller had
      // mounted) → a genuine missed call. If a ring payload was cached, post a
      // persistent "Missed call" notification. Read defensively and in its own
      // try so it can never interfere with the critical cache teardown below.
      try {
        const cache = require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
        const payload = typeof cache.getIncomingCallPayload === 'function'
          ? cache.getIncomingCallPayload(cid)
          : null;
        if (payload && f.data.reason !== 'declined') {
          const cn = require('../push/callNotification') as typeof import('../push/callNotification');
          void cn.showMissedCallNotif?.({
            callId: cid,
            callerName: payload.callerName,
            kind: payload.kind as import('../push/callNotification').CallNotifKind,
          });
          // CALL-16 — the notification alone left the chat thread with
          // no trace of the missed call (the bubble only landed on the
          // offline `call.missed` replay path). Same idempotent
          // missed-<callId> record, same gating as the notification.
          appendMissedCallBubble({
            callId: cid,
            from:   f.data.from,
            kind:   payload.kind === 'video' ? 'video' : 'voice',
          });
        }
      } catch { /* missed-call notif best-effort */ }
      try {
        const cache = require('../push/incomingCallCache') as typeof import('../push/incomingCallCache');
        cache.clearIncomingCallPayload(cid);
      } catch { /* cache unavailable */ }
      try {
        const {notifyCallEnded} = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
        notifyCallEnded(cid);
      } catch { /* fcmBootstrap not loaded in tests */ }
      // Drop pending frames for this call — the call ended before any
      // controller registered, no point queueing.
      pending.delete(cid);
      return true;
    }
    case 'call.media-state': {
      // BS-021 — peer-mute / peer-camera-off advisory. Route to the
      // active signalling for this callId; queue when no controller is
      // registered yet (same TTL window as ICE) so a media-state that
      // arrives during the answerer's getUserMedia setup window is
      // delivered once the hook calls registerSignalling. If no
      // controller ever registers it ages out — purely advisory, no
      // call invariants are tied to it.
      const f = frame as ServerCallMediaState;
      const sig = active.get(f.data.callId);
      if (sig) { sig.ingest(f); return true; }
      gcExpiredPending();
      const arr = pending.get(f.data.callId) ?? [];
      arr.push({frame: f, at: Date.now()});
      pending.set(f.data.callId, arr);
      return true;
    }
    case 'call.reoffer': {
      // Mid-call SDP renegotiation — voice→video upgrade. The peer is
      // already in a live call so a registered signalling MUST exist
      // by the time this lands. If it somehow doesn't (e.g. CallScreen
      // is in the middle of a remount via the resume-from-registry
      // path), queue with the same TTL so the controller picks it up
      // when registerSignalling fires. We don't drop unmatched reoffers
      // because the initiator is sitting on a half-applied addTrack
      // waiting for our reanswer — silently discarding here would leave
      // them hung until their watchdog rolls back ~8 s later.
      const f = frame as ServerCallReOffer;
      const sig = active.get(f.data.callId);
      if (sig) { sig.ingest(f); return true; }
      gcExpiredPending();
      const arr = pending.get(f.data.callId) ?? [];
      arr.push({frame: f, at: Date.now()});
      pending.set(f.data.callId, arr);
      return true;
    }
    case 'call.reanswer': {
      // Mid-call renegotiation reply. Same queue-on-miss rationale as
      // reoffer above — though in practice the initiator's signalling
      // is the one that's been live for the duration of the call so
      // an unmatched reanswer is a real anomaly worth surfacing.
      const f = frame as ServerCallReAnswer;
      const sig = active.get(f.data.callId);
      if (sig) { sig.ingest(f); return true; }
      gcExpiredPending();
      const arr = pending.get(f.data.callId) ?? [];
      arr.push({frame: f, at: Date.now()});
      pending.set(f.data.callId, arr);
      return true;
    }
    default:
      return false;
  }
}

/**
 * Round 2 fix: tear down ALL dispatcher state. Wired into authStore.signOut
 * so a logout doesn't leak the previous user's active call signalling
 * map, the queued-frame `pending` map (TTL'd 30 s but the entries are
 * still reachable), or the global `onIncoming` handler (which would
 * fire incoming-call banners on the next user's home screen if a stray
 * offer frame arrived during the logout transition).
 */
export function clearAllCallDispatchState(): void {
  active.clear();
  pending.clear();
  onIncoming = null;
  // Audit S7 — also drop the verifier so a logout-then-relogin doesn't
  // leave the previous user's verifier wired up.
  verifyOfferAuth = null;
}
