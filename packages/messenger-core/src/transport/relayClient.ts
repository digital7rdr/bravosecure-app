import type {SessionAddress} from './protocol';

/**
 * HTTP companion to the WS TransportClient. Used for:
 *   - Backup send path when the WS is down
 *   - Batch pull after reconnect
 *   - Ack on delivery
 *
 * Headers:
 *   Authorization: Bearer <JWT>
 *   X-Signal-Device-Id: <caller's Signal device id>
 *
 * Endpoints (apps/messenger-service/src/relay/envelope.controller.ts):
 *   POST /envelopes           — submit one envelope
 *   GET  /envelopes           — pull pending for this device (supports ?after=&limit=)
 *   POST /envelopes/:id/ack   — hard-delete on successful decrypt
 */

export interface RelayEnvelope {
  envelopeId:   string;
  recipient:    SessionAddress;
  /**
   * Sealed Sender v2 outer ECIES wrap (base64). Recipient unwraps via
   * `unwrapOuter` to recover the libsignal SessionCipher input + the
   * sender's address. The relay treats this string as opaque bytes —
   * no field on the wire links the envelope back to the sender.
   */
  outerSealed:  string;
  timestamp:    number;
  dwellExpires: number;
  /**
   * Audit P0-N9 — possession-proof token. Random per-envelope value
   * issued by the relay on first delivery; the recipient must present
   * it back on ack. Optional during the rollout window so legacy
   * clients can still ack pending envelopes; missing tokens fall back
   * to the recipient-identity check (legacy semantics) server-side.
   */
  ackToken?:    string;
}

export interface RelayHttpClientOptions {
  /** Base URL including scheme/host/port, no trailing slash. e.g. `http://10.0.2.2:3100` */
  baseUrl: string;
  /** Called before each request. Return null to abort with a friendly error. */
  getToken: () => Promise<string | null>;
  /** The caller's Signal deviceId. Required by the relay on every call. */
  signalDeviceId: number;
  /**
   * Fix #19: optional refresh callback. When the relay returns 401
   * the client invokes this once, then retries with the freshly-
   * refreshed token from `getToken`. Without this, an expired access-
   * token after wake-from-sleep made every send fail; the user had to
   * relaunch the app to recover.
   */
  refreshToken?: () => Promise<void>;
}

export class RelayHttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = 'RelayHttpError';
  }
}

export class RelayHttpClient {
  constructor(private readonly opts: RelayHttpClientOptions) {}

  async send(input: {
    recipient:    SessionAddress;
    outerSealed:  string;
    clientMsgId?: string;
    /**
     * Disappearing-message deadline (epoch seconds). When set, the relay
     * shortens the envelope's Redis TTL to match so the ciphertext self-
     * evicts at this time even if the recipient never comes online.
     * The deadline is also carried encrypted inside the sealed-sender
     * body for the recipient's own expiry sweep.
     */
    expiresAtSec?: number;
    /**
     * Killed-app wake suppression (server DTO `urgent`). Absent/true wakes
     * the recipient for displayable envelopes; `false` for non-displayable
     * ones (reactions, group-control/rekey) suppresses the phantom wake.
     */
    urgent?: boolean;
  }): Promise<{envelopeId: string; deliveredNow: boolean; clientMsgId?: string; retractToken?: string}> {
    return this.request('POST', '/envelopes', input);
  }

  async pull(opts?: {after?: number; limit?: number; bootstrap?: boolean}): Promise<{envelopes: RelayEnvelope[]}> {
    const params = new URLSearchParams();
    if (opts?.after !== null && opts?.after !== undefined) {params.set('after', String(opts.after));}
    if (opts?.limit !== null && opts?.limit !== undefined) {params.set('limit', String(opts.limit));}
    // Restore-after-reinstall fix #4 — flag the FIRST pull on a fresh
    // install so the server lets us drain the entire backlog (up to
    // relay.maxBootstrapLimit, default 1000) instead of paginating
    // through the normal 100-cap window. Without this a user with a
    // multi-week backlog of dwelling envelopes would see only the
    // most-recent slice on a reinstall.
    if (opts?.bootstrap) {params.set('bootstrap', '1');}
    const q = params.toString();
    return this.request('GET', `/envelopes${q ? `?${q}` : ''}`);
  }

