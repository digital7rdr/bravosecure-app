import type {PreKeyBundle, SessionAddress} from '../crypto/types';

/**
 * HTTP adapter for auth-service's existing keys endpoints.
 *
 *   POST /auth/keys/upload   — upload bundle + batch of pre-keys
 *   GET  /auth/keys/:userId  — fetch peer's bundle; server atomically
 *                              pops one one-time pre-key per call.
 *
 * Field-name translation lives HERE so the rest of the client uses
 * the internal `PreKeyBundle` shape (camelCase, nested signedPreKey).
 * Auth-service speaks `signedPrekey`/`oneTimePrekeys` (legacy casing).
 *
 * Phase-1 simplification: auth-service stores ONE identity per user,
 * no per-device dimension. We hardcode `deviceId: 1` when wrapping
 * fetched bundles into our internal shape. Multi-device support in
 * auth-service is a Phase-2 project.
 */

/** Server DTO — what POST /auth/keys/upload accepts. */
interface ServerUploadDto {
  registrationId:  number;
  identityKey:     string;
  signedPrekeyId:  number;
  signedPrekey:    string;
  signedPrekeySig: string;
  oneTimePrekeys?: {keyId: number; publicKey: string}[];
}

/** Server response — what GET /auth/keys/:userId returns. */
interface ServerBundleResponse {
  registrationId:  number;
  identityKey:     string;
  signedPrekeyId:  number;
  signedPrekey:    string;
  signedPrekeySig: string;
  oneTimePrekey:   {keyId: number; publicKey: string} | null;
}

export interface KeysHttpClientOptions {
  /** Auth-service base URL, e.g. http://10.0.2.2:3001 */
  baseUrl:  string;
  getToken: () => Promise<string | null>;
  /**
   * Fix #19: optional refresh-on-401. When auth-service returns 401
   * (typically expired access token), the client invokes this once
   * and retries with the freshly-refreshed token from `getToken`.
   * Caller is expected to dedupe concurrent refreshes (api.ts's
   * `fetchWithRefresh` does this via `refreshInFlight`).
   */
  refreshToken?: () => Promise<void>;
}

export class KeysHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'KeysHttpError';
  }
}

export class KeysHttpClient {
  constructor(private readonly opts: KeysHttpClientOptions) {}

  /**
   * Upload our own bundle + pre-key pool. Call after first install
   * (or when refilling the OPK pool — server supports append-only).
   */
  async uploadBundle(params: {
    registrationId:  number;
    identityKey:     string;
    signedPreKey:    {keyId: number; publicKey: string; signature: string};
    oneTimePreKeys?: {keyId: number; publicKey: string}[];
  }): Promise<{
    ok: true;
    oneTimeKeysStored: number;
    poolSize: number;
    /**
     * Handoff §4.5-1 — server-detected identity rotation. True when the
     * uploaded identity differs from the one previously on file for this
     * (userId, deviceId) — i.e. a reinstall/recovery minted a new keypair.
     * `previousIdentityKey` (base64 PUBLIC key) is the superseded identity
     * the relay purge endpoint needs; only present when rotated. Absent
     * on servers that predate the field (treat as not-rotated).
     */
    identityRotated?: boolean;
    previousIdentityKey?: string;
  }> {
    const body: ServerUploadDto = {
      registrationId:  params.registrationId,
      identityKey:     params.identityKey,
      signedPrekeyId:  params.signedPreKey.keyId,
      signedPrekey:    params.signedPreKey.publicKey,
      signedPrekeySig: params.signedPreKey.signature,
      oneTimePrekeys:  params.oneTimePreKeys,
    };
    return this.request('POST', '/auth/keys/upload', body);
  }

