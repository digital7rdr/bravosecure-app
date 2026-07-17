import {CryptoError} from './errors';

/**
 * Sealed Sender — pragmatic Phase-1 implementation.
 *
 * The construction: BEFORE the sender calls `SessionCipher.encrypt`,
 * wrap the plaintext + sender cert into a JSON envelope. The Signal
 * ciphertext produced by libsignal is then opaque to the relay — the
 * relay sees only `{recipient, ciphertext}` with no sender hint.
 *
 *   plaintext ──► seal(cert, plaintext) ──► wrapped
 *                                            │
 *                                            ▼
 *                                SessionCipher.encrypt(wrapped) ──► ciphertext
 *                                                                    │
 *                                                                    ▼
 *                                                           relay (no sender)
 *                                                                    │
 *                              ciphertext ──► SessionCipher.decrypt
 *                                                                    │
 *                                                                    ▼
 *                                             unseal(wrapped) ──► {cert, body, ...}
 *                                                                    │
 *                                                                    ▼
 *                                               verifySenderCert(cert) ──► identity
 *
 * M6 extension: optional `attachment` carries per-file AES-256-CBC key
 * + IV + R2 object key. The blob itself lives in R2; the key/iv never
 * touch HTTP outside this payload.
 *
 * M7 extension: optional `expiresAtSec` is the epoch-seconds deadline
 * at which both sides must purge the message locally. Both sender and
 * recipient countdown from the same value (no clock drift concerns
 * beyond typical NTP accuracy).
 *
 * Format versions:
 *   v: 1 — initial (M4)
 *   v: 2 — adds optional attachment + expiresAtSec
 *   v: 3 — adds optional `aad` block binding ciphertext to recipient + ts.
 *          Round 5 / Security S1 fix. Without aad, a captured ciphertext
 *          could be replayed to a DIFFERENT recipient (the inner Signal
 *          ratchet authenticates the sender but not the intended
 *          destination), and a stolen-then-released session record could
 *          be replayed against a future point in time (cert iat/exp is
 *          only ~1h-granular). The aad block binds both at seal time.
 *
 * v:1 parsers fail on v:2 messages. That's intentional — any client
 * seeing a v:2 payload needs to know how to handle the new optional
 * fields. We keep the strict check because silently dropping an
 * attachment or expiry timer is worse than rejecting the message.
 *
 * v:3 envelopes are accepted by v:2 parsers because the optional `aad`
 * field is shape-validated when present and ignored when absent — the
 * isSealedPayload guard is positive (validates known fields' shapes,
 * allows extras). v:3 receivers ENFORCE the aad binding when present;
 * legacy senders that omit it still interop (back-compat during rollout).
 */

const SEALED_VERSION = 3;
/**
 * Lowest payload version we will still parse. Audit fix #4 — during a
 * staggered rollout of v2 we still see v1 envelopes in flight. Hard-
 * rejecting them locked out clients mid-upgrade. We accept any version
 * `>= MIN_SEALED_VERSION` and only branch on the version when populating
 * optional fields the older shape didn't carry.
 */
const MIN_SEALED_VERSION = 1;

export interface SealedAttachment {
  /** R2 object key — feed to MediaClient.downloadEncrypted */
  objectKey: string;
  /** base64 AES-256 key */
  keyB64:    string;
  /** base64 16-byte IV */
  ivB64:     string;
  /** logical MIME type (display hint only — not cryptographically binding) */
  mimeType:  string;
  /** original plaintext byte length (before encryption) */
  size:      number;
  /**
   * Render hint for the recipient bubble — 'image' | 'audio' | 'video'
   * | 'file'. Display-only (not cryptographically binding); the
   * recipient falls back to sniffing `mimeType` when absent so older
   * senders still render.
   */
  kind?:     'image' | 'audio' | 'video' | 'file';
  /**
   * Media-parity metadata (2026-07-03, owner-approved) — all OPTIONAL,
   * all inside the sealed payload (relay-blind), display hints only.
   * Mirrors the messenger-core copy; keep in lockstep.
   */
  name?:       string;
  width?:      number;
  height?:     number;
  durationMs?: number;
  thumbB64?:   string;
}

/**
 * Group-addressing metadata (M9). When present, the recipient treats
 * the message as a group post and routes it into the group thread,
 * deduplicating on `(groupId, clientMsgId)` across the N pairwise
 * copies the sender produces as fan-out.
 */
