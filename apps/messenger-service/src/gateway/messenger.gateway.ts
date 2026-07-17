import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import {Logger, Injectable, OnModuleInit, OnModuleDestroy} from '@nestjs/common';
import type {Server, Socket} from 'socket.io';
import {randomUUID} from 'node:crypto';
import {JwtService, type AccessClaims} from '../auth/jwt.service';
import {ConnectionRegistry, type Connection} from './connection-registry';
import {SocketHub} from './socket-hub';
import {PresenceService, type PresenceState} from './presence.service';
import {EnvelopeService} from '../relay/envelope.service';
import {PushService} from '../push/push.service';
import {RedisService} from '../redis/redis.service';
import {SfuService} from '../sfu/sfu.service';
import {RoomTokenService} from '../sfu/room-token.service';
import {UserPrivacyService} from '../users/user-privacy.service';
import {WsRateLimiter, DEFAULT_WS_LIMITS, type RateLimit} from './ws-rate-limiter';
import type {
  ClientSfuJoin, ClientSfuConnectTransport, ClientSfuProduce,
  ClientSfuConsume, ClientSfuConsumerResume, ClientSfuLeave,
  ClientSfuRing, ClientSfuRingCancel, ClientSfuRingDecline,
  ClientSfuMuteTarget, ClientSfuKick,
  ClientSfuProducerPause, ClientSfuProducerResume,
} from '../sfu/sfu.types';
import {
  type CallOfferAuthBlock,
  type ClientCallAnswer,
  type ClientCallHangup,
  type ClientCallIce,
  type ClientCallMediaState,
  type ClientCallOffer,
  type ClientCallReAnswer,
  type ClientCallReOffer,
  type ClientEnvelopeAck,
  type ClientEnvelopePull,
  type ClientEnvelopeSend,
  type ClientPing,
  type ClientPresence,
  type ClientPresenceSubscribe,
  type ClientPresenceUnsubscribe,
  type ClientReadReceipt,
  type ClientTyping,
  type ServerCallAnswer,
  type ServerCallHangup,
  type ServerCallIce,
  type ServerCallMediaState,
  type ServerCallOffer,
  type ServerCallReAnswer,
  type ServerCallReOffer,
  type ServerEnvelopeAccepted,
  type ServerEnvelopeDeliver,
  type ServerError,
  type ServerPresence,
  type ServerReadReceipt,
  type ServerTyping,
} from './protocol';

/**
 * Per-socket session context captured by the handshake middleware after
 * JWT verification. Stored on `socket.data` so it survives socket.io's
 * connection-state recovery (which replays missed packets on reconnect).
 */
interface SocketContext {
  claims:         AccessClaims;
  signalDeviceId: number;
  sessionId:      string;
}

/**
 * 1:1 P2P call lifecycle the gateway tracks for auth + cleanup. A call
 * is created on the first `call.offer` (state='ringing') and ends on
 * `call.hangup` from either participant or on socket disconnect. After
 * end, a tombstone (state='ended', `endedAt` set) is retained for
 * `CALL_TOMBSTONE_TTL_MS` so a delayed duplicate offer for the same
 * callId is rejected as "already ended". Both participants are pinned
 * at offer time — late `call.*` frames from a third userId are dropped
 * with auth_failed.
 */
type CallSessionState = 'ringing' | 'active' | 'ended';
interface CallSession {
  callId:    string;
  caller:    {userId: string; deviceId: number};
  callee:    {userId: string; deviceId: number};
  state:     CallSessionState;
  createdAt: number;
  endedAt?:  number;
}

/** Typing auto-stop window — longer than a keystroke burst, shorter than a pause. */
const TYPING_TIMEOUT_MS = 6_000;

/**
 * Compact constructor for SFU error results returned over socket.io acks.
 *
 * Audit SFU-01 (2026-07-02): this MUST NOT carry an `event` property. The
 * NestJS socket.io adapter treats any handler return value with an `event`
 * key as a WsResponse and EMITS it, returning before invoking the ack
 * callback — so the client's `emitWithAck` never resolves and every SFU
 * error surfaced as a 15s `ack_timeout` instead of the real reason (this is
 * what made the group video-toggle failure impossible to diagnose). The
 * result is now an event-less `{ok:false, data:{...}}` so NestJS invokes the
 * ack; the client rejects on `ok === false`. The `data.{code,message}` shape
 * is preserved so both old and new clients parse the message the same way.
 */
function sfuError(message: string, code = 'sfu_error'): {ok: false; data: {code: string; message: string}} {
  return {ok: false, data: {code, message}};
}

/**
 * socket.io room names for SFU fanout. Participants join both at
 * `sfu.join`: `sfu:<roomId>` for room broadcasts and `sfutag:<tag>` for
 * self-addressed frames. Routing through named rooms (not raw Socket
 * refs) lets the Redis adapter deliver across pods — see bindFanout.
 */
function sfuRoom(roomId: string): string { return `sfu:${roomId}`; }
function sfuTagRoom(tag: string): string { return `sfutag:${tag}`; }

/**
 * Diagnostic SDP dumper — emits a one-line summary per m-line (kind, mid,
 * direction, ssrc count, msid presence) followed by the full SDP fenced
 * between BEGIN/END markers so it can be greppped out of `docker logs`.
 *
 * Direction is the load-bearing field for the video-call diagnosis: an
 * answer with `a=recvonly` on the video m-line means the answerer's
 * sender stayed dormant and no media will flow back.
 */
function dumpSdp(label: 'OFFER' | 'ANSWER' | 'RE-OFFER' | 'RE-ANSWER', callId: string, sdp: string | undefined): void {
  if (!sdp) {
    console.log(`[CALL][SDP] ${label} cid=${callId} (empty)`);
    return;
  }
  const lines = sdp.split(/\r?\n/);
  let curMedia: string | null = null;
  let curMid: string | null = null;
  let curDir: string | null = null;
  let curSsrcs = 0;
  let curHasMsid = false;
  const flush = () => {
    if (curMedia) {
      console.log(`[CALL][SDP] ${label} cid=${callId} kind=${curMedia} mid=${curMid ?? '?'} dir=${curDir ?? '?'} ssrcs=${curSsrcs} msid=${curHasMsid ? 'y' : 'n'}`);
    }
  };
  for (const line of lines) {
    if (line.startsWith('m=')) {
      flush();
      curMedia = line.slice(2).split(' ')[0] ?? null;
      curMid = null; curDir = null; curSsrcs = 0; curHasMsid = false;
    } else if (line.startsWith('a=mid:')) {
      curMid = line.slice(6).trim();
    } else if (line.startsWith('a=sendrecv') || line.startsWith('a=sendonly') ||
               line.startsWith('a=recvonly') || line.startsWith('a=inactive')) {
      curDir = line.slice(2).split('\r')[0].trim();
    } else if (line.startsWith('a=ssrc:')) {
      curSsrcs += 1;
    } else if (line.startsWith('a=msid:')) {
      curHasMsid = true;
    }
  }
  flush();
  // Round 2 / PII audit: do NOT log the full SDP to docker logs — it
  // exposes both peers' private IPs, port-reflexive ICE candidates,
  // and ufrag/password to anyone with `docker logs` access. Keep the
  // per-m-line summary above (which is enough to diagnose direction
  // bugs without leaking network topology) and gate the verbose dump
  // behind an explicit `BRAVO_DUMP_SDP=1` env-var so devs can opt in
  // when they need the full body for a deep diagnosis.
  if (process.env.BRAVO_DUMP_SDP === '1') {
    console.log(`[CALL][SDP] ${label} cid=${callId} === SDP BEGIN ===\n${sdp}\n[CALL][SDP] ${label} cid=${callId} === SDP END ===`);
  }
}

