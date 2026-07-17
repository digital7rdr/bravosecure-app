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
const RECOVERY_PID_KEY = 'bravo:transport:recoveryPid';

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
  | 'unauthorized';

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
   * Fix #18: wall-clock of the most recent successful 'connect'
   * event — used to throttle forceReconnect() so a flurry of
   * AppState transitions inside ~2s don't burn N handshakes.
   */
  private lastConnectedAt = 0;

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
   * Emit an event with a socket.io-style ack callback. SFU group-call
   * flows lean on this — `Device.createSendTransport.on('produce', cb)`
   * needs a producerId back from the server before mediasoup-client
   * proceeds. The ack timeout matches socket.io's default.
   */
  emitWithAck<T>(event: string, data: unknown, timeoutMs = 8_000): Promise<T> {
    if (!this.socket?.connected) {
      return Promise.reject(new Error('transport not open'));
    }
    const sock = this.socket;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`ack_timeout:${event}`)), timeoutMs);
      sock.emit(event, data, (resp: unknown) => {
        clearTimeout(t);
        const r = resp as {event?: string; data?: {message?: string}};
        if (r && r.event === 'sfu.error') {reject(new Error(r.data?.message ?? 'sfu_error'));}
        else {resolve(resp as T);}
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
    this.send({event: 'presence.subscribe', data: {userIds}});
  }

  unsubscribePresence(userIds: string[]): void {
    if (userIds.length === 0) {return;}
    this.send({event: 'presence.unsubscribe', data: {userIds}});
  }

  /**
   * Report the local app's foreground/background state so the server
   * refines presence from `online` to `active` / `away`. Clients should
   * call this on app state transitions (AppState 'active' / 'background').
   */
  setActivity(state: 'active' | 'away'): void {
    this.send({event: 'presence', data: {state}});
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
    this.recoveryPid = null;
    AsyncStorage.removeItem(RECOVERY_PID_KEY).catch(() => { /* non-fatal */ });
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
    if (this.socket) {
      try { this.socket.removeAllListeners(); } catch { /* ignore */ }
      try { this.socket.disconnect(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.setState('connecting');
    await this.open();
  }

  private async open(): Promise<void> {
    if (this.closedByUser) {return;}
    // F5 auth-refresh-reopen-skips-listener-teardown — open() is also reached
    // from the token-refresh reopen and the inline error-reconnect paths,
    // which disconnect() the prior socket but DON'T removeAllListeners(). With
    // forceNew:false the Socket.IO Manager reuses the same Socket instance, so
    // the socket.on / onAny re-registration below would STACK a second listener
    // set — every server frame then dispatched twice (duplicate decrypt +
    // duplicate state transitions). Strip the prior socket's listeners first,
    // mirroring forceReconnect's teardown. recoveryPid is a field, not on the
    // socket, so connectionStateRecovery still replays missed frames.
    if (this.socket) {
      try { this.socket.removeAllListeners(); } catch { /* ignore */ }
      try { this.socket.disconnect(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.setState('connecting');

    const token = await this.opts.getToken();
    if (!token) {
      this.setState('unauthorized');
      return;
    }

    // Fix #17: rehydrate recoveryPid from disk if we don't have one in
    // memory (kill-revive case — fresh JS context, no in-memory pid).
    // Best-effort: a stale pid is still useful — the server checks
    // recovery validity itself; on miss it just hands us a fresh one.
    if (!this.recoveryPid) {
      try {
        const stored = await AsyncStorage.getItem(RECOVERY_PID_KEY);
        if (stored) { this.recoveryPid = stored; }
      } catch { /* ignore — non-fatal */ }
    }

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
      // Audit P0-W4 — token + signalDeviceId travel in the Socket.IO
      // `auth` object (WS upgrade body) instead of the query string.
      // The query was logged by every reverse-proxy / CDN edge in the
      // path. The `pid` recovery hint piggybacks on the same auth
      // payload — socket.io's connectionStateRecovery expects it there
      // already.
      auth: {
        token,
        signalDeviceId: this.opts.signalDeviceId,
        ...(this.recoveryPid ? {pid: this.recoveryPid} : {}),
      },
    });
    this.socket = socket;

    socket.on('connect', () => {
      // Fix #17: when the server signals connectionStateRecovery
      // succeeded (`socket.recovered === true`), the server's session
      // id is still the OLD pid we sent — our `auth.pid` was honoured.
      // Otherwise the server minted a fresh pid (or we sent none, or
      // the previous session timed out) and we capture the new one.
      // Prefer `socket.pid` (libVersion 4.6+ field set when recovery
      // applies) over `socket.id` (always present).
      const sock = socket as unknown as {recovered?: boolean; id?: string; pid?: string};
      const nextPid = sock.recovered === true && this.recoveryPid
        ? this.recoveryPid
        : (sock.pid ?? socket.id ?? null);
      this.recoveryPid = nextPid;
      // Persist for kill-revive — fire-and-forget, never block the
      // connect path on disk I/O.
      if (nextPid) {
        AsyncStorage.setItem(RECOVERY_PID_KEY, nextPid).catch(() => { /* non-fatal */ });
      }
      // Fix #18: stamp the wall-clock so forceReconnect() can throttle
      // a redundant rebuild request that arrives within 2s.
      this.lastConnectedAt = Date.now();
      this.setState('connected');
    });
    socket.on('reconnect_attempt', () => this.setState('reconnecting'));
    socket.on('connect_error',  (err: Error & {data?: {code?: string; message?: string}}) => {
      // Transient handshake failure — socket.io will retry until we give up.
      if (this.closedByUser) {return;}
      // Why: when the server's handshake middleware rejects with an
      // `unauthorized`/`token_revoked` code (expired JWT, JTI not in
      // Redis, signature failure), socket.io fires `connect_error` —
      // NOT the inline `error` frame the mid-session auth path uses.
      // Without this branch, the client retries forever with the same
      // stale token. Trigger the same single-flight refresh+reopen
      // path the inline `error` handler uses.
      const code   = err?.data?.code;
      const reason = err?.data?.message ?? err?.message ?? '';
      const isAuthReject =
        code === 'unauthorized' ||
        code === 'token_revoked' ||
        /token_revoked|exp.*claim|invalid_token|missing_token|jwt|expired/i.test(reason);
      if (isAuthReject && this.opts.refreshToken && !this.unauthorizedRefreshInFlight) {
        this.unauthorizedRefreshInFlight = true;
        this.setState('reconnecting');
        try { socket.disconnect(); } catch { /* ignore */ }
        void this.opts.refreshToken()
          .then(() => {
            this.unauthorizedRefreshInFlight = false;
            void this.open();
          })
          .catch(() => {
            this.unauthorizedRefreshInFlight = false;
            this.closedByUser = true;
            this.setState('unauthorized');
          });
        return;
      }
      this.setState('reconnecting');
    });

    // Server emits every frame with its own event name (`envelope.deliver`,
    // `presence`, `call.offer`, `error`, etc). `onAny` captures the lot
    // and rebuilds the ServerFrame shape the app expects.
    socket.onAny((event: string, data: unknown) => {
      // The server's `error` frame carries `{code, message}` and is how
      // we learn about auth failures (it arrives right before disconnect).
      // Round 2 fix: instead of stranding the WS in `unauthorized` and
      // forcing the user to restart, drive a single refresh attempt and
      // reopen the socket with the fresh JWT. We only fall through to
      // the old "give up" branch when refresh itself fails OR no
      // refresh hook is wired (loopback dev / test runs).
      // Why: also handle 'token_revoked' (P0-6 mid-stream JTI revocation
      // sweep — see messenger.gateway.ts:360). Previously only
      // 'unauthorized' triggered refresh; token_revoked frames fell
      // through to onFrame, server disconnected, socket.io retried with
      // the same revoked JWT, and the WS sat stranded.
      if (event === 'error' && isErrorPayload(data) && (data.code === 'unauthorized' || data.code === 'token_revoked')) {
        if (this.opts.refreshToken && !this.unauthorizedRefreshInFlight) {
          this.unauthorizedRefreshInFlight = true;
          this.setState('reconnecting');
          try { socket.disconnect(); } catch { /* ignore */ }
          void this.opts.refreshToken()
            .then(() => {
              this.unauthorizedRefreshInFlight = false;
              // Reopen with the fresh access token. open() reads
              // `getToken()` which now returns the refreshed value.
              // open() returns a Promise; void it so the lint
              // no-floating-promises rule is satisfied — we do not
              // need to wait for the new connection to complete here.
              void this.open();
            })
            .catch(() => {
              // Refresh failed — fall back to the old behaviour so the
              // app surfaces the unauthorized state to the UI.
              this.unauthorizedRefreshInFlight = false;
              this.closedByUser = true;
              this.setState('unauthorized');
            });
          return;
        }
        this.closedByUser = true; // stop socket.io from retrying
        this.setState('unauthorized');
        try { socket.disconnect(); } catch { /* ignore */ }
        return;
      }
      const frame = {event, data} as ServerFrame;
      this.opts.onFrame(frame);
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
        this.setState('disconnected');
        return;
      }
      this.setState('reconnecting');
    });
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