export interface SealedGroup {
  /** Stable opaque group identifier (UUID). */
  groupId: string;
  /**
   * `text` is the common case; `admin` carries a membership change or
   * master-key rotation that recipients apply to local group state
   * BEFORE rendering (see groups/groupClient.ts).
   */
  kind:   'text' | 'admin';
  /** Sender-generated msg id so recipients can de-dupe identical copies. */
  clientMsgId: string;
}

/**
 * Round 5 / Security S1 — additional authenticated data binding the
 * sealed envelope to a SPECIFIC recipient + a SPECIFIC moment in time.
 *
 * Threat: without this binding, an attacker who copies the ciphertext
 * off the wire can attempt to replay it to:
 *   • a different recipient (won't decrypt under their session, BUT
 *     a buggy or compromised session record could)
 *   • the same recipient at a future time (re-shipping a message body
 *     that the user wrote but later regretted, or to confuse the
 *     ordering of events for a legal/audit purpose)
 *
 * Mitigation: at seal-time, the sender STAMPS the recipient address +
 * a millisecond timestamp into the JSON before ratcheting. At unseal
 * time, the receiver verifies that:
 *   1. aad.to.userId === self.userId (and deviceId matches),
 *   2. |aad.ts - now| ≤ 15 minutes (clock-tolerance window matched to
 *      the cert expiry window so legitimate offline-then-online flow
 *      still lands).
 *
 * The aad bytes themselves don't have to be authenticated by Signal —
 * they're INSIDE the Signal ratchet, which authenticates the sender's
 * identity. Putting `to` + `ts` inside that authenticated wrapper means
 * a replay against a different recipient or stale session would have
 * to forge a Double Ratchet message (computationally infeasible).
 */
export interface SealedAad {
  /** Recipient userId — receiver MUST verify it equals their own. */
  to:        {userId: string; deviceId: number};
  /** Sender-stamped epoch milliseconds when seal() was called. */
  ts:        number;
  /**
   * Audit P0-N2 — extended AAD bindings mirroring the package-side
   * SealedAad. See packages/messenger-core/src/crypto/sealedSender.ts
   * for the threat model. All four extensions are optional on the wire.
   */
  sender?:         {userId: string; deviceId: number};
  conversationId?: string;
  groupId?:        string;
  epoch?:          number;
}

export interface SealedPayload {
  /**
   * Format version — bump on any breaking change to the JSON shape.
   * Type is `number` (not the literal SEALED_VERSION) because we accept
   * any version >= MIN_SEALED_VERSION for backward compat during rollout
   * (audit fix #4). Branches in unsealPayload populate optionals only
   * for versions that actually carry them on the wire.
   */
  v: number;
  /** Opaque sender cert (Ed25519-signed JWT from auth-service). */
  cert: string;
  /** Original application plaintext. Empty string when message is attachment-only. */
  body: string;
  /**
   * Round 5 / Security S1 — recipient + timestamp binding. Optional on
   * the wire for back-compat; receivers validate when present and skip
   * (with a warning) when absent. Senders SHOULD always include it
   * starting v3.
   */
  aad?: SealedAad;
  /** Present only for messages that carry a file attachment. */
  attachment?: SealedAttachment;
  /** Epoch seconds. When set, both sides purge the message after this time. */
  expiresAtSec?: number;
  /**
   * Sender-chosen opaque id for this message. Receiver stores it as the
   * local message's `id` so reactions and replies can target the same
   * stable handle from both sides. Without this, sender and receiver
   * each mint independent ids, and any out-of-band reaction targeting
   * sender's id silently fails to match the receiver's row.
   */
  clientMsgId?: string;
  /** Present only for group posts — see SealedGroup. */
  group?: SealedGroup;
  /**
   * Quote/reply metadata — lets the recipient render the "↳ replying to X"
   * strip above the message body. `msgId` is the ORIGINATING sender's
   * client-generated id (opaque to server), `preview` is a plaintext
   * snippet the sender chooses to embed so the recipient doesn't have
   * to search their own history for context.
   */
  replyTo?: {msgId: string; preview: string};
  /**
   * Emoji reactions delivered out-of-band — an update that targets a
   * previously-sent message. When populated, clients treat this whole
   * envelope as a reaction update (body is empty), not a new message.
   */
  reaction?: {targetMsgId: string; emoji: string; remove?: boolean};
  /**
   * Out-of-band control message. Currently only `'rehandshake'`:
   * receiver-issued nudge sent after auto-rebuild on `DecryptError`.
   * The act of decrypting it (a fresh PreKeyWhisperMessage) makes
   * libsignal session-replace on the original sender's side, healing
   * the ratchet without user action. The recipient does NOT render
   * a control envelope — it's discarded after the session swap.
   */
  control?: 'rehandshake';
  /**
   * Group-call participant identity advertisement. Sent over the
   * existing E2E pairwise Signal session at SFU `sfu.join` time so
   * peers can map the SFU-assigned opaque `participantTag` (which the
   * SFU intentionally does not associate with a userId) to a human
   * display name. Without this, group-call tiles can only show the
   * first 8 characters of the random tag.
   *
   * Privacy invariant preserved: the SFU access log still contains only
   * tags. The mapping lives entirely on each client, end-to-end
   * encrypted in transit through the messenger relay.
   *
   * Recipient does NOT render this as a chat bubble — the runtime
   * routes it into a per-room identity registry consulted by
   * `useGroupCall` / `GroupCallScreen`.
   */
  groupCallPresence?: {
    roomId:         string;
    participantTag: string;
    displayName:    string;
    callType:       'voice' | 'video';
  };
}

