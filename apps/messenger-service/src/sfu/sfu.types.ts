/**
 * mediasoup SFU — protocol shapes shared between server and client.
 *
 * Phase-2 (current): backed by real Router/Transport/Producer/Consumer
 * machinery in `SfuService`. Clients use mediasoup-client's `Device`
 * which expects these exact field names (mirrors mediasoup's RtpParameters
 * / DtlsParameters / IceCandidates verbatim).
 *
 * Security invariants enforced server-side:
 *   - SFU sees SRTP-encrypted media only; plaintext never leaves
 *     mediasoup's RTP routing layer
 *   - Room id is opaque (server-derived from a client-supplied seed +
 *     room nonce); the SFU has no view of which `conversationId` it
 *     corresponds to
 *   - Participant tags are server-assigned ephemeral ids, NOT user
 *     identities — prevents the SFU access log from leaking group
 *     membership
 */

/** Opaque SFU room id — see SfuService.createRoom for derivation. */
export type RoomId = string;

export interface SfuRoom {
  roomId:    RoomId;
  createdAt: number;
  /** Active participant tags (server-assigned opaque ids, NOT userIds). */
  participants: string[];
}

/**
 * Audit P0-C2 / row #5 — DTO returned by `POST /sfu/rooms`. Same shape
 * as `SfuRoom` plus a `hostRoomToken` minted for the requesting caller
 * so they can call `sfu.join` with a verifiable token. Without this
 * field the host would fail the join gate on prod configs where
 * `SFU_ROOM_TOKEN_SECRET` is set.
 */
export interface SfuRoomCreated extends SfuRoom {
  hostRoomToken: string;
  hostRoomTokenExp: number;
}

/**
 * Transport params the RN client feeds into
 * mediasoup-client's `Device.createSendTransport` / `Device.createRecvTransport`.
 *
 * `unknown` here is intentional — these are forwarded verbatim from
 * mediasoup's `WebRtcTransport.{iceParameters,iceCandidates,dtlsParameters,sctpParameters}`.
 * The client casts back to mediasoup-client's `TransportOptions`.
 */
export interface SfuTransportParams {
  id:              string;
  iceParameters:   unknown;
  iceCandidates:   unknown[];
  dtlsParameters:  unknown;
  sctpParameters?: unknown;
}

/**
 * RTP capabilities advertised by the SFU router — clients load them
 * via `Device.load({routerRtpCapabilities})` before creating
 * transports. See mediasoup `Router.rtpCapabilities`.
 */
export interface SfuRouterRtpCapabilities {
  codecs:           unknown[];
  headerExtensions: unknown[];
}

// ─── Client → server frames ──────────────────────────────────────────

export interface ClientSfuJoin {
  event: 'sfu.join';
  data: {
    roomId:     RoomId;
    /**
     * Audit P0-C2 / row #5 — per-recipient HMAC token that proves the
     * caller was invited to this specific room. Minted in `sfu.ring`
     * (carried in `sfu.ring.incoming.roomToken`) and in `POST /sfu/
     * rooms` (as `hostRoomToken`). When the server has
     * `SFU_ROOM_TOKEN_SECRET` configured, the join is rejected unless
     * the token verifies. Optional for dev/test setups; production
     * deployments must set the secret.
     */
    roomToken?: string;
  };
}

export interface ClientSfuConnectTransport {
  event: 'sfu.transport.connect';
  data: {
    roomId:         RoomId;
    transportId:    string;
    dtlsParameters: unknown;
  };
}

export interface ClientSfuProduce {
  event: 'sfu.produce';
  data: {
    roomId:        RoomId;
    transportId:   string;
    kind:          'audio' | 'video';
    rtpParameters: unknown;
  };
}

export interface ClientSfuConsume {
  event: 'sfu.consume';
  data: {
    roomId:           RoomId;
    transportId:      string;
    producerId:       string;
    rtpCapabilities:  unknown;
  };
}

export interface ClientSfuConsumerResume {
  event: 'sfu.consumer.resume';
  data:  {roomId: RoomId; consumerId: string};
}

/**
 * Owner pauses/resumes their OWN producer (camera toggled off/on
 * mid-call). Ownership is enforced — the producer must live in the
 * caller's own producer map — and resume refuses a producer the HOST
 * paused (S6 mute: a self-resume would be an unmute bypass). The
 * service fans `sfu.producer-paused` / `sfu.producer-resumed` to the
 * room so peers deterministically swap the tile to its avatar
 * placeholder instead of freezing on the last decoded frame.
 */
export interface ClientSfuProducerPause {
  event: 'sfu.producer.pause';
  data:  {roomId: RoomId; producerId: string};
}

