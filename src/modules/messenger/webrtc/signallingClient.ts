import type {
  CallId,
  CallControlAuth,
  CallOfferAuth,
  SessionAddress,
  ServerCallOffer,
  ServerCallAnswer,
  ServerCallIce,
  ServerCallHangup,
  ServerCallMediaState,
  ServerCallReOffer,
  ServerCallReAnswer,
  ServerFrame,
  TransportClient,
} from '@bravo/messenger-core';
import type {HangupReason, IceCandidateInit, CallKind} from './types';

/**
 * Call-oriented wrapper over the app's WebSocket transport.
 *
 * Doesn't own the transport — borrows it. Multiple CallSignalling
 * instances CAN coexist against the same transport (e.g. if the app
 * wanted to support simultaneous calls) because each subscribes only
 * to frames that match its own callId set.
 *
 * The gateway is a pure relay for call.* frames (see M8 server), so
 * offer/answer/ICE pass through verbatim — no store, no tampering.
 */
export class CallSignalling {
  // Multi-subscriber arrays. Older code used a single-slot `xHandler`
  // setter, which silently overwrote when a stale CallController
  // (e.g. from a previous mount that hadn't fully torn down) was still
  // wired up — the new instance would clobber the old one's handler,
  // and frames the old controller still cared about for cleanup would
  // be dropped. Switching to arrays makes registration additive and
  // returns an explicit unregister fn so a controller's end() can
  // remove ITS handler without touching anyone else's.
  private offerHandlers:      Array<(f: ServerCallOffer['data'])      => void> = [];
  private answerHandlers:     Array<(f: ServerCallAnswer['data'])     => void> = [];
  private iceHandlers:        Array<(f: ServerCallIce['data'])        => void> = [];
  private hangupHandlers:     Array<(f: ServerCallHangup['data'])     => void> = [];
  /**
   * BS-021 — peer media-state advisory handlers. Receivers register
   * via `onMediaState(...)`; sender path is `sendMediaState(...)`.
   */
  private mediaStateHandlers: Array<(f: ServerCallMediaState['data']) => void> = [];
  /**
   * Mid-call SDP renegotiation handlers — voice→video upgrade. Same
   * multi-subscriber pattern as the rest. Routed by callId on the
   * controller side so a stale handler from a previous call can't
   * react to a fresh upgrade on a different call.
   */
  private reOfferHandlers:    Array<(f: ServerCallReOffer['data'])    => void> = [];
  private reAnswerHandlers:   Array<(f: ServerCallReAnswer['data'])   => void> = [];

  constructor(private readonly transport: TransportClient) {}

  /**
   * Plug into the transport's onFrame — the host app owns the single
   * subscription and routes call.* frames here. Call this once from
   * the place that constructs the transport.
   */
  ingest(frame: ServerFrame): void {
    // Snapshot the handler list before iterating: a handler is allowed
    // to call its own unregister() (controller.end on hangup), which
    // splices the array. Iterating the live array would skip the next
    // handler in that case.
    switch (frame.event) {
      case 'call.offer':        for (const h of this.offerHandlers.slice())      {try {h(frame.data);} catch {/* one bad handler must not block */}} return;
      case 'call.answer':       for (const h of this.answerHandlers.slice())     {try {h(frame.data);} catch {/* one bad handler must not block */}} return;
      case 'call.ice':          for (const h of this.iceHandlers.slice())        {try {h(frame.data);} catch {/* one bad handler must not block */}} return;
      case 'call.hangup':       for (const h of this.hangupHandlers.slice())     {try {h(frame.data);} catch {/* one bad handler must not block */}} return;
      case 'call.media-state':  for (const h of this.mediaStateHandlers.slice()) {try {h(frame.data);} catch {/* one bad handler must not block */}} return;
      case 'call.reoffer':      for (const h of this.reOfferHandlers.slice())    {try {h(frame.data);} catch {/* one bad handler must not block */}} return;
      case 'call.reanswer':     for (const h of this.reAnswerHandlers.slice())   {try {h(frame.data);} catch {/* one bad handler must not block */}} return;
      default:
        // Non-call frame — transport delegates these elsewhere.
        return;
    }
  }

  onOffer (h: (f: ServerCallOffer['data'])  => void): () => void {
    this.offerHandlers.push(h);
    return () => { this.offerHandlers = this.offerHandlers.filter(x => x !== h); };
  }
  onAnswer(h: (f: ServerCallAnswer['data']) => void): () => void {
    this.answerHandlers.push(h);
    return () => { this.answerHandlers = this.answerHandlers.filter(x => x !== h); };
  }
  onIce   (h: (f: ServerCallIce['data'])    => void): () => void {
    this.iceHandlers.push(h);
    return () => { this.iceHandlers = this.iceHandlers.filter(x => x !== h); };
  }
  onHangup(h: (f: ServerCallHangup['data']) => void): () => void {
    this.hangupHandlers.push(h);
    return () => { this.hangupHandlers = this.hangupHandlers.filter(x => x !== h); };
  }
  /**
   * BS-021 — receive peer-mute / peer-camera-off advisories. Returns an
   * unregister fn so the receiving hook (useCall) can remove its
   * handler on unmount without touching anyone else's.
   */
  onMediaState(h: (f: ServerCallMediaState['data']) => void): () => void {
    this.mediaStateHandlers.push(h);
    return () => { this.mediaStateHandlers = this.mediaStateHandlers.filter(x => x !== h); };
  }
  /**
   * Mid-call renegotiation — the controller subscribes to react to a
   * peer-initiated voice→video upgrade. callId match is enforced on
   * the controller side.
   */
  onReOffer(h: (f: ServerCallReOffer['data']) => void): () => void {
    this.reOfferHandlers.push(h);
    return () => { this.reOfferHandlers = this.reOfferHandlers.filter(x => x !== h); };
  }
  onReAnswer(h: (f: ServerCallReAnswer['data']) => void): () => void {
    this.reAnswerHandlers.push(h);
    return () => { this.reAnswerHandlers = this.reAnswerHandlers.filter(x => x !== h); };
  }

