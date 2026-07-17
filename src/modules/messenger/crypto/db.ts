/**
 * SQLCipher-backed SQLite store for the Signal Protocol state.
 * The encryption key MUST come from a hardware-backed keystore
 * (react-native-keychain with SecAccessControl on iOS, Android Keystore
 * on Android). Do not derive it from a user password at this layer —
 * that belongs one level up in the vault module.
 *
 * All tables hold binary key material as BLOB (Uint8Array). Do NOT
 * co-locate message ciphertext with keys here: message bodies live in
 * a separate messages table owned by the store/ slice.
 */

import { open } from '@op-engineering/op-sqlite';
import { StoreError } from '@bravo/messenger-core';

export type DbHandle = ReturnType<typeof open>;

/**
 * Schema versions
 *   1 — initial messenger DB (identity, pre_keys, signed_pre_keys, sessions, trusted_identities)
 *   2 — adds messages table
 *   3 — adds media_blobs cache table
 *   4 — adds messages.media_object_key (links message → cached blob for purge wiring)
 *   5 — adds messages.call_meta_json
 *   6 — adds outbox table
 *   7 — outbox PK becomes (client_msg_id, peer_user_id, peer_device_id) so
 *       group fan-out can persist one row per peer (audit P0-N4)
 *   8 — adds seen_envelopes table for persistent receive-side dedup
 *       (audit P0-N6)
 *   9 — adds peer_session_health (bug-hunt #1, persistent
 *       last-success + rebuild-attempt cooldown across cold start;
 *       closes the cold-start free-wipe window in P0-1 mitigation
 *       and bounds the previously-unbounded rebuild-attempt Map P1-7)
 *  10 — adds pending_group_envelopes + pending_admin_actions
 *       (bug-hunt #3 / #5, order-independent group join + rekey;
 *       stashes group ciphertext that arrived before the local
 *       master key landed, and admin actions that arrived
 *       out-of-epoch order, so neither is silently dropped)
 *  11 — adds group_master_keys (audit P0-S3 / P0-S5, moves group
 *       master keys out of plaintext AsyncStorage into the SQLCipher
 *       DB, AES-GCM-wrapped under a SEPARATE keychain entry so a
 *       one-shot extraction of either the SQLCipher key or the group-
 *       wrap key alone does not yield plaintext)
 *  14 — adds mirror_flushed (B-94, persistent backup-mirror flush
 *       ledger: (owner, message_id) → version hash of the last row
 *       version that SUCCESSFULLY reached the server. The boot
 *       catch-up sweep hydrates its dedup from this table so an idle
 *       boot re-uploads NOTHING — previously every boot re-encrypted
 *       and re-uploaded the entire history (fresh AES-GCM IV per row),
 *       so any kill before the trailing signed Merkle commit left the
 *       server bytes ahead of the signed root → the recurring
 *       equal-count `root_mismatch` restore dead-end)
 */
const SCHEMA_VERSION = 14;

