/**
 * Durable outbox.
 *
 * Why: the WS send path is fire-and-forget. If the app is killed (Doze,
 * swipe, low-memory) between `transport.send()` and the server's
 * `envelope.accepted`, the message lives only in the Zustand store as
 * `status: 'sending'` with no retry mechanism — it's gone. WhatsApp
 * persists every outgoing message to disk BEFORE shipping it and only
 * deletes the row after the server confirms. This store does the same.
 *
 * Group fan-out (audit P0-N4): each per-peer envelope is its own row.
 * The PK is composite — (clientMsgId, peerUserId, peerDeviceId) — so a
 * group send to N members enqueues N rows that all carry the same
 * clientMsgId but route to distinct recipients. drainOutbox replays
 * each row independently with per-row retry/backoff.
 *
 * Lifecycle:
 *   1. enqueue()  — runtime writes BEFORE `transport.send()`.
 *   2. markDelivered() — runtime deletes when `envelope.accepted` (or
 *      HTTP fallback) confirms acceptance for THIS peer.
 *   3. dueRows()  — startup + every `socket.on('connect')` calls this
 *      to pull rows whose `next_retry_at <= now`; runtime re-ships
 *      each via the existing HTTP relay path.
 *   4. recordAttempt() — bumps `attempts` and schedules the next retry
 *      with exponential backoff (1s, 4s, 15s, 60s, 5m cap).
 *   5. markFailed() — after MAX_ATTEMPTS attempts the row stays in the
 *      DB with `status='failed'` so the UI can surface a retry button.
 */

import type {DbHandle} from '../crypto/db';

export interface OutboxRow {
  clientMsgId:    string;
  conversationId: string;
  messageId:      string;
  peerUserId:     string;
  peerDeviceId:   number;
  /** JSON-serialised ClientEnvelopeSend.data (outerSealed + expiresAtSec). */
  payload:        string;
  attempts:       number;
  nextRetryAt:    number;
  createdAt:      number;
  status:         'pending' | 'failed';
}

export interface OutboxEnqueueInput {
  clientMsgId:    string;
  conversationId: string;
  messageId:      string;
  peerUserId:     string;
  peerDeviceId:   number;
  payload:        string;
}

/**
 * Exponential backoff schedule. Capped at 5 minutes; after MAX_ATTEMPTS
 * attempts the row is marked `failed` so the user can manually retry.
 */
