import type {SenderCertClient, IssuedCert} from '../transport';

/**
 * Caches the sealed-sender cert and refreshes it before expiry.
 * A single in-memory slot is fine — the cert is bound to this device's
 * identity key, which doesn't change at runtime. If the identity key
 * ever rotates, the cache must be invalidated.
 *
 * Refresh policy: request a new cert when less than 10 minutes remain.
 * This gives comfortable headroom for clock skew and network delay
 * without burning a call on every send.
 */

const REFRESH_MARGIN_SEC = 10 * 60;
/**
 * Fix #14: negative-cache TTL. Without it, a flapping auth-service
 * (rate-limited, briefly down) would hammer /sender-cert on EVERY
 * outbound message — each send blocks on a fresh fetch that re-fails
 * immediately, and the user sees one banner per send. Caching the
 * failure for 30s coalesces the storm into one error per window
 * while still recovering quickly when the server comes back.
 */
const NEGATIVE_CACHE_MS = 30_000;

export class SenderCertCache {
  private current: IssuedCert | null = null;
  private inflight: Promise<IssuedCert> | null = null;
  /** Last failure wall-clock + cached error for the negative-cache window. */
  private lastFailureAt: number = 0;
  private lastFailureErr: Error | null = null;

  constructor(
    private readonly client:             SenderCertClient,
    private readonly signalDeviceId:     number,
    private readonly ownIdentityKeyB64:  string,
  ) {}

  /**
   * Return a valid cert, fetching or refreshing if needed. Concurrent
   * callers share a single inflight request — no thundering herd.
   */
  async get(): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.current && this.current.expiresAt - nowSec > REFRESH_MARGIN_SEC) {
      return this.current.cert;
    }
    // Fix #14: short-circuit if a recent fetch failed. Throw the same
    // cached error so callers see consistent messaging instead of a
    // fresh auth-service round-trip per send.
    if (this.lastFailureErr && Date.now() - this.lastFailureAt < NEGATIVE_CACHE_MS) {
      throw this.lastFailureErr;
    }
    if (!this.inflight) {
      this.inflight = this.client.issueCert({
        senderSignalDeviceId: this.signalDeviceId,
        senderIdentityKey:    this.ownIdentityKeyB64,
      }).then(issued => {
        this.current = issued;
        // Success — clear any prior failure so the next miss can fetch.
        this.lastFailureErr = null;
        this.lastFailureAt  = 0;
        return issued;
      }).catch(err => {
        // Fix #14: arm the negative cache. Re-throw so the awaiter
        // sees the failure synchronously this time; subsequent calls
        // within the window get the cached throw above.
        this.lastFailureErr = err instanceof Error ? err : new Error(String(err));
        this.lastFailureAt  = Date.now();
        throw err;
      }).finally(() => {
        this.inflight = null;
      });
    }
    return (await this.inflight).cert;
  }

  /** Drop the cached cert — next call will re-fetch. Use on auth change. */
  invalidate(): void {
    this.current = null;
    // Also clear the negative cache so a forced invalidate (typically
    // post-login) doesn't get blocked by a stale 30s window.
    this.lastFailureErr = null;
    this.lastFailureAt  = 0;
  }
}