export interface SealOptions {
  attachment?:   SealedAttachment;
  expiresAtSec?: number;
  clientMsgId?:  string;
  group?:        SealedGroup;
  replyTo?:      {msgId: string; preview: string};
  reaction?:     {targetMsgId: string; emoji: string; remove?: boolean};
  control?:      'rehandshake';
  groupCallPresence?: SealedPayload['groupCallPresence'];
  /**
   * Round 5 / Security S1 — recipient address + sender clock to be
   * stamped into `aad` at seal time. When present, recipient verifies.
   * Callers that don't pass `aad` produce a v3 envelope WITHOUT the
   * binding (back-compat with pre-S1 receivers + non-Bravo peers).
   * Production code SHOULD always pass aad. Tests + legacy code paths
   * may omit it.
   */
  aad?: SealedAad;
}

/**
 * Produce the JSON string that should be passed to `SessionCipher.encrypt`.
 * The cert is typically refreshed from auth-service every ~1h; callers
 * cache it and pass it here for each outgoing message.
 */
export function sealPayload(cert: string, body: string, opts: SealOptions = {}): string {
  if (!cert) {throw new CryptoError('missing sender cert');}
  const wrapped: SealedPayload = {v: SEALED_VERSION, cert, body};
  if (opts.attachment)   {wrapped.attachment   = opts.attachment;}
  // Fix #2 — the previous `if (opts.expiresAtSec)` falsy-coerced `0` to
  // mean "absent". `0` is a legitimate expiry (epoch 1970) used in tests
  // and could become a valid sentinel later; gate on type instead so
  // every numeric input round-trips faithfully.
  if (typeof opts.expiresAtSec === 'number') {wrapped.expiresAtSec = opts.expiresAtSec;}
  if (opts.clientMsgId)  {wrapped.clientMsgId  = opts.clientMsgId;}
  if (opts.group)        {wrapped.group        = opts.group;}
  if (opts.replyTo)      {wrapped.replyTo      = opts.replyTo;}
  if (opts.reaction)     {wrapped.reaction     = opts.reaction;}
  if (opts.control)      {wrapped.control      = opts.control;}
  if (opts.groupCallPresence) {wrapped.groupCallPresence = opts.groupCallPresence;}
  // Round 5 / Security S1 — recipient + timestamp binding. Stamped here
  // so it lives INSIDE the libsignal ciphertext. Sender's local clock
  // is used (NTP-aligned in practice); receiver tolerates ±15min skew.
  if (opts.aad)          {wrapped.aad          = opts.aad;}
  return JSON.stringify(wrapped);
}

/**
 * Round 5 / Security S1 — clock-skew window for the aad timestamp
 * check. 15 minutes covers offline-then-online laggy delivery (the
 * relay holds messages up to a few minutes; mobile networks can lag a
 * single message by tens of seconds), without giving an attacker a
 * useful replay window. Aligns with the sender-cert iat/exp window so
 * a fresh cert + fresh aad produce the same effective freshness.
 */
export const SEALED_AAD_SKEW_MS = 15 * 60 * 1000;

/**
 * Audit MEDIUM-1 (2026-07-02) — FUTURE-timestamp tolerance (24h). Mirrors the
 * package side. A tight 15-min future bound against the receiver's own device
 * clock silently dropped every message from a fast-clock sender (or to a
 * slow-clock receiver). Replay is prevented by the ratchet + seen-store, not
 * this bound, so a wide sanity window eliminates the false-positive data loss.
 */