export interface ClientSfuProducerResume {
  event: 'sfu.producer.resume';
  data:  {roomId: RoomId; producerId: string};
}

/**
 * Reconcile query — the client asks for the authoritative producer set
 * it should be consuming so it can recover a missed `sfu.new-producer`
 * frame or a retry-exhausted consume. Read-only.
 */
export interface ClientSfuListProducers {
  event: 'sfu.producers';
  data:  {roomId: RoomId};
}

export interface ClientSfuLeave {
  event: 'sfu.leave';
  data:  {roomId: RoomId};
}

/**
 * Ring everyone in a group conversation. The server fans
 * `sfu.ring.incoming` to each `recipientUserIds` entry's userRoom and
 * fires a VoIP push wake for each so offline devices ring too.
 *
 * `recipientUserIds` is supplied by the caller because the server has
 * no view of group membership (groups are end-to-end encrypted). This
 * is purely a notification routing list — no permission elevation.
 *
 * The room is created BEFORE this frame fires; the caller has already
 * called `POST /sfu/rooms` and joined.
 */
export interface ClientSfuRing {
  event: 'sfu.ring';
  data: {
    roomId:           RoomId;
    /** Conversation that owns this call — used for chat history bubble + dedupe. */
    conversationId:   string;
    callType:         'voice' | 'video';
    /** Display name to show in the recipient's incoming-call UI. */
    callerName:       string;
    /** Userids to ring. Empty = nobody (no-op). */
    recipientUserIds: string[];
  };
}

/**
 * Caller cancels before anyone joined.
 *
 * Audit row #5 (C2) — `roomToken` is the host's self-token (minted at
 * `POST /sfu/rooms`). Without it any authed user could spam
 * `sfu.ring.cancelled` for someone else's room and force every
 * recipient's IncomingGroupCallScreen to self-dismiss. The gateway
 * verifies the token binds (roomId, caller) AND that caller equals
 * `SfuService.hostOf(roomId)`.
 */
export interface ClientSfuRingCancel {
  event: 'sfu.ring.cancel';
  data: {
    roomId:           RoomId;
    conversationId:   string;
    recipientUserIds: string[];
    roomToken?:       string;
  };
}

/**
 * Recipient declines the ring. Fans to other recipients + caller.
 *
 * Audit row #5 (C2) — `roomToken` is the recipient's ring token
 * (received in `sfu.ring.incoming.roomToken`). Without it any authed
 * user could fake-decline rings they never received, confusing the
 * host's UI and leaking who-is-in-which-call inferences from timing.
 */
export interface ClientSfuRingDecline {
  event: 'sfu.ring.decline';
  data: {
    roomId:         RoomId;
    conversationId: string;
    roomToken?:     string;
  };
}

/**
 * Host-only: pause/resume the target's audio producers server-side.
 *
 * Round 5 / Security S6 — actually pauses the mediasoup Producer (RTP
 * stops at the SFU) so a patched client can't ignore the mute. Also
 * emits `sfu.muted` to the target so their UI flips the indicator.
 * The default action mutes; pass `unmute: true` to resume the
 * previously host-paused producers.
 */
export interface ClientSfuMuteTarget {
  event: 'sfu.mute-target';
  data:  {roomId: RoomId; targetTag: string; unmute?: boolean};
}

/** Host-only: kick a participant out. Server closes their transports. */
export interface ClientSfuKick {
  event: 'sfu.kick';
  data:  {roomId: RoomId; targetTag: string};
}

export type SfuClientFrame =
  | ClientSfuJoin
  | ClientSfuConnectTransport
  | ClientSfuProduce
  | ClientSfuConsume
  | ClientSfuConsumerResume
  | ClientSfuListProducers
  | ClientSfuLeave
  | ClientSfuRing
  | ClientSfuRingCancel
  | ClientSfuRingDecline
  | ClientSfuMuteTarget
  | ClientSfuKick;

// ─── Server → client frames ──────────────────────────────────────────

export interface ServerSfuJoined {
  event: 'sfu.joined';
  data: {
    roomId:                RoomId;
    routerRtpCapabilities: SfuRouterRtpCapabilities;
    participantTag:        string;
    sendTransport:         SfuTransportParams;
    recvTransport:         SfuTransportParams;
    /** Producers already in the room — client immediately consumes each. */
    existingProducers: Array<{producerId: string; participantTag: string; kind: 'audio' | 'video'}>;
  };
}

export interface ServerSfuParticipantJoined {
  event: 'sfu.participant.joined';
  data:  {roomId: RoomId; participantTag: string};
}

export interface ServerSfuParticipantLeft {
  event: 'sfu.participant.left';
  data:  {roomId: RoomId; participantTag: string};
}

