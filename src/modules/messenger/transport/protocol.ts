/**
 * Mirror of apps/messenger-service/src/gateway/protocol.ts.
 *
 * Kept as a separate file (not a shared package) because the RN build
 * and the NestJS build have incompatible tsconfigs. When you change a
 * frame shape on the server, change it here in the same commit — type
 * drift is silent.
 */

export interface SessionAddress {
  userId:   string;
  deviceId: number;
}

export interface Ciphertext {
  type: 1 | 3;
  body: string;
}

export interface ClientPing {
  event: 'ping';
  data?: {ts: number};
}

export interface ClientEnvelopeSend {
  event: 'envelope.send';
  data: {
    to:          SessionAddress;
    /**
     * Sealed Sender v2 outer ECIES wrap. Replaces the Phase-1
     * `{ciphertext, senderAddressHint}` pair: the libsignal SessionCipher
     * output and the sender's address now travel inside an X25519+AES-GCM
     * envelope keyed off the recipient's identity public key. The relay
     * treats this as opaque bytes and has no field that links the
     * envelope back to the sender.
     */
    outerSealed: string;
    clientMsgId: string;
    /**
     * Disappearing-message deadline (epoch seconds). When set, the relay
     * shrinks the envelope's Redis TTL so the sealed ciphertext
     * self-evicts at its advertised expiry even if the recipient never
     * comes online to ACK.
     */
    expiresAtSec?: number;
  };
}

export interface ClientEnvelopeAck {
  event: 'envelope.ack';
  data: {envelopeId: string};
}

export interface ClientEnvelopePull {
  event: 'envelope.pull';
  data?: {
    after?: string;
    limit?: number;
    /**
     * Restore-after-reinstall fix #4 — bootstrap pulls bypass the
     * normal limit cap. Set to `true` on the FIRST pull after a
     * fresh install so the client gets every pending envelope in
     * one round-trip rather than the default 50/100.
     */
    bootstrap?: boolean;
  };
}

// ─── WebRTC call signalling (M8) — mirror of server protocol.ts ─────

export type CallId = string;

/**
 * Audit S7 — caller-identity binding for `call.offer`. Mirror of the
 * package-side `CallOfferAuthBlock`. Optional during the rollout window;
 * receivers fail-closed once telemetry shows zero legacy offers.
 */
export interface CallOfferAuthBlock {
  cert: string;
  aad: {
    v: number;
    callId: string;
    from: {userId: string; deviceId: number};
    to:   {userId: string; deviceId: number};
    kind: 'voice' | 'video';
    ts:   number;
  };
  sig: string;
}

export interface ClientCallOffer {
  event: 'call.offer';
  data: {
    callId: CallId; to: SessionAddress; sdp: string; kind: 'voice' | 'video';
    /** Audit S7 — see CallOfferAuthBlock. */
    auth?: CallOfferAuthBlock;
  };
}
export interface ClientCallAnswer {
  event: 'call.answer';
  data: {callId: CallId; to: SessionAddress; sdp: string};
}
export interface ClientCallIce {
  event: 'call.ice';
  data: {
    callId: CallId; to: SessionAddress; candidate: string;
    sdpMid?: string | null; sdpMLineIndex?: number | null;
  };
}
export interface ClientCallHangup {
  event: 'call.hangup';
  data: {callId: CallId; to: SessionAddress; reason: 'busy'|'declined'|'ended'|'failed'};
}

/**
 * BS-021 — peer-mute / peer-camera-off advisory.
 *
 *   The 1:1 P2P pipeline doesn't have a way for the peer to know when
 *   you flip `videoTrack.enabled = false`: RTP just stops, but the
 *   remote SurfaceView keeps painting the last decoded frame so the
 *   receiver sees a static image and can't tell if you muted your
 *   camera or if the network froze.
 *
 *   The fix is purely advisory: sender flips the track, fires this
 *   frame, receiver hides the remote tile and shows a "Camera off"
 *   placeholder. This does NOT affect SRTP — security stays intact.
 *
 *   The frame is server-relayed verbatim (gateway only forwards;
 *   never persists). On legacy peers that don't understand it, the
 *   server-side `forwardToDevice` returns `peer_offline`-style errors
 *   only when the user is offline; an unknown event name is a no-op
 *   on the receiver because the dispatcher's switch falls through.
 */
export interface ClientCallMediaState {
  event: 'call.media-state';
  data: {
    callId:     CallId;
    to:         SessionAddress;
    /** True when the LOCAL camera track is disabled. */
    cameraOff:  boolean;
    /** True when the LOCAL mic track is disabled (muted). */
    micOff:     boolean;
  };
}

/**
 * Mid-call SDP renegotiation — voice→video upgrade. Distinct from
 * `call.offer` so the recipient routes via callId match to the EXISTING
 * controller instead of mounting a fresh CallScreen. Pure relay: not
 * queued offline, no VoIP push (peer is already mid-call so by
 * definition online). On a peer running an older client that doesn't
 * understand the frame the dispatcher's switch falls through with a
 * no-op; the initiator's local watchdog (callController.upgradeToVideo)
 * times out and rolls back the half-applied upgrade so the call stays
 * voice-only and connected.
 *
 *   reoffer  — initiator (the side adding a video track) calls
 *              pc.setLocalDescription(createOffer()), ships the SDP.
 *   reanswer — responder applies the remote offer, optionally adds
 *              its own video, calls pc.createAnswer(), ships the SDP.
 */
