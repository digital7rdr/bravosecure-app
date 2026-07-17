/**
 * Audit P0-5 — per-socket token-bucket rate limiter for WS events.
 *
 * `@nestjs/throttler` only covers the HTTP surface; the WS gateway has
 * the same DoS profile (a single authed socket can pump `envelope.send`
 * in a tight loop) but no built-in defence. This module gives the
 * gateway a per-(socketId, event) bucket so a chatty event can't drown
 * the relay even when the client is "well-behaved" on HTTP.
 *
 * Design: classical leaky-bucket. Each (socket, event) pair carries a
 * `(tokens, lastRefillMs)` pair stored on the socket itself (WeakMap)
 * so disconnect garbage-collects automatically. Every consume() call
 * refills `(now - lastRefill) * rate` tokens (capped at `capacity`)
 * before decrementing.
 *
 * Why in-memory + per-socket rather than Redis: this is the LAST line
 * of defence against a single misbehaving connection. Cross-cluster
 * coordination would add a Redis round-trip to every WS event, and
 * the cluster-level concern is already handled by the per-user HTTP
 * throttler + per-recipient queue cap (P0-7). The local bucket is
 * cheap, correct, and survives Redis flakes.
 *
 * Time source is injectable so tests can simulate clock drift; defaults
 * to `Date.now()`.
 */

interface Bucket {
  tokens:        number;
  lastRefillMs:  number;
}

export interface RateLimit {
  /** Tokens regenerated per second. */
  refillPerSec: number;
  /** Bucket size — also the burst ceiling. */
  capacity:     number;
}

export interface RateLimited {
  ok:          false;
  retryAfterMs: number;
}

export interface RateAllowed {
  ok: true;
}

export type ConsumeResult = RateAllowed | RateLimited;

/**
 * Per-socket buckets, indexed by socket then by event name.
 *
 * WeakMap keys on the socket itself so a disconnected socket's entry
 * is reaped without explicit cleanup.
 */
const socketBuckets = new WeakMap<object, Map<string, Bucket>>();

export interface ClockSource {
  now(): number;
}

const DEFAULT_CLOCK: ClockSource = {now: () => Date.now()};

export class WsRateLimiter {
  constructor(private readonly clock: ClockSource = DEFAULT_CLOCK) {}

  /**
   * Try to consume one token from the (socket, event) bucket. Returns
   * `{ok: true}` when accepted; `{ok: false, retryAfterMs}` when
   * exhausted. The retry hint is the time until enough tokens regen
   * to admit one frame.
   */
  consume(socket: object, event: string, limit: RateLimit): ConsumeResult {
    let perSocket = socketBuckets.get(socket);
    if (!perSocket) {
      perSocket = new Map();
      socketBuckets.set(socket, perSocket);
    }
    const now = this.clock.now();
    let bucket = perSocket.get(event);
    if (!bucket) {
      bucket = {tokens: limit.capacity, lastRefillMs: now};
      perSocket.set(event, bucket);
    }
    // Refill: integer floor of accumulated regen, clamped at capacity.
    const elapsedMs = now - bucket.lastRefillMs;
    if (elapsedMs > 0) {
      const refill = (elapsedMs / 1000) * limit.refillPerSec;
      bucket.tokens = Math.min(limit.capacity, bucket.tokens + refill);
      bucket.lastRefillMs = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {ok: true};
    }
    // Deficit < 1 token; wait long enough to regen to >= 1.
    const deficit = 1 - bucket.tokens;
    const retryAfterMs = Math.max(1, Math.ceil((deficit / limit.refillPerSec) * 1000));
    return {ok: false, retryAfterMs};
  }

  /** Test-only: reset all buckets for a socket. */
  resetForSocket(socket: object): void {
    socketBuckets.delete(socket);
  }
}

/**
 * Default per-event limits. Tuned so:
 *   - `envelope.send`: 30 sends / 10s — same shape as the HTTP cap.
 *   - `envelope.ack`:  60 acks  / 10s — symmetric to the HTTP ack cap.
 *   - `call.offer`/`call.answer`/`call.reoffer`/`call.reanswer`: low
 *      cap; SDP renegotiation is rare and a flood is always abusive.
 *   - `call.ice`:      generous; a wifi handover can legitimately
 *      gather 40+ candidates in a second.
 *   - `presence.update` / `typing`: medium; UI debounces these, a
 *      flood is almost always a bug or attack.
 */
export const DEFAULT_WS_LIMITS: Record<string, RateLimit> = {
  'envelope.send':     {refillPerSec: 3,  capacity: 30},
  'envelope.ack':      {refillPerSec: 6,  capacity: 60},
  'call.offer':        {refillPerSec: 1,  capacity: 5},
  'call.answer':       {refillPerSec: 1,  capacity: 5},
  'call.reoffer':      {refillPerSec: 1,  capacity: 10},
  'call.reanswer':     {refillPerSec: 1,  capacity: 10},
  'call.ice':          {refillPerSec: 40, capacity: 200},
  'call.hangup':       {refillPerSec: 1,  capacity: 5},
  'call.media-state':  {refillPerSec: 1,  capacity: 10},
  // Group-call camera/mic toggle — same budget as the 1:1 media-state
  // toggle; each accepted frame fans out to the room, so an unmetered
  // toggle loop would be a broadcast amplifier.
  'sfu.producer.pause':  {refillPerSec: 1, capacity: 10},
  'sfu.producer.resume': {refillPerSec: 1, capacity: 10},
  // Audit SFU-07 — rate-limit room joins. The server can't verify E2E group
  // membership, so a removed member who knows the conversationId can discover
  // and join a live call; media CONTENT is already protected (removeGroupMember
  // rotates the SFrame key, so they see undecryptable frames), but they can
  // still occupy a slot against the 6-cap. Capping join attempts blunts the
  // slot-exhaustion / rejoin-spam DoS (a legit reconnect→rejoin is ≤ a few/min).
  'sfu.join':            {refillPerSec: 1, capacity: 6},
  // Audit P2-3 — meter the in-app group ring (was unmetered). Each accepted
  // frame fans `sfu.ring.incoming` + a VoIP wake to every target, so an
  // unmetered loop is a broadcast/wake amplifier. A host rings once per call;
  // a small burst budget covers legit retries after a transient failure.
  'sfu.ring':            {refillPerSec: 1, capacity: 5},
  'presence.update':   {refillPerSec: 2,  capacity: 10},
  // Handler event is `presence` (active/away) — keyed to match the gate call.
  'presence':          {refillPerSec: 2,  capacity: 10},
  'typing':            {refillPerSec: 2,  capacity: 10},
  'read-receipt':      {refillPerSec: 5,  capacity: 30},
  'mission.subscribe': {refillPerSec: 1,  capacity: 5},
  'mission.unsubscribe': {refillPerSec: 1, capacity: 5},
  // Audit WS-HIGH — these were unmetered. `envelope.pull` is the most
  // expensive WS verb (ZRANGEBYSCORE + pipeline GET of up to 1000 envelopes),
  // so an unmetered loop is a self-amplifying DoS. presence.subscribe joins N
  // watch rooms + a getMany snapshot. Caps allow a legit coalesced burst then
  // throttle to a steady trickle.
  'envelope.pull':       {refillPerSec: 1, capacity: 10},
  'presence.subscribe':  {refillPerSec: 1, capacity: 10},
  'presence.unsubscribe':{refillPerSec: 1, capacity: 10},
};
