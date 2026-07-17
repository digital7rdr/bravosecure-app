import {BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException, type OnModuleInit, type OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {randomUUID, randomBytes} from 'node:crypto';
import type {types as MS} from 'mediasoup';
import {SfuWorkerPool} from './sfuWorkerPool';
import type {RoomId, SfuRoom, SfuRouterRtpCapabilities, SfuTransportParams} from './sfu.types';

/**
 * Per-room participant cap. Mesh-WebRTC dies around 5; mediasoup itself
 * scales to dozens but the client tile grid + Opus mixing degrade fast
 * past 6, and 6 is the WhatsApp-parity cap the product chose.
 */
const MAX_PARTICIPANTS_PER_ROOM = 6;

/**
 * mediasoup SFU — Phase-2 implementation.
 *
 *   • createRoom    → picks a Worker, creates a Router on it.
 *   • joinRoom      → creates a send + recv WebRtcTransport pair,
 *                     returns transport params + router rtpCapabilities.
 *   • connectTransport → completes DTLS handshake on a transport.
 *   • produce       → registers a media producer (audio/video) on a
 *                     send transport; broadcasts `new-producer` to peers.
 *   • consume       → server-side `Router.canConsume` → creates a
 *                     Consumer on the recv transport; returns the
 *                     RTP params the client uses to spawn a remote track.
 *   • leaveRoom     → closes all per-participant resources.
 *
 * Security invariants:
 *   - SFU sees SRTP-encrypted media only — mediasoup's media plane
 *     never decrypts the stream. The DTLS-SRTP handshake terminates
 *     between client and server, but the *content* is still SRTP that
 *     mediasoup just routes.
 *   - `participantTag` is a fresh `randomUUID` per joinRoom so the
 *     SFU access log never sees the caller's userId.
 *   - `roomId` is generated server-side (16 bytes hex). Clients never
 *     supply it directly — they ask `createRoom` and store the
 *     opaque id; even the server does not associate it with the
 *     conversation.
 */
@Injectable()
export class SfuService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SfuService.name);

  /** Live rooms keyed by roomId. */
  private readonly rooms = new Map<RoomId, RoomState>();
  /** Live participants keyed by participantTag. */
  private readonly participants = new Map<string, ParticipantState>();
  /** Zombie-room sweeper handle. Created in onModuleInit. */
  private zombieSweeper: ReturnType<typeof setInterval> | null = null;
  /** Rooms older than this with zero participants are GC'd. */
  private static readonly ZOMBIE_ROOM_GRACE_MS = 60_000;
  private static readonly ZOMBIE_SWEEP_INTERVAL_MS = 30_000;

  /**
   * conversationId → roomId index. Lets a 2nd member tapping the phone
   * icon in the same group chat join the existing call instead of
   * creating a parallel ghost room. Cleared on `leaveRoom` of the last
   * participant. The conversationId itself is supplied by the caller —
   * the SFU never sees plaintext, but knows the conversation id is
   * the chat group's UUID (treated as opaque).
   */
  private readonly groupRoomIndex = new Map<string, RoomId>();

  /** Server → client frame fanout — bound at module init from the gateway. */
  private fanout: ((tag: string, frame: unknown) => void) | null = null;
  private broadcastToRoom: ((roomId: string, frame: unknown, exceptTag?: string) => void) | null = null;

  /**
   * Set at boot by validateAnnouncedIp() when the SFU plane must be
   * refused (fail closed) — e.g. a production deploy behind NAT with no
   * SFU_ANNOUNCED_IP configured, which would advertise unroutable ICE
   * candidates and silently fail 100% of cross-NAT group calls. Non-null
   * → createRoom throws so no call is ever admitted onto a broken plane.
   */
  private sfuDisabledReason: string | null = null;

  constructor(
    private readonly pool: SfuWorkerPool,
    private readonly cfg:  ConfigService,
  ) {}

  onModuleInit(): void {
    // Fail-closed boot gate for the announced-IP misconfiguration (see
    // validateAnnouncedIp) — must run before any room can be created.
    this.validateAnnouncedIp();
    // Zombie-room sweeper. A room can become a zombie when:
    //   - createRoom returns successfully (router built, slot reserved)
    //     but the client never follows up with sfu.join (rapid leave-
    //     during-boot, app crash mid-handshake, network hiccup).
    //   - the host leaves and the inline cleanup misses a participant
    //     bookkeeping detail and the room map keeps the entry.
    // Without a sweeper the entry would sit until process restart, and
    // findRoomForConversation would hand the dead room to the next
    // caller as a stale rendezvous (caller joins → no peers → marked
    // host of a corpse).
    this.zombieSweeper = setInterval(() => this.sweepZombieRooms(), SfuService.ZOMBIE_SWEEP_INTERVAL_MS);
    // Don't keep the Node process alive for the timer alone — Nest
    // shutdown should be free to exit.
    if (this.zombieSweeper && typeof (this.zombieSweeper as {unref?: () => void}).unref === 'function') {
      (this.zombieSweeper as {unref: () => void}).unref();
    }
    this.log.debug(`zombie-room sweeper armed interval=${SfuService.ZOMBIE_SWEEP_INTERVAL_MS}ms grace=${SfuService.ZOMBIE_ROOM_GRACE_MS}ms`);
  }

  onModuleDestroy(): void {
    if (this.zombieSweeper) {
      clearInterval(this.zombieSweeper);
      this.zombieSweeper = null;
    }
  }

  /**
   * Boot-time guard for `SFU_ANNOUNCED_IP`. A deploy behind NAT (AWS,
   * Contabo, any container host) that forgets this var leaves
   * `createWebRtcTransport` announcing the bind IP — `0.0.0.0` (or a
   * loopback) — so every ICE candidate the SFU hands out is unroutable
   * and 100% of cross-NAT group calls silently fail with no server-side
   * error. This is invisible until a real 2-device call is attempted.
   *
   * Behaviour:
   *   - Always LOG LOUD when the announced IP is unset / 0.0.0.0 / loopback.
   *   - In production, additionally FAIL CLOSED — refuse to enable the SFU
   *     plane (createRoom throws) so calls fail fast and visibly instead of
   *     black-holing media. An explicit `SFU_ALLOW_UNANNOUNCED=1` override
   *     keeps the old behaviour for single-host / host-network deploys where
   *     the bind IP really is routable.
   */
  private validateAnnouncedIp(): void {
    const announced = (this.cfg.get<string>('sfu.announcedIp') ?? '').trim();
    // Unroutable-from-a-peer set: empty (unset), the wildcard bind, and
    // loopback in v4/v6 forms.
    const UNROUTABLE = new Set(['', '0.0.0.0', '127.0.0.1', 'localhost', '::', '::1']);
    if (!UNROUTABLE.has(announced.toLowerCase())) return; // properly configured

    const nodeEnv = this.cfg.get<string>('nodeEnv') ?? process.env['NODE_ENV'] ?? 'development';
    const allowUnannounced = process.env['SFU_ALLOW_UNANNOUNCED'] === '1';
    const detail = announced ? `'${announced}'` : 'unset';
    const base =
      `SFU_ANNOUNCED_IP is ${detail} — WebRtcTransport will advertise unroutable ICE ` +
      `candidates and cross-NAT group calls will silently fail. Set SFU_ANNOUNCED_IP to ` +
      `this host's public IP.`;

    if (nodeEnv === 'production' && !allowUnannounced) {
      this.sfuDisabledReason = 'sfu_announced_ip_unconfigured';
      this.log.error(
        `${base} Refusing to enable the SFU plane in production (fail closed). ` +
        `Set SFU_ALLOW_UNANNOUNCED=1 to override for host-network deploys.`,
      );
      return;
    }
    this.log.error(base);
  }

  private sweepZombieRooms(): void {
    const cutoff = Date.now() - SfuService.ZOMBIE_ROOM_GRACE_MS;
    let reaped = 0;
    for (const [rid, room] of this.rooms) {
      if (room.participantTags.size === 0 && room.createdAt < cutoff) {
        // Delete registry state BEFORE closing the router so the router's
        // close observer (onRouterClosed) sees no live room and treats this
        // as an intentional teardown (no-op) rather than a worker death.
        this.rooms.delete(rid);
        if (room.conversationId) {
          // Only clear the conversation index if it's still pointing
          // at THIS roomId — a fresh room may have replaced it.
          if (this.groupRoomIndex.get(room.conversationId) === rid) {
            this.groupRoomIndex.delete(room.conversationId);
          }
        }
        // Best-effort router close. RoomState's router is a mediasoup
        // Router; calling close() reaps all transports/producers/
        // consumers. Wrapped in try because the router may already be
        // closed by a previous error path.
        try { (room.router as {close?: () => void}).close?.(); } catch { /* ignore */ }
        reaped++;
      }
    }
    if (reaped > 0) {
      this.log.warn(`zombie-room sweep reaped ${reaped} room(s)`);
    }
  }

  /**
   * The gateway calls this once during module init to wire WS fanout.
   * Keeping the dependency one-way means SfuService doesn't import the
   * gateway (which would create a cycle).
   */
  bindFanout(opts: {
    toParticipant: (tag: string, frame: unknown) => void;
    toRoom:        (roomId: string, frame: unknown, exceptTag?: string) => void;
  }): void {
    this.fanout = opts.toParticipant;
    this.broadcastToRoom = opts.toRoom;
  }

  // ─── Room lifecycle ─────────────────────────────────────────────

  async createRoom(opts?: {conversationId?: string; hostUserId?: string}): Promise<SfuRoom> {
    // Fail-closed on a misconfigured announced IP (validateAnnouncedIp) —
    // don't hand out rooms whose ICE candidates no peer can reach.
    if (this.sfuDisabledReason) throw new ServiceUnavailableException(this.sfuDisabledReason);
    // Idempotency: if there's already a live room for this conversation,
    // hand back its id instead of creating a parallel one. Without this,
    // two members tapping "call" within the same second each get their
    // own room and end up alone. The first creator wins.
    if (opts?.conversationId) {
      const existing = this.groupRoomIndex.get(opts.conversationId);
      if (existing && this.rooms.has(existing)) {
        this.log.debug(`room.reuse cid=${opts.conversationId} → ${existing}`);
        return {roomId: existing, createdAt: Date.now(), participants: []};
      }
    }
    const router = await this.pool.createRouter();
    const roomId = randomBytes(16).toString('hex');
    this.rooms.set(roomId, {
      router,
      participantTags: new Set(),
      conversationId: opts?.conversationId,
      hostUserId:     opts?.hostUserId,
      createdAt:      Date.now(),
    });
    if (opts?.conversationId) this.groupRoomIndex.set(opts.conversationId, roomId);
    // Why: reconcile the registry whenever this Router closes WITHOUT going
    // through one of our own teardown paths — the canonical cause is a
    // mediasoup Worker death, which closes every Router on the dead worker
    // out from under us (mediasoup fires observer 'close' on worker death).
    // Our intentional teardowns delete the room from `rooms` BEFORE calling
    // router.close(), so onRouterClosed is a no-op for them and only does
    // real work on an unexpected close. Without this, a dead worker leaves a
    // room whose Router is gone but whose registry entry survives — the
    // zombie sweeper never reaps it (it still has participants),
    // findRoomForConversation hands out the corpse, and the rejoin's
    // createWebRtcTransport throws on the dead Router → the conversation's
    // group calls are bricked until process restart.
    router.observer.once('close', () => this.onRouterClosed(roomId));
    this.log.debug(`room.create id=${roomId} cid=${opts?.conversationId ?? '-'} host=${opts?.hostUserId ?? '-'}`);
    return {roomId, createdAt: Date.now(), participants: []};
  }

  /**
   * Router-close reconciliation (P2-1). Fires from `router.observer.once
   * ('close')`. Reaching here with the room STILL registered means the
   * Router closed WITHOUT one of our teardown paths (which delete the room
   * first) — i.e. the backing mediasoup Worker died and took the Router
   * with it. Purge the room + its participants so the registry can't hand
   * out a corpse, and tell any survivors to tear down and rejoin (which
   * creates a fresh room on a healthy worker). Idempotent: a no-op once the
   * room is gone, so intentional closes fall straight through.
   */
  private onRouterClosed(roomId: RoomId): void {
    const room = this.rooms.get(roomId);
    if (!room) return; // intentional teardown already purged it — nothing to do

    const survivors = Array.from(room.participantTags);
    // Delete registry state FIRST so any re-entrant close/leave is a no-op.
    this.rooms.delete(roomId);
    if (room.conversationId && this.groupRoomIndex.get(room.conversationId) === roomId) {
      this.groupRoomIndex.delete(room.conversationId);
    }
    for (const tag of survivors) {
      this.participants.delete(tag);
      this.mutedProducerIdsByTag.delete(tag);
    }
    if (survivors.length > 0) {
      // Tell the room its backing Router is gone so clients tear down and
      // re-create/re-join rather than talking into a dead SFU.
      this.broadcastToRoom?.(roomId, {
        event: 'sfu.room.ended',
        data:  {roomId, reason: 'worker_died'},
      });
    }
    this.log.warn(
      `router-close reconcile: purged room=${roomId} participants=${survivors.length} ` +
      `(worker death or external close) — next call rebuilds on a healthy worker`,
    );
  }

  /**
   * Look up a live roomId for a conversation. Returns null when no call
   * is in progress. Used by the mobile client before tapping "call" so
   * a second member joins the existing room instead of starting a new one.
   */
  findRoomForConversation(conversationId: string): RoomId | null {
    const rid = this.groupRoomIndex.get(conversationId);
    if (rid) {
      const room = this.rooms.get(rid);
      // A room with active participants is live — hand it out.
      if (room && room.participantTags.size > 0) return rid;
      // Audit row #5 (M3) — fresh-room grace. A freshly-created room
      // sits with `participantTags.size === 0` for the window between
      // POST /sfu/rooms and the host's first sfu.join (typically 2-10s
      // on cold permission grants). Reaping during that window would
      // yank the room out from under the host — they'd come back with
      // their token and hit `room_not_found`. The grace below holds
      // reap until the room is older than FRESH_ROOM_GRACE_MS; after
      // that, zero-participant rooms are treated as zombies and reaped
      // as before.
      const FRESH_ROOM_GRACE_MS = 30_000;
      if (room && Date.now() - room.createdAt < FRESH_ROOM_GRACE_MS) {
        return rid;
      }
      // Zero participants past the grace window — zombie waiting for
      // the sweeper. Don't hand it out — the next caller would join
      // an empty room and become host of a corpse. Eagerly reap so a
      // fresh createRoom replaces it cleanly.
      if (room) {
        // Delete BEFORE close so onRouterClosed treats this as intentional.
        this.rooms.delete(rid);
        try { (room.router as {close?: () => void}).close?.(); } catch { /* ignore */ }
      }
      this.groupRoomIndex.delete(conversationId);
    }
    return null;
  }

  async joinRoom(roomId: RoomId, userId: string): Promise<{
    routerRtpCapabilities: SfuRouterRtpCapabilities;
    sendTransport:         SfuTransportParams;
    recvTransport:         SfuTransportParams;
    participantTag:        string;
    /** True when the joining user owns moderation rights (mute / kick). */
    isHost:                boolean;
    existingProducers: Array<{producerId: string; participantTag: string; kind: 'audio' | 'video'}>;
  }> {
    const room = this.rooms.get(roomId);
    if (!room) throw new NotFoundException('room_not_found');

    // Audit SFU-05 (2026-07-02): supersede a stale participant for the SAME
    // user before admitting the new join. A client that retries sfu.join after
    // a slow/lost ack (the first join actually succeeded server-side) otherwise
    // leaves the first participant alive — it holds a slot against the 6-cap,
    // fired a phantom participant.joined, and lingers until socket disconnect,
    // so a 5-person call could hit room_full. Single-device model, so matching
    // by userId is correct. Done BEFORE the cap check so a legit rejoin at cap
    // isn't rejected as full. Quiet supersede — broadcast `left` for the ghost
    // so peers drop the stale tile, then the join below broadcasts `joined`.
    for (const staleTag of Array.from(room.participantTags)) {
      const stale = this.participants.get(staleTag);
      if (stale && stale.userId === userId) {
        try { stale.sendTransport.close(); } catch { /* already closed */ }
        try { stale.recvTransport.close(); } catch { /* already closed */ }
        this.participants.delete(staleTag);
        room.participantTags.delete(staleTag);
        this.broadcastToRoom?.(roomId, {
          event: 'sfu.participant.left',
          data:  {roomId, participantTag: staleTag},
        }, staleTag);
      }
    }

    // 6-cap. WhatsApp-parity choice — see MAX_PARTICIPANTS_PER_ROOM.
    // Throw a typed error so the gateway can surface `room_full` cleanly
    // and the client can show "Call full (6/6)" instead of a generic fail.
    if (room.participantTags.size >= MAX_PARTICIPANTS_PER_ROOM) {
      throw new ForbiddenException('room_full');
    }

    // First joiner is the host if no host was set at create time. Cover
    // the path where `createRoom()` was called without `hostUserId`
    // (e.g. legacy tests).
    if (!room.hostUserId) room.hostUserId = userId;

    // Ephemeral tag — opaque to the client, opaque in the SFU log.
    const participantTag = randomUUID();

    // Why: if recv-transport creation throws after the send transport was
    // built, the send transport would leak — its ICE ports + file
    // descriptors stay pinned on the router until the whole room closes.
    // Close whatever we managed to create before propagating the failure.
    let sendTx!: MS.WebRtcTransport;
    let recvTx!: MS.WebRtcTransport;
    try {
      sendTx = await this.createWebRtcTransport(room.router);
      recvTx = await this.createWebRtcTransport(room.router);
    } catch (e) {
      try { (sendTx as MS.WebRtcTransport | undefined)?.close(); } catch { /* already closed */ }
      try { (recvTx as MS.WebRtcTransport | undefined)?.close(); } catch { /* already closed */ }
      throw e;
    }

    const participant: ParticipantState = {
      tag:        participantTag,
      userId,                         // tracked here to route `toParticipant` → socket
      roomId,
      sendTransport: sendTx,
      recvTransport: recvTx,
      producers:  new Map(),
      consumers:  new Map(),
    };
    this.participants.set(participantTag, participant);
    room.participantTags.add(participantTag);

    // Snapshot existing producers so the joiner can immediately consume
    // everyone else's media on connect.
    const existingProducers = this.snapshotProducers(roomId, participantTag);

    // Notify others in the room that a new participant joined.
    this.broadcastToRoom?.(roomId, {
      event: 'sfu.participant.joined',
      data:  {roomId, participantTag},
    }, participantTag);

    return {
      routerRtpCapabilities: room.router.rtpCapabilities as SfuRouterRtpCapabilities,
      sendTransport:         this.transportToParams(sendTx),
      recvTransport:         this.transportToParams(recvTx),
      participantTag,
      isHost:                room.hostUserId === userId,
      existingProducers,
    };
  }

  /**
   * Host-only mute.
   *
   * Round 5 / Security S6 — we now actually pause the target's audio
   * producer(s) on the mediasoup Router. Previously this was a pure
   * authorisation check + a `sfu.muted` advisory frame to the target,
   * trusting the muted client to honor it via track.enabled=false. A
   * patched client that ignores the advisory could keep speaking.
   *
   * Pausing the producer server-side stops media at the SFU itself —
   * RTP packets the target sends never reach peers regardless of
   * client cooperation. We still emit `sfu.muted` to the target so
   * their UI flips state; we ALSO emit it to the host as confirmation
   * the pause landed.
   *
   * `unmute` is the inverse — only the host (or the muted user
   * themselves, if we want self-unmute later) can resume. For now,
   * any host can resume any target.
   *
   * Tracked per-target so we can verify the producer was actually
   * paused when unmute fires: `mutedProducerIdsByTag[tag]` holds the
   * set of producer ids the host paused. Without tracking, we'd
   * either resume EVERY producer (including ones the client itself
   * paused locally for unrelated reasons) or get out-of-sync between
   * server pause-state and our own bookkeeping.
   */
  async authoriseMute(byTag: string, roomId: RoomId, targetTag: string, opts?: {unmute?: boolean}): Promise<{
    targetUserId: string;
    targetRoomId: RoomId;
    pausedProducers: number;
  }> {
    const by = this.requireParticipant(byTag);
    const room = this.rooms.get(roomId);
    if (!room) throw new NotFoundException('room_not_found');
    if (by.roomId !== roomId) throw new ForbiddenException('not_in_room');
    if (room.hostUserId !== by.userId) throw new ForbiddenException('not_host');
    const target = this.participants.get(targetTag);
    if (!target || target.roomId !== roomId) throw new NotFoundException('participant_not_found');
    if (target.tag === by.tag) throw new BadRequestException('cannot_mute_self_via_host');

    const unmute = opts?.unmute === true;
    let touched = 0;
    if (unmute) {
      // Resume only the producers we ourselves paused — leaves any
      // client-side pauses untouched.
      const muted = this.mutedProducerIdsByTag.get(targetTag);
      if (muted) {
        for (const pid of muted) {
          const prod = target.producers.get(pid);
          if (!prod) continue;
          try { await prod.resume(); touched += 1; } catch (e) {
            this.log.warn(`mute.resume failed pid=${pid} target=${targetTag} err=${(e as Error).message}`);
          }
        }
        this.mutedProducerIdsByTag.delete(targetTag);
      }
    } else {
      // Pause every audio producer the target owns. Video stays alive
      // — host moderation is about silencing the room, not blanking
      // the tile. (If we ever add a "kick from video" action it'd be
      // a separate authoriseMuteVideo with its own per-tag tracking.)
      const pausedSet = this.mutedProducerIdsByTag.get(targetTag) ?? new Set<string>();
      for (const [pid, prod] of target.producers) {
        if (prod.kind !== 'audio') continue;
        if (pausedSet.has(pid)) continue;       // already paused by us
        try { await prod.pause(); pausedSet.add(pid); touched += 1; } catch (e) {
          this.log.warn(`mute.pause failed pid=${pid} target=${targetTag} err=${(e as Error).message}`);
        }
      }
      this.mutedProducerIdsByTag.set(targetTag, pausedSet);
    }
    this.log.debug(`mute.${unmute ? 'unmute' : 'apply'} byTag=${byTag} target=${targetTag} touched=${touched}`);
    return {targetUserId: target.userId, targetRoomId: target.roomId, pausedProducers: touched};
  }

  /**
   * Round 5 / Security S6 — track which producers the host has paused
   * server-side. Cleared on participant leave / room close.
   */
  private readonly mutedProducerIdsByTag = new Map<string, Set<string>>();

  /**
   * Host-only kick. Closes the target's transports + cleans up state +
   * broadcasts `participant.left` to peers. Returns the kicked tag so
   * the gateway can send `sfu.kicked` to the booted client.
   */
  async kick(byTag: string, roomId: RoomId, targetTag: string): Promise<{kickedTag: string}> {
    const by = this.requireParticipant(byTag);
    const room = this.rooms.get(roomId);
    if (!room) throw new NotFoundException('room_not_found');
    if (by.roomId !== roomId) throw new ForbiddenException('not_in_room');
    if (room.hostUserId !== by.userId) throw new ForbiddenException('not_host');
    const target = this.participants.get(targetTag);
    if (!target || target.roomId !== roomId) throw new NotFoundException('participant_not_found');
    if (target.tag === by.tag) throw new BadRequestException('cannot_kick_self');
    await this.leaveRoom(targetTag);
    return {kickedTag: targetTag};
  }

  /** Read-only view of the host userId for a room — gateway uses this for ring fanout. */
  hostOf(roomId: RoomId): string | null {
    return this.rooms.get(roomId)?.hostUserId ?? null;
  }

  async connectTransport(participantTag: string, transportId: string, dtlsParameters: MS.DtlsParameters): Promise<void> {
    const p = this.requireParticipant(participantTag);
    const tx = this.matchTransport(p, transportId);
    await tx.connect({dtlsParameters});
  }

  /**
   * Weak-network ICE restart. Called when the client's mediasoup-client
   * transport reports `connectionstatechange === 'disconnected'`.
   *
   * mediasoup's `transport.restartIce()` reallocates ICE ufrag/pwd on
   * the SAME WebRtcTransport (no router teardown, no producer/consumer
   * loss) and returns fresh iceParameters. The client applies them via
   * `transport.restartIce({iceParameters})`, the engine re-gathers
   * candidates against the existing TURN allocation, and media resumes.
   * DTLS context survives the restart, so the verified-cipher pair from
   * the original handshake is reused.
   */
  async restartTransportIce(participantTag: string, transportId: string): Promise<MS.IceParameters> {
    const p = this.requireParticipant(participantTag);
    const tx = this.matchTransport(p, transportId);
    const iceParameters = await tx.restartIce();
    return iceParameters;
  }

  async produce(participantTag: string, transportId: string, kind: 'audio' | 'video', rtpParameters: MS.RtpParameters): Promise<{producerId: string}> {
    const p = this.requireParticipant(participantTag);
    const tx = this.matchTransport(p, transportId);
    if (tx !== p.sendTransport) throw new BadRequestException('produce_on_recv_transport');

    const producer = await tx.produce({kind, rtpParameters});
    p.producers.set(producer.id, producer);

    // Tear down on producer close.
    producer.on('transportclose', () => {
      p.producers.delete(producer.id);
    });

    // Fan out to peers in the room so they spawn a Consumer.
    this.broadcastToRoom?.(p.roomId, {
      event: 'sfu.new-producer',
      data: {
        roomId:         p.roomId,
        producerId:     producer.id,
        participantTag,
        kind,
      },
    }, participantTag);

    return {producerId: producer.id};
  }

  async consume(participantTag: string, transportId: string, producerId: string, rtpCapabilities: MS.RtpCapabilities): Promise<{
    consumerId:    string;
    producerId:    string;
    kind:          'audio' | 'video';
    rtpParameters: unknown;
    participantTag: string;
    producerPaused: boolean;
  }> {
    const p = this.requireParticipant(participantTag);
    const tx = this.matchTransport(p, transportId);
    if (tx !== p.recvTransport) throw new BadRequestException('consume_on_send_transport');

    const room = this.rooms.get(p.roomId);
    if (!room) throw new NotFoundException('room_not_found');

    if (!room.router.canConsume({producerId, rtpCapabilities})) {
      throw new BadRequestException('cannot_consume_producer');
    }

    // Find the producer's owner so we can stamp the participantTag in
    // the response — the client uses it to attach the new track to the
    // right tile.
    let producerOwnerTag: string | null = null;
    for (const otherTag of room.participantTags) {
      if (otherTag === participantTag) continue;
      const other = this.participants.get(otherTag);
      if (other?.producers.has(producerId)) { producerOwnerTag = otherTag; break; }
    }
    if (!producerOwnerTag) throw new NotFoundException('producer_not_found');

    // Start paused so the client can settle UI state, then resume after
    // the consumer spawns (sfu.consumer.resume).
    const consumer = await tx.consume({
      producerId,
      rtpCapabilities,
      paused: true,
    });
    p.consumers.set(consumer.id, consumer);

    consumer.on('transportclose', () => { p.consumers.delete(consumer.id); });
    consumer.on('producerclose',  () => {
      p.consumers.delete(consumer.id);
      try { consumer.close(); } catch { /* ignore */ }
    });

    return {
      consumerId:     consumer.id,
      producerId,
      kind:           consumer.kind === 'audio' ? 'audio' : 'video',
      rtpParameters:  consumer.rtpParameters,
      participantTag: producerOwnerTag,
      // Late joiners need the pause state at consume time — a peer whose
      // camera is currently off would otherwise render a black/frozen
      // tile until the next pause toggle.
      producerPaused: consumer.producerPaused,
    };
  }

  /**
   * Owner pauses/resumes their OWN producer (camera/mic toggled
   * mid-call). Ownership is structural — the producer must be in the
   * caller's own producer map. Resume additionally refuses producers
   * the HOST paused via sfu.mute-target (S6): a self-resume there
   * would be an unmute bypass. Fans sfu.producer-paused / -resumed to
   * the room so peers swap the tile to its avatar placeholder instead
   * of freezing on the last decoded frame.
   */
  async setProducerPaused(participantTag: string, producerId: string, paused: boolean): Promise<void> {
    const p = this.requireParticipant(participantTag);
    const producer = p.producers.get(producerId);
    if (!producer) throw new NotFoundException('producer_not_found');
    if (!paused && this.mutedProducerIdsByTag.get(participantTag)?.has(producerId)) {
      throw new ForbiddenException('producer_muted_by_host');
    }
    if (paused) { await producer.pause(); } else { await producer.resume(); }
    this.broadcastToRoom?.(p.roomId, {
      event: paused ? 'sfu.producer-paused' : 'sfu.producer-resumed',
      data: {
        roomId:         p.roomId,
        producerId,
        participantTag,
        kind:           producer.kind === 'audio' ? 'audio' : 'video',
      },
    }, participantTag);
  }

  async resumeConsumer(participantTag: string, consumerId: string): Promise<void> {
    const p = this.requireParticipant(participantTag);
    const c = p.consumers.get(consumerId);
    if (!c) throw new NotFoundException('consumer_not_found');
    await c.resume();
    // Why: a consumer is created paused (see consume(): paused:true), so the
    // first frames it would receive are whatever the producer happens to send
    // next. For video that is useless until a keyframe (I-frame) arrives — and
    // on a simulcast stream the next NATURAL keyframe can be many seconds out,
    // so the receiver's decoder sits frameless and the remote tile renders
    // black for the whole call. Explicitly requesting a keyframe on resume
    // forces the producer to emit an I-frame now so the freshly-resumed
    // receiver can decode immediately. Audio needs no keyframe. Best-effort:
    // requestKeyFrame can reject if the consumer closed between resume and
    // here, which is harmless — never fail the resume over it.
    if (c.kind === 'video') {
      try { await c.requestKeyFrame(); }
      catch (e) { this.log.warn(`consumer.requestKeyFrame failed cid=${consumerId} err=${(e as Error).message}`); }
    }
  }

  async leaveRoom(
    participantTag: string,
    // L7 host-disconnect-kills-room — only an INTENTIONAL host end (explicit
    // sfu.leave) terminates the room for everyone. A host's transient WS drop
    // (network change, backgrounding) routes here via handleDisconnect and must
    // NOT kill the call — it falls through to the normal participant-leave path
    // so survivors keep talking and the host can rejoin the still-live room.
    opts?: {hostTerminatesRoom?: boolean},
    // Audit SFU-06 — returns EVERY participant tag torn down by this call
    // (just [participantTag] normally; the host tag + all survivor tags on a
    // host-terminate), so the gateway can purge its sfuTagToSocket /
    // sfuSocketTags maps for survivors too (they were leaked before, pinning
    // Socket refs and making firstTagFor resolve dead tags).
  ): Promise<{removedTags: string[]}> {
    const p = this.participants.get(participantTag);
    if (!p) return {removedTags: []};
    const room = this.rooms.get(p.roomId);
    const isHost = !!room && room.hostUserId === p.userId;

    // HOST-LEAVE TERMINATES THE ROOM.
    //
    // WhatsApp/Zoom semantics: when the host ends a group call, EVERY
    // remaining participant drops out. Without this branch the host's
    // sfu.leave only fired `sfu.participant.left` for the host's tag,
    // leaving the rest of the room talking to each other in a
    // hostless ghost room indefinitely. Reproduce path: host of a 3+
    // participant call presses End → others "were on still on the
    // call" with continuing audio.
    //
    // Order:
    //   1. Snapshot the surviving participants (host's tag included).
    //   2. Broadcast sfu.room.ended to all of them so clients can tear
    //      down without us needing one round-trip per participant.
    //   3. Close every participant's resources (loop calls leaveRoom
    //      for each survivor — recursion is bounded: isHost only
    //      matches the original caller, surviving calls go through
    //      the non-host branch below).
    //   4. Close the router + delete the room mapping.
    //
    // Skipped when the host's session is the only one (no peers to
    // tell, normal close path applies) OR when this is a transient host
    // DISCONNECT rather than an intentional end (L7 — see opts above).
    if (opts?.hostTerminatesRoom && isHost && room && room.participantTags.size > 1) {
      const survivors = Array.from(room.participantTags).filter(t => t !== participantTag);

      this.broadcastToRoom?.(p.roomId, {
        event: 'sfu.room.ended',
        data:  {roomId: p.roomId, reason: 'host_left'},
      });

      // Close the host's own resources first so they don't keep
      // routing audio to the room while we tear down survivors.
      for (const c of p.consumers.values()) try { c.close(); } catch { /* ignore */ }
      for (const pr of p.producers.values()) try { pr.close(); } catch { /* ignore */ }
      try { p.sendTransport.close(); } catch { /* ignore */ }
      try { p.recvTransport.close(); } catch { /* ignore */ }
      this.mutedProducerIdsByTag.delete(participantTag);
      this.participants.delete(participantTag);
      room.participantTags.delete(participantTag);

      // Tear down each survivor. We DON'T recurse through leaveRoom
      // because that would re-broadcast sfu.participant.left for each
      // one — pure noise once the room is closing. Inline the cleanup.
      for (const tag of survivors) {
        const sp = this.participants.get(tag);
        if (!sp) continue;
        for (const c of sp.consumers.values()) try { c.close(); } catch { /* ignore */ }
        for (const pr of sp.producers.values()) try { pr.close(); } catch { /* ignore */ }
        try { sp.sendTransport.close(); } catch { /* ignore */ }
        try { sp.recvTransport.close(); } catch { /* ignore */ }
        this.mutedProducerIdsByTag.delete(tag);
        this.participants.delete(tag);
      }

      // Delete BEFORE close so the router's close observer (onRouterClosed)
      // is a no-op here — survivors already got sfu.room.ended above.
      this.rooms.delete(p.roomId);
      if (room.conversationId) this.groupRoomIndex.delete(room.conversationId);
      try { room.router.close(); } catch { /* ignore */ }
      this.log.debug(`room.close-host-left id=${p.roomId} survivors=${survivors.length}`);
      return {removedTags: [participantTag, ...survivors]};
    }

    // Non-host leave (or host leaving an empty room) — the original path.
    for (const c of p.consumers.values()) try { c.close(); } catch { /* ignore */ }
    for (const pr of p.producers.values()) try { pr.close(); } catch { /* ignore */ }
    try { p.sendTransport.close(); } catch { /* ignore */ }
    try { p.recvTransport.close(); } catch { /* ignore */ }

    // Round 5 / Security S6 — drop server-side mute bookkeeping for
    // a leaving participant; their producers are already closed above.
    this.mutedProducerIdsByTag.delete(participantTag);

    this.participants.delete(participantTag);
    if (room) {
      room.participantTags.delete(participantTag);
      // Last one out kills the room (and the Router with it).
      if (room.participantTags.size === 0) {
        // Delete BEFORE close so onRouterClosed treats this as intentional.
        this.rooms.delete(p.roomId);
        if (room.conversationId) this.groupRoomIndex.delete(room.conversationId);
        try { room.router.close(); } catch { /* ignore */ }
        this.log.debug(`room.close id=${p.roomId}`);
        return {removedTags: [participantTag]};
      }
      // Tell remaining participants this peer is gone so they can
      // tear down their consumers + drop the tile.
      this.broadcastToRoom?.(p.roomId, {
        event: 'sfu.participant.left',
        data:  {roomId: p.roomId, participantTag},
      });
    }
    return {removedTags: [participantTag]};
  }

  /** Look up the userId behind a participantTag — gateway uses this for fanout. */
  resolveParticipantUser(participantTag: string): {userId: string; roomId: string} | null {
    const p = this.participants.get(participantTag);
    if (!p) return null;
    return {userId: p.userId, roomId: p.roomId};
  }

  /** All participantTags in a room — gateway uses this to route broadcasts. */
  participantsInRoom(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.participantTags);
  }

  /**
   * Snapshot every producer in a room except the caller's own. Single
   * source of truth for both the join-time `existingProducers` payload
   * and the reconcile-time `listProducers` query, so the two can never
   * drift in shape.
   */
  private snapshotProducers(
    roomId: RoomId,
    exceptTag: string,
  ): Array<{producerId: string; participantTag: string; kind: 'audio' | 'video'; paused: boolean}> {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const out: Array<{producerId: string; participantTag: string; kind: 'audio' | 'video'; paused: boolean}> = [];
    for (const otherTag of room.participantTags) {
      if (otherTag === exceptTag) continue;
      const other = this.participants.get(otherTag);
      if (!other) continue;
      for (const [pid, prod] of other.producers) {
        out.push({
          producerId:     pid,
          participantTag: otherTag,
          kind:           prod.kind === 'audio' ? 'audio' : 'video',
          // Reconcile self-heal: a client that missed the paused/resumed
          // frame converges on the authoritative state on the next tick.
          paused:         prod.paused,
        });
      }
    }
    return out;
  }

  /**
   * Reconcile query — the current producer set the caller SHOULD be
   * consuming. The client polls this while joined (and after an ICE
   * restart) to recover any `sfu.new-producer` frame it missed or any
   * consume that failed transiently: it diffs the result against its
   * live consumers and consumes the gaps. Validates the caller is a
   * real participant of the room so it can't enumerate arbitrary rooms.
   */
  listProducers(
    participantTag: string,
    roomId: RoomId,
  ): Array<{producerId: string; participantTag: string; kind: 'audio' | 'video'; paused: boolean}> {
    const p = this.requireParticipant(participantTag);
    if (p.roomId !== roomId) throw new ForbiddenException('not_in_room');
    return this.snapshotProducers(roomId, participantTag);
  }

  async stats(): Promise<{rooms: number; participants: number; workers: number; restartTotals: number}> {
    const ps = this.pool.stats();
    return {
      rooms:         this.rooms.size,
      participants:  this.participants.size,
      workers:       ps.workers,
      restartTotals: ps.restartTotals,
    };
  }

  // ─── Internals ──────────────────────────────────────────────────

  private requireParticipant(tag: string): ParticipantState {
    const p = this.participants.get(tag);
    if (!p) throw new NotFoundException('participant_not_found');
    return p;
  }

  private matchTransport(p: ParticipantState, transportId: string): MS.WebRtcTransport {
    if (p.sendTransport.id === transportId) return p.sendTransport;
    if (p.recvTransport.id === transportId) return p.recvTransport;
    throw new BadRequestException('transport_not_found_for_participant');
  }

  private transportToParams(tx: MS.WebRtcTransport): SfuTransportParams {
    return {
      id:             tx.id,
      iceParameters:  tx.iceParameters,
      iceCandidates:  tx.iceCandidates,
      dtlsParameters: tx.dtlsParameters,
    };
  }

  private async createWebRtcTransport(router: MS.Router): Promise<MS.WebRtcTransport> {
    const listenIp    = this.cfg.get<string>('sfu.listenIp')   ?? '0.0.0.0';
    const announcedIp = this.cfg.get<string | undefined>('sfu.announcedIp');
    const initialBitrate = this.cfg.get<number>('sfu.initialBitrate') ?? 1_000_000;

    const tx = await router.createWebRtcTransport({
      listenIps:    [{ip: listenIp, announcedIp}],
      enableUdp:    true,
      enableTcp:    true,
      preferUdp:    true,
      initialAvailableOutgoingBitrate: initialBitrate,
    });
    return tx;
  }
}

interface RoomState {
  router:           MS.Router;
  participantTags:  Set<string>;
  /** Source chat conversation — drives groupRoomIndex + ring routing. */
  conversationId?:  string;
  /** Userid that owns moderation rights (mute / kick). First creator wins. */
  hostUserId?:      string;
  createdAt:        number;
}

interface ParticipantState {
  tag:           string;
  userId:        string;
  roomId:        string;
  sendTransport: MS.WebRtcTransport;
  recvTransport: MS.WebRtcTransport;
  producers:     Map<string, MS.Producer>;
  consumers:     Map<string, MS.Consumer>;
}
