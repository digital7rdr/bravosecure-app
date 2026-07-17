import type { Socket} from 'socket.io-client';
import {io} from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {ClientFrame, ServerFrame} from './protocol';

// Fix #17: persisted recovery PID. socket.io's connectionStateRecovery
// keys missed packets by the session id we hand back as `auth.pid`.
// Holding it in memory only worked for in-process reconnects; an app
// kill-revive (Doze for >2min, force-stop) reopens the socket with no
// pid → server treats it as a brand-new session and drops anything
// that piled up. Persisting to AsyncStorage lets the post-revive
// connect resume the previous session.
const RECOVERY_PID_KEY    = 'bravo:transport:recoveryPid';
// Why: socket.io v4 connectionStateRecovery only triggers when the
// server receives BOTH `auth.pid` and `auth.offset` as strings (see
// namespace.js _createSocket — if offset is missing the server skips
// restoreSession entirely and mints a fresh session). The lib's own
// _lastOffset/_pid tracking lives on the Socket instance and is lost
// the moment we destroy + rebuild the Socket in forceReconnect(), so
// we track + persist offset alongside pid here and hand both back.
const RECOVERY_OFFSET_KEY = 'bravo:transport:recoveryOffset';

// Fix #18: minimum interval between forceReconnect() calls. Two
// AppState-active transitions in close succession (user toggles
// recent-apps-and-back) used to fire two full handshakes inside
// 200ms. Throttle here so we don't chatter the auth service.
const RECONNECT_THROTTLE_MS = 2_000;

/**
 * Connection-state machine surfaced to UI (status badge, reconnect toast, etc).
 */
export type TransportState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unauthorized'
  // B-11 — single-device takeover: a newer session for the same
  // (user, device) connected and the server evicted this one. We do
  // NOT reconnect (that would ping-pong the kick), so this is a
  // distinct terminal-ish state, not a transient 'disconnected'.
  | 'superseded';

export interface TransportOptions {
  /**
   * Base URL for the messenger-service host — e.g.
   * `http://10.0.2.2:3100` for Android emulator. The socket.io client
   * appends `/ws` as the handshake path (see `path` option below).
   */
  url: string;
  /** Signal device id — required by the server to route envelopes. */
  signalDeviceId: number;
  /** Called before each connect attempt. Return null to abort. */
  getToken: () => Promise<string | null>;
  /**
   * Round 2 fix: when the server emits an `error{code:'unauthorized'}`
   * frame (token expired mid-WS-session), drive a single-flight
   * refresh and reconnect — instead of stranding the WS in
   * `unauthorized` until the user manually restarts. Optional so the
   * old behaviour (stop retrying) remains the default.
   */
  refreshToken?: () => Promise<void>;
  /** Fires for every authenticated server frame. */
  onFrame: (frame: ServerFrame) => void;
  /** Optional — receive state transitions for UI surfaces. */
  onStateChange?: (state: TransportState) => void;
  /** Max backoff between reconnect attempts. Defaults to 30s. */
  maxBackoffMs?: number;
}

/**
 * Authenticated, self-healing socket.io client.
 *
 * Wraps `socket.io-client` so the app code keeps talking in terms of
 * `{event, data}` frames and a simple state machine. The server runs
 * socket.io 4.x + the Redis adapter, so any replica in the cluster can
 * service this connection transparently.
 *
 * Transport: `['websocket']` only — we skip long-polling for lean mobile
 * wire + faster connect. socket.io-client handles reconnection,
 * heartbeats, and buffering automatically; the state machine below just
 * maps its lifecycle events to UI-friendly labels.
 */