export const SEALED_AAD_FUTURE_MS = 24 * 60 * 60 * 1000;

/**
 * Audit MSG-01 — anti-replay (staleness) bound = relay dwell (30d). Mirrors
 * the package side. Kept separate from the clock-skew bound so a legitimately
 * delayed store-and-forward message is not dropped as "stale".
 */
export const SEALED_AAD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface VerifyAadParams {
  /** The sealed payload coming back from unsealPayload. */
  sealed:           SealedPayload;
  /** The receiver's own address — must match aad.to. */
  selfUserId:       string;
  selfDeviceId:     number;
  /** Defaults to Date.now(); override for deterministic tests. */
  now?:             number;
  /** Legacy alias; no longer bounds the future check (MEDIUM-1). */
  clockSkewMs?:     number;
  /** Audit MEDIUM-1 — defaults to SEALED_AAD_FUTURE_MS (24h). Bounds the FUTURE check. */
  futureMs?:        number;
  /** Audit MSG-01 — defaults to SEALED_AAD_MAX_AGE_MS. Bounds the STALE check. */
  maxAgeMs?:        number;
  /**
   * Audit S10 + P0-N1 — when true (default), missing AAD is treated
   * as a verification failure (`reason: 'missing'`). Set to FALSE
   * only for the legacy rollout-compatibility path. Mirrors the
   * package-side flag.
   */
  requireAad?:      boolean;
  /**
   * Audit P0-N2 — extended AAD verification. Mirrors the package side.
   * Each expected* field is checked only when both the wire AAD and the
   * caller provide a value.
   */
  expectedSender?:         {userId: string; deviceId: number};
  expectedConversationId?: string;
  expectedGroupId?:        string;
  expectedEpoch?:          number;
}

export type SealedAadReason =
  | 'recipient_mismatch'
  | 'stale'
  | 'future'
  | 'malformed'
  | 'missing'
  | 'sender_mismatch'
  | 'conversation_mismatch'
  | 'group_mismatch'
  | 'epoch_stale';

/**
 * Round 5 / Security S1 — verify the AAD binding, if present.
 *
 *   `{ok: true,  aad}` when verification succeeds.
 *   `{ok: false, reason}` when the binding is wrong.
 *   `{ok: true,  aad: undefined}` when no aad on the wire AND
 *      requireAad is not set.
 *   `{ok: false, reason: 'missing'}` when requireAad is true and
 *      the wire didn't carry an AAD block.
 *
 * The function does NOT throw — callers can choose to fail-open during
 * the rollout window (e.g. log + continue) and fail-closed once all
 * peers have shipped v3 senders.
 */
export function verifySealedAad(p: VerifyAadParams):
  | {ok: true;  aad: SealedAad | undefined}
  | {ok: false; reason: SealedAadReason} {
  const aad = p.sealed.aad;
  if (!aad) {
    // Audit P0-N1 — default is fail-closed. The rollout escape hatch
    // is `requireAad: false` (explicit), driven by the production
    // runtime's SEALED_AAD_LEGACY env flag.
    const requireAad = p.requireAad ?? true;
    if (requireAad) {return {ok: false, reason: 'missing'};}
    return {ok: true, aad: undefined};
  }
  if (typeof aad.ts !== 'number' || !aad.to) {return {ok: false, reason: 'malformed'};}
  if (aad.to.userId !== p.selfUserId) {return {ok: false, reason: 'recipient_mismatch'};}
  // Audit P0-N3 — deviceId=0 wildcard is no longer accepted (was a
  // regression introduced by the S1 fix). Phase-1 every account is
  // deviceId=1; an AAD carrying deviceId=0 was either a buggy sender
  // we want to retire or an attacker stripping the recipient binding
  // to widen replay scope.
  if (typeof aad.to.deviceId !== 'number' || aad.to.deviceId < 1) {
    return {ok: false, reason: 'malformed'};
  }
  if (aad.to.deviceId !== p.selfDeviceId) {
    return {ok: false, reason: 'recipient_mismatch'};
  }
  const now = p.now ?? Date.now();
  void (p.clockSkewMs ?? SEALED_AAD_SKEW_MS); // legacy alias; see MEDIUM-1
  // Audit MSG-01 — stale bound = relay dwell (30d). MEDIUM-1 — future bound is
  // the wide clock-skew tolerance (24h), not 15 min, so a mis-set clock no
  // longer silently drops messages.
  const maxAge   = p.maxAgeMs ?? SEALED_AAD_MAX_AGE_MS;
  const futureMs = p.futureMs ?? SEALED_AAD_FUTURE_MS;
  if (aad.ts < now - maxAge) {return {ok: false, reason: 'stale'};}
  if (aad.ts > now + futureMs) {return {ok: false, reason: 'future'};}
  // Audit P0-N2 — extended AAD checks. Mirror of the package side.
  if (aad.sender && p.expectedSender) {
    if (aad.sender.userId !== p.expectedSender.userId ||
        aad.sender.deviceId !== p.expectedSender.deviceId) {
      return {ok: false, reason: 'sender_mismatch'};
    }
  }
  if (aad.conversationId && p.expectedConversationId &&
      aad.conversationId !== p.expectedConversationId) {
    return {ok: false, reason: 'conversation_mismatch'};
  }
  if (aad.groupId && p.expectedGroupId && aad.groupId !== p.expectedGroupId) {
    return {ok: false, reason: 'group_mismatch'};
  }
  if (typeof aad.epoch === 'number' && typeof p.expectedEpoch === 'number' &&
      aad.epoch < p.expectedEpoch) {
    return {ok: false, reason: 'epoch_stale'};
  }
  return {ok: true, aad};
}