  /**
   * Handoff §4.5-4 — mint a short-lived MFA action token (auth-service
   * `POST /auth/biometric/assert`) for a purpose-gated relay call (the
   * only current consumer: `recipient_purge`). Returns null on ANY
   * failure — the callers are best-effort flows that must proceed
   * without the proof.
   *
   * `attestationToken`: a real Play Integrity / DeviceCheck token when
   * the app has one. The default placeholder only passes on staging
   * (BIOMETRIC_DEV_BYPASS=true); production correctly rejects it, the
   * caller degrades gracefully, and the path lights up the day a real
   * attestation provider ships. Deliberately NOT a bypass — the server
   * gate stays intact.
   */
  async mintActionToken(
    purpose: string,
    attestationToken = 'attestation-unavailable',
  ): Promise<{actionToken: string} | null> {
    try {
      const res = await this.request<{actionToken?: string}>('POST', '/auth/biometric/assert', {
        attestationToken,
        platform: 'android',
        purpose,
      });
      return res?.actionToken ? {actionToken: res.actionToken} : null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch a peer bundle AND surface the pool-size header so the
   * runtime can trigger an OPK refill when the pool is getting low.
   * auth-service sets `X-Pre-Key-Count` whenever the pool drops below
   * its threshold; we translate that into an optional field here.
   */
  async fetchPeerBundleWithPoolSize(userId: string): Promise<{
    bundle:   PreKeyBundle;
    poolSize: number | null;
  }> {
    // Fix #19: retry once on 401 after a token refresh.
    const fetchOnce = async (): Promise<Response> => {
      const tok = await this.opts.getToken();
      if (!tok) {throw new KeysHttpError(401, 'no_token');}
      return fetch(`${this.opts.baseUrl}/auth/keys/${encodeURIComponent(userId)}`, {
        headers: {Authorization: `Bearer ${tok}`},
      });
    };
    let res = await fetchOnce();
    if (res.status === 401 && this.opts.refreshToken) {
      try { await this.opts.refreshToken(); res = await fetchOnce(); } catch { /* fall through */ }
    }
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {throw new KeysHttpError(res.status, (parsed?.message as string) ?? res.statusText);}

    const poolHeader = res.headers.get('x-pre-key-count') ?? res.headers.get('X-Pre-Key-Count');
    const poolSize   = poolHeader ? Number.parseInt(poolHeader, 10) : null;

    const resp = parsed as ServerBundleResponse;
    const bundle: PreKeyBundle = {
      registrationId: resp.registrationId,
      address:        {userId, deviceId: 1},
      identityKey:    resp.identityKey,
      signedPreKey: {
        keyId:     resp.signedPrekeyId,
        publicKey: resp.signedPrekey,
        signature: resp.signedPrekeySig,
      },
    };
    if (resp.oneTimePrekey) {
      bundle.preKey = {keyId: resp.oneTimePrekey.keyId, publicKey: resp.oneTimePrekey.publicKey};
    }
    return {bundle, poolSize: Number.isFinite(poolSize as number) ? poolSize : null};
  }

  /**
   * Fetch a peer's bundle for X3DH. Returns an internal PreKeyBundle
   * shape. Each call consumes ONE one-time pre-key from the peer's
   * server-side pool — never call speculatively.
   */
  async fetchPeerBundle(userId: string): Promise<PreKeyBundle> {
    const resp = await this.request<ServerBundleResponse>(
      'GET',
      `/auth/keys/${encodeURIComponent(userId)}`,
    );
    const address: SessionAddress = {userId, deviceId: 1};
    const bundle: PreKeyBundle = {
      registrationId: resp.registrationId,
      address,
      identityKey:    resp.identityKey,
      signedPreKey: {
        keyId:     resp.signedPrekeyId,
        publicKey: resp.signedPrekey,
        signature: resp.signedPrekeySig,
      },
    };
    if (resp.oneTimePrekey) {
      bundle.preKey = {
        keyId:     resp.oneTimePrekey.keyId,
        publicKey: resp.oneTimePrekey.publicKey,
      };
    }
    return bundle;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Fix #19: retry once on 401 after a token refresh.
    const send = async (): Promise<Response> => {
      const token = await this.opts.getToken();
      if (!token) {throw new KeysHttpError(401, 'no_token');}
      return fetch(`${this.opts.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };
    let res = await send();
    if (res.status === 401 && this.opts.refreshToken) {
      try { await this.opts.refreshToken(); res = await send(); } catch { /* fall through */ }
    }
    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = typeof parsed === 'object' && parsed && 'message' in parsed
        ? String((parsed as {message: unknown}).message)
        : text || res.statusText;
      throw new KeysHttpError(res.status, msg);
    }
    return (parsed ?? {}) as T;
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
