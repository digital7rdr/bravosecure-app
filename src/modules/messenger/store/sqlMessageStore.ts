/**
 * SQLCipher-backed message store.
 *
 * Spec compliance: per Bravo Secure architecture v1.0 R1 §2.2 the
 * client-side message store is "SQLCipher-encrypted local SQLite
 * database. Message keys are derived per-session and stored separately
 * from message ciphertext." This module owns the messages table inside
 * the same SQLCipher DB that holds Signal Protocol session state, with
 * page-level encryption from a hardware-bound key (keychain).
 *
 * The Zustand store remains the read path for the UI (fast in-memory
 * lookup); this store is the durable write path. On boot the runtime
 * loads everything here back into Zustand. Every mutation that flows
 * through messengerStore also fans out here via a subscribe-based
 * mirror in productionRuntime.
 *
 * Schema lives in `crypto/db.ts` (messages table + indexes). Bumping
 * the columns here requires bumping SCHEMA_VERSION in db.ts.
 */

import type {DbHandle} from '../crypto/db';
import type {LocalMessage} from './types';
import {runWithRatchetTxn} from '../runtime/receiveTransaction';

/** Row shape — wire format for reading from SQLite. */
interface MessageRow {
  id:               string;
  conversation_id:  string;
  sender_id:        string;
  type:             string;
  content:          string | null;
  media_mime:       string | null;
  media_object_key: string | null;
  media_key:        string | null;
  media_iv:         string | null;
  status:           string;
  is_encrypted:     number;
  created_at:       string;
  peer_user_id:     string;
  peer_device_id:   number;
  envelope_id:      string | null;
  retract_token:    string | null;
  expires_at:       number | null;
  reply_to_msg_id:  string | null;
  reply_to_preview: string | null;
  reactions_json:   string | null;
  call_meta_json:   string | null;
  media_meta_json:  string | null;
}

export class SqlMessageStore {
  constructor(private readonly db: DbHandle) {}

  /**
   * Audit fix #18 — per-conversation Promise chain.
   *
   * The runtime's store→SQL subscriber issues `upsert` and `remove`
   * calls based on diffs between consecutive Zustand snapshots. When
   * the user clears a chat, the diff produces a burst of DELETEs; if
   * any subsequent message arrives WHILE those DELETEs are still
   * inflight, the inserts could land before the deletes (op-sqlite
   * dispatches awaits independently) and the cleared messages would
   * resurrect after the DELETE finally runs. Serialising every write
   * for one conversation through a Promise chain keeps DELETEs and
   * UPSERTs in the order the subscriber emitted them. Different
   * conversations still parallelise.
   */
  private readonly chains = new Map<string, Promise<unknown>>();

  /**
   * Audit fix #19 — coalesce upserts within a 50ms window.
   *
   * `upsert` was autocommit per call, so a chat-message burst (10
   * messages in one second) cost 10 BEGIN/COMMIT cycles, each with an
   * fsync. The `upsertCoalesced` path queues writes per conversation
   * into a window-flush list and ships them via `upsertBatch` (one
   * transaction). For correctness, the in-window queue dedupes by
   * id — the latest version of each row wins.
   */
  private readonly coalesceQueues = new Map<string, Map<string, LocalMessage>>();
  private readonly coalesceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly COALESCE_WINDOW_MS = 50;