const BACKOFF_MS = [1_000, 4_000, 15_000, 60_000, 5 * 60_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 5; // tolerate ~10 failed attempts

export class SqlOutboxStore {
  constructor(private readonly db: DbHandle) {}

  /** Insert a brand-new outbox row. PK collision is treated as idempotent. */
  async enqueue(row: OutboxEnqueueInput): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      `INSERT OR IGNORE INTO outbox (
         client_msg_id, conversation_id, message_id, peer_user_id,
         peer_device_id, payload, attempts, next_retry_at, created_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'pending')`,
      [
        row.clientMsgId, row.conversationId, row.messageId,
        row.peerUserId, row.peerDeviceId, row.payload,
        now, now,
      ],
    );
  }

  /**
   * Audit MSG-07 (2026-07-02): every message_id that still has ANY outbox row
   * (pending or failed). The boot sweep flips hydrated 'sending' bubbles with
   * NO row here to 'failed' — a crash between append and enqueue left them
   * permanently stuck in 'sending' with no retry path.
   */
  async allMessageIds(): Promise<Set<string>> {
    const result = await this.db.execute('SELECT DISTINCT message_id FROM outbox');
    const rows = (result.rows ?? []) as unknown as ReadonlyArray<{message_id: string}>;
    return new Set(rows.map(r => r.message_id));
  }

  /**
   * Rows that are due for a retry attempt. Caller is expected to ship
   * each one and then call either markDelivered() (success) or
   * recordAttempt() (transient failure).
   */
  async dueRows(now: number = Date.now()): Promise<OutboxRow[]> {
    const result = await this.db.execute(
      `SELECT client_msg_id, conversation_id, message_id, peer_user_id,
              peer_device_id, payload, attempts, next_retry_at,
              created_at, status
         FROM outbox
        WHERE status = 'pending' AND next_retry_at <= ?
        ORDER BY created_at ASC`,
      [now],
    );
    const rows = (result.rows ?? []) as unknown as ReadonlyArray<{
      client_msg_id:   string;
      conversation_id: string;
      message_id:      string;
      peer_user_id:    string;
      peer_device_id:  number;
      payload:         string;
      attempts:        number;
      next_retry_at:   number;
      created_at:      number;
      status:          string;
    }>;
    return rows.map(r => ({
      clientMsgId:    r.client_msg_id,
      conversationId: r.conversation_id,
      messageId:      r.message_id,
      peerUserId:     r.peer_user_id,
      peerDeviceId:   r.peer_device_id,
      payload:        r.payload,
      attempts:       r.attempts,
      nextRetryAt:    r.next_retry_at,
      createdAt:      r.created_at,
      status:         r.status === 'failed' ? 'failed' : 'pending',
    }));
  }

  /**
   * Confirm delivery for one (clientMsgId, peer) row. Group sends call
   * this once per recipient; 1:1 sends call it once. Audit P0-N4: the
   * composite key prevents one peer's ack from clearing every peer's
   * row.
   */
  async markDelivered(
    clientMsgId: string,
    peerUserId: string,
    peerDeviceId: number,
  ): Promise<void> {
    await this.db.execute(
      `DELETE FROM outbox
        WHERE client_msg_id = ?
          AND peer_user_id = ?
          AND peer_device_id = ?`,
      [clientMsgId, peerUserId, peerDeviceId],
    );
  }

  /**
   * Audit MSG-05 (2026-07-02): delete EVERY peer row for a clientMsgId.
   * Used by the tap-to-retry path: retry removes the failed bubble and
   * re-sends under a FRESH clientMsgId, so the old clientMsgId's outbox
   * row(s) must be dropped — otherwise the next reconnect drain also ships
   * the original envelope and the recipient receives the message twice
   * (different clientMsgIds, so the receive-side dedup can't catch it).
   */
  async deleteByClientMsgId(clientMsgId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM outbox WHERE client_msg_id = ?',
      [clientMsgId],
    );
  }

  /**
   * Audit P2-10 — drop EVERY outbox row for a conversation. Used by
   * "Clear chat": without it, a still-queued (pending/failed) row keeps
   * getting re-shipped by the next reconnect drain even though the user
   * cleared the thread, so the recipient receives a message the sender
   * deleted. Deleting a single message routes through deleteByClientMsgId.
   */
  async deleteByConversation(conversationId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM outbox WHERE conversation_id = ?',
      [conversationId],
    );
  }

  /**
   * Transient failure — bump attempts and schedule the next retry for
   * THIS (clientMsgId, peer) row. Returns the new attempt count so the
   * runtime can decide whether to surface a UI banner (after, say, 3
   * retries).
   */
  async recordAttempt(
    clientMsgId: string,
    peerUserId: string,
    peerDeviceId: number,
  ): Promise<{attempts: number; failed: boolean}> {
    const existing = await this.db.execute(
      `SELECT attempts FROM outbox
        WHERE client_msg_id = ?
          AND peer_user_id = ?
          AND peer_device_id = ?`,
      [clientMsgId, peerUserId, peerDeviceId],
    );
    const row = existing.rows?.[0] as unknown as {attempts: number} | undefined;
    if (!row) {
      // Already removed via markDelivered, or never existed. No-op.
      return {attempts: 0, failed: false};
    }
    const nextAttempts = row.attempts + 1;
    if (nextAttempts >= MAX_ATTEMPTS) {
      await this.db.execute(
        `UPDATE outbox SET attempts = ?, status = 'failed'
          WHERE client_msg_id = ?
            AND peer_user_id = ?
            AND peer_device_id = ?`,
        [nextAttempts, clientMsgId, peerUserId, peerDeviceId],
      );
      return {attempts: nextAttempts, failed: true};
    }
    // BACKOFF_MS is bounded by MAX_ATTEMPTS-5 to keep the lookup safe
    // here; even the last slot caps at 5 min which keeps the relay
    // window (~30 days dwell) far from exhaustion.
    const delay = BACKOFF_MS[Math.min(nextAttempts - 1, BACKOFF_MS.length - 1)];
    await this.db.execute(
      `UPDATE outbox
          SET attempts = ?, next_retry_at = ?
        WHERE client_msg_id = ?
          AND peer_user_id = ?
          AND peer_device_id = ?`,
      [nextAttempts, Date.now() + delay, clientMsgId, peerUserId, peerDeviceId],
    );
    return {attempts: nextAttempts, failed: false};
  }

  /**
   * Operator/manual retry of a row that previously hit MAX_ATTEMPTS.
   * Resets attempts to 0 and schedules an immediate replay for the
   * specified (clientMsgId, peer) row.
   */
  async resetFailed(
    clientMsgId: string,
    peerUserId: string,
    peerDeviceId: number,
  ): Promise<void> {
    await this.db.execute(
      `UPDATE outbox
          SET attempts = 0, next_retry_at = ?, status = 'pending'
        WHERE client_msg_id = ?
          AND peer_user_id = ?
          AND peer_device_id = ?
          AND status = 'failed'`,
      [Date.now(), clientMsgId, peerUserId, peerDeviceId],
    );
  }
}