const DDL = [
  `CREATE TABLE IF NOT EXISTS schema_version (
     version INTEGER PRIMARY KEY
   )`,
  `CREATE TABLE IF NOT EXISTS identity (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     registration_id INTEGER NOT NULL,
     public_key BLOB NOT NULL,
     private_key BLOB NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS pre_keys (
     key_id INTEGER PRIMARY KEY,
     public_key BLOB NOT NULL,
     private_key BLOB NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS signed_pre_keys (
     key_id INTEGER PRIMARY KEY,
     public_key BLOB NOT NULL,
     private_key BLOB NOT NULL,
     signature BLOB NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     address TEXT PRIMARY KEY,
     record TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // Audit P0-I3 — verification columns capture an explicit safety-
  // number ack from the user. `verified_at_ms` is the unix-ms when the
  // ack happened; `verified_safety_number_sha256` is the SHA-256 hex
  // of the safety-number string the user confirmed. Both are NULL by
  // default (TOFU-trusted, never verified). When the identity key
  // flips (`saveIdentity` with a new bytes), the UPSERT auto-clears
  // both columns — the user must re-verify against the new safety
  // number before the green checkmark returns.
  `CREATE TABLE IF NOT EXISTS trusted_identities (
     address TEXT PRIMARY KEY,
     identity_key BLOB NOT NULL,
     first_seen INTEGER NOT NULL,
     verified_at_ms INTEGER,
     verified_safety_number_sha256 TEXT
   )`,
  // Idempotent ALTERs for installs predating P0-I3.
  'ALTER TABLE trusted_identities ADD COLUMN verified_at_ms INTEGER',
  'ALTER TABLE trusted_identities ADD COLUMN verified_safety_number_sha256 TEXT',
  // Spec compliance: message store lives inside the SQLCipher DB. The
  // row holds the *plaintext* body (the ciphertext on the wire is
  // already long-discarded by the time we display it); the disk
  // protection is the SQLCipher page-level encryption with the
  // hardware-bound key. The Signal protocol session keys live in the
  // tables above, separate from the message bodies, exactly as the
  // architecture spec requires ("Message keys are derived per-session
  // and stored separately from message ciphertext").
  `CREATE TABLE IF NOT EXISTS messages (
     id               TEXT NOT NULL,
     conversation_id  TEXT NOT NULL,
     sender_id        TEXT NOT NULL,
     type             TEXT NOT NULL,
     content          TEXT,
     media_mime       TEXT,
     /**
      * R2 object key for messages that carry an attachment. Persisted
      * separately from the sealed envelope so the disappearing-message
      * sweeper, retract path, and conversation-clear flow can hand a
      * concrete key to MediaBlobCache.remove() — without it, expiring
      * a message would leak its decrypted-blob cache row even though
      * the message itself is gone from history.
      */
     media_object_key TEXT,
     /**
      * Per-file AES-256-CBC key + 16-byte IV (base64) for an encrypted
      * attachment. The architecture doc keeps message keys "stored
      * separately from message ciphertext" — these decrypt the blob in
      * media_blobs / object storage, never the message row itself.
      * Without persisting them here, an attachment becomes an
      * unrecoverable broken-bubble after the first cold-start hydrate
      * (the key only ever lived in the consumed sealed envelope).
      * SQLCipher page encryption protects them at rest. Schema v7.
      */
     media_key        TEXT,
     media_iv         TEXT,
     status           TEXT NOT NULL,
     is_encrypted     INTEGER NOT NULL,
     created_at       TEXT NOT NULL,
     peer_user_id     TEXT NOT NULL,
     peer_device_id   INTEGER NOT NULL,
     envelope_id      TEXT,
     retract_token    TEXT,
     expires_at       INTEGER,
     reply_to_msg_id  TEXT,
     reply_to_preview TEXT,
     reactions_json   TEXT,
     /**
      * JSON-encoded call record metadata when type === 'call'. Lets
      * the chat timeline render WhatsApp-style "Voice call · 0:42"
      * pills inline with text bubbles after restart. Schema-bumped
      * to v5 — runMigrations adds this column to existing installs.
      */
     call_meta_json   TEXT,
     /**
      * Media-parity metadata (schema v13): JSON {name?, width?, height?,
      * durationMs?, thumbB64?, sizeBytes?} carried in the sealed
      * attachment. Persisted so bubbles render instant previews with the
      * right aspect ratio after restart. Same one-JSON-column pattern as
      * reactions_json/call_meta_json.
      */
     media_meta_json  TEXT,
     PRIMARY KEY (conversation_id, id)
   )`,
  // Idempotent ALTER for installs predating schema v13.
  'ALTER TABLE messages ADD COLUMN media_meta_json TEXT',
  `CREATE INDEX IF NOT EXISTS idx_messages_conv_created
     ON messages (conversation_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_envelope
     ON messages (envelope_id)`,
  // Persistent media blob cache. Stores the already-encrypted bytes
  // exactly as they came back from R2 — the per-file AES-256-CBC key
  // lives in the sealed envelope, never on disk here. SQLCipher's
  // page-level encryption protects the cached ciphertext anyway, so
  // disk forensics yields nothing without the keychain key.
  // LRU eviction is driven by `last_accessed`.
  `CREATE TABLE IF NOT EXISTS media_blobs (
     object_key    TEXT PRIMARY KEY,
     ciphertext    BLOB NOT NULL,
     mime_type     TEXT,
     size          INTEGER NOT NULL,
     created_at    INTEGER NOT NULL,
     last_accessed INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_media_blobs_lru
     ON media_blobs (last_accessed)`,
  // Durable outbox — writes the outgoing-message envelope to disk
  // BEFORE handing it to the WS transport. If the app crashes or is
  // killed before `envelope.accepted` arrives, the next-launch scan
  // (and every subsequent socket reconnect) re-ships the row until the
  // relay confirms acceptance, then deletes the row. Closes the
  // "WhatsApp keeps it, we lose it" gap and the message-loss-on-Doze
  // case. `payload` holds the JSON-serialised ClientEnvelopeSend.data
  // (outerSealed, expiresAtSec). `peer_*` carry the routing addr
  // because we may need to refresh outerSealed if the peer rotated
  // identity between attempts (out of scope for v1 — just persist).
  // Composite PK lets group fan-out persist one row per recipient even
  // though every per-peer envelope shares the same `client_msg_id`
  // (audit P0-N4). 1:1 sends still get a single row because there's
  // only one peer in that conversation. handleAccepted (WS ack) +
  // httpFallback always identify a row by (clientMsgId, peerUserId,
  // peerDeviceId), never by clientMsgId alone.
  `CREATE TABLE IF NOT EXISTS outbox (
     client_msg_id   TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     message_id      TEXT NOT NULL,
     peer_user_id    TEXT NOT NULL,
     peer_device_id  INTEGER NOT NULL,
     payload         TEXT NOT NULL,
     attempts        INTEGER NOT NULL DEFAULT 0,
     next_retry_at   INTEGER NOT NULL,
     created_at      INTEGER NOT NULL,
     status          TEXT NOT NULL DEFAULT 'pending',
     PRIMARY KEY (client_msg_id, peer_user_id, peer_device_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_due
     ON outbox (status, next_retry_at)`,
  // Audit P0-N6 — persistent receive-side envelope-id dedup. The relay
  // re-pushes pending envelopes on every reconnect; without this gate
  // libsignal would advance the ratchet a second time against the same
  // ciphertext on every reconnect-storm, corrupting the session ("bad
  // MAC" forever). Lives in the same SQLCipher DB so the receive
  // transaction (P0-N14) can write the markSeen row atomically with
  // the ratchet + plaintext upserts.
  `CREATE TABLE IF NOT EXISTS seen_envelopes (
     envelope_id   TEXT PRIMARY KEY,
     first_seen_ms INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_seen_envelopes_first_seen
     ON seen_envelopes (first_seen_ms)`,
  // Bug-hunt #1 — persistent per-peer session health record. Closes the
  // cold-start free-wipe window in `sessionWipeProtection`: without this
  // the in-process `lastSuccessfulDecryptByPeer` Map evaporated on every
  // restart, so the first DecryptError after a crash slipped past the
  // protection check and the legacy rebuild path destroyed the live
  // ratchet. Also folds in `markRebuildAttempt` cooldown (P1-7) which
  // previously lived in an unbounded in-process Map. Address key is
  // `${userId}.${deviceId}` — same shape used everywhere else.
  `CREATE TABLE IF NOT EXISTS peer_session_health (
     peer_key                 TEXT PRIMARY KEY,
     last_success_ms          INTEGER NOT NULL DEFAULT 0,
     last_rebuild_attempt_ms  INTEGER NOT NULL DEFAULT 0,
     updated_at               INTEGER NOT NULL
   )`,
  // Bug-hunt #3 — stash for group envelopes that arrived before we
  // hold the master key for their group. The admin `create` (first
  // time joining) or `rekey` envelope that distributes the key can
  // race the text envelope through the relay; without a stash the
  // text envelope was previously rendered as a ciphertext-JSON bubble
  // via the legacy plaintext fall-through and acked, so the moment
  // the create/rekey arrived seconds later the message was lost
  // permanently. Rows are drained when applyAdminAction commits a
  // new masterKeyB64 for the matching groupId. `sealed_json` carries
  // the entire SealedPayload so the drain can re-run parseGroupMessage
  // without re-unwrapping the outer ECIES layer. Bounded by per-group
  // cap + global cap + RETENTION_MS sweep so a hostile sender can't
  // fill the table with junk pending traffic for groups the recipient
  // has never joined.
  `CREATE TABLE IF NOT EXISTS pending_group_envelopes (
     envelope_id      TEXT PRIMARY KEY,
     group_id         TEXT NOT NULL,
     peer_user_id     TEXT NOT NULL,
     peer_device_id   INTEGER NOT NULL,
     sealed_json      TEXT NOT NULL,
     received_at_ms   INTEGER NOT NULL,
     attempts         INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_group_envelopes_group
     ON pending_group_envelopes (group_id, received_at_ms)`,
  // Bug-hunt #5 follow-through — stash for stale-epoch admin actions
  // that arrived out of order (the canonical case: rekey @ E+1 lands
  // before add @ E because the two were broadcast within the same
  // tick and the relay re-ordered them per-recipient). The existing
  // applyAdminAction reducer silently no-ops on stale epoch; bug-hunt
  // #5 added a crashLog breadcrumb but the message itself was still
  // dropped. This table records the action so the next admin commit
  // can replay it. Bounded the same way as pending_group_envelopes.
  `CREATE TABLE IF NOT EXISTS pending_admin_actions (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
     group_id         TEXT NOT NULL,
     action_epoch     INTEGER NOT NULL,
     sender_user_id   TEXT NOT NULL,
     action_json      TEXT NOT NULL,
     received_at_ms   INTEGER NOT NULL,
     attempts         INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_admin_actions_group
     ON pending_admin_actions (group_id, action_epoch)`,
  // Audit P0-S3 / P0-S5 — group master keys move OUT of AsyncStorage
  // (where they previously rode in
  // `messengerStore.vaultByOwner[*].groups[*].masterKeyB64` as plaintext
  // base64 in the Android SharedPreferences XML / iOS plist) and INTO
  // this table. Each row stores the master key AES-GCM-encrypted under
  // the per-user group-wrap secret held in a SEPARATE keychain entry
  // (see `getOrCreateGroupWrapKey` in runtime/keychain.ts).
  //
  // Threat model: a one-shot extraction of either the SQLCipher key OR
  // the group-wrap key yields nothing useful — the attacker needs both
  // to reach a single plaintext master key. The previous design held
  // the master key in plaintext AsyncStorage, so an attacker with raw
  // file-system access (rooted device, ADB backup, file-vault forensic
  // tool) could read every group's master key without any key extraction
  // at all.
  `CREATE TABLE IF NOT EXISTS group_master_keys (
     group_id     TEXT PRIMARY KEY,
     wrapped_key  BLOB NOT NULL,
     iv           BLOB NOT NULL,
     updated_at   INTEGER NOT NULL
   )`,
  // Audit P0-S6 — forensic trail of peer-identity rotations. Each row
  // is a single observed key change for a peer; written from
  // SqlCipherProtocolStore.saveIdentity inside the BEGIN IMMEDIATE
  // transaction that performs the trusted_identities upsert. Stores
  // SHA-256 of the old and new key bytes (NOT the raw keys), so a
  // forensic dump of this table reveals WHO rotated and WHEN but
  // doesn't let an attacker pre-compute X3DH bundles to impersonate.
  //
  // Append-only: pruning is intentionally not implemented — rotation
  // events are rare per peer (typically a handful over the lifetime
  // of a relationship) and the bytes are tiny (two 64-char hexes per
  // row). The longevity of the log is the audit value.
  `CREATE TABLE IF NOT EXISTS identity_rotations (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     address         TEXT NOT NULL,
     old_key_sha256  TEXT NOT NULL,
     new_key_sha256  TEXT NOT NULL,
     observed_at_ms  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_identity_rotations_addr_ts
     ON identity_rotations (address, observed_at_ms DESC)`,
  // B-94 — persistent backup-mirror flush ledger. `version` is the
  // FNV-1a hash of the serialized LocalMessage that last SUCCEEDED a
  // /backup/messages upload ('__deleted__' for tombstones). The boot
  // catch-up sweep seeds the mirror dedup from these rows so unchanged
  // history is never re-encrypted + re-uploaded (each re-upload mints a
  // fresh AES-GCM IV, changing the server bytes and re-opening the
  // "rows ahead of the signed Merkle root" kill-window on every boot).
  // Holds hashes only — no plaintext, no key material.
  `CREATE TABLE IF NOT EXISTS mirror_flushed (
     owner_user_id TEXT NOT NULL,
     message_id    TEXT NOT NULL,
     version       TEXT NOT NULL,
     updated_at    INTEGER NOT NULL,
     PRIMARY KEY (owner_user_id, message_id)
   )`,
];

export interface OpenStoreParams {
  name?: string;
  encryptionKey: string;
}

/**
 * Audit fix #38 — opens a DbHandle for the messenger SQLCipher file.
 * Callers that want concurrency across orthogonal concerns (sessions,
 * messages, media_blobs) should call `openSecondaryDb` to get an
 * additional native worker that shares the same file via WAL.
 *
 * NOTE: op-sqlite serialises every statement on the JS thread
 * regardless of how many DbHandles you hold against the same file —
 * the bottleneck is the JS bridge, not SQLite. The benefit of separate
 * handles is therefore narrower than implied by "separate workers": it
 * lets a long-running PRAGMA on one handle (e.g. wal_checkpoint) not
 * block another handle's queue. We expose the helper so the runtime
 * can opt in where it actually helps; the default path remains a
 * single handle to avoid file-locking footguns.
 */
export async function openCryptoDb({
  name = 'messenger-crypto.db',
  encryptionKey,
}: OpenStoreParams): Promise<DbHandle> {
  if (!encryptionKey || encryptionKey.length < 32) {
    throw new StoreError('encryption key must be >= 32 chars');
  }
  const db = open({ name, encryptionKey, location: 'documents' });
  // Audit P0-S4 — SQLCipher hardening PRAGMAs must run BEFORE any other
  // statement on the connection (cipher_memory_security in particular
  // is rejected after the page cache has been touched). Apply them
  // first, then the WAL knobs below.
  //
  //  - cipher_memory_security=ON disables mmap on the SQLite page cache
  //    AND zeros buffer reuse on every page eviction, so an attacker
  //    who gets a memory dump from a paused/swapped process sees no
  //    plaintext page residue. Modest perf cost (extra memset on
  //    eviction); the page cache is small on this workload so the
  //    cost is negligible in practice.
  //  - cipher_use_hmac is asserted ON (the SQLCipher 4 default) — this
  //    is a fail-loud guard against an op-sqlite fork or future
  //    SQLCipher version that flips the default. Without HMAC, each
  //    page's AES-CBC ciphertext is unauthenticated and an attacker
  //    with disk-write access could swap pages between databases
  //    keyed under the same secret. Querying the PRAGMA returns the
  //    live setting; we throw if it ever reports 0.
  //
  // NOTE: raw `x'<hex>'` keying (skipping PBKDF2 on the already-random
  // hex string) is NOT applied here. op-sqlite's native open path
  // (cpp/bridge.cpp) interpolates the encryption key string directly
  // into `PRAGMA key = '<key>'` with no escaping, so passing
  // `x'<hex>'` breaks the single-quote parser and bricks the open.
  // Switching would require either patching op-sqlite or running a
  // destructive `PRAGMA rekey` against every existing install — both
  // out of scope for this audit. The PBKDF2 cost on a 64-char hex
  // string is one-time per open (sub-100ms even on low-end Android)
  // so the footgun the audit flagged is bounded.
  await db.execute('PRAGMA cipher_memory_security=ON');
  await assertCipherUseHmac(db);
  // Concurrency knobs — without these, SQLite uses journal_mode=DELETE,
  // which holds an exclusive lock for the entire write and immediately
  // errors readers/writers that race it. The mission-group send path
  // encrypts to N peers in a tight loop, each updating per-peer Signal
  // session state in `sessions`; under DELETE mode any concurrent
  // inbound envelope handler hitting the same DB would surface as
  // "database is locked" mid-loop and the whole group send would fail
  // with red error bubbles on the chat. WAL lets one writer run
  // alongside multiple readers; busy_timeout makes the rare collision
  // wait up to 5s instead of erroring out. synchronous=NORMAL is the
  // recommended pairing with WAL — equivalent durability for our
  // workload (per-message, not per-byte) at a meaningful speedup.
  await db.execute('PRAGMA journal_mode=WAL');
  await db.execute('PRAGMA busy_timeout=5000');
  await db.execute('PRAGMA synchronous=NORMAL');
  for (const stmt of DDL) {
    try {
      await db.execute(stmt);
    } catch (e) {
      // ALTER TABLE … ADD COLUMN throws "duplicate column" on installs
      // where CREATE TABLE IF NOT EXISTS just added the column (fresh
      // install) or where a previous boot already migrated. Idempotent
      // by intent — swallow the duplicate-column case for ALTERs only.
      const msg = (e as Error).message || '';
      if (/duplicate column name/i.test(msg) && /^\s*ALTER\b/i.test(stmt)) {
        continue;
      }
      throw e;
    }
  }
  const result = await db.execute('SELECT version FROM schema_version LIMIT 1');
  const rows = result.rows ?? [];
  const current = rows.length ? (rows[0] as { version: number }).version : 0;
  if (current > 0 && current < SCHEMA_VERSION) {
    await runMigrations(db, current);
  }
  if (current < SCHEMA_VERSION) {
    await db.execute('DELETE FROM schema_version');
    await db.execute('INSERT INTO schema_version (version) VALUES (?)', [SCHEMA_VERSION]);
  }
  return db;
}

/**
 * Audit fix #38 — open a SECONDARY handle to the same SQLCipher file
 * that's already been opened by `openCryptoDb`. Skips the schema
 * bootstrap (DDL + migrations already ran on the primary handle) and
 * just sets the WAL pragmas so the new handle is functional.
 *
 * Use case: messages and media_blobs writes can fight for the
 * single-handle queue with the Signal session writes during a busy
 * group send. Giving messages + media_blobs their own handle lets
 * those queues drain independently of the session-table writes.
 *
 * Encryption key + filename MUST match the primary openCryptoDb call.
 */
export async function openSecondaryDb({
  name = 'messenger-crypto.db',
  encryptionKey,
}: OpenStoreParams): Promise<DbHandle> {
  if (!encryptionKey || encryptionKey.length < 32) {
    throw new StoreError('encryption key must be >= 32 chars');
  }
  const db = open({name, encryptionKey, location: 'documents'});
  // Audit P0-S4 — mirror the hardening PRAGMAs on the secondary handle.
  // cipher_memory_security MUST be set before any other statement (it's
  // a one-shot per-connection setting); cipher_use_hmac is asserted as
  // a fail-loud check on every handle we open against this file.
  await db.execute('PRAGMA cipher_memory_security=ON');
  await assertCipherUseHmac(db);
  await db.execute('PRAGMA journal_mode=WAL');
  await db.execute('PRAGMA busy_timeout=5000');
  await db.execute('PRAGMA synchronous=NORMAL');
  return db;
}

/**
 * Audit P0-S5 residual — three-compartment SQLCipher split.
 *
 * Opens three separate SQLCipher files, each under its own keychain-
 * derived encryption key:
 *   - `id`  — identity / pre-keys / signed pre-keys
 *   - `rt`  — sessions / ratchets / trusted_identities / seen-envelopes
 *             (also serves as the `main` schema for ATTACH)
 *   - `msg` — messages / media_blobs / outbox / group_master_keys
 *
 * Threat model improvement: a single keychain entry exfiltration
 * (audit's stated threat) recovers AT MOST one compartment. Without
 * the split, ONE SQLCipher key wrapped identity + ratchets + group
 * master keys + plaintext bodies under one compromise surface.
 *
 * Returns the `rt` handle as the primary (it owns the `main` schema)
 * with `id` and `msg` attached. Existing store queries that use
 * unqualified table names resolve via the ATTACH search order.
 */
export interface CompartmentedDbHandles {
  primary: DbHandle;
}

export interface CompartmentedDbOpenParams {
  keys: {id: string; rt: string; msg: string};
  /**
   * Optional name override for tests. Production callers leave this
   * undefined — the runtime composes per-platform conventional names.
   */
  baseName?: string;
}

/**
 * Audit P0-S4 — strict key-shape validator. The encryption key gets
 * interpolated into a single-quoted `PRAGMA key = '<key>'` by
 * op-sqlite's native open path with NO escaping; any character outside
 * `[0-9a-fA-F]` (especially a single quote) breaks the parser AND
 * opens a class of SQL-injection-style escapes through the PRAGMA.
 *
 * Enforcing exactly 64 hex chars (= 32 bytes of entropy, the SQLCipher
 * default key size when keyed as a passphrase fed into PBKDF2) makes
 * the keying contract loud: any caller that hands us a non-conforming
 * key gets a thrown StoreError instead of a silent open failure.
 */
function assertSafeHexKey(key: string, label: string): void {
  if (typeof key !== 'string' || !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new StoreError(`compartment key '${label}' must be 64-char hex (got len=${key?.length ?? 0})`);
  }
}

export async function openCompartmentedDb(
  params: CompartmentedDbOpenParams,
): Promise<CompartmentedDbHandles> {
  // Validate every key up front. Reject before any open() so a bad
  // input doesn't half-open one compartment + leak the partial state.
  assertSafeHexKey(params.keys.id,  'id');
  assertSafeHexKey(params.keys.rt,  'rt');
  assertSafeHexKey(params.keys.msg, 'msg');

  const baseName = params.baseName ?? 'messenger';
  // Open the rt (ratchets) compartment as the primary — it owns the
  // `main` schema and the most write-heavy tables.
  const primary = open({
    name:          `${baseName}-rt.db`,
    encryptionKey: params.keys.rt,
    location:      'documents',
  });
  await primary.execute('PRAGMA cipher_memory_security=ON');
  await assertCipherUseHmac(primary);
  await primary.execute('PRAGMA journal_mode=WAL');
  await primary.execute('PRAGMA busy_timeout=5000');
  await primary.execute('PRAGMA synchronous=NORMAL');

  // ATTACH the id and msg compartments. Per-attached-schema
  // cipher_use_hmac assertion mirrors the primary check so a future
  // op-sqlite fork that disables HMAC on attach can't slip past.
  // Note: ATTACH key is interpolated the same way as the primary
  // PRAGMA key, so the assertSafeHexKey gate above is what makes this
  // safe.
  await primary.execute(
    `ATTACH DATABASE '${baseName}-id.db' AS id KEY '${params.keys.id}'`,
  );
  const idHmac = await primary.execute('PRAGMA id.cipher_use_hmac');
  assertAttachedHmac(idHmac, 'id');

  await primary.execute(
    `ATTACH DATABASE '${baseName}-msg.db' AS msg KEY '${params.keys.msg}'`,
  );
  const msgHmac = await primary.execute('PRAGMA msg.cipher_use_hmac');
  assertAttachedHmac(msgHmac, 'msg');

  return {primary};
}

function assertAttachedHmac(
  res: {rows?: Array<Record<string, unknown>>},
  label: string,
): void {
  const rows = res.rows ?? [];
  if (!rows.length) {return;}
  const v = Object.values(rows[0])[0];
  const enabled =
    v === 1 || v === '1' || v === true ||
    (typeof v === 'string' && v.toLowerCase() === 'on');
  if (!enabled) {
    throw new StoreError(
      `cipher_use_hmac is OFF on attached '${label}' — refusing to open an unauthenticated SQLCipher DB`,
    );
  }
}

/**
 * Audit P0-S4 — query the live `cipher_use_hmac` setting and throw if
 * it isn't 1. SQLCipher 4 defaults to ON; this assertion is a fail-loud
 * guard against an op-sqlite fork (or future upstream) that flips the
 * default and removes per-page authentication. Without HMAC, each
 * page's AES-CBC ciphertext is unauthenticated and an attacker with
 * disk-write access can swap pages between two databases keyed under
 * the same secret. The PRAGMA returns a row like `{cipher_use_hmac: 1}`;
 * any other value (or no rows at all on a non-SQLCipher build) trips
 * the throw.
 */
async function assertCipherUseHmac(db: DbHandle): Promise<void> {
  const res = await db.execute('PRAGMA cipher_use_hmac');
  const rows = res.rows ?? [];
  if (!rows.length) {
    throw new StoreError('cipher_use_hmac PRAGMA returned no rows — not a SQLCipher build?');
  }
  const row = rows[0] as Record<string, unknown>;
  // The column name varies between SQLCipher reporting modes; accept
  // any column whose value resolves to a truthy 1 / "1".
  const v = Object.values(row)[0];
  const enabled =
    v === 1 || v === '1' || v === true ||
    (typeof v === 'string' && v.toLowerCase() === 'on');
  if (!enabled) {
    throw new StoreError(
      'cipher_use_hmac is OFF — refusing to open an unauthenticated SQLCipher DB',
    );
  }
}

/**
 * Forward-only migrations. New columns get ADDed to existing tables;
 * never DROP a column you don't want destroyed on every legacy install.
 * Each migration is wrapped in a try/catch so re-running on a partially-
 * migrated DB (e.g. crash mid-upgrade) is idempotent — `ADD COLUMN`
 * with `column already exists` is the only error we swallow.
 */
async function runMigrations(db: DbHandle, fromVersion: number): Promise<void> {
  if (fromVersion < 4) {
    try {
      await db.execute('ALTER TABLE messages ADD COLUMN media_object_key TEXT');
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (!/duplicate column|already exists/i.test(msg)) {throw e;}
    }
  }
  if (fromVersion < 5) {
    try {
      await db.execute('ALTER TABLE messages ADD COLUMN call_meta_json TEXT');
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (!/duplicate column|already exists/i.test(msg)) {throw e;}
    }
  }
  if (fromVersion < 6) {
    // Outbox table is created idempotently by the DDL block above (it
    // uses CREATE TABLE IF NOT EXISTS). This branch is reserved so a
    // future change to the outbox shape can ALTER TABLE here without
    // breaking the upgrade path; for now there's nothing to do beyond
    // the IF NOT EXISTS create that openCryptoDb already runs.
  }
  if (fromVersion < 7) {
    // Audit P0-N4 — composite PK migration. SQLite can't alter a PK
    // in place, so the standard recipe: create the new table, copy
    // rows, drop the old, rename. The CREATE TABLE IF NOT EXISTS in
    // the DDL block above runs FIRST (with the new shape), so on an
    // upgrade the new shape already exists under a *different* name
    // is NOT the case — IF NOT EXISTS is a no-op when the v6 table
    // already exists. We therefore do the rebuild here unconditionally
    // when crossing from <7, regardless of what the DDL block did.
    //
    // Pre-existing rows are 1:1 sends — (client_msg_id) is already
    // unique for them, so promoting (client_msg_id, peer_user_id,
    // peer_device_id) to PK is a safe widening.
    try {
      await db.execute(`CREATE TABLE outbox_v7 (
        client_msg_id   TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id      TEXT NOT NULL,
        peer_user_id    TEXT NOT NULL,
        peer_device_id  INTEGER NOT NULL,
        payload         TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_retry_at   INTEGER NOT NULL,
        created_at      INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        PRIMARY KEY (client_msg_id, peer_user_id, peer_device_id)
      )`);
      await db.execute(`INSERT INTO outbox_v7
        (client_msg_id, conversation_id, message_id, peer_user_id,
         peer_device_id, payload, attempts, next_retry_at, created_at, status)
        SELECT client_msg_id, conversation_id, message_id, peer_user_id,
               peer_device_id, payload, attempts, next_retry_at, created_at, status
          FROM outbox`);
      await db.execute('DROP TABLE outbox');
      await db.execute('ALTER TABLE outbox_v7 RENAME TO outbox');
      await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox (status, next_retry_at)',
      );
    } catch (e) {
      // If the old outbox table didn't exist (fresh install whose v6
      // run created the v7-shaped table directly via the updated DDL),
      // the CREATE outbox_v7 collides with the fresh table and we can
      // safely no-op the migration.
      const msg = (e as Error).message ?? '';
      if (!/already exists|no such table/i.test(msg)) {throw e;}
    }
  }
  if (fromVersion < 8) {
    // Audit P0-N6 — seen_envelopes table is created idempotently by the
    // DDL block above (CREATE TABLE IF NOT EXISTS). Nothing to migrate;
    // first-launch installs start with an empty table and accumulate
    // entries as inbound envelopes are processed. The 35-day prune
    // sweep runs from the runtime boot path.
  }
  if (fromVersion < 9) {
    // Bug-hunt #1 — peer_session_health table is created idempotently
    // by the DDL block above (CREATE TABLE IF NOT EXISTS). No row-copy
    // needed; first-launch installs start empty. Existing installs gain
    // the table here and the per-table boot warm in the runtime fills
    // the in-process Map cache from the persisted rows.
  }
  if (fromVersion < 10) {
    // Bug-hunt #3 / #5 — pending_group_envelopes + pending_admin_actions
    // are created idempotently by the DDL block above. Nothing to
    // migrate; existing installs gain the tables here and the runtime
    // boot prunes anything older than RETENTION_MS on the first launch
    // post-upgrade (in practice the tables are empty for upgrading
    // installs and only fill as the new no_key branch starts stashing).
  }
  if (fromVersion < 11) {
    // Audit P0-S3 / P0-S5 — group_master_keys is created idempotently
    // by the DDL block above. Existing installs that already have
    // group master keys in AsyncStorage will run the warm path in
    // productionRuntime: every in-memory `s.groups[*].masterKeyB64`
    // that has no on-disk row is wrapped and persisted on first boot
    // post-upgrade, then the AsyncStorage partialize strips the field
    // on the next debounced flush. No copy here.
  }
  if (fromVersion < 12) {
    // Encrypted-attachment send/receive — persist the per-file AES key
    // + IV on the message row so attachments survive a cold-start
    // hydrate (previously the key only lived in the consumed sealed
    // envelope and was lost on restart, leaving a broken-bubble).
    for (const col of ['media_key', 'media_iv']) {
      try {
        await db.execute(`ALTER TABLE messages ADD COLUMN ${col} TEXT`);
      } catch (e) {
        const msg = (e as Error).message ?? '';
        if (!/duplicate column|already exists/i.test(msg)) {throw e;}
      }
    }
  }
  if (fromVersion < 14) {
    // B-94 — mirror_flushed is created idempotently by the DDL block
    // above (CREATE TABLE IF NOT EXISTS). Nothing to copy; upgrading
    // installs start with an empty ledger, so their FIRST post-upgrade
    // boot sweep re-uploads once (exactly today's behaviour) and every
    // boot after that is a no-op because the flush path records what
    // the server now holds.
  }
}