export class TransportClient {
  private socket: Socket | null = null;
  private _state: TransportState = 'disconnected';
  private closedByUser = false;
  // Socket.io v4.6+ recovery handle. The server's
  // `connectionStateRecovery` config buffers missed packets for the
  // session id captured here; on reopen we hand it back via `auth.pid`
  // so the server replays anything we missed (typing, presence, calls
  // mid-handshake) instead of dropping them. Without this every reopen
  // is a fresh session and the screen-lock-then-resume flow shows the
  // user a stuck "Reconnecting…" banner.
  //
  // Fix #17: persist this to AsyncStorage so the kill-revive case
  // (app force-stopped or Doze-killed for >2min) can still resume
  // via connectionStateRecovery on next open.
  private recoveryPid: string | null = null;
  // socket.io v4 appends the packet offset as the trailing arg of every
  // emit when recovery is enabled. Capture it from onAny so we can pass
  // it back on the next handshake (`auth.offset`) — without it the
  // server refuses to restore the session.
  private recoveryOffset: string | null = null;
  /**
   * Round 2 fix: single-flight guard for the unauthorized-refresh path.
   * Without it, two `error{unauthorized}` frames arriving back-to-back
   * (server emits the error then closes the socket; on the next
   * reconnect we get the same error again before refresh completes)
   * would each kick off a refresh. With this guard the second one
   * coalesces into a no-op while the first is still in flight.
   */
  private unauthorizedRefreshInFlight = false;
  /**
   * B-05 / JWT-secret-drift — count of consecutive auth-reject→refresh cycles
   * with NO successful connect in between. When refresh keeps SUCCEEDING but the
   * server still rejects the fresh token (e.g. JWT_ACCESS_SECRET drift between
   * auth and messenger), the inFlight guard alone loops forever; this cap stops
   * the refresh storm and surfaces a visible 'unauthorized' instead of an endless
   * 'reconnecting'. Reset on a successful connect and on forceReconnect().
   */
  private unauthorizedRefreshAttempts = 0;
  private static readonly MAX_UNAUTH_REFRESH = 4;
  /**
   * B-11 — `code` of the most recent server `error` frame. The server
   * sends `error{code:'superseded'}` immediately before it evicts the
   * older socket on a single-device takeover; capturing it lets the
   * `disconnect` handler tell a takeover apart from a transient
   * server-side drop. Cleared on every successful (re)connect.
   */
  private lastServerErrorCode: string | null = null;
  /**
   * B-14 — backoff timer + attempt counter for the manual reconnect we
   * drive after a NON-takeover `io server disconnect` (server restart,
   * idle reap, crash — B-05). socket.io deliberately does NOT
   * auto-reconnect after a server-initiated disconnect, so without this
   * the messenger transport stayed dead (zero recv.enter) until the app
   * was restarted. Reset on every successful (re)connect.
   */
  private serverReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private serverReconnectAttempts = 0;
  /**
   * Fix #18: wall-clock of the most recent successful 'connect'
   * event — used to throttle forceReconnect() so a flurry of
   * AppState transitions inside ~2s don't burn N handshakes.
   */
  private lastConnectedAt = 0;
  /**
   * Audit fix 5.1 — secondary frame listeners. The main `opts.onFrame`
   * is the runtime's central dispatcher; this set lets specific
   * screens (LiveTrackingScreen, ops-console live page) plug in their
   * own per-screen listener without monkey-patching the runtime.
   * Listener errors are swallowed — one buggy screen mustn't block
   * the rest.
   */
  private readonly frameListeners = new Set<(frame: ServerFrame) => void>();
  /**
   * B-05 — reconnect listeners. Fired when the socket RE-connects (not on
   * the first connect). Group-call boot subscribes here so it can re-join
   * the SFU room after the server's P0-6 revoked-socket sweep drops + the
   * refresh path reopens the WS — the SFU tore the room/transports down on
   * disconnect, so an ICE restart over the new socket would never recover.
   * Errors are swallowed so one buggy subscriber can't block the rest.
   */
  private readonly reconnectListeners = new Set<() => void>();
  /**
   * B-05 — true once the very first 'connect' has fired. Lets the connect
   * handler distinguish the initial connect (no rejoin needed) from a
   * genuine reconnect (rejoin required).
   */
  private hasConnectedOnce = false;
  /**
   * P1-12 — single-flight guard for open(). Two reopen triggers inside
   * open()'s async window (the 5 s send-ack watchdog racing an
   * AppState-`active` reconnect, both suspended at `await getToken()`)
   * each used to build a socket; the first became an orphan with live
   * listeners and the gateway then evicted one as `superseded`, dumping
   * the user to the login screen. Concurrent callers now coalesce onto
   * the one in-flight open promise.
   */
  private openInFlight: Promise<void> | null = null;
  /**
   * P1-12 — connect generation. Bumped at the start of every doOpen()
   * (and on close()); a suspended async continuation re-checks it after
   * each await and bails — tearing down any socket it managed to build —
   * if a newer connect superseded it, so a stale continuation can never
   * install an orphan socket.
   */
  private connectGeneration = 0;

  constructor(private readonly opts: TransportOptions) {}

  get state(): TransportState {
    return this._state;
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    await this.open();
  }

  send(frame: ClientFrame): void {
    if (!this.socket?.connected) {
      throw new Error('transport not open');
    }
    // socket.io dispatches by event name; server handlers are mounted
    // via @SubscribeMessage(<event>) and receive `data` verbatim.
    this.socket.emit(frame.event, (frame as {data?: unknown}).data ?? {});
  }

