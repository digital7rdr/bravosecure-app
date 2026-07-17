/**
 * Delivery-failure signalling (handoff §3.6 options (a) + (c)).
 *
 * The relay's ack is one wire signal carrying two meanings — "delete
 * this envelope" and "the recipient has it" — and the receive path
 * deliberately acks terminal decrypt failures (anti-poison, P1-4), so
 * a destroyed message produced the same sender-side ✓✓ as a delivered
 * one and left no trace in the receiver's thread. This module carries
 * the receiver-side truth:
 *
 *   - `noteDestroyedEnvelope` / `takeDestroyedEnvelope`: the deep
 *     receive path (doHandleIncoming) marks an envelope as DESTROYED
 *     (unrecoverable, will never render); the ack site reads the mark
 *     and acks with `disposition: 'discarded'` so the relay emits
 *     `envelope.undeliverable` to the sender instead of
 *     `envelope.delivered`. Module-level map avoids threading yet
 *     another parameter through the 13-arg receive signature.
 *   - `insertDecryptFailurePlaceholder`: persistent per-conversation
 *     "message couldn't be decrypted" row, deduped by envelopeId, so
 *     the receiver sees a gap marker instead of silence.
 *   - `applyEnvelopeUndeliverable`: sender-side handler for the new
 *     `envelope.undeliverable` frame — flips the bubble to
 *     `undelivered` and defends against a late `envelope.delivered`
 *     (applyEnvelopeDelivered only advances from `sent`, so the
 *     undelivered mark is stable once set).
 *
 * Stash branches (group no_key / recoverable tamper) are NOT destroyed
 * — the device durably holds the ciphertext and renders it after key
 * sync — so they keep the honest `delivered` disposition and never get
 * a destroyed-placeholder.
 *
 * Security: never logs or stores plaintext/ciphertext/key material —
 * only envelopeIds, conversation ids, and short reason codes.
 */

import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';
import type {SessionAddress} from '@bravo/messenger-core';

export interface DestroyedEnvelopeInfo {
  envelopeId:      string;
  /** Known for post-unwrap failures (AAD reject, tamper-final). */
  conversationId?: string;
  peer?:           SessionAddress;
  reason:          string;
}

const MAX_TRACKED = 200;
const destroyed = new Map<string, DestroyedEnvelopeInfo>();

export function noteDestroyedEnvelope(info: DestroyedEnvelopeInfo): void {
  if (!info.envelopeId) {return;}
  if (destroyed.size >= MAX_TRACKED && !destroyed.has(info.envelopeId)) {
    const oldest = destroyed.keys().next().value;
    if (oldest !== undefined) {destroyed.delete(oldest);}
  }
  destroyed.set(info.envelopeId, info);
}

export function takeDestroyedEnvelope(envelopeId?: string): DestroyedEnvelopeInfo | undefined {
  if (!envelopeId) {return undefined;}
  const info = destroyed.get(envelopeId);
  if (info) {destroyed.delete(envelopeId);}
  return info;
}

/** Test hook — clears module state between cases. */
export function _resetDestroyedEnvelopes(): void {
  destroyed.clear();
}

export function placeholderMessageId(envelopeId: string): string {
  return `undecryptable:${envelopeId}`;
}

/**
 * Build + append the persistent placeholder row. Returns the appended
 * message so the caller can mirror it into SQLCipher (the receive path
 * does `sqlMessages.upsert(msg)` inside the txn, same as real rows), or
 * null when deduped / not insertable. Idempotent by message id — a WS
 * redelivery or drain retry of the same envelope never duplicates it.
 */
export function insertDecryptFailurePlaceholder(params: {
  conversationId: string;
  peer:           SessionAddress;
  envelopeId:     string;
  reason:         string;
}): LocalMessage | null {
  const {conversationId, peer, envelopeId, reason} = params;
  if (!envelopeId || !conversationId) {return null;}
  const store = useMessengerStore.getState();
  const id = placeholderMessageId(envelopeId);
  if (store.messages[conversationId]?.some(m => m.id === id)) {return null;}
  const msg: LocalMessage = {
    id,
    conversation_id: conversationId,
    sender_id:       peer.userId,
    type:            'system',
    content:         "A message couldn't be decrypted on this device. Ask the sender to resend it.",
    status:          'delivered',
    is_encrypted:    false,
    created_at:      new Date().toISOString(),
    peer,
    envelope_id:     envelopeId,
  };
  store.appendMessage(conversationId, msg);
  // Why: reason is a short code, never message content — safe to log.
  console.warn(`[messenger] recv-failure placeholder convo=${conversationId.slice(0, 12)} env=${envelopeId.slice(0, 8)} reason=${reason.slice(0, 40)}`);
  return msg;
}

/**
 * Sender-side `envelope.undeliverable` handler. Flips `sent` (and a
 * stale `delivered` that raced ahead) to `undelivered`; never touches
 * `read` (the receipt proves the recipient rendered it, which
 * contradicts a destroy — trust the stronger signal). Idempotent.
 * Returns the number of bubbles flipped (0 or 1).
 */
export function applyEnvelopeUndeliverable(envelopeId: string): number {
  if (!envelopeId) {return 0;}
  const store = useMessengerStore.getState();
  for (const [conversationId, list] of Object.entries(store.messages)) {
    for (const msg of list) {
      if (msg.envelope_id !== envelopeId) {continue;}
      if (msg.status === 'sent' || msg.status === 'delivered') {
        store.updateMessageStatus(conversationId, msg.id, 'undelivered');
        return 1;
      }
      return 0;
    }
  }
  return 0;
}