/**
 * Host-initiated room termination. Fired by the server when the host
 * leaves the room — every remaining participant gets this frame and
 * tears their session down (closes consumers/transports, drops the
 * UI). Without this event, the host's `sfu.leave` only triggers a
 * per-participant `sfu.participant.left` for the host's tag, leaving
 * the rest of the room talking to each other in a hostless ghost
 * room. WhatsApp/Zoom semantics: when the host ends a call, EVERYONE
 * drops out.
 *
 * `reason`:
 *   - 'host_left'   — host pressed End (most common)
 *   - 'host_kicked' — admin/server-side terminated the room (future)
 *   - 'worker_died' — the mediasoup Worker backing this room's Router
 *                     died; the room + its Router are gone server-side,
 *                     so clients must tear down and re-create/re-join a
 *                     fresh room on a healthy worker.
 */
export interface ServerSfuRoomEnded {
  event: 'sfu.room.ended';
  data:  {
    roomId: RoomId;
    reason: 'host_left' | 'host_kicked' | 'worker_died';
  };
}

export interface ServerSfuNewProducer {
  event: 'sfu.new-producer';
  data: {
    roomId:         RoomId;
    producerId:     string;
    participantTag: string;
    kind:           'audio' | 'video';
  };
}

/** Producer owner toggled their camera/mic off (paused) or back on. */
export interface ServerSfuProducerPaused {
  event: 'sfu.producer-paused' | 'sfu.producer-resumed';
  data: {
    roomId:         RoomId;
    producerId:     string;
    participantTag: string;
    kind:           'audio' | 'video';
  };
}

export interface ServerSfuProduced {
  event: 'sfu.produced';
  data:  {roomId: RoomId; producerId: string};
}

export interface ServerSfuConsumed {
  event: 'sfu.consumed';
  data: {
    roomId:         RoomId;
    consumerId:     string;
    producerId:     string;
    kind:           'audio' | 'video';
    rtpParameters:  unknown;
    participantTag: string;
  };
}

export interface ServerSfuTransportConnected {
  event: 'sfu.transport.connected';
  data:  {roomId: RoomId; transportId: string};
}

export interface ServerSfuError {
  event: 'sfu.error';
  data:  {code: string; message: string};
}

/**
 * Pushed to recipients of `sfu.ring`. The recipient app shows the
 * incoming-call screen and can join the room with the supplied roomId.
 * `from` carries the caller's userId so the receiver can map it to a
 * contact display; `callerName` is the caller-supplied label as a fast
 * fallback.
 */
export interface ServerSfuRingIncoming {
  event: 'sfu.ring.incoming';
  data: {
    roomId:         RoomId;
    conversationId: string;
    callType:       'voice' | 'video';
    from:           {userId: string; deviceId: number};
    callerName:     string;
    /**
     * Audit P0-C2 / row #5 — per-recipient HMAC room-access token.
     * Recipient must echo this back in `sfu.join.roomToken`. Server
     * mints with a 30-minute TTL — long enough for push delivery,
     * iOS PushKit / Android Doze thaw, ICE gather; short enough that
     * a captured ring frame has bounded utility. Empty string when
     * the server has not configured `SFU_ROOM_TOKEN_SECRET`.
     */
    roomToken:      string;
    roomTokenExp:   number;
  };
}

/** Pushed to all ringers when the caller cancels. */
export interface ServerSfuRingCancelled {
  event: 'sfu.ring.cancelled';
  data:  {roomId: RoomId; conversationId: string};
}

/** Pushed to peer ringers + caller when one recipient declines. */
export interface ServerSfuRingDeclined {
  event: 'sfu.ring.declined';
  data:  {roomId: RoomId; conversationId: string; from: {userId: string; deviceId: number}};
}

/** Pushed to a target client by host action. Client self-mutes audio. */
export interface ServerSfuMuted {
  event: 'sfu.muted';
  data:  {roomId: RoomId; byTag: string};
}

/** Pushed to a kicked client. Client tears its session down + leaves. */
export interface ServerSfuKicked {
  event: 'sfu.kicked';
  data:  {roomId: RoomId; byTag: string};
}

export type SfuServerFrame =
  | ServerSfuJoined
  | ServerSfuParticipantJoined
  | ServerSfuParticipantLeft
  | ServerSfuRoomEnded
  | ServerSfuNewProducer
  | ServerSfuProduced
  | ServerSfuConsumed
  | ServerSfuTransportConnected
  | ServerSfuError
  | ServerSfuRingIncoming
  | ServerSfuRingCancelled
  | ServerSfuRingDeclined
  | ServerSfuMuted
  | ServerSfuKicked;