  private chainOp<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(conversationId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => work());
    this.chains.set(conversationId, next);
    void next.finally(() => {
      // Drop only if we're still the head of the chain.
      if (this.chains.get(conversationId) === next) {
        this.chains.delete(conversationId);
      }
    });
    return next;
  }

  async upsert(msg: LocalMessage): Promise<void> {
    return this.chainOp(msg.conversation_id, () => this.doUpsert(msg));
  }

  /**
   * Audit fix #19 — coalesce-batch upsert. Drops the message into a
   * 50ms window keyed by conversation; flushes via upsertBatch (one
   * BEGIN/COMMIT) when the timer fires. Returns immediately — caller
   * doesn't await durability for non-critical updates (status flips,
   * reactions).
   */
  upsertCoalesced(msg: LocalMessage): void {
    const cid = msg.conversation_id;
    let q = this.coalesceQueues.get(cid);
    if (!q) {q = new Map(); this.coalesceQueues.set(cid, q);}
    q.set(msg.id, msg); // dedupe — newest wins
    if (this.coalesceTimers.has(cid)) {return;}
    this.coalesceTimers.set(cid, setTimeout(() => {
      const queue = this.coalesceQueues.get(cid);
      this.coalesceTimers.delete(cid);
      this.coalesceQueues.delete(cid);
      if (!queue?.size) {return;}
      const batch = Array.from(queue.values());
      void this.chainOp(cid, () => this.upsertBatch(batch)).catch(e => {
        console.warn('[sqlMessageStore] coalesced flush failed', e);
      });
    }, SqlMessageStore.COALESCE_WINDOW_MS));
  }

  private async doUpsert(msg: LocalMessage): Promise<void> {
    const reactions = msg.reactions ? JSON.stringify(msg.reactions) : null;
    const callMeta  = msg.call_meta ? JSON.stringify(msg.call_meta) : null;
    const mediaMeta = msg.media_meta ? JSON.stringify(msg.media_meta) : null;
    await this.db.execute(
      `INSERT OR REPLACE INTO messages (
         id, conversation_id, sender_id, type, content, media_mime, media_object_key,
         media_key, media_iv,
         status, is_encrypted, created_at,
         peer_user_id, peer_device_id, envelope_id, retract_token,
         expires_at, reply_to_msg_id, reply_to_preview, reactions_json, call_meta_json,
         media_meta_json
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        msg.id,
        msg.conversation_id,
        msg.sender_id,
        msg.type,
        msg.content ?? null,
        msg.media_mime ?? null,
        msg.media_object_key ?? null,
        msg.media_key ?? null,
        msg.media_iv ?? null,
        msg.status,
        msg.is_encrypted ? 1 : 0,
        msg.created_at,
        msg.peer.userId,
        msg.peer.deviceId,
        msg.envelope_id ?? null,
        msg.retract_token ?? null,
        msg.expires_at ?? null,
        msg.reply_to_msg_id ?? null,
        msg.reply_to_preview ?? null,
        reactions,
        callMeta,
        mediaMeta,
      ],
    );
  }

  async remove(conversationId: string, id: string): Promise<void> {
    return this.chainOp(conversationId, async () => {
      await this.db.execute(
        'DELETE FROM messages WHERE conversation_id = ? AND id = ?',
        [conversationId, id],
      );
    });
  }

  /**
   * Load every persisted message into a `Record<conversationId, msgs[]>`.
   * Called once at runtime boot. Sorted by created_at ascending so the
   * UI can paint history in chronological order without a re-sort.
   *
   * NOTE: prefer `loadRecent(perConversation)` for the boot path —
   * `loadAll` is kept for back-compat with the migration import flow.
   */
  async loadAll(): Promise<Record<string, LocalMessage[]>> {
    // Audit P1-N20 — tie-break on `id` so two messages stamped with
    // the same millisecond (rapid-fire send, clock-skew on receive) get
    // a deterministic, stable order across loads instead of flipping
    // every time SQLite picks a different physical-row scan order.
    const result = await this.db.execute(
      'SELECT * FROM messages ORDER BY conversation_id, created_at ASC, id ASC',
    );
    const rows = (result.rows ?? []) as unknown as MessageRow[];
    const out: Record<string, LocalMessage[]> = {};
    for (const r of rows) {
      const msg = rowToMessage(r);
      if (!out[msg.conversation_id]) {out[msg.conversation_id] = [];}
      out[msg.conversation_id].push(msg);
    }
    return out;
  }

  /**
   * Audit fix #16 — load only the N most-recent messages per conversation.
   *
   * Implementation uses a window-function-style ROW_NUMBER inside a CTE
   * so we don't have to round-trip per conversation. Rows come back
   * already filtered to `<= perConversation` per chat, ordered ascending
   * inside each conversation so the renderer doesn't re-sort.
   */
  async loadRecent(perConversation: number): Promise<Record<string, LocalMessage[]>> {
    if (perConversation <= 0) {return {};}
    // Audit MSG-14 (2026-07-02): hard-purge disappearing messages whose
    // deadline has passed BEFORE hydrating. The in-memory ExpirySweeper only
    // walks the ~200 rows currently in the store, so a timed message that was
    // pushed past the recent window before it expired lingered on disk — it
    // would briefly flash on scroll-back (until the sweeper caught it) and its
    // relay-retract could fire days late. Deleting at boot closes that.
    try {
      await this.db.execute(
        'DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?',
        [Date.now()],
      );
    } catch { /* best-effort — hydration proceeds either way */ }
    const result = await this.db.execute(
      `SELECT * FROM messages
         WHERE rowid IN (
           SELECT rowid FROM (
             SELECT rowid, ROW_NUMBER() OVER (
               PARTITION BY conversation_id
               ORDER BY created_at DESC, id DESC
             ) AS rn
             FROM messages
           )
           WHERE rn <= ?
         )
         ORDER BY conversation_id, created_at ASC, id ASC`,
      [perConversation],
    );
    const rows = (result.rows ?? []) as unknown as MessageRow[];
    const out: Record<string, LocalMessage[]> = {};
    for (const r of rows) {
      const msg = rowToMessage(r);
      if (!out[msg.conversation_id]) {out[msg.conversation_id] = [];}
      out[msg.conversation_id].push(msg);
    }
    return out;
  }

  /**
   * Audit fix #16 — load a page of OLDER messages for one conversation.
   * `before` is the ISO timestamp of the oldest already-rendered row;
   * we return the next `limit` rows strictly older than it. Tied to a
   * stable cursor on `(created_at, id)` so duplicate timestamps don't
   * skip rows. Returns ascending (oldest-first) so the UI can prepend.
   */
  async loadOlder(
    conversationId: string,
    before: string,
    beforeId: string,
    limit: number,
  ): Promise<LocalMessage[]> {
    const result = await this.db.execute(
      `SELECT * FROM messages
         WHERE conversation_id = ?
           AND (
             created_at < ?
             OR (created_at = ? AND id < ?)
           )
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      [conversationId, before, before, beforeId, Date.now(), limit],
    );
    const rows = (result.rows ?? []) as unknown as MessageRow[];
    return rows.map(rowToMessage).reverse();
  }

  /**
   * B-90 T-04 — WhatsApp-parity "Links" browser. Pages text messages whose
   * decrypted body contains an http(s) URL, newest-first, across ALL
   * conversations. The relay can't index links (bodies are sealed), so this
   * local scan is the only possible source. The LIKE is a cheap prefilter —
   * exact URL extraction happens in the UI with the shared URL regex.
   * Read-only; expired disappearing messages are excluded, mirroring
   * loadOlder.
   */
  async loadLinkMessages(limit: number, offset = 0): Promise<LocalMessage[]> {
    const result = await this.db.execute(
      `SELECT * FROM messages
         WHERE type = 'text'
           AND content LIKE '%http%'
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      [Date.now(), limit, offset],
    );
    const rows = (result.rows ?? []) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * Signal resend protocol — recent still-undelivered outbound 1:1 TEXT
   * messages for a conversation, newest-first, capped. Used to re-transmit
   * after a peer signals it rebuilt its session (i.e. couldn't decrypt what we
   * sent). Scoped to `status='sent'` (accepted by the relay but not yet
   * `delivered`/`read`) and `type='text'` (attachments need a media re-grant,
   * out of scope for the resend).
   */
  async recentUndeliveredSelfText(
    conversationId: string,
    sinceIso: string,
    limit: number,
  ): Promise<LocalMessage[]> {
    const result = await this.db.execute(
      `SELECT * FROM messages
         WHERE conversation_id = ?
           AND sender_id = 'self'
           AND status = 'sent'
           AND type = 'text'
           AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT ?`,
      [conversationId, sinceIso, limit],
    );
    const rows = (result.rows ?? []) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * Bulk import — used during the AsyncStorage → SQLCipher migration
   * and from the audit-fix #19 coalesced-upsert path. Calls the raw
   * `doUpsert` directly so the per-conversation chain isn't re-entered
   * (which would deadlock against the chain that's currently holding
   * the lock for this call).
   */
  async upsertBatch(messages: LocalMessage[]): Promise<void> {
    if (messages.length === 0) {return;}
    // M-14 — serialize the explicit BEGIN/COMMIT across ALL
    // SqlMessageStore instances that share this op-sqlite connection (the
    // restore path constructs its OWN instance while the live coalesced-
    // flush path uses the runtime's; the per-instance `chains` map does
    // NOT serialize across instances).
    //
    // Audit P0-1 (2026-07-09) — the M-14 fix used a store-local static
    // mutex, which serialized upsertBatch against ITSELF but not against
    // the receive transaction (`runWithRatchetTxn`) on the SAME SQLCipher
    // connection. A receive `BEGIN IMMEDIATE` landing inside an open
    // flush txn threw "cannot start a transaction within a transaction",
    // the catch-all classified it terminal, and the relay ack-`discarded`
    // (destroyed) a committed inbound message. Funnel the flush through
    // the ONE per-connection exclusive-txn runner instead: it chains on
    // the same module-level mutex as every receive txn, opens
    // BEGIN IMMEDIATE, commits/rolls back, and flags isInsideRatchetTxn()
    // so nested writers (sqlCipherStore.saveIdentity) skip their own
    // BEGIN — exactly the awareness the receive txn already has.
    return runWithRatchetTxn(this.db, async () => {
      // op-sqlite has a `transaction` helper but a sequential await loop
      // is fine for the hundreds-of-rows scale of a Phase-1 user. Wrapping
      // in BEGIN/COMMIT halves the fsync count on Android.
      for (const m of messages) {await this.doUpsert(m);}
    });
  }

  /**
   * Drop every message in the messages table. Used by the destructive
   * "wipe identity" flow alongside `IndexedDBProtocolStore.wipe()` /
   * `SqlCipherProtocolStore.wipe()`.
   */
  async wipe(): Promise<void> {
    await this.db.execute('DELETE FROM messages');
  }
}

function rowToMessage(r: MessageRow): LocalMessage {
  return {
    id:               r.id,
    conversation_id:  r.conversation_id,
    sender_id:        r.sender_id,
    type:             r.type as LocalMessage['type'],
    content:          r.content ?? '',
    media_mime:       r.media_mime ?? undefined,
    media_object_key: r.media_object_key ?? undefined,
    media_key:        r.media_key ?? undefined,
    media_iv:         r.media_iv ?? undefined,
    status:           r.status as LocalMessage['status'],
    is_encrypted:     r.is_encrypted === 1,
    created_at:       r.created_at,
    peer:             {userId: r.peer_user_id, deviceId: r.peer_device_id},
    envelope_id:      r.envelope_id ?? undefined,
    retract_token:    r.retract_token ?? undefined,
    expires_at:       r.expires_at ?? undefined,
    reply_to_msg_id:  r.reply_to_msg_id ?? undefined,
    reply_to_preview: r.reply_to_preview ?? undefined,
    reactions:        r.reactions_json ? safeJson(r.reactions_json) : undefined,
    call_meta:        r.call_meta_json ? safeJsonCallMeta(r.call_meta_json) : undefined,
    media_meta:       r.media_meta_json ? safeJsonMediaMeta(r.media_meta_json) : undefined,
  };
}

function safeJson(s: string): Record<string, string> | undefined {
  try { return JSON.parse(s) as Record<string, string>; }
  catch { return undefined; }
}

function safeJsonCallMeta(s: string): LocalMessage['call_meta'] {
  try { return JSON.parse(s) as LocalMessage['call_meta']; }
  catch { return undefined; }
}

function safeJsonMediaMeta(s: string): LocalMessage['media_meta'] {
  try { return JSON.parse(s) as LocalMessage['media_meta']; }
  catch { return undefined; }
}
