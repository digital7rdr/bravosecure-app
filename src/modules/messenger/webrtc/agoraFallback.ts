/**
 * Agora fallback decision logic.
 *
 * In Phase 1 we prefer direct WebRTC (coturn TURN servers in Mumbai +
 * London per infra plan). If ICE fails to reach `connected` within
 * the budget (default 12s), we fall back to Agora SDK for the call.
 * Every fallback emits an audit event so the security team can track
 * how often we're degrading to a third-party media path.
 *
 * This module is intentionally logic-only — it does NOT import
 * `react-native-agora`. The host app plugs in an `agoraStart`
 * callback; that's where the native side-effect lives.
 */

export interface AgoraFallbackOptions {
  /** ms to wait for ICE `connected` before bailing. */
  iceTimeoutMs?: number;
  /** Called with {callId, reason} whenever we start the Agora path. */
  onFallback:  (event: {callId: string; reason: string; at: number}) => void;
  /** Host provides this — actually boots the Agora SDK call. */
  agoraStart:  (callId: string) => Promise<void>;
}

export class AgoraFallback {
  constructor(private readonly opts: AgoraFallbackOptions) {}

  private get budget(): number {
    return this.opts.iceTimeoutMs ?? 12_000;
  }

  /**
   * Race an ICE-connected signal against a timeout. If the timeout
   * wins, run the fallback path. If ICE wins, do nothing. Caller
   * invokes `cancel()` when the call ends so stale timers don't fire.
   */
  watch(callId: string, iceConnected: Promise<void>): {cancel: () => void; done: Promise<'ice' | 'agora'>} {
    let settled = false;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const done = new Promise<'ice' | 'agora'>((resolve, reject) => {
      iceConnected.then(() => {
        if (settled || cancelled) {return;}
        settled = true;
        if (timeoutId) {clearTimeout(timeoutId);}
        resolve('ice');
      }).catch(e => {
        if (settled || cancelled) {return;}
        settled = true;
        if (timeoutId) {clearTimeout(timeoutId);}
        reject(e);
      });

      timeoutId = setTimeout(() => {
        if (settled || cancelled) {return;}
        settled = true;
        this.opts.onFallback({callId, reason: 'ice_timeout', at: Date.now()});
        this.opts.agoraStart(callId)
          .then(() => resolve('agora'))
          .catch(reject);
      }, this.budget);
    });

    return {
      cancel: () => {
        cancelled = true;
        if (timeoutId) {clearTimeout(timeoutId);}
      },
      done,
    };
  }
}