  /**
   * Fire-and-forget control frame (presence / room subscribe-unsubscribe / activity)
   * that is SAFE to drop when the socket is closed: these subscriptions are explicitly
   * re-established on the next `open` transition (see onReconnect + the per-screen hooks),
   * so a send against a closed transport must NOT throw. Left un-guarded, the throw escapes
   * a React effect (e.g. useMissionEvents → subscribeMission) into the app's ErrorBoundary
   * and crashes the whole app. Mirrors sendReadReceipt's best-effort semantics.
   */
  private bestEffortSend(frame: ClientFrame): void {
    try {
      this.send(frame);
    } catch {
      /* socket not open — the subscription re-subscribes on reconnect. */
    }
  }

  /**
   * Emit an event with a socket.io-style ack callback. SFU group-call
   * flows lean on this — `Device.createSendTransport.on('produce', cb)`
   * needs a producerId back from the server before mediasoup-client
   * proceeds. The ack timeout matches socket.io's default.
   */
  emitWithAck<T>(event: string, data: unknown, timeoutMs = 15_000): Promise<T> {
    if (!this.socket?.connected) {
      return Promise.reject(new Error('transport not open'));
    }
    const sock = this.socket;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`ack_timeout:${event}`)), timeoutMs);
      sock.emit(event, data, (resp: unknown) => {
        clearTimeout(t);
        // Audit SFU-01: the server now returns an event-less {ok:false,data}
        // on error so NestJS actually invokes this ack (an {event} return is
        // emitted-not-acked). Reject on ok===false; keep the legacy
        // event==='sfu.error' branch so a transitional server still parses.
        const r = resp as {ok?: boolean; event?: string; data?: {message?: string}};
        if (r && (r.ok === false || r.event === 'sfu.error')) {
          reject(new Error(r.data?.message ?? 'sfu_error'));
        } else {
          resolve(resp as T);
        }
      });
    });
  }

  /**
   * Subscribe to a list of users' live presence. The server emits a
   * `presence` snapshot for every id in the list, then streams
   * subsequent transitions. Idempotent — resubscribing is safe.
   */
  subscribePresence(userIds: string[]): void {
    if (userIds.length === 0) {return;}
    this.bestEffortSend({event: 'presence.subscribe', data: {userIds}});
  }

  unsubscribePresence(userIds: string[]): void {
    if (userIds.length === 0) {return;}
    this.bestEffortSend({event: 'presence.unsubscribe', data: {userIds}});
  }

  /**
   * Audit fix 5.1 — subscribe to a mission's lifecycle channel. The
   * gateway joins this socket to a `mission:<id>` room; the server
   * pushes `mission.status` / `mission.team` / `mission.telemetry`
   * frames through the existing `onFrame` callback, so the consumer
   * just adds another branch in their frame switch.
   *
   * Idempotent — resubscribing is harmless. Survives the WS reconnect:
   * socket.io's connectionStateRecovery replays the room membership
   * inside the recovery window; outside that, the client should
   * resubscribe on the next `state === 'open'` transition.
   */
  subscribeMission(missionId: string): void {
    if (!missionId) {return;}
    this.bestEffortSend({event: 'mission.subscribe', data: {missionId}});
  }

  unsubscribeMission(missionId: string): void {
    if (!missionId) {return;}
    this.bestEffortSend({event: 'mission.unsubscribe', data: {missionId}});
  }

  /**
   * Audit fix 5.1 — per-screen frame listener registration. Returns an
   * unsubscribe function. The listener fires AFTER the runtime's main
   * `onFrame` callback so any state updates from the runtime have
   * already landed before screen-level state updates.
   */
  addFrameListener(fn: (frame: ServerFrame) => void): () => void {
    this.frameListeners.add(fn);
    return () => { this.frameListeners.delete(fn); };
  }

  /**
   * B-05 — subscribe to socket RE-connect events. The callback fires on
   * every successful 'connect' AFTER the first one (i.e. a reopen following
   * a drop), never on the initial connect. Returns an unsubscribe fn.
   */
  onReconnect(fn: () => void): () => void {
    this.reconnectListeners.add(fn);
    return () => { this.reconnectListeners.delete(fn); };
  }

  /**
   * Report the local app's foreground/background state so the server
   * refines presence from `online` to `active` / `away`. Clients should
   * call this on app state transitions (AppState 'active' / 'background').
   */
  setActivity(state: 'active' | 'away'): void {
    this.bestEffortSend({event: 'presence', data: {state}});
  }

  /**
   * Tell `peer`'s connected devices that we've read the listed
   * envelopes. The server fans this out only to that peer, leaving
   * Sealed Sender semantics intact for everyone else. Best-effort:
   * if the socket is not open, the receipt is dropped.
   */
  sendReadReceipt(peer: {userId: string; deviceId: number}, envelopeIds: string[]): void {
    if (envelopeIds.length === 0) {return;}
    try {
      this.send({event: 'read-receipt', data: {to: peer, envelopeIds}});
    } catch { /* socket not open — best effort */ }
  }

  close(): void {
    this.closedByUser = true;
    // P1-12 — invalidate any doOpen() continuation still suspended at an
    // await so it can't install a socket after this close.
    this.connectGeneration++;
    // B-14 — cancel any pending manual reconnect so a user-initiated
    // close (logout) isn't undone by a queued backoff retry.
    if (this.serverReconnectTimer) {
      clearTimeout(this.serverReconnectTimer);
      this.serverReconnectTimer = null;
    }
    this.serverReconnectAttempts = 0;
    if (this.socket) {
      try { this.socket.disconnect(); } catch { /* ignore */ }
      this.socket = null;
    }
    // Fix #17: clear the persisted recovery pid on a USER-initiated
    // close (logout, forceClose). Without this, next session's open()
    // would replay against an authenticated-as-previous-user pid and
    // the server's recovery check would either miss (harmless) or, in
    // the worst case, hand back stale state. Don't clear in transient
    // disconnect paths (`socket.disconnect` events) — those preserve
    // the pid so reconnect can resume.
    this.recoveryPid    = null;
    this.recoveryOffset = null;
    AsyncStorage.removeItem(RECOVERY_PID_KEY).catch(() => { /* non-fatal */ });
    AsyncStorage.removeItem(RECOVERY_OFFSET_KEY).catch(() => { /* non-fatal */ });
    this.setState('disconnected');
  }

  /**
   * Force a fresh connection — used on app foreground when the OS may
   * have silently killed the socket fd while we were backgrounded. Just
   * calling `connect()` isn't enough because socket.io may still report
   * `socket.connected === true` against a dead socket. Tearing the
   * existing socket down and starting over guarantees a real session.
   * Preserves the recovery PID so the server replays anything we missed
   * via connectionStateRecovery.
   *
   * Fix #18: throttle. If a real handshake completed less than
   * RECONNECT_THROTTLE_MS ago, skip the rebuild — the socket is
   * almost certainly fine. Two AppState 'active' transitions in
   * close succession (notification swipe, recents-and-back) used
   * to fire two full handshakes inside 200ms.
   */
  async forceReconnect(): Promise<void> {
    if (this._state === 'connected' && Date.now() - this.lastConnectedAt < RECONNECT_THROTTLE_MS) {
      return;
    }
    this.closedByUser = false;
    this.unauthorizedRefreshAttempts = 0;
    this.setState('connecting');
    // P1-12 — route through the single-flight open(). doOpen() performs the
    // prior-socket teardown itself, and a reopen that races an in-flight
    // open() (send-ack watchdog vs AppState-active, both previously
    // suspended at getToken()) coalesces onto that attempt instead of
    // building a second socket the gateway then evicts as `superseded`.
    await this.open();
  }

  /**
   * Called by the runtime when NetInfo reports a network type change
   * (Wi-Fi ↔ cellular handover, captive portal flip, etc). The TCP
   * sockets bound to the old route are dead the moment the kernel
   * destroys them, but socket.io's default backoff is ~30s — far too
   * slow for an active call. We short-circuit it.
   *
   * Behaviour:
   *  • If we believe we're connected, the OS handover already nuked the
   *    socket layer but socket.io's heartbeat (~25s ping) hasn't noticed
   *    yet — force a fresh handshake on the new route (throttled by
   *    forceReconnect()'s 2s window).
   *  • If we're NOT connected (reconnecting / connecting / a transient
   *    refresh failure), the network just came back: reconnect NOW
   *    instead of waiting out socket.io's up-to-30s backoff or a pending
   *    B-14 retry timer.
   *  • A takeover ('superseded') or user close never auto-reconnects.
   */
  async notifyNetworkChange(): Promise<void> {
    if (this.closedByUser) {return;}
    // B-11 — re-grabbing the (user, device) slot would ping-pong the kick
    // back to the device that just took over.
    if (this._state === 'superseded') {return;}
    if (this._state !== 'connected') {
      // Fast-path reconnect on network restore: cancel the pending B-14
      // backoff so the immediate attempt isn't followed by a stale
      // long-delay retry, and reset its step counter — the route change
      // means the old failure streak says nothing about the new route.
      if (this.serverReconnectTimer) {
        clearTimeout(this.serverReconnectTimer);
        this.serverReconnectTimer = null;
      }
      this.serverReconnectAttempts = 0;
      await this.forceReconnect();
      return;
    }
    await this.forceReconnect();
  }

  /**
   * Shared auth-reject handler for both the handshake `connect_error` path and
   * the mid-session `error{unauthorized|token_revoked}` frame. Returns true when
   * it took ownership (kicked a single-flight refresh, or tripped the attempt cap
   * and surfaced 'unauthorized'); false when the caller should run its own
   * fallback (no refresh hook wired, or a refresh is already in flight).
   */
  private handleAuthReject(socket: {disconnect: () => void}): boolean {
    if (!this.opts.refreshToken || this.unauthorizedRefreshInFlight) {
      return false;
    }
    if (this.unauthorizedRefreshAttempts >= TransportClient.MAX_UNAUTH_REFRESH) {
      // Persistent reject (e.g. server JWT-secret drift: refresh succeeds but the
      // fresh token is STILL rejected) — stop the refresh storm and surface a
      // visible error instead of an endless 'reconnecting'. Recoverable:
      // forceReconnect() (app foreground / manual retry) clears closedByUser AND
      // resets this counter, giving a fresh budget once the cause is fixed.
      this.closedByUser = true;
      this.setState('unauthorized');
      try { socket.disconnect(); } catch { /* ignore */ }
      return true;
    }
    this.unauthorizedRefreshAttempts += 1;
    this.unauthorizedRefreshInFlight = true;
    this.setState('reconnecting');
    try { socket.disconnect(); } catch { /* ignore */ }
    const attempt = this.unauthorizedRefreshAttempts;
    void this.opts.refreshToken()
      .then(async () => {
        this.unauthorizedRefreshInFlight = false;
        // Growing backoff so a persistent reject doesn't hammer auth-service
        // /refresh before the cap trips.
        await new Promise(r => setTimeout(r, 400 * attempt));
        void this.open();
      })
      .catch((e: unknown) => {
        this.unauthorizedRefreshInFlight = false;
        // P1-BR-7 — only a DEFINITIVE reject from the refresh endpoint is
        // terminal. A transient failure (radio not re-attached after Doze,
        // auth-service mid-redeploy 5xx, timeout, DNS blip) used to land
        // here too and strand the transport in terminal 'unauthorized' —
        // no messages, no call rings — until the app was force-cycled.
        // Stay 'reconnecting' and retry through the B-14 backoff instead;
        // forceReconnect() there re-reads getToken() and re-enters this
        // refresh path, so recovery is automatic once the network is back.
        if (isTerminalRefreshError(e)) {
          this.closedByUser = true;
          this.setState('unauthorized');
          return;
        }
        this.scheduleServerReconnect();
      });
    return true;
  }

  /**
   * P1-12 — single-flight open. Concurrent reopen triggers (the 5s
   * send-ack watchdog racing an AppState-active forceReconnect, both
   * otherwise suspended at `await getToken()`) coalesce onto the one
   * in-flight attempt instead of each building a socket. Pre-fix, the
   * first socket became an orphan with live listeners; the gateway
   * evicted one as `superseded` for the same (user, device) and the app
   * misread its own duplicate as a device takeover → spurious sign-out.
   */
  private open(): Promise<void> {
    if (this.openInFlight) {return this.openInFlight;}
    const tracked: Promise<void> = this.doOpen().finally(() => {
      if (this.openInFlight === tracked) {this.openInFlight = null;}
    });
    this.openInFlight = tracked;
    return tracked;
  }

  private async doOpen(): Promise<void> {
    if (this.closedByUser) {return;}
    const gen = ++this.connectGeneration;
    // Audit RELAY-C1 (2026-07-02): tear down any prior socket's listeners
    // before opening a new one. open() is reached on the token-refresh
    // reopen (handleAuthReject) and the inline-error reopen WITHOUT going
    // through forceReconnect() (which already does this). With
    // forceNew:false socket.io reuses the same Manager/Socket, so skipping
    // this stacks a second listener set on every reopen — every server
    // frame then dispatches twice (duplicate libsignal decrypt corrupts
    // the ratchet / raises spurious bad-MAC banners, and state transitions
    // double-fire). Mirrors forceReconnect()'s teardown.
    if (this.socket) {
      try { this.socket.removeAllListeners(); } catch { /* ignore */ }
      try { this.socket.disconnect(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.setState('connecting');

    const token = await this.opts.getToken();
    // P1-12 — a close() superseded this attempt while we were suspended:
    // bail before touching state or installing a socket.
    if (gen !== this.connectGeneration || this.closedByUser) {return;}
    if (!token) {
      this.setState('unauthorized');
      return;
    }

    // Fix #17: rehydrate recoveryPid + offset from disk if we don't
    // have them in memory (kill-revive case — fresh JS context, no
    // in-memory state). Best-effort: a stale pid/offset is still
    // useful; if the server has expired the session it just hands us a
    // fresh one.
    if (!this.recoveryPid) {
      try {
        const [storedPid, storedOff] = await Promise.all([
          AsyncStorage.getItem(RECOVERY_PID_KEY),
          AsyncStorage.getItem(RECOVERY_OFFSET_KEY),
        ]);
        if (storedPid) { this.recoveryPid    = storedPid; }
        if (storedOff) { this.recoveryOffset = storedOff; }
      } catch { /* ignore — non-fatal */ }
    }
    if (gen !== this.connectGeneration || this.closedByUser) {return;}

    const maxBackoff = this.opts.maxBackoffMs ?? 30_000;
    // socket.io-client treats everything after the host as a namespace,
    // so strip a trailing `/ws` if the caller gave us the legacy raw-ws
    // URL. The actual handshake path is set via the `path` option below.
    const base = this.opts.url.replace(/\/ws\/?$/, '');
    const socket = io(base, {
      path:                   '/ws',
      transports:             ['websocket'],
      reconnection:           true,
      reconnectionAttempts:   Infinity,
      reconnectionDelay:      500,
      reconnectionDelayMax:   maxBackoff,
      randomizationFactor:    0.5,
      autoConnect:            true,
      // forceNew=false so socket.io reuses the same Manager across
      // reconnects, which preserves the recovery context. Combined
      // with the `auth.pid` hand-back below, the server's
      // connectionStateRecovery (2 min window) replays any frames
      // missed during a screen lock or brief network blip.
      forceNew:               false,
      // Server's _createSocket requires both pid AND offset as strings
      // to even attempt recovery. Send empty string on the very first
      // connect (no offset yet) — server treats that as "replay from
      // the beginning of the buffer," which is the right behaviour for
      // a brand-new session.
      //
      // Audit P0-T1 — `token` and `signalDeviceId` now travel in the
      // socket.io `auth` payload (carried in the WebSocket upgrade body
      // as an Engine.IO `0{...}` frame) rather than the URL query string.
      // The query form leaked the JWT into nginx access logs, browser
      // history, and any L7 LB that records URLs. The server prefers
      // auth and falls back to query for one rollout release; once
      // telemetry shows zero clients still using query the fallback
      // will be removed.
      auth: {
        token,
        signalDeviceId: this.opts.signalDeviceId,
        ...(this.recoveryPid
          ? {pid: this.recoveryPid, offset: this.recoveryOffset ?? ''}
          : {}),
      },
    });
    this.socket = socket;

    socket.on('connect', () => {
      // Fix #17: when the server signals connectionStateRecovery
      // succeeded (`socket.recovered === true`), the server's session
      // id is still the OLD pid we sent — our `auth.pid` was honoured.
      // Otherwise the server minted a fresh session and we capture its pid.
      //
      // P1-13: socket.io-client exposes NO public `pid` — the recovery
      // session id is the private `_pid` the server sends in the CONNECT
      // payload when connectionStateRecovery is enabled. The old code fell
      // back to `socket.id`, which is NOT a recovery key: the server's
      // restoreSession never matched it (the 2-min missed-frame replay
      // never fired), and handing it back as `auth.pid` overrode the lib's
      // own correct `_pid` in the CONNECT builder, breaking stock
      // in-process recovery too. Capture `_pid` only; when the server sends
      // none (recovery disabled), clear any stale persisted pid so future
      // handshakes omit `auth.pid`/`auth.offset` entirely.
      const sock = socket as unknown as {recovered?: boolean; _pid?: string};
      if (sock.recovered !== true) {
        // Fresh server session — the previous session's offset is
        // meaningless against the new buffer.
        this.recoveryOffset = null;
        AsyncStorage.removeItem(RECOVERY_OFFSET_KEY).catch(() => { /* non-fatal */ });
      }
      const nextPid = sock.recovered === true && this.recoveryPid
        ? this.recoveryPid
        : (typeof sock._pid === 'string' && sock._pid.length > 0 ? sock._pid : null);
      this.recoveryPid = nextPid;
      // Persist for kill-revive — fire-and-forget, never block the
      // connect path on disk I/O.
      if (nextPid) {
        AsyncStorage.setItem(RECOVERY_PID_KEY, nextPid).catch(() => { /* non-fatal */ });
      } else {
        AsyncStorage.removeItem(RECOVERY_PID_KEY).catch(() => { /* non-fatal */ });
      }
      // Fix #18: stamp the wall-clock so forceReconnect() can throttle
      // a redundant rebuild request that arrives within 2s.
      this.lastConnectedAt = Date.now();
      // B-11 — a fresh connection clears any prior takeover/error code so
      // a later transient drop isn't misread as a supersession.
      this.lastServerErrorCode = null;
      // B-14 — reset the manual-reconnect backoff now that we're back.
      this.serverReconnectAttempts = 0;
      if (this.serverReconnectTimer) {
        clearTimeout(this.serverReconnectTimer);
        this.serverReconnectTimer = null;
      }
      // Healthy connect — clear the auth-refresh budget so a future genuine
      // reject starts fresh.
      this.unauthorizedRefreshAttempts = 0;
      this.setState('connected');
      // B-05 — fire reconnect listeners ONLY on a genuine reopen (not the
      // first connect). Snapshot so a listener that (un)subscribes during
      // dispatch doesn't mutate the set mid-loop; swallow listener faults.
      if (this.hasConnectedOnce) {
        for (const fn of [...this.reconnectListeners]) {
          try { fn(); } catch { /* listener fault — keep dispatching */ }
        }
      }
      this.hasConnectedOnce = true;
    });
    socket.on('reconnect_attempt', () => this.setState('reconnecting'));
    socket.on('connect_error',  (err: Error & {data?: {code?: string; message?: string}}) => {
      // Transient handshake failure — socket.io will retry until we give up.
      if (this.closedByUser) {return;}
      // Why: when the server's handshake middleware rejects with an
      // `unauthorized`/`token_revoked` code (expired JWT, JTI not in
      // Redis, signature failure), socket.io fires `connect_error` —
      // NOT the inline `error` frame the auth-mid-session path uses.
      // Without this branch, the client retries forever with the same
      // stale token. Trigger the same single-flight refresh+reopen
      // path the inline `error` handler uses.
      const code   = err?.data?.code;
      const reason = err?.data?.message ?? err?.message ?? '';
      const isAuthReject =
        code === 'unauthorized' ||
        code === 'token_revoked' ||
        /token_revoked|exp.*claim|invalid_token|missing_token|jwt|expired/i.test(reason);
      if (isAuthReject && this.handleAuthReject(socket)) {
        return;
      }
      this.setState('reconnecting');
    });

    // Server emits every frame with its own event name (`envelope.deliver`,
    // `presence`, `call.offer`, `error`, etc). `onAny` captures the lot
    // and rebuilds the ServerFrame shape the app expects. The variadic
    // args also include socket.io's recovery offset as a trailing
    // string when connectionStateRecovery is enabled — capture it so
    // the next handshake can resume the session.
    socket.onAny((event: string, ...args: unknown[]) => {
      const data = args[0];
      // Recovery offset arrives as the LAST arg when recovery is on.
      // It's always a string. Persist it best-effort.
      const tail = args[args.length - 1];
      if (this.recoveryPid && typeof tail === 'string' && tail !== this.recoveryOffset) {
        this.recoveryOffset = tail;
        AsyncStorage.setItem(RECOVERY_OFFSET_KEY, tail).catch(() => { /* non-fatal */ });
      }
      // The server's `error` frame carries `{code, message}` and is how
      // we learn about auth failures (it arrives right before disconnect).
      // Round 2 fix: instead of stranding the WS in `unauthorized` and
      // forcing the user to restart, drive a single refresh attempt and
      // reopen the socket with the fresh JWT. We only fall through to
      // the old "give up" branch when refresh itself fails OR no
      // refresh hook is wired (loopback dev / test runs).
      //
      // Why: previously only `code === 'unauthorized'` triggered the
      // refresh path. The server's P0-6 mid-stream revocation sweep
      // (messenger.gateway.ts:360) emits `code: 'token_revoked'`
      // INSTEAD of `unauthorized`, so the refresh never fired. The
      // socket disconnected, socket.io retried with the same revoked
      // JWT, every reconnect 401'd, and the WS sat in 'reconnecting'
      // forever without acking anything. Match both codes so either
      // server-initiated drop kicks the refresh+reopen flow.
      if (event === 'error' && isErrorPayload(data) && (data.code === 'unauthorized' || data.code === 'token_revoked')) {
        if (this.handleAuthReject(socket)) {
          return;
        }
        // No refresh hook wired (loopback dev / test) or a refresh is already
        // in flight — surface unauthorized so the UI can react.
        this.closedByUser = true; // stop socket.io from retrying
        this.setState('unauthorized');
        try { socket.disconnect(); } catch { /* ignore */ }
        return;
      }
      // B-11 — single-device takeover. The server emits this right
      // before it disconnects the older socket for the same
      // (user, device). Record the code so the imminent
      // `io server disconnect` is handled as a takeover (no reconnect)
      // rather than a transient drop, and surface a distinct state. It
      // is not message content, so we do NOT pass it on to onFrame.
      if (event === 'error' && isErrorPayload(data) && data.code === 'superseded') {
        this.lastServerErrorCode = 'superseded';
        this.setState('superseded');
        return;
      }
      const frame = {event, data} as ServerFrame;
      this.opts.onFrame(frame);
      // Audit fix 5.1 — fan out to secondary listeners. Listener
      // errors are swallowed so one buggy subscriber doesn't break
      // the runtime's central dispatch. Snapshot the set so a
      // listener that calls addFrameListener() during dispatch
      // doesn't get re-fired in the same loop.
      for (const fn of [...this.frameListeners]) {
        try { fn(frame); } catch { /* listener fault — keep dispatching */ }
      }
    });

    socket.on('disconnect', (reason: string) => {
      if (this.closedByUser) {
        this.setState('disconnected');
        return;
      }
      // socket.io auto-reconnects for network-level drops; we only flip
      // state for UI feedback. `io server disconnect` means the server
      // called `socket.disconnect(true)` — usually auth or supersession —
      // and socket.io will NOT auto-reconnect in that case.
      if (reason === 'io server disconnect') {
        // B-11 — a single-device takeover (`superseded` error frame
        // arrived just before this). Do NOT reconnect: re-grabbing the
        // (user, device) slot would ping-pong the kick back to the
        // device that just took over. Stay in the distinct 'superseded'
        // state so the UI can say "active on another device".
        if (this.lastServerErrorCode === 'superseded') {
          this.setState('superseded');
          return;
        }
        // An auth reject (`unauthorized`/`token_revoked`) is handled by
        // the error/connect_error paths, which either set closedByUser
        // (→ handled at the top of this handler) or drive a single-flight
        // refresh+reopen. Don't double-reconnect while that's in flight.
        if (this.unauthorizedRefreshInFlight) {return;}
        // B-14 — otherwise this is a server-initiated drop that is NOT a
        // takeover and NOT an auth reject: a messenger-service restart,
        // idle reap, or crash (B-05). socket.io will NOT auto-reconnect
        // after a server disconnect, so the transport used to sit dead
        // (no recv.enter, no sends) until app restart. Drive the
        // reconnect ourselves with capped exponential backoff.
        this.scheduleServerReconnect();
        return;
      }
      this.setState('reconnecting');
    });
  }

  /**
   * B-14 — schedule a manual reconnect after a non-takeover server
   * disconnect, with capped exponential backoff. forceReconnect()
   * rebuilds the socket and re-reads getToken(), so a token that
   * expired during the outage self-heals via the connect_error refresh
   * path on the next attempt. Keeps retrying (capped at maxBackoffMs)
   * until the server is back — a long outage must not strand the
   * transport. Resets once a connect succeeds.
   */
  private scheduleServerReconnect(): void {
    if (this.closedByUser) {return;}
    this.setState('reconnecting');
    const maxBackoff = this.opts.maxBackoffMs ?? 30_000;
    const base = Math.min(1_000 * 2 ** this.serverReconnectAttempts, maxBackoff);
    // Why: ±25% jitter — after a service restart every client sees the
    // drop at the same instant; identical backoff steps would stampede
    // the gateway in lockstep waves (thundering herd).
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.serverReconnectAttempts++;
    if (this.serverReconnectTimer) {clearTimeout(this.serverReconnectTimer);}
    this.serverReconnectTimer = setTimeout(() => {
      this.serverReconnectTimer = null;
      if (this.closedByUser) {return;}
      void this.forceReconnect();
    }, delay);
  }

  private setState(next: TransportState): void {
    if (this._state === next) {return;}
    this._state = next;
    this.opts.onStateChange?.(next);
  }
}

function isErrorPayload(v: unknown): v is {code: string; message?: string} {
  return !!v && typeof v === 'object' && typeof (v as {code?: unknown}).code === 'string';
}

/**
 * P1-BR-7 — classify a refreshToken() failure. Terminal only when the
 * auth service definitively rejected the refresh (HTTP 401/403 — expired
 * or revoked refresh token) or there is no refresh token to present.
 * Anything else (network error, 5xx, timeout) is transient: the caller
 * must keep the transport retrying instead of stranding it in a terminal
 * 'unauthorized'. Reads the axios error shape (`response.status`) with a
 * plain `status` fallback for fetch-style wrappers.
 */
function isTerminalRefreshError(e: unknown): boolean {
  if (!e || typeof e !== 'object') {return false;}
  const status = (e as {response?: {status?: number}}).response?.status
    ?? (e as {status?: number}).status;
  if (typeof status === 'number') {
    return status === 401 || status === 403;
  }
  const msg = (e as {message?: unknown}).message;
  return typeof msg === 'string' && /no refresh token|refresh.*revoked|token_revoked/i.test(msg);
}