/**
 * Parse the JSON produced by `SessionCipher.decrypt` into its parts.
 * Rejects unknown versions so unhandled fields can't silently drop.
 */
export function unsealPayload(plaintext: string): SealedPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (e) {
    throw new CryptoError('sealed payload is not JSON', e);
  }
  if (!isSealedPayload(parsed)) {
    throw new CryptoError('sealed payload shape invalid');
  }
  // Audit fix #4 — accept v >= MIN_SEALED_VERSION rather than equality.
  // Older clients in flight during a staggered rollout still need to
  // talk to us; rejecting them silently dropped legitimate messages.
  if (parsed.v < MIN_SEALED_VERSION || parsed.v > SEALED_VERSION) {
    throw new CryptoError(`unsupported sealed version ${parsed.v}`);
  }
  // v:1 has no `attachment` or `expiresAtSec` on the wire even when our
  // type guard accepts the field; strip anything an older sender might
  // have sneaked in so downstream code doesn't trust v1-shaped payloads
  // with v2 fields. (Per-version branch lives here, not in isSealedPayload,
  // because the guard is shape-only — it doesn't see version semantics.)
  if (parsed.v < 2) {
    delete parsed.attachment;
    delete parsed.expiresAtSec;
  }
  // Round 5 / Security S1 — `aad` only meaningful in v3+. Older versions
  // can't have produced it; strip if present so a hostile peer can't
  // confuse the receiver by stamping a v2 envelope with an aad block.
  if (parsed.v < 3) {
    delete parsed.aad;
  }
  return parsed;
}

/**
 * Audit fix #3 — the original guard accepted any value for the optional
 * `clientMsgId`, `replyTo`, `reaction`, `control`, `groupCallPresence`
 * fields. A malformed sender (or a tampered payload that survived the
 * outer wrap because of a bug we haven't found yet) could push, e.g.,
 * `replyTo: {msgId: 42}` and crash the renderer when it called
 * `.slice(...)` on a number. Validate every optional field's shape so
 * the rest of the runtime can trust the SealedPayload typing.
 */
const SEALED_PAYLOAD_KEYS = new Set([
  'v', 'cert', 'body', 'attachment', 'expiresAtSec', 'clientMsgId',
  'group', 'replyTo', 'reaction', 'control', 'groupCallPresence', 'aad',
]);
const SEALED_AAD_KEYS = new Set([
  'ts', 'to', 'sender', 'conversationId', 'groupId', 'epoch',
]);