  /**
   * All send paths funnel through here so a closed-transport throw
   * ("transport not open") cannot escape into a React unmount cleanup
   * and corrupt the fiber tree. CallScreen tearing down after the
   * peer hung up is the worst-case path: the WS already closed, our
   * cleanup calls controller.hangup() → sendHangup() → transport.send()
   * → throws → React's commit phase explodes → app freezes.
   *
   * Best-effort semantics are correct for call.* frames: if the
   * transport is gone the peer either already saw the hangup (because
   * they triggered it) or will time out on their own after the
   * heartbeat window. Either way, dropping the local ack is fine.
   *
   * Tagged for logcat: [bravo.signalling].
   */
  private safeSend(event: string, data: unknown): void {
    try {
      this.transport.send({event, data} as Parameters<TransportClient['send']>[0]);
    } catch (e) {
      console.warn(`[bravo.signalling] ${event} dropped — transport closed: ${(e as Error).message}`);
    }
  }

  /**
   * Wait briefly for the WS to come up, then send. Used for OFFER only —
   * if we drop the initial offer the call is dead on arrival (peer
   * never rings). Common path: user opens chat right after restore /
   * cold-start, taps Call before the WS reconnect handshake finishes.
   * The transport's onStateChange would normally drain this in 1-2s.
   *
   * timeoutMs is a hard cap. After timeout we fall back to safeSend
   * which logs + drops; the caller's CallScreen state machine will
   * surface "Connecting…" → "Could not connect" so the user can retry.
   */
  private async waitOpenThenSend(event: string, data: unknown, timeoutMs = 4000): Promise<void> {
    // Already open — common case, fast path.
    const stateNow = (this.transport as unknown as {state?: string}).state;
    if (stateNow === 'connected') {
      this.safeSend(event, data);
      return;
    }
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const s = (this.transport as unknown as {state?: string}).state;
      if (s === 'connected') {
        this.safeSend(event, data);
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    // Timeout: the UI-facing connection-state label can lag a socket that
    // is in fact usable — group-call `wsRequest` and chat sends keep
    // working in this window because socket.io buffers emits and flushes
    // them on (re)connect. The old behaviour DROPPED the frame here, which
    // bricked 1:1 calls even though the WS was fine: the OFFER never went
    // out (callee never rang) and the ANSWER never went out (caller stuck
    // on "Answering…"). Send best-effort instead — `safeSend` swallows a
    // genuinely-closed-transport throw, and socket.io delivers the
    // buffered frame once the handshake completes.
    console.warn(`[bravo.signalling] ${event} — state not 'connected' after ${timeoutMs}ms; sending best-effort (socket.io buffers+flushes)`);
    this.safeSend(event, data);
  }

  // Per-callId send queue. Without this, sendOffer (queued via
  // waitOpenThenSend on a slow transport) would race sendHangup
  // (immediate fire-and-drop) — the user could dial then instantly
  // cancel, see hangup silently dropped because the WS hadn't opened
  // yet, then watch the offer fly out 2s later when the WS came up.
  // Peer rings forever for a call we cancelled. Fix: every call.* frame
  // for a given callId chains off the previous send for that callId so
  // hangup always lands AFTER offer (or after answer, on the answerer).
  private callIdQueues = new Map<CallId, Promise<void>>();
  private enqueueForCall(callId: CallId, work: () => Promise<void>): Promise<void> {
    const prev = this.callIdQueues.get(callId) ?? Promise.resolve();
    const next = prev.catch(() => {/* don't propagate prior failures */}).then(work);
    // Track the latest tail so we can chain again. Clean up when this
    // tail resolves AND nothing newer was chained.
    this.callIdQueues.set(callId, next);
    void next.finally(() => {
      if (this.callIdQueues.get(callId) === next) {
        this.callIdQueues.delete(callId);
      }
    });
    return next;
  }

  sendOffer(callId: CallId, to: SessionAddress, sdp: string, kind: CallKind, auth?: CallOfferAuth): void {
    // Audit S7 — caller-identity binding rides on the same frame; relay
    // passes it through verbatim. Omitting `auth` ships an unsigned
    // offer (rollout window only — receivers fail-closed once telemetry
    // is clean).
    void this.enqueueForCall(callId, () =>
      this.waitOpenThenSend('call.offer', auth ? {callId, to, sdp, kind, auth} : {callId, to, sdp, kind}));
  }
  sendAnswer(callId: CallId, to: SessionAddress, sdp: string, auth?: CallControlAuth): void {
    // Same wait-open semantics as offer — accepting an incoming call
    // right after waking the device is the mirror case where the WS
    // may still be reconnecting.
    //
    // Audit P1-C3 — answerer-identity binding rides on the same frame;
    // relay passes it through verbatim. Omitting `auth` ships an
    // unsigned answer (rollout window only — receivers fail-closed once
    // telemetry is clean).
    void this.enqueueForCall(callId, () =>
      this.waitOpenThenSend('call.answer', auth ? {callId, to, sdp, auth} : {callId, to, sdp}));
  }
  /**
   * Mid-call renegotiation send paths. Use waitOpenThenSend like the
   * initial offer/answer: the user might tap Camera right as the WS
   * is recovering from a brief drop, and we don't want to silently
   * drop the upgrade. The controller's watchdog still reverts the
   * local addTrack if the round-trip never completes.
   */
  sendReOffer(callId: CallId, to: SessionAddress, sdp: string): void {
    void this.enqueueForCall(callId, () =>
      this.waitOpenThenSend('call.reoffer', {callId, to, sdp}));
  }
  sendReAnswer(callId: CallId, to: SessionAddress, sdp: string): void {
    void this.enqueueForCall(callId, () =>
      this.waitOpenThenSend('call.reanswer', {callId, to, sdp}));
  }
  sendIce(callId: CallId, to: SessionAddress, cand: IceCandidateInit, duringRestart = false): void {
    const payload = {
      callId, to,
      candidate: cand.candidate,
      sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex,
    };
    // Normal in-call trickle stays on the immediate path. ICE candidates
    // are useless if they arrive AFTER the offer was applied (already-set
    // remote description ignores late candidates), so chaining them behind
    // a slow offer queue would actively hurt. Peer's candidate dispatcher
    // already queues pre-remote-description ICE for us.
    //
    // BS-CALL2 — EXCEPT during an ICE-restart (screen-off Doze, Wi-Fi↔
    // cellular handover): the WS is briefly reconnecting, and the restart
    // re-offer has NOT yet been applied by the peer, so these candidates
    // are NOT late. Dropping them here (the old behaviour) killed the
    // recovery and the call died on screen-on. Wait briefly for the WS
    // like reOffer/reAnswer do — this is what makes recovery seamless.
    if (duringRestart) {
      void this.enqueueForCall(callId, () => this.waitOpenThenSend('call.ice', payload));
    } else {
      this.safeSend('call.ice', payload);
    }
  }
  /**
   * Hangup MUST chain after any pending offer/answer for the same
   * callId. The rapid-hangup regression we shipped: user taps Call →
   * sendOffer goes into waitOpenThenSend (transport reconnecting); user
   * instantly taps End → sendHangup used safeSend (drops because WS
   * still down) → 2s later WS opens → offer flushes → peer rings
   * forever for a cancelled call. With per-callId queueing, the
   * hangup is enqueued BEHIND the offer; when the WS opens the offer
   * sends, then immediately the hangup. Peer gets a one-tick ring,
   * not an unanswerable forever-call. Short timeout (1500ms) because
   * if the WS hasn't opened by then the call wasn't going anywhere
   * anyway and we don't want to block the controller's end() path.
   */
  sendHangup(callId: CallId, to: SessionAddress, reason: HangupReason): void {
    void this.enqueueForCall(callId, () =>
      this.waitOpenThenSend('call.hangup', {callId, to, reason}, 1500));
  }
  /**
   * BS-021 — emit peer-mute / peer-camera-off advisory to the active
   * peer. Best-effort like the rest of the call.* sends: a closed
   * transport drops the frame silently (the call would already be
   * tearing down anyway). Receiver flips a placeholder in the remote
   * tile so the user can distinguish a frozen feed from an intentional
   * disable.
   */
  sendMediaState(callId: CallId, to: SessionAddress, cameraOff: boolean, micOff: boolean, auth?: CallControlAuth): void {
    // Audit P1-C2 — sender-identity binding optional during the rollout
    // window. Relay forwards verbatim; receivers fail-closed when the
    // gate flips on.
    //
    // O-A (VIDEO_CALL_RENDER_ISSUES_HANDOFF §4) — this used to be a bare
    // safeSend: a frame dropped during a WS blip left the receiver's
    // `remoteVideoOff` stale FOREVER (the "Camera off" placeholder is
    // checked BEFORE remoteHasVideo, so it masked live video, and
    // nothing reconciles the flag). Ride the same per-callId queue +
    // wait-open as reoffer/reanswer so a toggle during a reconnect still
    // lands — and lands in order relative to the upgrade frames it
    // annotates.
    void this.enqueueForCall(callId, () =>
      this.waitOpenThenSend('call.media-state', auth
        ? {callId, to, cameraOff, micOff, auth}
        : {callId, to, cameraOff, micOff}));
  }
}
