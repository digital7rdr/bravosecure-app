/**
 * Audit P0-T6 — sender-facing delivered-tick handler.
 *
 * Why this lives in its own module:
 *   The Jest `messenger-crypto` project runs under Node (no Metro,
 *   no native modules). `productionRuntime.ts` transitively imports
 *   `@op-engineering/op-sqlite`, which is a native module and cannot
 *   be required at test time. Lifting this tiny helper out of the
 *   runtime keeps the unit-test surface dependency-light.
 *
 * Contract:
 *   The relay emits `envelope.delivered { envelopeId }` to the
 *   original submitter device the moment the recipient acks. This
 *   function advances the local bubble from single-tick `sent` to
 *   double-tick `delivered`.
 *
 * Guards:
 *   - `read` → leave as-is (a slow delivered must NOT regress a
 *     bubble the recipient has already read).
 *   - `delivered` → no-op (idempotent — defends against any future
 *     relay that emits delivered more than once).
 *   - `sending` / `failed` → skip; we never observed `sent`, so
 *     painting `delivered` would be a lie (most likely a stale
 *     frame for an already-retracted message).
 *
 * Returns the number of bubbles whose status was flipped (0 or 1).
 * The store carries at most one bubble per envelope_id by
 * construction (the sender mints clientMsgId + the relay mints
 * envelopeId, both unique), so the scan short-circuits on first
 * match.
 */

import {useMessengerStore} from '../store/messengerStore';

export function applyEnvelopeDelivered(envelopeId: string): number {
  if (!envelopeId) {return 0;}
  const store = useMessengerStore.getState();
  for (const [conversationId, list] of Object.entries(store.messages)) {
    for (const msg of list) {
      if (msg.envelope_id !== envelopeId) {continue;}
      if (msg.status === 'sent') {
        store.updateMessageStatus(conversationId, msg.id, 'delivered');
        return 1;
      }
      return 0;
    }
  }
  return 0;
}