export interface ClientCallReOffer {
  event: 'call.reoffer';
  data: {callId: CallId; to: SessionAddress; sdp: string};
}

export interface ClientCallReAnswer {
  event: 'call.reanswer';
  data: {callId: CallId; to: SessionAddress; sdp: string};
}

// ─── Ephemeral signals (M11) — mirror ────────────────────────────────

export interface ClientTyping {
  event: 'typing';
  data:  {to: SessionAddress; state: 'start' | 'stop'};
}
export interface ClientReadReceipt {
  event: 'read-receipt';
  data:  {to: SessionAddress; envelopeIds: string[]};
}
export interface ClientPresence {
  event: 'presence';
  data:  {state: 'active' | 'away'};
}

/**
 * Subscribe to a list of users' presence. The server joins this socket
 * to each user's `watch` room and immediately emits a one-shot snapshot
 * so the contact-status UI can paint before the next state transition.
 */
export interface ClientPresenceSubscribe {
  event: 'presence.subscribe';
  data:  {userIds: string[]};
}
export interface ClientPresenceUnsubscribe {
  event: 'presence.unsubscribe';
  data:  {userIds: string[]};
}

export type ClientFrame =
  | ClientPing
  | ClientEnvelopeSend
  | ClientEnvelopeAck
  | ClientEnvelopePull
  | ClientCallOffer
  | ClientCallAnswer
  | ClientCallIce
  | ClientCallHangup
  | ClientCallMediaState
  | ClientCallReOffer
  | ClientCallReAnswer
  | ClientTyping
  | ClientReadReceipt
  | ClientPresence
  | ClientPresenceSubscribe
  | ClientPresenceUnsubscribe;

export interface ServerPong {
  event: 'pong';
  data: {ts: number};
}

export interface ServerEnvelopeAccepted {
  event: 'envelope.accepted';
  data: {
    clientMsgId: string;
    envelopeId:  string;
    /**
     * M12: capability token the sender stores to retract this envelope
     * before the recipient pulls it. Single-use; absence means the
     * server didn't issue one (older deploys) — caller falls back to
     * waiting on dwell expiry.
     */
    retractToken?: string;
  };
}

export interface ServerEnvelopeDeliver {
  event: 'envelope.deliver';
  data: {
    envelopeId:  string;
    /** Sealed Sender v2 outer ECIES wrap — see ClientEnvelopeSend.outerSealed. */
    outerSealed: string;
    timestamp:   number;
  };
}

export interface ServerError {
  event: 'error';
  data: {code: string; message: string};
}

export interface ServerCallOffer {
  event: 'call.offer';
  data: {
    callId: CallId; from: SessionAddress; sdp: string; kind: 'voice' | 'video';
    /** Audit S7 — forwarded verbatim from the caller; receiver verifies. */
    auth?: CallOfferAuthBlock;
  };
}
export interface ServerCallAnswer {
  event: 'call.answer';
  data: {callId: CallId; from: SessionAddress; sdp: string};
}
export interface ServerCallIce {
  event: 'call.ice';
  data: {
    callId: CallId; from: SessionAddress; candidate: string;
    sdpMid?: string | null; sdpMLineIndex?: number | null;
  };
}
export interface ServerCallHangup {
  event: 'call.hangup';
  data: {callId: CallId; from: SessionAddress; reason: 'busy'|'declined'|'ended'|'failed'};
}

/**
 * BS-021 — server-side mirror of the client media-state advisory.
 * `from` is the peer who toggled their track; receiver flips the
 * remote tile placeholder accordingly.
 */
export interface ServerCallMediaState {
  event: 'call.media-state';
  data: {
    callId:    CallId;
    from:      SessionAddress;
    cameraOff: boolean;
    micOff:    boolean;
  };
}

/**
 * Server-side mirrors of the renegotiation frames. `from` is the peer
 * who initiated (reoffer) or replied to (reanswer) the renegotiation.
 */
export interface ServerCallReOffer {
  event: 'call.reoffer';
  data: {callId: CallId; from: SessionAddress; sdp: string};
}

export interface ServerCallReAnswer {
  event: 'call.reanswer';
  data: {callId: CallId; from: SessionAddress; sdp: string};
}

export interface ServerTyping {
  event: 'typing';
  data:  {from: SessionAddress; state: 'start' | 'stop'};
}
export interface ServerReadReceipt {
  event: 'read-receipt';
  data:  {from: SessionAddress; envelopeIds: string[]};
}
export interface ServerPresence {
  event: 'presence';
  data:  {
    userId: string;
    /**
     * `online` — connected, no active/away hint yet
     * `active` — foreground + interacting
     * `away`   — backgrounded / idle
     * `offline` — no sockets for this user anywhere in the cluster
     */
    state:  'online' | 'active' | 'away' | 'offline';
    /** epoch ms of the last state transition. */
    lastSeenMs?: number;
  };
}

export type ServerFrame =
  | ServerPong
  | ServerEnvelopeAccepted
  | ServerEnvelopeDeliver
  | ServerError
  | ServerCallOffer
  | ServerCallAnswer
  | ServerCallIce
  | ServerCallHangup
  | ServerCallMediaState
  | ServerCallReOffer
  | ServerCallReAnswer
  | ServerTyping
  | ServerReadReceipt
  | ServerPresence;

export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_POLICY       = 4403;
export const WS_CLOSE_HEARTBEAT    = 4408;