  /**
   * Audit P0-N9 — `ackToken` is the possession-proof issued in the
   * deliver frame / pull response. Optional during the rollout window
   * so legacy callers don't have to thread it through immediately;
   * once 100% of clients are sending it, server-side enforcement flips
   * from "warn on missing" to "reject on missing".
   */
  async ack(
    envelopeId: string,
    ackToken?: string,
    /**
     * Handoff §3.6(c) — 'discarded' when the device destroyed the
     * message (terminal decrypt failure): the relay still hard-deletes
     * but emits `envelope.undeliverable` to the sender instead of the
     * ✓✓ `envelope.delivered`. Absent/'delivered' keeps legacy behavior.
     */
    disposition?: 'delivered' | 'discarded',
  ): Promise<void> {
    const body = (ackToken || disposition)
      ? {...(ackToken ? {ackToken} : {}), ...(disposition ? {disposition} : {})}
      : undefined;
    await this.request(
      'POST',
      `/envelopes/${encodeURIComponent(envelopeId)}/ack`,
      body,
    );
  }

  /**
   * Sender-initiated retract — the server hard-deletes the envelope
   * if it's still in the relay queue. Idempotent: if the recipient
   * has already pulled + ACKed, returns `{retracted: false}` without
   * error. Capability auth: the token alone is the proof, no JWT
   * identity check (preserves Sealed Sender — see envelope.service.ts).
   */
  async retract(retractToken: string): Promise<{retracted: boolean}> {
    return this.request('POST', '/envelopes/retract', {retractToken});
  }

  /**
   * Audit P0-1 follow-up — purge queued envelopes addressed to a
   * SUPERSEDED recipient identity. Called by the client immediately
   * after `installIdentity` publishes a new identity to the keys
   * service. The relay enumerates its queue for the JWT-authenticated
   * user and drops every envelope whose outer ECIES wrap was built
   * against the supplied `supersededIdentityB64` — those envelopes
   * are unrecoverable on the client (the matching private key was
   * discarded with the old install) so leaving them on the relay
   * just blocks the drain for up to 30 days.
   *
   * Idempotency: safe to call any number of times. Returns
   * `{purged}` count when the backend honours it. If the endpoint
   * doesn't exist (older backend), throws RelayHttpError with status
   * 404 — caller treats that as "feature not yet deployed" and
   * silently no-ops. NEVER include the NEW identity in the request
   * (that would let an attacker who learned the new identity also
   * trigger purges).
   */
  /**
   * Audit P1-T2 — `mfaProofToken` is the fresh MFA action token
   * (purpose=`recipient_purge`, minted by auth-service after an
   * identity-rotation ceremony). Required by the server-side
   * `RecipientPurgeGuard`; without it the request 401s with
   * `missing_mfa_proof`. Caller (mobile installIdentity flow) obtains
   * the token from auth-service immediately after publishing the new
   * bundle, then hands it to us.
   *
   * Backward-compat: when the auth-service has not yet shipped the
   * `recipient_purge` purpose, the caller can pass `undefined` and the
   * server will reject — exactly the desired posture (fail-closed on
   * an under-provisioned auth-service rather than silently succeeding).
   */
  async purgeStaleRecipientQueue(
    supersededIdentityB64: string,
    mfaProofToken?: string,
  ): Promise<{purged: number}> {
    return this.request<{purged: number}>(
      'POST',
      '/envelopes/purge-stale-recipient',
      {supersededIdentity: supersededIdentityB64},
      mfaProofToken ? {'X-Mfa-Proof': mfaProofToken} : undefined,
    );
  }

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    // Fix #19: retry once on 401 after a token refresh. The first
    // attempt is identical to the original code; on 401 we drive the
    // (deduped) refresh callback and retry with fresh credentials.
    // Any other status — or a second 401 after refresh — bubbles up.
    const send = async (): Promise<Response> => {
      const token = await this.opts.getToken();
      if (!token) {throw new RelayHttpError(401, 'no_token');}
      const headers: Record<string, string> = {
        Authorization:        `Bearer ${token}`,
        'X-Signal-Device-Id': String(this.opts.signalDeviceId),
        ...(extraHeaders ?? {}),
      };
      if (body !== undefined) {headers['Content-Type'] = 'application/json';}
      return fetch(`${this.opts.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };

    let res = await send();
    if (res.status === 401 && this.opts.refreshToken) {
      try {
        await this.opts.refreshToken();
        res = await send();
      } catch { /* refresh failed — fall through with the original 401 */ }
    }

    if (res.status === 204) {return undefined as T;}
    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg  = typeof parsed === 'object' && parsed && 'message' in parsed ? String((parsed as {message: unknown}).message) : text || res.statusText;
      const code = typeof parsed === 'object' && parsed && 'code' in parsed    ? String((parsed as {code:    unknown}).code)    : undefined;
      throw new RelayHttpError(res.status, msg, code);
    }
    return (parsed ?? {}) as T;
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
