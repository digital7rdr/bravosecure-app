/**
 * HTTP client for auth-service's sealed-sender cert endpoint.
 *
 *   POST /sender-cert  body={senderSignalDeviceId, senderIdentityKey}
 *                      returns {cert, expiresAt}
 *
 * The cert is a short-lived (~1h) Ed25519 JWT. Callers cache it via
 * CertCache and include it inside every outgoing sealed payload.
 */

export interface SenderCertClientOptions {
  /** Auth-service base URL, e.g. http://10.0.2.2:3001 */
  baseUrl:  string;
  getToken: () => Promise<string | null>;
  /** Fix #19: optional refresh-on-401 — see relayClient for rationale. */
  refreshToken?: () => Promise<void>;
}

export class SenderCertHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'SenderCertHttpError';
  }
}

export interface IssuedCert {
  cert:      string;
  /** Unix seconds — same value the cert's own `exp` claim carries. */
  expiresAt: number;
}

export class SenderCertClient {
  constructor(private readonly opts: SenderCertClientOptions) {}

  async issueCert(params: {
    senderSignalDeviceId: number;
    senderIdentityKey:    string;
  }): Promise<IssuedCert> {
    // Fix #19: retry once on 401 after a token refresh — see relayClient.
    const send = async (): Promise<Response> => {
      const token = await this.opts.getToken();
      if (!token) {throw new SenderCertHttpError(401, 'no_token');}
      return fetch(`${this.opts.baseUrl}/sender-cert`, {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          senderSignalDeviceId: params.senderSignalDeviceId,
          senderIdentityKey:    params.senderIdentityKey,
        }),
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
      throw new SenderCertHttpError(res.status, msg);
    }
    return parsed as IssuedCert;
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