function isSealedPayload(x: unknown): x is SealedPayload {
  if (!x || typeof x !== 'object') {return false;}
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!SEALED_PAYLOAD_KEYS.has(k)) {return false;}
  }
  if (typeof o.v !== 'number')    {return false;}
  if (typeof o.cert !== 'string') {return false;}
  if (typeof o.body !== 'string') {return false;}
  if (o.attachment !== null && o.attachment !== undefined) {
    if (typeof o.attachment !== 'object') {return false;}
    const a = o.attachment as Record<string, unknown>;
    if (typeof a.objectKey !== 'string') {return false;}
    if (typeof a.keyB64    !== 'string') {return false;}
    if (typeof a.ivB64     !== 'string') {return false;}
    if (typeof a.mimeType  !== 'string') {return false;}
    if (typeof a.size      !== 'number') {return false;}
    // Media-parity metadata (2026-07-03) — optional hints must be the
    // right shape or the payload is rejected; bounds stop a hostile
    // "thumbnail" from bloating the envelope. Mirrors messenger-core.
    if (a.kind       !== undefined && typeof a.kind       !== 'string') {return false;}
    if (a.name       !== undefined && (typeof a.name !== 'string' || a.name.length > 256)) {return false;}
    if (a.width      !== undefined && typeof a.width      !== 'number') {return false;}
    if (a.height     !== undefined && typeof a.height     !== 'number') {return false;}
    if (a.durationMs !== undefined && typeof a.durationMs !== 'number') {return false;}
    if (a.thumbB64   !== undefined && (typeof a.thumbB64 !== 'string' || a.thumbB64.length > 64 * 1024)) {return false;}
  }
  if (o.expiresAtSec !== null && o.expiresAtSec !== undefined && typeof o.expiresAtSec !== 'number') {return false;}
  if (o.clientMsgId !== null && o.clientMsgId !== undefined && typeof o.clientMsgId !== 'string') {return false;}
  if (o.group !== null && o.group !== undefined) {
    if (typeof o.group !== 'object') {return false;}
    const g = o.group as Record<string, unknown>;
    if (typeof g.groupId    !== 'string') {return false;}
    if (typeof g.kind       !== 'string') {return false;}
    if (g.kind !== 'text' && g.kind !== 'admin') {return false;}
    if (typeof g.clientMsgId !== 'string') {return false;}
  }
  if (o.replyTo !== null && o.replyTo !== undefined) {
    if (typeof o.replyTo !== 'object') {return false;}
    const r = o.replyTo as Record<string, unknown>;
    if (typeof r.msgId   !== 'string') {return false;}
    if (typeof r.preview !== 'string') {return false;}
  }
  if (o.reaction !== null && o.reaction !== undefined) {
    if (typeof o.reaction !== 'object') {return false;}
    const r = o.reaction as Record<string, unknown>;
    if (typeof r.targetMsgId !== 'string') {return false;}
    if (typeof r.emoji       !== 'string') {return false;}
    if (r.remove !== undefined && typeof r.remove !== 'boolean') {return false;}
  }
  if (o.control !== null && o.control !== undefined) {
    if (o.control !== 'rehandshake') {return false;}
  }
  if (o.groupCallPresence !== null && o.groupCallPresence !== undefined) {
    if (typeof o.groupCallPresence !== 'object') {return false;}
    const p = o.groupCallPresence as Record<string, unknown>;
    if (typeof p.roomId         !== 'string') {return false;}
    if (typeof p.participantTag !== 'string') {return false;}
    if (typeof p.displayName    !== 'string') {return false;}
    if (p.callType !== 'voice' && p.callType !== 'video') {return false;}
  }
  // Round 5 / Security S1 — validate aad shape. Wrong shape ≠ tamper
  // (the inner Signal ratchet is what authenticates), but a malformed
  // aad would crash verifySealedAad, so reject the whole envelope.
  if (o.aad !== null && o.aad !== undefined) {
    if (typeof o.aad !== 'object') {return false;}
    const a = o.aad as Record<string, unknown>;
    // Audit P1-N9 — reject unknown AAD fields.
    for (const k of Object.keys(a)) {
      if (!SEALED_AAD_KEYS.has(k)) {return false;}
    }
    if (typeof a.ts !== 'number') {return false;}
    if (!a.to || typeof a.to !== 'object') {return false;}
    const to = a.to as Record<string, unknown>;
    if (typeof to.userId !== 'string') {return false;}
    if (typeof to.deviceId !== 'number') {return false;}
    // Audit P0-N2 — extended optional fields.
    if (a.sender !== undefined) {
      if (!a.sender || typeof a.sender !== 'object') {return false;}
      const s = a.sender as Record<string, unknown>;
      if (typeof s.userId !== 'string') {return false;}
      if (typeof s.deviceId !== 'number') {return false;}
    }
    if (a.conversationId !== undefined && typeof a.conversationId !== 'string') {return false;}
    if (a.groupId !== undefined && typeof a.groupId !== 'string') {return false;}
    if (a.epoch !== undefined && typeof a.epoch !== 'number') {return false;}
  }
  return true;
}