@Injectable()
@WebSocketGateway({
  path: '/ws',
  // Audit Transport P0-4 — CORS is enforced by RedisIoAdapter.createIOServer
  // using the same allowlist as HTTP (cors.origins config). We disable the
  // decorator-level cors here so Nest does not merge a permissive default
  // that overrides the adapter's allowlist. Mobile (no Origin header) is
  // allowed by the adapter's origin callback; browser origins must match
  // CORS_ORIGINS env var or be denied.
  cors: false,
})
export class MessengerGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(MessengerGateway.name);

  /**
   * Pending typing auto-stop timers keyed by `${from}->${to}`. Socket.io
   * typing frames are ephemeral and can be lost; without a timer we'd
   * leave the "… is typing" indicator stuck forever if the sender's
   * `stop` frame drops. The timer guarantees the indicator self-clears.
   */
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Audit P0-5 — per-(socket, event) WS rate limiter. Token-bucket so
   * a single authed socket cannot pump `envelope.send` / `call.*` in a
   * tight loop and DoS the relay (same threat surface as HTTP, where
   * `@nestjs/throttler` covers it). One shared instance: per-socket
   * buckets live in a WeakMap keyed by the socket itself, so disconnect
   * garbage-collects them automatically.
   */
  private readonly wsRateLimiter = new WsRateLimiter();

  @WebSocketServer() server!: Server;

  /**
   * Track which socket each SFU participant tag belongs to so the
   * gateway can fanout `sfu.*` server frames to the right connection.
   * Also tracks tag → roomId so a socket disconnect can leave the
   * room cleanly without the participant having to send sfu.leave.
   */
  private readonly sfuTagToSocket = new Map<string, Socket>();
  private readonly sfuSocketTags  = new WeakMap<Socket, Set<string>>();
  // Audit SFU-04 — pending leave-grace timers per SFU tag. On a socket drop we
  // DELAY the mediasoup teardown so a transient blip / socket.io recovery /
  // quick reconnect doesn't kill the user's media mid-call. leaveRoom is
  // idempotent and a rejoin within grace is handled by joinRoom's same-user
  // supersede (SFU-05), so a late timer firing is a harmless no-op.
  private readonly sfuLeaveGrace  = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly SFU_LEAVE_GRACE_MS = 10_000;

  /**
   * Per-callId session state for 1:1 P2P calls. Previously the gateway
   * was a pure relay with zero knowledge of who was in which call —
   * which meant:
   *   - a malicious client could send `call.hangup` for someone else's
   *     callId and end any call (no auth);
   *   - a socket disconnect mid-call left the peer waiting 30s for ICE
   *     to time out instead of getting an immediate `bye`;
   *   - duplicate offers for the same callId were silently relayed
   *     (no idempotency).
   *
   * The map is in-memory only (1:1 sessions are short-lived and a
   * gateway restart legitimately ends the call anyway). For multi-pod
   * deployments either pin caller+callee to the same pod via Redis
   * adapter sticky sessions, or promote this to Redis with a 5-min
   * EXpiry. The `endedAt` field is a tombstone — kept for `TOMBSTONE_TTL_MS`
   * after a hangup so a late-arriving duplicate `call.offer` for the
   * same callId is rejected as "already ended" instead of being
   * accepted as a brand-new call (which is the rapid-redial-with-
   * recycled-callId attack surface).
   */
  private readonly callSessions = new Map<string, CallSession>();
  private static readonly CALL_TOMBSTONE_TTL_MS = 60_000;
  /** Tracks callIds owned per socket so handleDisconnect can fire bye. */
  private readonly socketCalls = new WeakMap<Socket, Set<string>>();

  /**
   * P1-BR-5 / B-58 — deferred disconnect-bye timers for CONNECTED 1:1
   * calls, keyed by `${callId}::${userId}::${deviceId}`. A brief WS drop
   * mid-call (Doze fd cut, Wi-Fi↔cellular handover, reconnect churn) must
   * NOT instantly tear the call down; we hold the bye for a grace window
   * so a same-device reconnect can cancel it (mirrors the SFU leave-grace).
   * Only `ringing` sessions still get the immediate bye. In-memory is fine
   * (single-replica deploy; a gateway restart legitimately ends the call).
   */
  private readonly callDisconnectGrace = new Map<string, {timer: ReturnType<typeof setTimeout>; userId: string; deviceId: number; peer: {userId: string; deviceId: number}; callId: string}>();
  private static readonly CALL_DISCONNECT_GRACE_MS = 12_000;

  /** P3-P-1 — one-shot guard so the tokenless-SFU-admit warning isn't spammed. */
  private tokenlessSfuAdmitLogged = false;

  constructor(
    private readonly jwt:       JwtService,
    private readonly registry:  ConnectionRegistry,
    private readonly hub:       SocketHub,
    private readonly presence:  PresenceService,
    private readonly envelopes: EnvelopeService,
    private readonly push:      PushService,
    private readonly sfu:       SfuService,
    private readonly redis:     RedisService,
    private readonly roomToken: RoomTokenService,
    private readonly privacy:   UserPrivacyService,
  ) {
    // Wire SFU → gateway fanout so SfuService can broadcast room
    // events without importing the gateway (which would create a
    // circular dependency).
    // Multi-pod fanout: route SFU frames through socket.io rooms so the
    // Redis adapter delivers them to participants on ANY pod, not just
    // this one. Each participant socket joins `sfutag:<tag>` (self-
    // addressed frames: muted/kicked) and `sfu:<roomId>` (room
    // broadcasts: new-producer, participant.left, etc.) at `sfu.join`.
    // The old path emitted directly on in-memory `sfuTagToSocket` Socket
    // refs, which only exist on the pod that owns the connection — a
    // participant on a different pod silently never received
    // `sfu.new-producer` and their tile never appeared. `server.to(room)`
    // publishes via Redis pub/sub and reaches every replica.
    this.sfu.bindFanout({
      toParticipant: (tag, frame) => {
        this.hub.server
          ?.to(sfuTagRoom(tag))
          .emit((frame as {event: string}).event, (frame as {data?: unknown}).data ?? {});
      },
      toRoom: (roomId, frame, exceptTag) => {
        const emitter = this.hub.server?.to(sfuRoom(roomId));
        if (!emitter) return;
        // `exceptTag` excludes the frame's originator. Their socket is in
        // `sfutag:<exceptTag>`, so excluding that room drops them from the
        // broadcast on every pod (the adapter honours .except across the
        // Redis fanout, same as the typing/presence broadcasts already do).
        (exceptTag ? emitter.except(sfuTagRoom(exceptTag)) : emitter)
          .emit((frame as {event: string}).event, (frame as {data?: unknown}).data ?? {});
      },
    });
  }

  afterInit(server: Server): void {
    this.hub.server = server;

    // Handshake auth — runs before `handleConnection` and rejects bad
    // tokens with socket.io's built-in connect_error path so the client
    // gets a clean error instead of a connected-then-disconnected blip.
    // Note: socket.io's connectionStateRecovery does NOT preserve custom
    // socket.data across recovery, so this middleware ALSO runs on
    // recovery reconnects (skipMiddlewares is false in the adapter) to
    // repopulate socket.data. JWT verify is cheap; without it
    // handleConnection drops every recovered socket as unauthorized.
    server.use(async (socket, next) => {
      const ip = socket.handshake.address;
      try {
        const {token, signalDeviceId, source} = extractHandshakeParams(socket);
        if (!token) {
          this.logger.warn(`[handshake] reject missing_token ip=${ip} src=${source}`);
          return next(handshakeError('missing_token'));
        }
        if (signalDeviceId == null) {
          this.logger.warn(`[handshake] reject missing_signal_device_id ip=${ip} src=${source}`);
          return next(handshakeError('missing_signal_device_id'));
        }
        // Audit P0-T1 — warn (once per connect) when a client still
        // carries the token in the URL. The connection succeeds for
        // rollout compatibility, but every line of this warning is a
        // line that should disappear before we drop the query branch.
        if (source === 'query') {
          this.logger.warn(
            `[P0-T1] handshake_token_via_query — client should move to socket.io auth payload`,
          );
        }
        const claims = await this.jwt.verifyAccessToken(token);
        // Audit P0-6 — JTI revocation check on WS handshake. Mirrors
        // the HTTP JwtHttpGuard: a token revoked at auth-service
        // (logout, remote-wipe, password change) MUST NOT open a new
        // WS session. Previously the WS handshake stopped at signature
        // verification, so a stolen JWT kept opening new sockets for
        // the full 15-min `exp` even after revocation. The redis key
        // is `jti:<jti>`, written by auth-service on issue and DEL'd
        // on revoke; the same key the HTTP guard checks.
        if (!(await this.redis.client.exists(`jti:${claims.jti}`))) {
          this.logger.warn(`[handshake] reject token_revoked ip=${ip} sub=${claims.sub} jti=${claims.jti.slice(0,8)}`);
          return next(handshakeError('token_revoked'));
        }
        const ctx: SocketContext = {claims, signalDeviceId, sessionId: randomUUID()};
        socket.data = ctx;
        next();
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'invalid_token';
        this.logger.warn(`[handshake] reject verify_throw ip=${ip} msg=${msg}`);
        next(handshakeError(msg));
      }
    });

  }

  /**
   * Audit P0-6 — periodic JTI re-validation for ALREADY-CONNECTED
   * sockets. The HTTP guard and WS handshake catch revocation at
   * request/connect time; this closes the long-tail case where a
   * socket opens, the user logs out shortly after, and the existing
   * socket would otherwise drain envelopes for the full `exp` window.
   *
   * Strategy: every `JTI_RECHECK_INTERVAL_MS` we walk every connected
   * socket and EXISTS-check its claims.jti. Sockets whose JTI is gone
   * get a soft disconnect (close=true, server-side) so the client can
   * re-auth with a fresh token on reconnect. EXISTS is sub-ms per
   * key; a 60s cadence keeps the cost negligible at our scale.
   *
   * Pub/sub-style real-time invalidation could shave the worst-case
   * lag from 60s to ~1s but it requires auth-service to publish on
   * every revoke — a cross-service contract we avoid until pressure
   * justifies it. 60s is well within the "user-visible promptness"
   * bar for a remote-wipe / logout-from-other-device flow.
   */
  private readonly jtiRecheckInterval: ReturnType<typeof setInterval> = setInterval(() => {
    void this.recheckAllJtis().catch(e =>
      this.logger.warn(`[P0-6] jti recheck failed: ${(e as Error).message}`),
    );
  }, 60_000);

  private async recheckAllJtis(): Promise<void> {
    if (!this.server) return;
    const sockets = await this.server.fetchSockets();
    if (sockets.length === 0) return;
    // Batch the EXISTS lookups via pipeline so N sockets cost ~1 RTT.
    const ctxs: {jti: string; sid: string; sock: typeof sockets[number]}[] = [];
    const pipe = this.redis.client.pipeline();
    for (const sock of sockets) {
      const ctx = sock.data as SocketContext | undefined;
      if (!ctx?.claims?.jti) continue;
      ctxs.push({jti: ctx.claims.jti, sid: ctx.claims.sub, sock});
      pipe.exists(`jti:${ctx.claims.jti}`);
    }
    if (ctxs.length === 0) return;
    const results = await pipe.exec();
    for (let i = 0; i < ctxs.length; i++) {
      const [err, present] = results?.[i] ?? [null, 0];
      if (err) continue;
      if (present === 0) {
        const {jti, sid, sock} = ctxs[i];
        this.logger.log(`[P0-6] disconnecting revoked socket sub=${sid.slice(0, 8)} jti=${jti.slice(0, 8)}`);
        try { sock.emit('error', {code: 'token_revoked', message: 'session revoked'}); } catch { /* ignore */ }
        try { sock.disconnect(true); } catch { /* ignore */ }
      }
    }
  }

  /** Audit P0-6 — clear the recheck interval on module destroy. */
  onModuleDestroy(): void {
    clearInterval(this.jtiRecheckInterval);
    // P1-BR-5 — drop any pending disconnect-bye timers so they can't fire
    // after teardown (also keeps Jest from leaking open handles).
    for (const {timer} of this.callDisconnectGrace.values()) clearTimeout(timer);
    this.callDisconnectGrace.clear();
  }

  // Why: previously bootstrapMissionEventsSubscriber() ran inside
  // afterInit, which fires when the WS server starts — that happens
  // BEFORE Nest's onModuleInit has finished resolving every provider,
  // so `this.redis.client` was still undefined and `.duplicate()` threw.
  // Moving the bootstrap to onModuleInit (which Nest guarantees runs
  // AFTER every constructor-injected dependency's own onModuleInit
  // resolves) closes the race without polling.
  async onModuleInit(): Promise<void> {
    // Audit fix 5.1 — bridge auth-service `mission:events` pub/sub to
    // socket.io rooms. A dedicated subscriber connection (NOT the main
    // ioredis client — once subscribed, ioredis can't run other
    // commands on the same connection) listens for mission lifecycle
    // frames and re-emits to the matching `mission:<id>` room. The
    // socket.io Redis adapter (cluster-wide) handles cross-pod fanout.
    this.bootstrapMissionEventsSubscriber().catch(e => {
      this.logger.error(`mission-events subscriber init failed: ${(e as Error).message}`);
    });
  }

  /**
   * Audit fix 5.1 — Redis subscriber for `mission:events`. Re-emits
   * each frame to the matching `mission:<id>` socket.io room. Designed
   * to survive Redis disconnects (ioredis auto-reconnects, and the
   * subscription persists across the reconnect).
   */
  private async bootstrapMissionEventsSubscriber(): Promise<void> {
    const sub = this.redis.client.duplicate();
    sub.on('error', err => this.logger.warn(`mission-events subscriber error: ${err.message}`));
    sub.on('message', (channel: string, raw: string) => {
      if (channel !== 'mission:events') return;
      try {
        const frame = JSON.parse(raw) as {missionId: string; event: string; data: unknown; ts: number};
        if (!frame.missionId || !frame.event) return;
        this.server.to(`mission:${frame.missionId}`).emit(frame.event, {
          missionId: frame.missionId,
          ...((frame.data as object | undefined) ?? {}),
          ts: frame.ts,
        });
      } catch (e) {
        this.logger.warn(`mission-events frame parse failed: ${(e as Error).message}`);
      }
    });
    await sub.subscribe('mission:events');
    this.logger.log('subscribed to mission:events');
  }

  async handleConnection(client: Socket): Promise<void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) {
      // Should be unreachable — middleware populates data before this
      // fires — but defend anyway. Treat as an auth failure.
      try { client.emit('error', {code: 'unauthorized', message: 'missing context'}); } catch { /* ignore */ }
      try { client.disconnect(true); } catch { /* ignore */ }
      return;
    }
    const {claims, signalDeviceId, sessionId} = ctx;

    // Room membership drives cross-node fanout through the Redis adapter.
    await client.join([
      this.hub.deviceRoom({userId: claims.sub, deviceId: signalDeviceId}),
      this.hub.userRoom(claims.sub),
    ]);

    const conn: Connection = {
      userId:       claims.sub,
      deviceId:     signalDeviceId,
      socket:       client,
      sessionId,
      authDeviceId: claims.deviceId,
      lastSeenMs:   Date.now(),
    };
    const superseded = this.registry.add(conn);

    // P1-BR-5 — a reconnect within the disconnect-grace window cancels any
    // deferred bye for this (user, device) so a live call survives a brief blip.
    this.cancelCallDisconnectByes(claims.sub, signalDeviceId);

    // Presence — only flip to `online` when this is the first device
    // for the user across the whole cluster. If other devices are
    // already connected we leave the existing state alone so a user on
    // their phone (active) doesn't get clobbered by their tablet
    // reconnecting.
    //
    // B-11 — skip the INCR entirely on a single-device takeover. The
    // evicted socket already counted this (user, device) slot and its
    // `onDisconnect` is skipped (presence audit fix #4), so a second
    // INCR here leaks the counter and pins the user `online` forever
    // even after every device has dropped.
    if (!superseded && await this.presence.onConnect(claims.sub)) {
      await this.presence.set(claims.sub, 'online');
    }

    // Keep `lastSeenMs` fresh for telemetry; engine.io handles real
    // liveness via ping/pong. `onAny` gives us every inbound frame.
    client.onAny(() => this.registry.touch(claims.sub, signalDeviceId));

    this.logger.log(`ws open sub=${claims.sub} signalDev=${signalDeviceId} recovered=${client.recovered ? 'yes' : 'no'}`);

    // Auto-drain queued envelopes on connect. Without this, clients
    // that came online while messages were piling up in Redis would
    // need to remember to call `envelope.pull` themselves — which
    // every webclient/agent has historically been getting wrong, with
    // the result that "I sent a message but nothing arrived" happens
    // any time the recipient was offline at send time. Server-pushing
    // the backlog removes the dependency on client wiring.
    void this.flushPendingOnConnect(client, {userId: claims.sub, deviceId: signalDeviceId});
    void this.deliverPendingCallOffer(client, {userId: claims.sub, deviceId: signalDeviceId});
    // P2-BR-9 — replay any group-call ring queued while this user was offline
    // (live ring if within the 45s window, else a missed-group-call record).
    void this.deliverPendingGroupRing(client, {userId: claims.sub});
    // Audit RELAY-C3 — replay any delivered ("double-tick") receipts that
    // couldn't reach this sender while they were offline.
    void this.envelopes.flushPendingDelivered({userId: claims.sub, deviceId: signalDeviceId});
  }

  /**
   * If a caller hit `peer_offline` for this user recently, the offer
   * was stashed in Redis with a short TTL. Drain it on connect so the
   * callee's UI rings the moment they come back online — even if the
   * VoIP push that woke them only carried the wake-up signal, not the
   * SDP. Best-effort: failures don't block other connect-time work.
   */
  private async deliverPendingCallOffer(
    client: Socket,
    address: {userId: string; deviceId: number},
  ): Promise<void> {
    try {
      // Drain the SET of queued callIds for this device. The earlier
      // single-slot key silently overwrote the first caller when a
      // second caller dialed within 45s — they saw nothing while their
      // target rang for the second caller. Now we replay every queued
      // offer in arrival order.
      const idxKey = pendingOfferIndexKey(address.userId, address.deviceId);
      const callIds = await this.redis.client.smembers(idxKey);
      if (!callIds || callIds.length === 0) return;
      // SREM the entire index up-front so a parallel reconnect on
      // another socket doesn't double-deliver.
      await this.redis.client.del(idxKey);
      // Read each offer payload and replay in chronological order.
      const records: PendingCallOffer[] = [];
      for (const cid of callIds) {
        const key = pendingOfferKey(address.userId, address.deviceId, cid);
        const markerKey = missedCallMarkerKey(address.userId, address.deviceId, cid);
        try {
          const raw = await this.redis.client.get(key);
          await this.redis.client.del(key);
          if (raw) {
            const parsed = JSON.parse(raw) as PendingCallOffer;
            const ageSec = (Date.now() - parsed.at) / 1000;
            if (ageSec <= 45) {
              // Fresh, live offer — replay it and drop the missed-marker: the
              // callee is getting the call live now (an answer will follow).
              await this.redis.client.del(markerKey);
              records.push(parsed);
              continue;
            }
          }
          // N-02 — no live offer (expired, or the caller hung up and we purged
          // the payload but kept the marker). If a missed-marker survives, the
          // callee genuinely missed the call: emit `call.missed` so they get a
          // "Missed call" record. This replaces the old payload-based emit,
          // which was dead code (the 45s payload had always expired by the time
          // its age crossed the >45s threshold that would have emitted it).
          const markerRaw = await this.redis.client.get(markerKey);
          await this.redis.client.del(markerKey);
          if (markerRaw) {
            const m = JSON.parse(markerRaw) as MissedCallMarker;
            client.emit('call.missed', {callId: m.callId, from: m.from, kind: m.kind, at: m.at});
          }
        } catch { /* skip malformed entry */ }
      }
      records.sort((a, b) => a.at - b.at);
      for (const parsed of records) {
        const ageSec = (Date.now() - parsed.at) / 1000;
        this.logger.log(`replay pending offer cid=${parsed.callId.slice(0, 8)} → ${address.userId.slice(0, 8)}/${address.deviceId} age=${ageSec.toFixed(1)}s`);
        client.emit('call.offer', {
          callId: parsed.callId,
          from:   parsed.from,
          sdp:    parsed.sdp,
          kind:   parsed.kind,
          // Audit S7 — replay the same signed AAD the caller minted; the
          // receiver verifies via verifyCallOfferAuth.
          auth:   parsed.auth,
        });
      }
    } catch (e) {
      this.logger.warn(`pending-offer replay failed: ${(e as Error).message}`);
    }
  }

  /**
   * P2-BR-9 — drain queued group-call rings for this user on connect. A ring
   * within the 45s window is replayed as a live `sfu.ring.incoming`; anything
   * older surfaces a `sfu.ring.missed` record from the 6h marker. The group
   * analogue of `deliverPendingCallOffer` (device-agnostic: group rings target
   * userIds, so the first device to reconnect drains the shared per-user set).
   */
  private async deliverPendingGroupRing(
    client: Socket,
    address: {userId: string},
  ): Promise<void> {
    try {
      const idxKey = pendingGroupRingIndexKey(address.userId);
      const roomIds = await this.redis.client.smembers(idxKey);
      if (!roomIds || roomIds.length === 0) return;
      // SREM the whole index up-front so a parallel reconnect doesn't double-drain.
      await this.redis.client.del(idxKey);
      const fresh: PendingGroupRing[] = [];
      for (const rid of roomIds) {
        const key = pendingGroupRingKey(address.userId, rid);
        const markerKey = missedGroupCallMarkerKey(address.userId, rid);
        try {
          const raw = await this.redis.client.get(key);
          await this.redis.client.del(key);
          if (raw) {
            const parsed = JSON.parse(raw) as PendingGroupRing;
            if ((Date.now() - parsed.at) / 1000 <= 45) {
              // Fresh, live ring — replay it and drop the missed-marker.
              await this.redis.client.del(markerKey);
              fresh.push(parsed);
              continue;
            }
          }
          // No live ring (expired or host-cancelled) — surface the missed record.
          const markerRaw = await this.redis.client.get(markerKey);
          await this.redis.client.del(markerKey);
          if (markerRaw) {
            const m = JSON.parse(markerRaw) as MissedGroupCallMarker;
            client.emit('sfu.ring.missed', {
              roomId: m.roomId, conversationId: m.conversationId, from: m.from, callType: m.callType, at: m.at,
            });
          }
        } catch { /* skip malformed entry */ }
      }
      fresh.sort((a, b) => a.at - b.at);
      for (const parsed of fresh) {
        this.logger.log(`replay pending group-ring rid=${parsed.roomId.slice(0, 8)} → ${address.userId.slice(0, 8)}`);
        client.emit('sfu.ring.incoming', {
          roomId:         parsed.roomId,
          conversationId: parsed.conversationId,
          callType:       parsed.callType,
          from:           parsed.from,
          callerName:     parsed.callerName,
          roomToken:      parsed.roomToken,
          roomTokenExp:   parsed.roomTokenExp,
        });
      }
    } catch (e) {
      this.logger.warn(`pending group-ring replay failed: ${(e as Error).message}`);
    }
  }

  /** P2-BR-9 — remove a queued group ring (payload, marker, index) for one target. */
  private async clearPendingGroupRingArtifacts(userId: string, roomId: string): Promise<void> {
    try {
      await this.redis.client.del(pendingGroupRingKey(userId, roomId));
      await this.redis.client.del(missedGroupCallMarkerKey(userId, roomId));
      await this.redis.client.srem(pendingGroupRingIndexKey(userId), roomId);
    } catch { /* best effort */ }
  }

  /**
   * On a freshly-connected socket, pull every pending envelope for
   * the (userId, deviceId) and emit them as `envelope.deliver` frames.
   * The client's existing inbound handler ACKs each via `envelope.ack`,
   * which removes them from Redis. Best-effort: any error is logged
   * and the client can still call `envelope.pull` explicitly to retry.
   *
   * Round 7 / crypto audit fix F1+F2 — previously this used a hard-
   * coded `limit=200` with no bootstrap flag. The relay clamps non-
   * bootstrap pulls to `relay.maxPullLimit` (default 100), so
   * recipients with >100 queued envelopes silently lost the rest until
   * they explicitly hit `envelope.pull` (which clients don't do
   * automatically because the connect-flush conditioned them not to).
   * Now we pass `{bootstrap:true}` to lift the cap to
   * `relay.maxBootstrapLimit` (default 1000) AND paginate until the
   * server has nothing left to deliver.
   */
  private async flushPendingOnConnect(
    client: Socket,
    address: {userId: string; deviceId: number},
  ): Promise<void> {
    const PAGE_SIZE = 1000;
    const MAX_PAGES = 20; // 20k envelopes ceiling; symptomatic of a stuck-ack loop beyond that.
    try {
      let total = 0;
      let after = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const pending = await this.envelopes.pull(address, after, PAGE_SIZE, {bootstrap: true});
        if (pending.length === 0) break;
        for (const env of pending) {
          // Why: pass JUST the inner payload as socket.io's data arg.
          // The two other emit sites (tryFanOut, envelope.pull handler)
          // already do `emit(event, frame.data)`. Previously this site
          // passed the WHOLE ServerEnvelopeDeliver wrapper, so the
          // client's onAny handler rebuilt `{event, data:{event, data:{...}}}`
          // and every catch-up envelope arrived with `data.envelopeId`
          // undefined — handleDeliver's unwrap step then threw
          // "Cannot read property 'slice' of undefined", surfaced as
          // the persistent red banner on the chat surface, and the
          // recipient never rendered any pending message.
          client.emit('envelope.deliver', {
            envelopeId:  env.envelopeId,
            outerSealed: env.outerSealed,
            timestamp:   env.timestamp,
            // Audit P0-N9 — ack token from service.pull (minted or
            // reused) lets the recipient prove possession on ack.
            ackToken:    env.ackToken,
          });
        }
        total += pending.length;
        // Audit P1-T7 — same-ms cursor safety. The relay's
        // zrangebyscore uses an EXCLUSIVE lower bound (`(${after}`),
        // so anything at the EXACT cursor timestamp is skipped on the
        // next page. When a page is full (PAGE_SIZE rows) the very
        // next envelope might share the last ms of this page; if we
        // advance to `last.timestamp` we'd silently drop those rows.
        // Step back by 1ms and rely on the receive-side `seenEnvelopes`
        // dedup (P0-N6) to swallow the resulting overlap. The single-
        // ms overlap is bounded — at most one ms of duplicate IDs per
        // page — and the seen-set lookup is O(1).
        const lastTs = pending[pending.length - 1].timestamp;
        after = pending.length >= PAGE_SIZE ? Math.max(0, lastTs - 1) : lastTs;
        if (pending.length < PAGE_SIZE) break;
      }
      if (total > 0) {
        this.logger.log(`flush ${total} pending envelopes → ${address.userId}/${address.deviceId}`);
      }
    } catch (e) {
      this.logger.warn(`flush failed for ${address.userId}/${address.deviceId}: ${(e as Error).message}`);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return;
    const {claims, signalDeviceId, sessionId} = ctx;

    // Round 7 / presence audit fix #4 — capture whether this disconnect
    // is a real eviction (the session owned the registry slot) or a
    // supersession-driven leftover (a newer sessionId already took
    // over). When a fresh socket replaces us the new connection has
    // already fired `presence.onConnect`, so we must NOT also fire
    // `presence.onDisconnect` — that would DECR back to zero and
    // broadcast a spurious offline → online blip across every watcher.
    const wasLiveOwner = this.registry.remove(claims.sub, signalDeviceId, sessionId);
    this.clearTypingTimersFrom(claims.sub, signalDeviceId);

    // Tear down any SFU participant tags owned by this socket — without
    // this, a reload-mid-call leaves the Router thinking the participant
    // is still in the room and peers keep receiving stale producers.
    const tags = this.sfuSocketTags.get(client);
    if (tags) {
      for (const tag of tags) {
        // Audit SFU-04 — grace before teardown (see sfuLeaveGrace). The dead
        // socket's tag mapping is dropped now, but the mediasoup participant is
        // held for SFU_LEAVE_GRACE_MS so a quick reconnect keeps media alive.
        this.sfuTagToSocket.delete(tag);
        const prev = this.sfuLeaveGrace.get(tag);
        if (prev) clearTimeout(prev);
        const timer = setTimeout(() => {
          this.sfuLeaveGrace.delete(tag);
          void this.sfu.leaveRoom(tag).catch(() => { /* swallow — idempotent */ });
        }, MessengerGateway.SFU_LEAVE_GRACE_MS);
        // Don't keep the event loop alive on this timer alone.
        (timer as unknown as {unref?: () => void}).unref?.();
        this.sfuLeaveGrace.set(tag, timer);
      }
      tags.clear();
    }

    // Fire `call.hangup` to the peer for every active 1:1 call this
    // socket owned. Without this, a flaky-network drop leaves the peer
    // staring at "Connecting…" / "In call" until ICE consent times out
    // (~30s with default RFC 7675 settings). With this, the peer sees
    // "Call ended (failed)" within milliseconds. Cheap fanout — at
    // most 1-2 active calls per socket. Idempotent if the client also
    // sent a final `call.hangup` before disconnect (trackCallEnd is
    // already a no-op on tombstoned sessions).
    const ownedCalls = this.socketCalls.get(client);
    if (ownedCalls) {
      const myUserId = claims.sub;
      const myDeviceId = signalDeviceId;
      for (const callId of ownedCalls) {
        const session = this.callSessions.get(callId);
        if (!session || session.state === 'ended') continue;
        // Identify the peer (the OTHER participant).
        const peer = session.caller.userId === myUserId
          ? session.callee
          : session.caller;
        if (session.state === 'active') {
          // P1-BR-5 / B-58 — a CONNECTED call must survive a brief WS blip.
          // Defer the bye by the grace window; a same-device reconnect cancels
          // it (see handleConnection). Only unanswered `ringing` sessions get
          // the immediate bye so a dropped ring doesn't dangle.
          this.scheduleCallDisconnectBye(callId, {userId: myUserId, deviceId: myDeviceId}, peer);
          continue;
        }
        this.trackCallEnd(callId);
        const target = this.hub.server?.to(this.hub.deviceRoom(peer));
        if (target) {
          target.emit('call.hangup', {
            callId,
            from:   {userId: myUserId, deviceId: myDeviceId},
            reason: 'failed',
          });
          this.logger.log(`[CALL] disconnect-bye cid=${callId.slice(0, 8)} → ${peer.userId.slice(0, 8)}/${peer.deviceId}`);
        }
      }
      ownedCalls.clear();
    }

    // Atomic DECR — flip to `offline` only when this was the user's
    // last active socket across the cluster. Skip entirely when a
    // newer session already evicted us (see fix #4 above) — the new
    // socket's presence.onConnect already maintained the count, so
    // touching it here would underflow.
    if (wasLiveOwner && await this.presence.onDisconnect(claims.sub)) {
      await this.presence.set(claims.sub, 'offline');
    }

    this.logger.log(`ws close sub=${claims.sub} signalDev=${signalDeviceId}`);
  }

  // ─── ping / envelope handlers (unchanged semantics) ─────────────────

  @SubscribeMessage('ping')
  handlePing(
    @MessageBody() data: ClientPing['data'],
    @ConnectedSocket() client: Socket,
  ): {ts: number} {
    const ts = data?.ts ?? Date.now();
    // Why B-05: two clients hit this handler with different needs.
    //  (1) productionRuntime sends fire-and-forget `ping` (transport.send) and
    //      listens for a `pong` EVENT (RTT chip + AppState-resume gating).
    //  (2) useGroupCall sends `ping` via emitWithAck() and needs the socket.io
    //      ACK to resolve, else it ack_timeouts every keepalive cadence.
    // NestJS routes an event-shaped return ({event,data}) to socket.emit() and
    // returns BEFORE invoking the ack — so the old `return {event:'pong',...}`
    // fed (1) but never acked (2). Emit the event explicitly for (1), and
    // return an event-LESS object so Nest invokes the ack for (2).
    client.emit('pong', {ts});
    // Audit WS-MED — refresh the presence liveness counter on the heartbeat so
    // a long-lived foreground socket (> counter TTL) isn't false-reaped to
    // `offline` by the stale sweep. Fire-and-forget; ping must stay cheap.
    const ctx = client.data as SocketContext | undefined;
    if (ctx) void this.presence.touch(ctx.claims.sub).catch(() => { /* best-effort */ });
    return {ts};
  }

  /**
   * Audit fix 5.1 — mission lifecycle subscription.
   *
   * The auth-service publishes mission status/team/telemetry frames
   * to the Redis `mission:events` channel; this gateway listens (see
   * `onModuleInit` below) and re-emits to the `mission:<id>` room.
   * Clients call `mission.subscribe` with the missionId they care
   * about and the gateway joins their socket to that room.
   *
   * Membership guard: ANY authenticated socket can subscribe. The
   * frames carry only state summaries (not message content), and the
   * underlying REST endpoints (which the client uses for the actual
   * payload re-fetch) are already region/role-gated. The subscribe
   * itself is metadata only — knowing "mission X just went LIVE" is
   * not sensitive enough to warrant a second auth round-trip per
   * subscribe.
   *
   * Multiple missions per socket are supported (operator opens 3
   * tabs, each on a different mission). Unsubscribe drops the room
   * membership; full disconnect drops everything automatically.
   */
  /**
   * Audit P0-5 — per-socket WS rate-limit gate. Returns a typed
   * `ServerError` when the (socket, event) bucket is exhausted; the
   * caller returns it directly so socket.io routes it into the
   * standard ack/error channel. Limits live in `DEFAULT_WS_LIMITS`;
   * pass an override only when the call site has a justified looser
   * (or tighter) cadence than the table default.
   *
   * Returns `null` on the happy path so the call site doesn't have to
   * unwrap a discriminated union before continuing.
   */
  private rateGate(socket: Socket, event: string, override?: RateLimit): ServerError | null {
    const limit = override ?? DEFAULT_WS_LIMITS[event];
    if (!limit) return null;
    const result = this.wsRateLimiter.consume(socket, event, limit);
    if (result.ok) return null;
    return {
      event: 'error',
      data:  {
        code:    'rate_limited',
        message: `event ${event} rate-limited; retry in ${result.retryAfterMs}ms`,
      },
    };
  }

  /**
   * Audit MEDIUM-3 (2026-07-02): CLUSTER-GLOBAL per-USER rate limit for the hot
   * abusive verbs. The per-socket WsRateLimiter is in-memory, so a single user
   * amplifies a flood by opening N sockets across N pods. This is a Redis
   * fixed-window counter keyed on (user, verb, minute) — one INCR+EXPIRE per
   * accepted request, enforced across the whole cluster regardless of how many
   * sockets/pods the user spreads across. Fails OPEN on a Redis hiccup (the
   * per-socket limiter still applies) so a transient Redis blip can't lock
   * every user out. Returns true when the caller should REJECT.
   */
  private async userRateExceeded(userId: string, verb: string, perMinute: number): Promise<boolean> {
    try {
      const bucket = Math.floor(Date.now() / 60_000);
      const key = `urate:${verb}:${userId}:${bucket}`;
      const n = await this.redis.client.incr(key);
      if (n === 1) {await this.redis.client.expire(key, 120);}
      return n > perMinute;
    } catch {
      return false; // fail-open — per-socket limiter is still in force
    }
  }

  @SubscribeMessage('mission.subscribe')
  async handleMissionSubscribe(
    @MessageBody() data: {missionId: string},
    @ConnectedSocket() client: Socket,
  ): Promise<{event: 'mission.subscribed'; data: {missionId: string}} | ServerError> {
    const limited = this.rateGate(client, 'mission.subscribe');
    if (limited) return limited;
    if (!data?.missionId || typeof data.missionId !== 'string' || data.missionId.length > 64) {
      return {event: 'error', data: {code: 'bad_request', message: 'invalid_mission_id'}};
    }
    // Audit P1-T3 — per-socket mission subscription cap. The full fix
    // (membership check against auth-service) is tracked separately;
    // until then the cap limits the blast radius of an authed
    // attacker fishing for mission activity. 32 is roomy for legit
    // operators juggling multiple dashboards but well below the
    // thousands-of-rooms-at-once shape of a fishing attack.
    const MAX_MISSIONS_PER_SOCKET = 32;
    const currentMissionRooms = Array.from(client.rooms).filter(r => r.startsWith('mission:')).length;
    if (currentMissionRooms >= MAX_MISSIONS_PER_SOCKET) {
      return {event: 'error', data: {
        code: 'mission_sub_limit',
        message: `socket cap of ${MAX_MISSIONS_PER_SOCKET} mission subscriptions reached`,
      }};
    }
    await client.join(`mission:${data.missionId}`);
    return {event: 'mission.subscribed', data: {missionId: data.missionId}};
  }

  @SubscribeMessage('mission.unsubscribe')
  async handleMissionUnsubscribe(
    @MessageBody() data: {missionId: string},
    @ConnectedSocket() client: Socket,
  ): Promise<{event: 'mission.unsubscribed'; data: {missionId: string}} | ServerError> {
    if (!data?.missionId || typeof data.missionId !== 'string') {
      return {event: 'error', data: {code: 'bad_request', message: 'invalid_mission_id'}};
    }
    await client.leave(`mission:${data.missionId}`);
    return {event: 'mission.unsubscribed', data: {missionId: data.missionId}};
  }

  @SubscribeMessage('envelope.send')
  async handleEnvelopeSend(
    @MessageBody() data: ClientEnvelopeSend['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerEnvelopeAccepted | ServerError> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'envelope.send');
    if (limited) {
      this.logger.warn(`[envelope.send] rate-limited sub=${ctx.claims.sub.slice(0,8)} clientMsgId=${(data?.clientMsgId ?? '?').slice(0,8)}`);
      return limited;
    }
    // MEDIUM-3 — cluster-global per-user cap (defeats multi-socket / multi-pod
    // amplification of the per-socket limit). 600/min = 10/s sustained, well
    // above any human sender, blunts a scripted flood from one account.
    if (await this.userRateExceeded(ctx.claims.sub, 'env', 600)) {
      this.logger.warn(`[envelope.send] user-rate-limited sub=${ctx.claims.sub.slice(0,8)}`);
      return {event: 'error', data: {code: 'rate_limited', message: 'per-user send rate exceeded'}};
    }
    this.logger.log(`[envelope.send] sub=${ctx.claims.sub.slice(0,8)} → ${(data?.to?.userId ?? '?').slice(0,8)}/${data?.to?.deviceId} clientMsgId=${(data?.clientMsgId ?? '?').slice(0,8)}`);
    try {
      const res = await this.envelopes.submitEnvelope({
        recipient:    data.to,
        outerSealed:  data.outerSealed,
        clientMsgId:  data.clientMsgId,
        expiresAtSec: data.expiresAtSec,
        // Audit P0-T6 — pass the submitter so the relay can wire the
        // delivered callback. The submitter address comes from the
        // authenticated WS context — not from any client-supplied
        // field — so it cannot be spoofed by the sender. NOT
        // persisted into StoredEnvelope; lives only in the transient
        // `submitter:{envelopeId}` mapping consumed at recipient ack.
        submitter:    {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId},
      });

      // Fire a chat-wake FCM push so the recipient sees a heads-up
      // banner when their app is backgrounded or killed. Best-effort:
      // failures must not block the WS ack. Sender identity is the
      // submitting JWT's claims.sub — which is what we already
      // disclose to the relay for rate limiting; pushing it as data
      // so the client can swap in the local contact name doesn't
      // widen the trust boundary.
      // Title stays generic ("New message") since AccessClaims only
      // carries `sub` — the client looks up the local name on receipt.
      // Audit P2-BR-3 — parity with the HTTP path: skip the wake for
      // non-displayable envelopes (`urgent:false` from the client) and for
      // submits the relay marked not notification-worthy (dedup-hit retry,
      // pre-expired send) so killed devices stop getting phantom banners.
      if (data.urgent !== false && res.wakeEligible) {
        void this.push.sendChatWake(data.to.userId, {
          senderUserId: ctx.claims.sub,
        }).catch(e => this.logger.warn(`push.chat.dispatch-failed: ${(e as Error).message}`));
      }

      const accepted: ServerEnvelopeAccepted = {
        event: 'envelope.accepted',
        data:  {
          clientMsgId:  res.clientMsgId ?? data.clientMsgId,
          envelopeId:   res.envelopeId,
          retractToken: res.retractToken,
        },
      };
      // Why: the mobile transport uses fire-and-forget `socket.emit` with
      // no callback (transport/client.ts#send), so the NestJS return value
      // — which socket.io routes into the callback-ack channel — is
      // silently discarded. The sender's runtime waits on the
      // `envelope.accepted` *event* (handled in onAny → handleAccepted)
      // and falls back to a 5s HTTP retry when it never arrives. Emit
      // explicitly so the event listener fires; the return is kept for
      // any future callback-style caller.
      this.logger.log(`[envelope.send] accepted envId=${res.envelopeId.slice(0,8)} clientMsgId=${(data?.clientMsgId ?? '?').slice(0,8)}`);
      client.emit('envelope.accepted', accepted.data);
      return accepted;
    } catch (e) {
      this.logger.warn(`[envelope.send] FAILED sub=${ctx.claims.sub.slice(0,8)} → ${(data?.to?.userId ?? '?').slice(0,8)} err=${(e as Error).message?.slice(0,120)}`);
      return toError(e);
    }
  }

  @SubscribeMessage('envelope.ack')
  async handleEnvelopeAck(
    @MessageBody() data: ClientEnvelopeAck['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{event: 'envelope.ack.ok'; data: {envelopeId: string}} | ServerError> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    this.logger.log(`[envelope.ack] received sub=${ctx.claims.sub.slice(0,8)} envId=${(data.envelopeId ?? '?').slice(0,8)}`);
    const limited = this.rateGate(client, 'envelope.ack');
    if (limited) {
      this.logger.warn(`[envelope.ack] RATE-LIMITED sub=${ctx.claims.sub.slice(0,8)} envId=${(data.envelopeId ?? '?').slice(0,8)}`);
      return limited;
    }
    try {
      // Audit P0-N9 — service enforces the possession-proof token when
      // present, falls back to the recipient-identity check when absent
      // (rollout window), and rejects when `relay.requireAckToken=true`.
      await this.envelopes.ack(
        {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId},
        data.envelopeId,
        data.ackToken,
        // Handoff §3.6(c) — only the literal 'discarded' flips the
        // sender-facing receipt; junk/missing defaults to 'delivered'.
        data.disposition === 'discarded' ? 'discarded' : 'delivered',
      );
      return {event: 'envelope.ack.ok', data: {envelopeId: data.envelopeId}};
    } catch (e) {
      this.logger.warn(`[envelope.ack] FAILED sub=${ctx.claims.sub.slice(0,8)} envId=${(data.envelopeId ?? '?').slice(0,8)} err=${(e as Error).message?.slice(0,120)}`);
      return toError(e);
    }
  }

  // ─── Call signalling (M8) ─────────────────────────────────────────

  @SubscribeMessage('call.offer')
  async handleCallOffer(
    @MessageBody() data: ClientCallOffer['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'call.offer');
    if (limited) return limited;
    // Audit row #6 — fail-CLOSED at the gateway when the offer carries
    // no auth block. The mobile dispatcher also rejects the same case
    // end-to-end, so the only senders shipping an unsigned offer here
    // are either out-of-date clients (about to be rejected anyway) or
    // attackers probing the WS surface directly. Drop early so we don't
    // leak a `peer_offline` / VoIP-wake side-channel based on the
    // recipient's online state.
    if (!data.auth) {
      console.warn(`[CALL] reject unsigned offer from=${ctx.claims.sub?.slice(0, 8)} cid=${data.callId.slice(0, 8)}`);
      return {event: 'error', data: {code: 'missing_offer_auth', message: 'call.offer requires auth block'}};
    }
    // Why: M-07 (P1-11) — a blocked pair must not ring the blocker, live OR
    // killed. Silent-drop mirroring the typing/read-receipt no-oracle path: no
    // error to the caller, no session tracked, no forward, no pending-offer
    // queue, no VoIP wake. Unlike sealed-sender messages, call.offer exposes
    // both parties to the server, so a server-side gate is feasible here.
    if (await this.privacy.isBlockedEither(ctx.claims.sub, data.to.userId)) {
      console.log(`[CALL] OFFER blocked-drop from=${ctx.claims.sub?.slice(0, 8)} → ${data.to.userId.slice(0, 8)} cid=${data.callId.slice(0, 8)}`);
      return undefined;
    }
    // Round 2 / PII audit: log id-prefixes only — full userIds /
    // signal-device-ids leak account identity to anyone with
    // `docker logs` access. Eight-char prefix is enough to correlate a
    // single call across log lines without giving up the full uuid.
    console.log(`[CALL] OFFER from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} → ${data.to.userId.slice(0, 8)}/${data.to.deviceId} cid=${data.callId.slice(0, 8)} kind=${data.kind} sdpLen=${data.sdp?.length}`);
    dumpSdp('OFFER', data.callId, data.sdp);
    // Register the call session BEFORE forwarding. trackCallStart
    // rejects duplicate callIds (covers the rapid-redial-with-recycled-
    // callId race). The peer is now pinned to (caller, callee) — any
    // subsequent call.* frame from a third userId is rejected by
    // authorizeCallFrame.
    const trackErr = this.trackCallStart(
      client, data.callId,
      {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId},
      {userId: data.to.userId, deviceId: data.to.deviceId},
    );
    if (trackErr) {
      console.warn(`[CALL] OFFER rejected cid=${data.callId.slice(0, 8)} ${trackErr.data.code}`);
      return trackErr;
    }
    const result = await this.forwardToDevice(client, data.to, false, (from): ServerCallOffer => ({
      event: 'call.offer',
      // Audit S7 — forward the caller-minted auth block verbatim. The
      // relay is intentionally a pure pass-through here; the callee
      // performs end-to-end verification via verifyCallOfferAuth.
      data:  {callId: data.callId, from, sdp: data.sdp, kind: data.kind, auth: data.auth},
    }));
    console.log(`[CALL] OFFER result cid=${data.callId.slice(0, 8)} ${result?.event === 'error' ? 'ERR='+result.data.code : 'OK'}`);
    // N-01 — ALWAYS queue the offer + fire the VoIP wake, not only when the
    // socket-room probe says peer_offline. A killed/frozen app (Doze, radio
    // asleep, OEM freeze, network switch) leaves a ZOMBIE socket in the room
    // for up to ~55s (heartbeat 30s + grace 25s); `forwardToDevice` "succeeds"
    // by emitting into that dead socket, so the old peer_offline-gated path
    // skipped BOTH the queue and the wake — the call rang nowhere and left no
    // trace. The group `sfu.ring` path already always-sends the wake and the
    // client dedupes by callId (notifee id `bravo-call-<callId>`; the
    // foreground onMessage ignores voip-wake), so mirroring it here is safe.
    const ctxFrom = (client.data as SocketContext | undefined)?.claims;
    const fromDeviceId = (client.data as SocketContext | undefined)?.signalDeviceId ?? 1;
    let queued = false;
    if (ctxFrom?.sub) {
      const from = {userId: ctxFrom.sub, deviceId: fromDeviceId};
      const pending: PendingCallOffer = {
        callId: data.callId,
        from,
        sdp:    data.sdp,
        kind:   data.kind,
        at:     Date.now(),
        // Audit S7 — persist auth so the WS-open replay delivers the SAME
        // signed block (a stripped auth would re-open the spoof window).
        auth:   data.auth,
      };
      const marker: MissedCallMarker = {callId: data.callId, from, kind: data.kind, at: pending.at};
      try {
        // Per-callId payload + index entry so concurrent callers for the same
        // offline recipient don't overwrite each other. The offer payload
        // (with SDP) stays short-lived (45s); the slim missed-marker + index
        // live long enough for a late reconnect to surface a "Missed call".
        await this.redis.client.set(
          pendingOfferKey(data.to.userId, data.to.deviceId, data.callId),
          JSON.stringify(pending),
          'EX', 45,
        );
        await this.redis.client.set(
          missedCallMarkerKey(data.to.userId, data.to.deviceId, data.callId),
          JSON.stringify(marker),
          'EX', MISSED_CALL_MARKER_TTL_SEC,
        );
        await this.redis.client.sadd(
          pendingOfferIndexKey(data.to.userId, data.to.deviceId),
          data.callId,
        );
        await this.redis.client.expire(
          pendingOfferIndexKey(data.to.userId, data.to.deviceId),
          MISSED_CALL_MARKER_TTL_SEC,
        );
        queued = true;
      } catch { /* best effort */ }
    }
    // §5 parity (Ranak-approved 2026-07-05, relaxes audit P1-N2): the wake
    // carries the pseudonymous sender UUID + call kind so the killed-app ring
    // labels the caller from LOCAL contacts; no cleartext name hits FCM. Full
    // call detail still arrives via the queued `call.offer` frame on reconnect.
    // P2-BR-8 — the 1:1 call.offer frame carries the media kind as `kind`
    // ('voice'|'video'); read it (with the legacy `callType` as fallback) so a
    // video call to a killed device rings as video, not always "voice".
    void this.push.sendVoipWake(
      data.to.userId, data.callId, ctx.claims.sub, undefined,
      ((data as {kind?: string}).kind ?? (data as {callType?: string}).callType) === 'video' ? 'video' : 'voice',
    ).catch(() => { /* swallow */ });
    // Hide peer_offline from the caller when we queued + pushed — their UI
    // stays in "calling…" and the call.answer arrives once the callee comes
    // online and accepts. (For an online callee `result` is undefined already.)
    if (result && result.event === 'error' && result.data.code === 'peer_offline' && queued) {
      return undefined;
    }
    return result;
  }

  @SubscribeMessage('call.answer')
  async handleCallAnswer(
    @MessageBody() data: ClientCallAnswer['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'call.answer');
    if (limited) return limited;
    console.log(`[CALL] ANSWER from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} → ${data.to.userId.slice(0, 8)}/${data.to.deviceId} cid=${data.callId.slice(0, 8)} sdpLen=${data.sdp?.length}`);
    dumpSdp('ANSWER', data.callId, data.sdp);
    const auth = this.authorizeCallFrame(ctx.claims.sub, data.callId);
    if (auth.ok === false) {
      if ('ignore' in auth) return undefined;
      console.warn(`[CALL] ANSWER rejected cid=${data.callId.slice(0, 8)} ${auth.err.data.code}`);
      return auth.err;
    }
    // Track callee's socket so disconnect on EITHER side fires bye.
    this.trackCallAnswer(client, data.callId);
    // N-02 — the callee answered, so purge THEIR queued offer + missed-marker.
    // Without this, a later reconnect drain would replay/emit a missed call for
    // a call that was actually answered.
    void this.clearPendingCallArtifacts(ctx.claims.sub, ctx.signalDeviceId, data.callId);
    return this.forwardToDevice(client, data.to, false, (from): ServerCallAnswer => ({
      event: 'call.answer',
      data:  {callId: data.callId, from, sdp: data.sdp},
    }));
  }

  /**
   * N-02 — remove a queued offer's Redis artifacts (offer payload, missed
   * marker, index membership) for one (user, device, callId). Used when a call
   * is answered or ended so nothing stale replays on the next reconnect.
   */
  private async clearPendingCallArtifacts(
    userId: string,
    deviceId: number,
    callId: string,
    opts: {keepMarker?: boolean} = {},
  ): Promise<void> {
    try {
      await this.redis.client.del(pendingOfferKey(userId, deviceId, callId));
      // P1-15 / P2-13 — the reconnect `call.missed` drain enumerates ONLY the
      // pending-offer index, so the SREM must stay INSIDE the keep-marker guard:
      // when we keep the missed-marker (caller gave up on an unanswered call)
      // we must ALSO keep the index entry, else the surviving marker is
      // unreachable and `call.missed` never fires on the callee's next connect.
      if (!opts.keepMarker) {
        await this.redis.client.del(missedCallMarkerKey(userId, deviceId, callId));
        await this.redis.client.srem(pendingOfferIndexKey(userId, deviceId), callId);
      }
    } catch { /* best effort */ }
  }

  @SubscribeMessage('call.ice')
  async handleCallIce(
    @MessageBody() data: ClientCallIce['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'call.ice');
    if (limited) return limited;
    // Round 2 / PII audit: do NOT log the candidate body — even an 80
    // char slice usually contains the IP + port. The mid + idx are
    // enough to correlate a candidate frame with the SDP m-line for
    // diagnosis. Length is a useful signal that the candidate isn't
    // empty without leaking the network topology.
    const candLen = (data.candidate ?? '').length;
    console.log(`[CALL] ICE from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} → ${data.to.userId.slice(0, 8)}/${data.to.deviceId} cid=${data.callId.slice(0, 8)} mid=${data.sdpMid} idx=${data.sdpMLineIndex} candLen=${candLen}`);
    const auth = this.authorizeCallFrame(ctx.claims.sub, data.callId);
    if (auth.ok === false) {
      if ('ignore' in auth) return undefined; // late ICE for ended call — silent drop
      return auth.err;
    }
    return this.forwardToDevice(client, data.to, false, (from): ServerCallIce => ({
      event: 'call.ice',
      data:  {
        callId: data.callId, from,
        candidate: data.candidate,
        sdpMid: data.sdpMid, sdpMLineIndex: data.sdpMLineIndex,
      },
    }));
  }

  @SubscribeMessage('call.hangup')
  async handleCallHangup(
    @MessageBody() data: ClientCallHangup['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'call.hangup');
    if (limited) return limited;
    console.log(`[CALL] HANGUP from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} → ${data.to.userId.slice(0, 8)}/${data.to.deviceId} cid=${data.callId.slice(0, 8)} reason=${data.reason}`);
    const auth = this.authorizeCallFrame(ctx.claims.sub, data.callId);
    if (auth.ok === false) {
      if ('ignore' in auth) return undefined; // duplicate / late hangup — ack silently
      console.warn(`[CALL] HANGUP rejected cid=${data.callId.slice(0, 8)} ${auth.err.data.code} (third-party hangup attempt blocked)`);
      return auth.err;
    }
    // N-02 — was the call still ringing (never answered)? Read BEFORE
    // trackCallEnd flips it. `isCaller` distinguishes a caller giving up (the
    // callee, possibly a killed device, is the one still "ringing") from a
    // callee declining (the caller isn't ringing and never "missed" anything).
    const pre = this.callSessions.get(data.callId);
    const wasRinging = pre?.state === 'ringing';
    const isCaller = !!pre && pre.caller.userId === ctx.claims.sub;
    // Mark ended BEFORE forwarding so a duplicate hangup frame in
    // flight is dropped at the auth gate (not relayed).
    this.trackCallEnd(data.callId);
    // N-02 — kill the ghost ring: purge the callee's queued offer so a reconnect
    // within 45s can't replay a call the caller already abandoned. Keep the
    // missed-marker only when the caller gave up on an unanswered call (so the
    // callee still learns they missed it); drop it otherwise (answered, or a
    // callee-initiated decline is not a "missed call").
    const callerGaveUp = wasRinging && isCaller;
    // P1-14 — the queued offer/marker/index were keyed on the CALLEE at offer
    // time (handleCallOffer used data.to = the ringing callee). Clear THOSE
    // keys regardless of who hung up: on a callee-decline, this frame's
    // `data.to` is the CALLER, so using it would leave the callee's own
    // missed-marker + index entry alive → a phantom "Missed call" (and, within
    // 45s, a ghost re-ring) on the callee's next reconnect for a call they
    // explicitly declined.
    const ringingCallee = pre ? pre.callee : {userId: data.to.userId, deviceId: data.to.deviceId};
    void this.clearPendingCallArtifacts(
      ringingCallee.userId, ringingCallee.deviceId, data.callId, {keepMarker: callerGaveUp},
    );
    // N-02 — no push-based ring cancel existed: a Doze-deferred wake could ring
    // for up to 45s AFTER the caller hung up ("notification only after the
    // call"). When the caller gives up on an unanswered call, send a data-only
    // cancel push so a killed device dismisses the ring and shows a Missed call.
    if (callerGaveUp) {
      // The call session doesn't retain the media kind; the missed-call label
      // ('Voice'/'Video') is cosmetic, so default to voice. Target the ringing
      // callee (P1-14) — the device(s) still ringing from the VoIP wake.
      void this.push.sendCallCancel(
        ringingCallee.userId, data.callId, ctx.claims.sub, 'voice', /*missed*/ true,
      ).catch(() => { /* swallow — best effort */ });
    }
    return this.forwardToDevice(client, data.to, false, (from): ServerCallHangup => ({
      event: 'call.hangup',
      data:  {callId: data.callId, from, reason: data.reason},
    }));
  }

  /**
   * BS-021 — pure relay for the peer-mute / peer-camera-off advisory.
   * Receiver flips a "Camera off" / "Mic off" placeholder in the
   * remote tile so the user can distinguish an intentional disable
   * from a frozen RTP feed. Server never persists this.
   */
  @SubscribeMessage('call.media-state')
  handleCallMediaState(
    @MessageBody() data: ClientCallMediaState['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> | undefined {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return Promise.resolve(authMissing());
    const limited = this.rateGate(client, 'call.media-state');
    if (limited) return Promise.resolve(limited);
    console.log(`[CALL] MEDIA-STATE from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} → ${data.to.userId.slice(0, 8)}/${data.to.deviceId} cid=${data.callId.slice(0, 8)} cam=${data.cameraOff ? 'off' : 'on'} mic=${data.micOff ? 'off' : 'on'}`);
    // Round 7 / WebRTC audit fix W1 — every other call.* handler
    // verifies the sender is actually a participant of the named call;
    // this one was skipping the check, so any authed user could spoof
    // a media-state advisory for someone else's callId and flip the
    // recipient's "Camera off" placeholder. Adding the same gate as
    // call.answer/ice/hangup.
    const auth = this.authorizeCallFrame(ctx.claims.sub, data.callId);
    if (auth.ok === false) {
      if ('ignore' in auth) return undefined;
      return Promise.resolve(auth.err);
    }
    return this.forwardToDevice(client, data.to, false, (from): ServerCallMediaState => ({
      event: 'call.media-state',
      data:  {callId: data.callId, from, cameraOff: data.cameraOff, micOff: data.micOff},
    }));
  }

  /**
   * Mid-call SDP renegotiation — voice→video upgrade. Pure relay just
   * like call.offer/answer; no offline queueing or VoIP push because
   * the peer is mid-call and therefore by definition online (the WS
   * has been carrying ICE keepalives between them up to this moment).
   * If `forwardToDevice` returns peer_offline we surface it back to
   * the initiator so its watchdog can roll back the half-applied
   * upgrade and the call stays voice-only.
   *
   * dumpSdp gated behind the same BRAVO_DUMP_SDP env-var as the
   * initial offer/answer so we don't leak SDP into normal docker logs.
   */
  @SubscribeMessage('call.reoffer')
  handleCallReOffer(
    @MessageBody() data: ClientCallReOffer['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> | undefined {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return Promise.resolve(authMissing());
    const limited = this.rateGate(client, 'call.reoffer');
    if (limited) return Promise.resolve(limited);
    console.log(`[CALL] RE-OFFER from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} → ${data.to.userId.slice(0, 8)}/${data.to.deviceId} cid=${data.callId.slice(0, 8)} sdpLen=${data.sdp?.length}`);
    dumpSdp('RE-OFFER', data.callId, data.sdp);
    // Round 7 / WebRTC audit fix W1 — without this check a third party
    // who guesses a callId can ship a malicious renegotiation SDP that
    // the receiver's setRemoteDescription accepts, breaking the active
    // call by negotiating bogus codecs / media lines.
    const auth = this.authorizeCallFrame(ctx.claims.sub, data.callId);
    if (auth.ok === false) {
      if ('ignore' in auth) return undefined;
      return Promise.resolve(auth.err);
    }
    return this.forwardToDevice(client, data.to, false, (from): ServerCallReOffer => ({
      event: 'call.reoffer',
      data:  {callId: data.callId, from, sdp: data.sdp},
    }));
  }

  @SubscribeMessage('call.reanswer')
  handleCallReAnswer(
    @MessageBody() data: ClientCallReAnswer['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> | undefined {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return Promise.resolve(authMissing());
    const limited = this.rateGate(client, 'call.reanswer');
    if (limited) return Promise.resolve(limited);
    console.log(`[CALL] RE-ANSWER from=${ctx.claims.sub?.slice(0, 8)}/${ctx.signalDeviceId} → ${data.to.userId.slice(0, 8)}/${data.to.deviceId} cid=${data.callId.slice(0, 8)} sdpLen=${data.sdp?.length}`);
    dumpSdp('RE-ANSWER', data.callId, data.sdp);
    // Round 7 / WebRTC audit fix W1 — same rationale as call.reoffer
    // above: confirm the sender is a participant before forwarding the
    // SDP to the peer.
    const auth = this.authorizeCallFrame(ctx.claims.sub, data.callId);
    if (auth.ok === false) {
      if ('ignore' in auth) return undefined;
      return Promise.resolve(auth.err);
    }
    return this.forwardToDevice(client, data.to, false, (from): ServerCallReAnswer => ({
      event: 'call.reanswer',
      data:  {callId: data.callId, from, sdp: data.sdp},
    }));
  }

  // ─── SFU group calls (M9) ─────────────────────────────────────────
  //
  // Frames flow client → gateway → SfuService → mediasoup. The gateway
  // returns frame ack payloads inline (socket.io ack semantics) so the
  // mediasoup-client `Device` callbacks can chain transport.connect /
  // produce / consume without separate request/response plumbing.

  @SubscribeMessage('sfu.join')
  async handleSfuJoin(
    @MessageBody() data: ClientSfuJoin['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ReturnType<SfuService['joinRoom']> | {ok: false; data: {code: string; message: string}}> {
    // Audit SFU-07 — rate-limit joins to blunt slot-exhaustion / rejoin-spam by
    // a removed member who knows the conversationId. Event-less sfuError so it
    // rides the ack (SFU-01).
    if (this.rateGate(client, 'sfu.join')) return sfuError('rate_limited');
    const ctx = client.data as SocketContext;
    // MEDIUM-3 — cluster-global per-user join cap. The per-socket limit above
    // is bypassed by a removed member reconnecting fresh sockets across pods to
    // spam joins; 30 joins/min/user is generous for legit reconnect/rejoin.
    if (await this.userRateExceeded(ctx.claims.sub, 'sfujoin', 30)) {
      return sfuError('rate_limited');
    }
    // Audit P0-C2 / row #5 — verify the per-recipient HMAC token before
    // admitting. Token absent: probe whether the server has
    // SFU_ROOM_TOKEN_SECRET configured by attempting to mint a throw-
    // away. If issue() succeeds the secret IS set → tokenless join is
    // a hard reject. If issue() throws (secret unset, dev/legacy)
    // admit without verification.
    if (data.roomToken) {
      const verdict = this.roomToken.verify(data.roomToken, data.roomId, ctx.claims.sub);
      if (!verdict.ok) {
        this.logger.warn(`[SFU] join rejected uid=${ctx.claims.sub?.slice(0, 8)} rid=${data.roomId.slice(0, 8)} reason=${verdict.reason}`);
        return sfuError(`room_token_${verdict.reason}`, 'room_token_invalid');
      }
    } else {
      try {
        this.roomToken.issue('probe', 'probe', 1);
        this.logger.warn(`[SFU] join rejected uid=${ctx.claims.sub?.slice(0, 8)} rid=${data.roomId.slice(0, 8)} reason=missing_token`);
        return sfuError('room_token_required', 'room_token_required');
      } catch {
        // P3-P-1 — issue() throwing means SFU_ROOM_TOKEN_SECRET is unset. FAIL
        // CLOSED in production: a prod box missing the secret must NOT run the
        // whole SFU plane in open-admit mode with zero boot signal. In non-prod
        // we still admit (dev/test), but LOUDLY once so the gap is visible.
        if (process.env.NODE_ENV === 'production') {
          this.logger.error(`[SFU] join rejected uid=${ctx.claims.sub?.slice(0, 8)} rid=${data.roomId.slice(0, 8)} reason=token_secret_unset_prod`);
          return sfuError('room_token_required', 'room_token_required');
        }
        if (!this.tokenlessSfuAdmitLogged) {
          this.tokenlessSfuAdmitLogged = true;
          this.logger.error('[SFU] admitting joins WITHOUT token verification — SFU_ROOM_TOKEN_SECRET is unset (non-prod only). Set it to enforce per-recipient room-access tokens.');
        }
      }
    }
    try {
      const joined = await this.sfu.joinRoom(data.roomId, ctx.claims.sub);
      // Track the participant tag so server-pushed sfu.* frames find
      // the socket, and tear down on disconnect.
      this.sfuTagToSocket.set(joined.participantTag, client);
      let tags = this.sfuSocketTags.get(client);
      if (!tags) { tags = new Set(); this.sfuSocketTags.set(client, tags); }
      tags.add(joined.participantTag);
      // Join the socket.io rooms the multi-pod fanout broadcasts to
      // (see bindFanout). `sfu:<roomId>` for room-wide frames,
      // `sfutag:<tag>` for self-addressed ones. Leaving happens in
      // handleDisconnect / handleSfuLeave / kick via leaveSfuRooms.
      void client.join(sfuRoom(data.roomId));
      void client.join(sfuTagRoom(joined.participantTag));
      return joined;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'sfu_join_failed';
      return sfuError(message, 'sfu_join_failed');
    }
  }

  @SubscribeMessage('sfu.transport.connect')
  async handleSfuConnect(
    @MessageBody() data: ClientSfuConnectTransport['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true} | {ok: false; data: {code: string; message: string}}> {
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    try {
      await this.sfu.connectTransport(tag, data.transportId, data.dtlsParameters as never);
      return {ok: true};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_connect_failed');
    }
  }

  /**
   * Weak-network ICE restart. The client's mediasoup-client transport
   * reports `connectionstatechange === 'disconnected'` (e.g. Wi-Fi ↔
   * cellular handover) and asks the server for fresh iceParameters.
   * mediasoup's `transport.restartIce()` reallocates ICE ufrag/pwd
   * without tearing the WebRtcTransport down — producers and consumers
   * survive, DTLS context is preserved, and media resumes once the
   * client applies the new parameters and re-gathers candidates.
   */
  @SubscribeMessage('sfu.transport.restartIce')
  async handleSfuRestartIce(
    @MessageBody() data: {roomId: string; transportId: string},
    @ConnectedSocket() client: Socket,
  ): Promise<{iceParameters: unknown} | {ok: false; data: {code: string; message: string}}> {
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    try {
      const iceParameters = await this.sfu.restartTransportIce(tag, data.transportId);
      return {iceParameters};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_restart_ice_failed');
    }
  }

  @SubscribeMessage('sfu.produce')
  async handleSfuProduce(
    @MessageBody() data: ClientSfuProduce['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{producerId: string} | {ok: false; data: {code: string; message: string}}> {
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    try {
      return await this.sfu.produce(tag, data.transportId, data.kind, data.rtpParameters as never);
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_produce_failed');
    }
  }

  @SubscribeMessage('sfu.consume')
  async handleSfuConsume(
    @MessageBody() data: ClientSfuConsume['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<Awaited<ReturnType<SfuService['consume']>> | {ok: false; data: {code: string; message: string}}> {
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    try {
      return await this.sfu.consume(tag, data.transportId, data.producerId, data.rtpCapabilities as never);
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_consume_failed');
    }
  }

  @SubscribeMessage('sfu.consumer.resume')
  async handleSfuConsumerResume(
    @MessageBody() data: ClientSfuConsumerResume['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true} | {ok: false; data: {code: string; message: string}}> {
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    try {
      await this.sfu.resumeConsumer(tag, data.consumerId);
      return {ok: true};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_resume_failed');
    }
  }

  // Owner toggles their own camera/mic producer. Ownership + the S6
  // host-mute guard live in SfuService.setProducerPaused; the fan-out
  // (sfu.producer-paused / -resumed) lets peers swap the frozen tile
  // for the avatar placeholder deterministically.
  @SubscribeMessage('sfu.producer.pause')
  async handleSfuProducerPause(
    @MessageBody() data: ClientSfuProducerPause['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true} | {ok: false; data: {code: string; message: string}}> {
    // Audit SFU-09 — enforce the (previously-dead) pause/resume rate budget.
    // Convert the limiter's event-shaped result into the event-LESS sfuError so
    // it still rides the ack (SFU-01) rather than becoming a blind timeout.
    if (this.rateGate(client, 'sfu.producer.pause')) return sfuError('rate_limited');
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    try {
      await this.sfu.setProducerPaused(tag, data.producerId, true);
      return {ok: true};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_producer_pause_failed');
    }
  }

  @SubscribeMessage('sfu.producer.resume')
  async handleSfuProducerResume(
    @MessageBody() data: ClientSfuProducerResume['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true} | {ok: false; data: {code: string; message: string}}> {
    // Audit SFU-09 — enforce the resume rate budget (event-less sfuError).
    if (this.rateGate(client, 'sfu.producer.resume')) return sfuError('rate_limited');
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    try {
      await this.sfu.setProducerPaused(tag, data.producerId, false);
      return {ok: true};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_producer_resume_failed');
    }
  }

  /**
   * Reconcile query — client diffs this against its live consumers and
   * consumes any producer it's missing (dropped/missed `sfu.new-producer`
   * frame, or a transiently-failed consume). Read-only; the SFU validates
   * the caller is in the room.
   */
  @SubscribeMessage('sfu.producers')
  handleSfuListProducers(
    @MessageBody() data: {roomId: string},
    @ConnectedSocket() client: Socket,
  ): {producers: Array<{producerId: string; participantTag: string; kind: 'audio' | 'video'; paused: boolean}>} | {ok: false; data: {code: string; message: string}} {
    const tag = this.firstTagFor(client, data.roomId);
    if (!tag) return sfuError('no_active_participant');
    try {
      return {producers: this.sfu.listProducers(tag, data.roomId)};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_list_producers_failed');
    }
  }

  @SubscribeMessage('sfu.leave')
  async handleSfuLeave(
    @MessageBody() data: ClientSfuLeave['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true}> {
    const tags = this.sfuSocketTags.get(client);
    if (!tags) return {ok: true};
    // Filter by roomId — leaving room A must NOT tear down a tag that
    // belongs to room B. Previously this handler iterated EVERY tag on
    // the socket; on rapid leave-then-join (incoming-call accept mid-
    // call) the new room's tag was killed before it ever started
    // routing media. If the client didn't send roomId (older clients,
    // or roomId is missing in the schema), fall back to the all-tags
    // semantics so no leak — a missing roomId is rare enough that the
    // wrong-room-killed risk is acceptable.
    const targetRoomId = data?.roomId;
    const tagsToLeave: string[] = [];
    if (targetRoomId) {
      for (const tag of tags) {
        const info = this.sfu.resolveParticipantUser(tag);
        if (info && info.roomId === targetRoomId) tagsToLeave.push(tag);
      }
    } else {
      tagsToLeave.push(...tags);
    }
    for (const tag of tagsToLeave) {
      // L7 — this is the INTENTIONAL leave (the user pressed End/Leave; the
      // socket stays connected). A host ending here terminates the room for
      // everyone, per WhatsApp/Zoom semantics. A host's transient WS DROP goes
      // through handleDisconnect (no flag) and does NOT kill the room.
      const {removedTags} = await this.sfu.leaveRoom(tag, {hostTerminatesRoom: true})
        .catch(() => ({removedTags: [tag]}));
      // Audit SFU-06 — purge the gateway maps for EVERY torn-down tag, not just
      // our own. On a host-terminate leaveRoom also closes the survivors; their
      // sfuTagToSocket entries (a STRONG Map) and sfuSocketTags sets used to
      // leak until each survivor's own socket disconnected, and firstTagFor
      // could then resolve a dead tag for a later moderation action.
      for (const rt of removedTags) {
        const survSock = this.sfuTagToSocket.get(rt);
        this.sfuTagToSocket.delete(rt);
        if (survSock) {
          this.sfuSocketTags.get(survSock)?.delete(rt);
          void survSock.leave(sfuTagRoom(rt));
        }
      }
      tags.delete(tag);
      // Leave the fanout rooms so post-leave broadcasts don't reach this
      // socket. The socket stays connected (only this SFU session ended),
      // so unlike handleDisconnect we must leave explicitly.
      void client.leave(sfuTagRoom(tag));
    }
    if (targetRoomId) void client.leave(sfuRoom(targetRoomId));
    return {ok: true};
  }

  // ─── Group call ringing ──────────────────────────────────────────
  //
  // The caller has already POSTed /sfu/rooms and joined the room. This
  // handler takes the explicit recipient list (server doesn't see group
  // membership — groups are E2E) and fans `sfu.ring.incoming` to each
  // recipient's userRoom + fires a VoIP push wake so offline devices ring.

  @SubscribeMessage('sfu.ring')
  async handleSfuRing(
    @MessageBody() data: ClientSfuRing['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true} | {ok: false; data: {code: string; message: string}}> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return sfuError('unauthenticated');
    const callerId = ctx.claims.sub;

    // P2-3 — meter the in-app group ring (was unmetered): a host could spam
    // `sfu.ring` to online victims' IncomingGroupCallScreen. Per-socket bucket
    // plus a cluster-global per-user cap (mirrors sfu.join) so multi-socket /
    // multi-pod amplification is also blunted.
    if (this.rateGate(client, 'sfu.ring')) return sfuError('rate_limited');
    if (await this.userRateExceeded(callerId, 'sfuring', 20)) return sfuError('rate_limited');

    // Audit row #5 (C3) — only the room HOST may ring. Without this,
    // any authed user could ship `sfu.ring` for any roomId they
    // guessed or saw in a prior frame and spam-ring arbitrary
    // `recipientUserIds[]`. The host check binds ringing to "the
    // person who POSTed /sfu/rooms" — same authority anchor as
    // sfu.mute-target + sfu.kick. Unknown roomId returns `not_host`
    // (forbidden) so attackers can't enumerate hostless rooms.
    const host = this.sfu.hostOf(data.roomId);
    if (!host || host !== callerId) {
      this.logger.warn(`[SFU] ring rejected uid=${callerId.slice(0, 8)} rid=${data.roomId.slice(0, 8)} reason=not_host`);
      return sfuError('not_host');
    }

    // Audit row #5 (C3) — cap per-call ring fan-out. A 10k-entry
    // recipientUserIds[] would otherwise force 10k WS emits + 10k VoIP
    // wakes in one frame. 250 is generous (Phase-1 informal group cap
    // is ~50) but bounded enough to block torch attacks.
    const MAX_RING_TARGETS = 250;
    if (Array.isArray(data.recipientUserIds) && data.recipientUserIds.length > MAX_RING_TARGETS) {
      this.logger.warn(`[SFU] ring rejected uid=${callerId.slice(0, 8)} rid=${data.roomId.slice(0, 8)} reason=too_many_targets count=${data.recipientUserIds.length}`);
      return sfuError('too_many_targets');
    }

    // Strip self + duplicates from the recipient list — caller's own
    // devices already know about the call (they're in it).
    const deduped = Array.from(new Set(data.recipientUserIds.filter(uid => uid && uid !== callerId)));
    // Why: M-07 (P1-11) — never ring (WS incoming OR VoIP wake) a user in a
    // block relationship with the host. Silent-filter, no oracle.
    const blockedFlags = await Promise.all(deduped.map(uid => this.privacy.isBlockedEither(callerId, uid)));
    const targets = deduped.filter((_, i) => !blockedFlags[i]);
    if (targets.length === 0) return {ok: true};

    for (const uid of targets) {
      // Audit P0-C2 / row #5 — mint per-recipient HMAC token. Without
      // this, knowing a roomId was enough to silently land in the
      // room. 30-min TTL (M1) absorbs PushKit cold-start + Doze thaw.
      // issue() throws when secret unset → ship empty string, gateway
      // skips verify on join (dev/legacy compat).
      let roomToken = '';
      let roomTokenExp = 0;
      try {
        const minted = this.roomToken.issue(data.roomId, uid);
        roomToken = minted.token;
        roomTokenExp = minted.exp;
      } catch { /* secret not configured — dev only */ }

      const ringData = {
        roomId:         data.roomId,
        conversationId: data.conversationId,
        callType:       data.callType,
        from:           {userId: callerId, deviceId: ctx.signalDeviceId},
        callerName:     data.callerName,
        roomToken,
        roomTokenExp,
      };
      // Fan to every connected device of this user. Cross-node delivery
      // rides the Redis adapter automatically.
      this.hub.server?.to(this.hub.userRoom(uid)).emit('sfu.ring.incoming', ringData);
      // VoIP wake — best-effort; reusing roomId as the call id since
      // group calls don't have a separate callId concept. §5 parity
      // (Ranak-approved 2026-07-05, relaxes P1-N2): pseudonymous caller
      // UUID + group call-kind ride the wake for instant local-name ring
      // labeling. Audit row #7 — per-(caller, recipient) wake budget
      // enforced inside sendVoipWake. Audit PUSH-B6 — pass the recipient's
      // minted room token so a killed-app decline can authenticate
      // sfu.ring.decline. Empty string when the secret isn't configured.
      void this.push.sendVoipWake(
        uid, data.roomId, callerId, roomToken || undefined,
        (data as {callType?: string}).callType === 'video' ? 'group-video' : 'group-voice',
      ).catch(() => { /* swallow */ });

      // P2-BR-9 — queue a short-TTL pending ring + a 6h missed-group-call
      // marker per target so a device offline/Dozed at ring time either rings
      // live (reconnect within 45s) or records a missed group call (reconnect
      // later) — the group analogue of the 1:1 pendingOffer/missed-marker.
      // conversationId rides the queued payload so the replayed ring can dedupe
      // + attach to the right thread.
      try {
        const at = Date.now();
        const pendingRing: PendingGroupRing = {
          roomId:         data.roomId,
          conversationId: data.conversationId,
          callType:       data.callType,
          from:           {userId: callerId, deviceId: ctx.signalDeviceId},
          callerName:     data.callerName,
          roomToken,
          roomTokenExp,
          at,
        };
        await this.redis.client.set(pendingGroupRingKey(uid, data.roomId), JSON.stringify(pendingRing), 'EX', 45);
        await this.redis.client.set(
          missedGroupCallMarkerKey(uid, data.roomId),
          JSON.stringify({roomId: data.roomId, conversationId: data.conversationId, from: pendingRing.from, callType: data.callType, at} satisfies MissedGroupCallMarker),
          'EX', MISSED_CALL_MARKER_TTL_SEC,
        );
        await this.redis.client.sadd(pendingGroupRingIndexKey(uid), data.roomId);
        await this.redis.client.expire(pendingGroupRingIndexKey(uid), MISSED_CALL_MARKER_TTL_SEC);
      } catch { /* best effort */ }
    }
    this.logger.log(`[GROUP-CALL] ring rid=${data.roomId} from=${callerId} → ${targets.length} user(s)`);
    return {ok: true};
  }

  @SubscribeMessage('sfu.ring.cancel')
  handleSfuRingCancel(
    @MessageBody() data: ClientSfuRingCancel['data'],
    @ConnectedSocket() client: Socket,
  ): {ok: true} | {ok: false; data: {code: string; message: string}} {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return sfuError('unauthenticated');
    // Audit row #5 (C2) — only the room HOST may cancel. Otherwise
    // any authed user could force every recipient's IncomingGroupCall-
    // Screen to self-dismiss by spamming the cancel frame for a
    // guessed roomId. hostOnly=true → caller must equal
    // SfuService.hostOf(roomId) AND (when secret set) present a token
    // binding (roomId, callerId).
    const ringGateErr = this.verifySfuRingAuthority(data.roomToken, data.roomId, ctx.claims.sub, /*hostOnly*/ true);
    if (ringGateErr) return ringGateErr;
    const targets = Array.from(new Set(data.recipientUserIds.filter(uid => uid && uid !== ctx.claims.sub)));
    const frame = {
      event: 'sfu.ring.cancelled',
      data:  {roomId: data.roomId, conversationId: data.conversationId},
    };
    for (const uid of targets) {
      this.hub.server?.to(this.hub.userRoom(uid)).emit(frame.event, frame.data);
      // P2-15 — parity with the 1:1 N-02 cancel push: a killed/Dozed device
      // never saw the WS cancel and keeps ringing up to the 45s wake TTL.
      // Reuse roomId as the callId so the client dismisses `bravo-call-<roomId>`.
      void this.push.sendCallCancel(uid, data.roomId, ctx.claims.sub, 'voice', /*missed*/ false)
        .catch(() => { /* best effort */ });
      // Drop the queued pending ring (P2-BR-9) so a reconnect can't re-ring.
      void this.clearPendingGroupRingArtifacts(uid, data.roomId);
    }
    return {ok: true};
  }

  @SubscribeMessage('sfu.ring.decline')
  handleSfuRingDecline(
    @MessageBody() data: ClientSfuRingDecline['data'],
    @ConnectedSocket() client: Socket,
  ): {ok: true} | {ok: false; data: {code: string; message: string}} {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return sfuError('unauthenticated');
    // Audit row #5 (C2) — proof the decliner was actually ringed.
    // Token was minted in handleSfuRing per recipient and shipped in
    // sfu.ring.incoming.roomToken; presenting it back proves they
    // received the ring. hostOnly=false → token presence + binding
    // is enough.
    const ringGateErr = this.verifySfuRingAuthority(data.roomToken, data.roomId, ctx.claims.sub, /*hostOnly*/ false);
    if (ringGateErr) return ringGateErr;
    // Tell the room's host about the decline. We can't address the host
    // directly from the decliner's side because the decliner never joined,
    // so the cleanest path is: ask the SFU for the host of this room and
    // emit to their userRoom. If the room is gone (host hung up before
    // decline arrived) this is a no-op.
    const hostUserId = this.sfu.hostOf(data.roomId);
    if (hostUserId && hostUserId !== ctx.claims.sub) {
      this.hub.server?.to(this.hub.userRoom(hostUserId)).emit('sfu.ring.declined', {
        roomId:         data.roomId,
        conversationId: data.conversationId,
        from:           {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId},
      });
    }
    return {ok: true};
  }

  /**
   * Audit row #5 (C2 helper) — shared authority check for
   * `sfu.ring.cancel` / `sfu.ring.decline`. Returns an `sfu.error`
   * object on failure (caller should `return` it), or `null` to admit.
   *
   * - `hostOnly: true`  → caller must equal `SfuService.hostOf(roomId)`
   *                       AND (when secret is set) present a valid
   *                       `roomToken` binding (roomId, caller).
   * - `hostOnly: false` → caller need only present a valid token. The
   *                       token presence proves they received the ring;
   *                       the binding proves they didn't borrow someone
   *                       else's. Used by decline (anyone legitimately
   *                       ringed may decline).
   */
  private verifySfuRingAuthority(
    token:    string | undefined,
    roomId:   string,
    callerId: string | undefined,
    hostOnly: boolean,
  ): {ok: false; data: {code: string; message: string}} | null {
    if (!callerId) return sfuError('unauthenticated');
    if (hostOnly) {
      const host = this.sfu.hostOf(roomId);
      if (!host || host !== callerId) {
        this.logger.warn(`[SFU] cancel rejected uid=${callerId.slice(0, 8)} rid=${roomId.slice(0, 8)} reason=not_host`);
        return sfuError('not_host');
      }
    }
    if (token) {
      const verdict = this.roomToken.verify(token, roomId, callerId);
      if (!verdict.ok) {
        this.logger.warn(`[SFU] ring-auth rejected uid=${callerId.slice(0, 8)} rid=${roomId.slice(0, 8)} reason=${verdict.reason}`);
        return sfuError(`room_token_${verdict.reason}`);
      }
      return null;
    }
    // No token — probe whether the server has the secret. If set, reject.
    try {
      this.roomToken.issue('probe', 'probe', 1);
      this.logger.warn(`[SFU] ring-auth rejected uid=${callerId.slice(0, 8)} rid=${roomId.slice(0, 8)} reason=missing_token`);
      return sfuError('room_token_required');
    } catch {
      return null;
    }
  }

  @SubscribeMessage('sfu.mute-target')
  async handleSfuMuteTarget(
    @MessageBody() data: ClientSfuMuteTarget['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true; pausedProducers: number} | {ok: false; data: {code: string; message: string}}> {
    // Audit SFU-06 — resolve the tag scoped to THIS room. Without the hint,
    // firstTagFor fell back to insertion order, so a host who was a survivor
    // of a previously-ended call could resolve a stale tag → participant_not_
    // found (surfaced as an ack error for a moderation action on the live call).
    const byTag = this.firstTagFor(client, data.roomId);
    if (!byTag) return sfuError('no_active_participant');
    try {
      // Round 5 / Security S6 — authoriseMute is now async because it
      // actually pauses (or resumes) the mediasoup Producer server-
      // side. Pause stops RTP at the SFU regardless of whether the
      // target client honors the advisory frame.
      const {targetUserId, pausedProducers} = await this.sfu.authoriseMute(
        byTag, data.roomId, data.targetTag, {unmute: data.unmute === true},
      );
      const event = data.unmute ? 'sfu.unmuted' : 'sfu.muted';
      // Emit to the target's `sfutag:<tag>` room — delivered on whichever
      // pod holds the socket via the Redis adapter, so this works
      // cross-node without the old WeakMap-then-user-room fallback. The
      // target joined this room at sfu.join. `targetUserId` is no longer
      // needed for routing here (kept in the service return for logging).
      void targetUserId;
      this.hub.server?.to(sfuTagRoom(data.targetTag)).emit(event, {
        roomId: data.roomId, byTag,
      });
      return {ok: true, pausedProducers};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_mute_failed');
    }
  }

  @SubscribeMessage('sfu.kick')
  async handleSfuKick(
    @MessageBody() data: ClientSfuKick['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<{ok: true} | {ok: false; data: {code: string; message: string}}> {
    // Audit SFU-06 — scope the actor tag to this room (see mute-target).
    const byTag = this.firstTagFor(client, data.roomId);
    if (!byTag) return sfuError('no_active_participant');
    try {
      const {kickedTag} = await this.sfu.kick(byTag, data.roomId, data.targetTag);
      // Tell the kicked client via their `sfutag:<tag>` room so the signal
      // reaches them on whatever pod holds their socket (Redis fanout).
      // socket.io room membership is socket-side, so this still resolves
      // even though sfu.kick already removed them from the SFU room state.
      this.hub.server?.to(sfuTagRoom(kickedTag)).emit('sfu.kicked', {roomId: data.roomId, byTag});
      // Clean up our local tag → socket mapping + fanout-room membership
      // if the kicked socket lives on this pod.
      const targetSock = this.sfuTagToSocket.get(kickedTag);
      this.sfuTagToSocket.delete(kickedTag);
      if (targetSock) {
        const tags = this.sfuSocketTags.get(targetSock);
        if (tags) tags.delete(kickedTag);
        void targetSock.leave(sfuTagRoom(kickedTag));
        void targetSock.leave(sfuRoom(data.roomId));
      }
      return {ok: true};
    } catch (e) {
      return sfuError(e instanceof Error ? e.message : 'sfu_kick_failed');
    }
  }

  /**
   * Returns the SFU participant tag bound to this socket. When `roomId`
   * is provided, prefers the tag whose participant is in that room —
   * critical when a single socket holds two SFU sessions (rapid leave→
   * rejoin, or accept-incoming-call-mid-call). Without the roomId
   * preference, iteration order would silently pick the OLDER tag and
   * subsequent `sfu.produce`/`sfu.consume` would route against a torn-
   * down ParticipantState and surface as `participant_not_found`.
   * Falls back to insertion order if no roomId hint is given (legacy
   * call sites; their flows are in single-room scope so the fallback
   * is safe).
   */
  private firstTagFor(client: Socket, roomId?: string): string | null {
    const tags = this.sfuSocketTags.get(client);
    if (!tags || tags.size === 0) return null;
    if (roomId) {
      for (const tag of tags) {
        const info = this.sfu.resolveParticipantUser(tag);
        if (info && info.roomId === roomId) return tag;
      }
    }
    return tags.values().next().value as string;
  }

  // ─── Ephemeral signals (M11) ──────────────────────────────────────

  @SubscribeMessage('typing')
  async handleTyping(
    @MessageBody() data: ClientTyping['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    // Audit WS-HIGH — meter the fan-out signal (was unmetered).
    const limited = this.rateGate(client, 'typing');
    if (limited) return limited;
    // Why: M-07 — blocked pairs must not leak typing signals. Silent drop
    // (no error frame) so the block itself stays undetectable. Server leg
    // only: message delivery is NOT gated here (sealed sender hides it).
    if (await this.privacy.isBlockedEither(ctx.claims.sub, data.to.userId)) return undefined;
    const from = {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId};

    // Typing indicators are volatile — skip the online probe and skip
    // buffering. If the peer's socket has a full send queue we'd rather
    // drop the frame than delay a real message behind it.
    this.hub.server
      ?.to(this.hub.deviceRoom(data.to))
      .volatile
      .emit('typing', {from, state: data.state} satisfies ServerTyping['data']);

    const key = typingKey(from, data.to);
    const prev = this.typingTimers.get(key);
    if (prev) clearTimeout(prev);

    if (data.state === 'start') {
      const t = setTimeout(() => {
        this.hub.server
          ?.to(this.hub.deviceRoom(data.to))
          .volatile
          .emit('typing', {from, state: 'stop'} satisfies ServerTyping['data']);
        this.typingTimers.delete(key);
      }, TYPING_TIMEOUT_MS);
      (t as {unref?: () => void})?.unref?.();
      this.typingTimers.set(key, t);
    } else {
      this.typingTimers.delete(key);
    }
    return undefined;
  }

  @SubscribeMessage('read-receipt')
  async handleReadReceipt(
    @MessageBody() data: ClientReadReceipt['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    // Audit WS-HIGH — meter read-receipt fan-out (was unmetered).
    const limited = this.rateGate(client, 'read-receipt');
    if (limited) return limited;
    // Why: M-07 — silent drop when blocked; an error frame would be a
    // block oracle.
    if (await this.privacy.isBlockedEither(ctx.claims.sub, data.to.userId)) return undefined;
    const from = {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId};
    const frame: ServerReadReceipt = {
      event: 'read-receipt',
      data:  {from, envelopeIds: data.envelopeIds},
    };
    // P2-BR-11 / F7 — a ≤55s ZOMBIE socket (dead TCP, Doze-frozen) still
    // counts as "online" via deviceIsOnline() but never receives the emit, so
    // the old online→emit-only / offline→queue split lost receipts forever on
    // that window. ALWAYS enqueue to the durable queue AND attempt the live
    // emit; the drain is idempotent (receipts dedupe by (envelopeId, reader)
    // on the client), so a double delivery is harmless.
    try {
      await this.envelopes.queueReadReceipt(data.to, frame.data);
    } catch { /* best-effort — the live emit below may still deliver */ }
    try {
      if (await this.hub.deviceIsOnline(data.to)) {
        this.hub.server?.to(this.hub.deviceRoom(data.to)).emit(frame.event, frame.data);
      }
    } catch { /* best-effort — the durable queue above drains on reconnect */ }
    return undefined;
  }

  // ─── Presence ─────────────────────────────────────────────────────

  @SubscribeMessage('presence')
  async handlePresence(
    @MessageBody() data: ClientPresence['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'presence');
    if (limited) return limited;
    const next: PresenceState = data.state === 'active' ? 'active' : 'away';
    await this.presence.set(ctx.claims.sub, next);
    return undefined;
  }

  /**
   * Subscribe to a list of users' presence. Joins this socket to each
   * `watch:<userId>` room, then immediately emits a one-shot snapshot
   * so the client can paint its contact-status UI without waiting for
   * the next state transition.
   */
  @SubscribeMessage('presence.subscribe')
  async handlePresenceSubscribe(
    @MessageBody() data: ClientPresenceSubscribe['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'presence.subscribe');
    if (limited) return limited;
    const userIds = sanitizeUserIds(data?.userIds);
    if (userIds.length === 0) return undefined;
    // Why: M-07 — a blocked pair gets NO live watch (never joins the room)
    // and a plain-offline snapshot instead of an error, so a blocker cannot
    // be detected by probing presence.
    const blocked = await Promise.all(
      userIds.map(uid => this.privacy.isBlockedEither(ctx.claims.sub, uid)),
    );
    const watchable = userIds.filter((_, i) => !blocked[i]);
    if (watchable.length > 0) {
      await client.join(watchable.map(uid => this.presence.watchRoom(uid)));
    }
    const snapshot = await this.presence.getMany(watchable);
    const visible = await Promise.all(
      watchable.map(uid => this.privacy.isLastSeenVisible(uid)),
    );
    const visibleByUid = new Map(watchable.map((uid, i) => [uid, visible[i]]));
    for (let i = 0; i < userIds.length; i++) {
      const uid = userIds[i];
      const rec = snapshot[uid];
      // M-06 — strip lastSeenMs from the snapshot when the SUBJECT's
      // last_seen_visible is false; the state boolean is a separate toggle.
      const frame: ServerPresence = blocked[i] || !rec
        ? {event: 'presence', data: {userId: uid, state: 'offline'}}
        : {
            event: 'presence',
            data: visibleByUid.get(uid)
              ? {userId: uid, state: rec.state, lastSeenMs: rec.lastSeenMs}
              : {userId: uid, state: rec.state},
          };
      client.emit(frame.event, frame.data);
    }
    return undefined;
  }

  @SubscribeMessage('presence.unsubscribe')
  async handlePresenceUnsubscribe(
    @MessageBody() data: ClientPresenceUnsubscribe['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const limited = this.rateGate(client, 'presence.unsubscribe');
    if (limited) return limited;
    const userIds = sanitizeUserIds(data?.userIds);
    for (const uid of userIds) {
      await client.leave(this.presence.watchRoom(uid));
    }
    return undefined;
  }

  // ─── Envelope pull ────────────────────────────────────────────────

  @SubscribeMessage('envelope.pull')
  async handleEnvelopePull(
    @MessageBody() data: ClientEnvelopePull['data'],
    @ConnectedSocket() client: Socket,
  ): Promise<void | ServerError> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    // Audit WS-HIGH — meter the most expensive WS verb (was unmetered).
    const limited = this.rateGate(client, 'envelope.pull');
    if (limited) return limited;
    try {
      const bootstrap = data?.bootstrap === true;
      const envs = await this.envelopes.pull(
        {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId},
        data?.after ? Number.parseInt(data.after, 10) || 0 : 0,
        data?.limit ?? (bootstrap ? 1000 : 50),
        {bootstrap},
      );
      for (const env of envs) {
        const frame: ServerEnvelopeDeliver = {
          event: 'envelope.deliver',
          data: {
            envelopeId:  env.envelopeId,
            outerSealed: env.outerSealed,
            timestamp:   env.timestamp,
            // Audit P0-N9 — minted (or fetched) by service.pull.
            ackToken:    env.ackToken,
          },
        };
        client.emit(frame.event, frame.data);
      }
      return undefined;
    } catch (e) {
      return toError(e);
    }
  }

  // ─── helpers ──────────────────────────────────────────────────────

  // ─── Call-session bookkeeping ────────────────────────────────────
  // Helpers for the 1:1 P2P call lifecycle. See `callSessions` field
  // declaration for the full rationale.

  /**
   * Track a freshly-created call. Called from `call.offer` after
   * duplicate / tombstone checks have passed. Returns a structured
   * error if the callId is already known (active or in tombstone
   * window), else creates the session and links it to the caller's
   * socket so disconnect can fire bye.
   */
  private trackCallStart(
    client: Socket,
    callId: string,
    caller: {userId: string; deviceId: number},
    callee: {userId: string; deviceId: number},
  ): ServerError | undefined {
    this.gcCallTombstones();
    const existing = this.callSessions.get(callId);
    if (existing) {
      // Already exists in any state. Either:
      //   - state === 'ended' & still in tombstone window → reject as
      //     duplicate. Caller should regenerate callId on rapid redial.
      //   - state === 'ringing' / 'active' → it's an active call; the
      //     same caller can re-offer (renegotiation goes through the
      //     dedicated call.reoffer handler, not call.offer), so reject.
      return {event: 'error', data: {code: 'duplicate_call_id', message: `callId ${callId.slice(0, 8)} is already known (${existing.state})`}};
    }
    this.callSessions.set(callId, {
      callId, caller, callee,
      state: 'ringing', createdAt: Date.now(),
    });
    let owned = this.socketCalls.get(client);
    if (!owned) { owned = new Set(); this.socketCalls.set(client, owned); }
    owned.add(callId);
    return undefined;
  }

  /**
   * Verify the sender of a `call.*` frame is a participant in the
   * referenced callId. Returns null if the call is unknown or ended
   * (caller should treat as "ignore this frame"), or an error frame if
   * the sender isn't authorized. Returns the session on success.
   */
  private authorizeCallFrame(
    senderUserId: string,
    callId: string,
  ): {ok: true; session: CallSession} | {ok: false; err: ServerError} | {ok: false; ignore: true} {
    this.gcCallTombstones();
    const session = this.callSessions.get(callId);
    if (!session || session.state === 'ended') {
      // Frame for a call we don't track or that already ended. Don't
      // hand out an error to the sender (could be benign — e.g. a late
      // ICE for a hung-up call); silently drop.
      return {ok: false, ignore: true};
    }
    if (session.caller.userId !== senderUserId && session.callee.userId !== senderUserId) {
      // Cross-call mischief: a third party trying to hangup someone
      // else's call. Surface as auth_failed so the offending client
      // sees the rejection in its logs.
      return {ok: false, err: {event: 'error', data: {code: 'auth_failed', message: 'sender is not a participant in this call'}}};
    }
    return {ok: true, session};
  }

  /**
   * Bind callee's socket on the first `call.answer` so disconnect on
   * either side fires bye to the other.
   */
  private trackCallAnswer(
    client: Socket,
    callId: string,
  ): void {
    const s = this.callSessions.get(callId);
    if (!s) return;
    if (s.state === 'ringing') s.state = 'active';
    let owned = this.socketCalls.get(client);
    if (!owned) { owned = new Set(); this.socketCalls.set(client, owned); }
    owned.add(callId);
  }

  /**
   * Idempotent call end — flips to tombstone, NOT deletes. Tombstones
   * are GC'd by `gcCallTombstones` after CALL_TOMBSTONE_TTL_MS.
   */
  private trackCallEnd(callId: string): CallSession | undefined {
    const s = this.callSessions.get(callId);
    if (!s) return undefined;
    if (s.state !== 'ended') {
      s.state = 'ended';
      s.endedAt = Date.now();
    }
    return s;
  }

  /** Sweep ended sessions older than tombstone TTL. Called on any call.* hit. */
  private gcCallTombstones(): void {
    const cutoff = Date.now() - MessengerGateway.CALL_TOMBSTONE_TTL_MS;
    for (const [cid, s] of this.callSessions) {
      if (s.state === 'ended' && (s.endedAt ?? 0) < cutoff) {
        this.callSessions.delete(cid);
      }
    }
  }

  /**
   * P1-BR-5 / B-58 — schedule the disconnect-bye for a CONNECTED 1:1 call.
   * Fires after the grace window UNLESS `cancelCallDisconnectByes` clears it
   * first (same-device reconnect). At fire time we re-check the session so a
   * peer-hangup / answer during grace makes it a no-op.
   */
  private scheduleCallDisconnectBye(
    callId: string,
    who:  {userId: string; deviceId: number},
    peer: {userId: string; deviceId: number},
  ): void {
    const key = callGraceKey(callId, who.userId, who.deviceId);
    const prev = this.callDisconnectGrace.get(key);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      this.callDisconnectGrace.delete(key);
      const session = this.callSessions.get(callId);
      if (!session || session.state === 'ended') return; // resolved during grace
      this.trackCallEnd(callId);
      const target = this.hub.server?.to(this.hub.deviceRoom(peer));
      if (target) {
        target.emit('call.hangup', {callId, from: who, reason: 'failed'});
        this.logger.log(`[CALL] grace disconnect-bye cid=${callId.slice(0, 8)} → ${peer.userId.slice(0, 8)}/${peer.deviceId}`);
      }
    }, MessengerGateway.CALL_DISCONNECT_GRACE_MS);
    (timer as unknown as {unref?: () => void}).unref?.();
    this.callDisconnectGrace.set(key, {timer, userId: who.userId, deviceId: who.deviceId, peer, callId});
  }

  /** P1-BR-5 — cancel every deferred bye owned by this (user, device). */
  private cancelCallDisconnectByes(userId: string, deviceId: number): void {
    for (const [key, v] of this.callDisconnectGrace) {
      if (v.userId === userId && v.deviceId === deviceId) {
        clearTimeout(v.timer);
        this.callDisconnectGrace.delete(key);
      }
    }
  }

  /**
   * P1-BR-3 — headless / HTTP decline. Lets a killed-app client reject a ring
   * over a lightweight authenticated POST (no WS/runtime boot needed) so the
   * caller stops ringing instantly. Idempotent + best-effort: safe to call even
   * when the call is already gone (the CallsController always returns 200).
   *
   *   direct → tell the caller's devices `call.hangup{reason:'declined'}`, clear
   *            the DECLINING callee's own queued artifacts (drop the marker — a
   *            decline is not a missed call), and cancel-push the callee's OTHER
   *            devices so they stop ringing.
   *   group  → tell the room host `sfu.ring.declined`, and clear this member's
   *            queued group-ring artifacts.
   *
   * `caller` here is the DECLINING user (from the verified JWT), NOT the ring's
   * originator — `body.peerUserId` names the 1:1 originator.
   */
  async declineCallViaHttp(
    caller: {userId: string; deviceId: number},
    callId: string,
    body:   {peerUserId?: string; kind?: 'direct' | 'group'; roomId?: string},
  ): Promise<void> {
    if (body.kind === 'group') {
      const roomId = body.roomId || callId;
      const hostUserId = this.sfu.hostOf(roomId);
      if (hostUserId && hostUserId !== caller.userId) {
        this.hub.server?.to(this.hub.userRoom(hostUserId)).emit('sfu.ring.declined', {
          roomId, conversationId: '', from: caller,
        });
      }
      await this.clearPendingGroupRingArtifacts(caller.userId, roomId);
      return;
    }
    // 1:1 decline. Tombstone locally so any in-flight WS frames stop relaying.
    this.trackCallEnd(callId);
    if (body.peerUserId) {
      this.hub.server?.to(this.hub.userRoom(body.peerUserId)).emit('call.hangup', {
        callId, from: caller, reason: 'declined',
      });
    }
    // Drop the declining callee's own queued offer + marker (a decline is not a
    // missed call), keyed on the callee — the correct addressing from P1-14.
    await this.clearPendingCallArtifacts(caller.userId, caller.deviceId, callId);
    // Stop the callee's OTHER devices still ringing from the VoIP wake.
    void this.push.sendCallCancel(
      caller.userId, callId, body.peerUserId || caller.userId, 'voice', /*missed*/ false,
    ).catch(() => { /* best effort */ });
  }

  /**
   * Cross-node forward — probes `fetchSockets` so the caller sees a
   * definitive `peer_offline` even when the callee is on another
   * replica. Set `volatile=true` for frames that are safe to drop
   * (typing / presence broadcasts).
   */
  private async forwardToDevice<T extends {event: string; data: unknown}>(
    client: Socket,
    to: {userId: string; deviceId: number},
    volatile: boolean,
    buildFrame: (from: {userId: string; deviceId: number}) => T,
  ): Promise<ServerError | void> {
    const ctx = client.data as SocketContext | undefined;
    if (!ctx) return authMissing();
    const from = {userId: ctx.claims.sub, deviceId: ctx.signalDeviceId};

    const online = await this.hub.deviceIsOnline(to);
    if (!online) {
      return {event: 'error', data: {code: 'peer_offline', message: 'callee not connected'}};
    }
    const frame = buildFrame(from);
    const target = this.hub.server?.to(this.hub.deviceRoom(to));
    if (volatile && target) {
      target.volatile.emit(frame.event, frame.data);
    } else if (target) {
      target.emit(frame.event, frame.data);
    }
    return undefined;
  }

  private clearTypingTimersFrom(userId: string, deviceId: number): void {
    const prefix = `${userId}:${deviceId}->`;
    for (const [k, t] of this.typingTimers) {
      if (k.startsWith(prefix)) {
        clearTimeout(t);
        this.typingTimers.delete(k);
      }
    }
  }
}

/**
 * Offer that landed while the callee was offline. Persists for ~45s in
 * Redis so the callee's WS-open handler can replay it as a `call.offer`
 * frame the moment they reconnect — pairing with the VoIP push wake
 * gives users the "ring even when not in the app" experience.
 */
interface PendingCallOffer {
  callId: string;
  from:   {userId: string; deviceId: number};
  sdp:    string;
  kind:   'voice' | 'video';
  /** epoch ms — used to skip replay of stale offers. */
  at:     number;
  /**
   * Audit S7 — caller's signed AAD. Pass-through; the relay never
   * verifies. Persisted with the queued offer so the WS-open replay
   * delivers the SAME auth block the original offerer minted (replaying
   * with a stripped auth would force the callee into legacy fallback
   * and re-open the spoof window).
   */
  auth?:  CallOfferAuthBlock;
}

/**
 * Per-callId Redis key for queued offline offers. Previously the key
 * was just `${userId}:${deviceId}` — a SECOND caller dialing the same
 * offline recipient within the 45s TTL silently OVERWROTE the first
 * caller's offer, who then saw nothing while their target rang for
 * the second caller. Scoping by callId means up to N concurrent
 * offers can wait per recipient device. The connect-time drain (see
 * `pendingOfferIndexKey`) enumerates them via a Redis SET and emits
 * each in arrival order.
 */
function pendingOfferKey(userId: string, deviceId: number, callId: string): string {
  return `pending-call-offer:${userId}:${deviceId}:${callId}`;
}
/** SET of callIds with queued offers for a (user,device) pair. */
function pendingOfferIndexKey(userId: string, deviceId: number): string {
  return `pending-call-offer-idx:${userId}:${deviceId}`;
}

/**
 * N-02 — slim missed-call marker (no SDP). The pending offer payload lives only
 * 45s, so the old payload-based `call.missed` emit on reconnect was effectively
 * dead code (the payload had already expired by the time its age crossed the
 * >45s threshold that would have emitted it). This marker carries just enough
 * to render a "Missed call" on reconnect, and lives long enough that a
 * killed/Dozed device that reconnects minutes-to-hours later still learns it
 * missed a call — bounded so markers can't accumulate unboundedly.
 */
const MISSED_CALL_MARKER_TTL_SEC = 6 * 60 * 60; // 6h
interface MissedCallMarker {
  callId: string;
  from:   {userId: string; deviceId: number};
  kind:   'voice' | 'video';
  at:     number;
}
function missedCallMarkerKey(userId: string, deviceId: number, callId: string): string {
  return `missed-call-marker:${userId}:${deviceId}:${callId}`;
}

/** P1-BR-5 — grace-timer key so a reconnect can cancel the deferred bye. */
function callGraceKey(callId: string, userId: string, deviceId: number): string {
  return `${callId}::${userId}::${deviceId}`;
}

/**
 * P2-BR-9 — group-call ring queued for an offline member. Payload (incl. the
 * per-recipient room token) lives 45s so a quick reconnect rings live; the slim
 * missed-marker outlives it (6h) so a later reconnect still learns it missed a
 * group call. Group rings target userIds (server has no view of group device
 * membership), so these keys are per-user, not per-device.
 */
interface PendingGroupRing {
  roomId:         string;
  conversationId: string;
  callType:       'voice' | 'video';
  from:           {userId: string; deviceId: number};
  callerName:     string;
  roomToken:      string;
  roomTokenExp:   number;
  at:             number;
}
interface MissedGroupCallMarker {
  roomId:         string;
  conversationId: string;
  from:           {userId: string; deviceId: number};
  callType:       'voice' | 'video';
  at:             number;
}
function pendingGroupRingKey(userId: string, roomId: string): string {
  return `pending-group-ring:${userId}:${roomId}`;
}
function pendingGroupRingIndexKey(userId: string): string {
  return `pending-group-ring-idx:${userId}`;
}
function missedGroupCallMarkerKey(userId: string, roomId: string): string {
  return `missed-group-call-marker:${userId}:${roomId}`;
}

/**
 * Audit P0-T1 — extract `token` and `signalDeviceId` from the socket.io
 * handshake. Preference order:
 *   1. `socket.handshake.auth` — the Socket.IO `auth` payload travels
 *      inside the WebSocket upgrade body (Engine.IO `0{"token":...}`
 *      packet), NOT in the URL. Reverse proxies, CDN access logs, and
 *      browser history don't see it.
 *   2. `socket.handshake.query` — legacy form. The token rides the URL
 *      and ends up in nginx / ALB / Cloudflare access logs. Kept for
 *      one rollout release so old clients still authenticate; emits a
 *      `[P0-T1] handshake_token_via_query` warning so we can spot any
 *      client that hasn't moved over before the fallback is removed.
 *
 * Removal plan: once telemetry shows 100% of connects carry the token
 * via auth, drop the query branch entirely and reject with
 * `missing_token` for any client still using the URL form.
 */
export function extractHandshakeParams(socket: Socket): {token: string | null; signalDeviceId: number | null; source: 'auth' | 'query' | 'none'} {
  const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;
  const authToken = typeof auth.token === 'string' && auth.token.length > 0 ? auth.token : null;
  const authDevRaw = auth.signalDeviceId;
  const authDev = typeof authDevRaw === 'number' && Number.isFinite(authDevRaw)
    ? authDevRaw
    : (typeof authDevRaw === 'string' ? Number.parseInt(authDevRaw, 10) : NaN);
  if (authToken && Number.isFinite(authDev) && authDev >= 1) {
    return {token: authToken, signalDeviceId: authDev, source: 'auth'};
  }

  const q = socket.handshake.query ?? {};
  const rawToken = Array.isArray(q['token']) ? q['token'][0] : q['token'];
  const rawDev   = Array.isArray(q['signalDeviceId']) ? q['signalDeviceId'][0] : q['signalDeviceId'];
  const token    = typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : null;
  const n        = typeof rawDev === 'string' ? Number.parseInt(rawDev, 10) : NaN;
  const signalDeviceId = Number.isFinite(n) && n >= 1 ? n : null;
  return {token, signalDeviceId, source: token ? 'query' : 'none'};
}

/**
 * socket.io surfaces middleware rejections to the client as
 * `connect_error` with `err.data` attached. We embed the same
 * `{code, message}` shape our other error frames use so the RN client
 * can key off `code === 'unauthorized'` uniformly.
 */
function handshakeError(reason: string): Error & {data: {code: string; message: string}} {
  const code = reason === 'missing_token' || reason === 'missing_signal_device_id'
    ? 'unauthorized'
    : 'unauthorized';
  const err = new Error(reason) as Error & {data: {code: string; message: string}};
  err.data = {code, message: reason};
  return err;
}

function authMissing(): ServerError {
  return {event: 'error', data: {code: 'unauthenticated', message: 'no socket context'}};
}

function toError(e: unknown): ServerError {
  const msg = e instanceof Error ? e.message : String(e);
  const code =
    msg.includes('invalid_recipient') ? 'bad_request' :
    msg.includes('invalid_ciphertext') ? 'bad_request' :
    msg.includes('ciphertext_too_large') ? 'too_large' :
    msg.includes('not_recipient') ? 'forbidden' :
    'internal';
  return {event: 'error', data: {code, message: msg}};
}

function typingKey(
  from: {userId: string; deviceId: number},
  to:   {userId: string; deviceId: number},
): string {
  return `${from.userId}:${from.deviceId}->${to.userId}:${to.deviceId}`;
}

/** Strip non-strings, trim, cap at 200 ids per subscribe to bound work. */
function sanitizeUserIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t.length === 0 || t.length > 128) continue;
    out.push(t);
    if (out.length >= 200) break;
  }
  return out;
}
