/**
 * Group-add visibility fixes (docs/handoffs/GROUP_ADD_VISIBILITY_AND_DELIVERY_GAPS_HANDOFF.md §2).
 *
 * Why this lives in its own module:
 *   `productionRuntime.ts` transitively imports native modules and cannot
 *   be required under the Jest `messenger-crypto` project (same reason as
 *   `envelopeDelivered.ts`). These helpers are the single writers of the
 *   group conversation row on a receiving device, so they need direct
 *   unit coverage.
 */

import {useMessengerStore} from '../store/messengerStore';
import type {GroupState, SessionAddress} from '@bravo/messenger-core';

/**
 * Single writer for a group's inbox row from a verified `admin: create`
 * state. Extracted from the `group-create:recv` handler so:
 *   (a) the idempotent duplicate-create early-return can REPAIR a device
 *       that holds groups[gid] crypto state but lost/never wrote the
 *       conversations[gid] row (previously the early return preceded the
 *       upsert, so redelivery could never fix an invisible group), and
 *   (b) a re-shared create no longer clobbers local-only fields —
 *       unread_count / mute / pin / custom name / last_message survive
 *       for members who already had the row (upsertConversation is a
 *       full replace).
 * Ad-hoc `'Call'` groups must be excluded by the CALLER (BS-CALL-GHOST).
 */
export function upsertGroupConversationFromState(
  state: GroupState,
  senderUserId: string,
): void {
  const store = useMessengerStore.getState();
  const existing = store.conversations[state.groupId];
  const memberIds = Object.keys(state.members);
  const otherMembers = memberIds.filter(uid => uid !== senderUserId);
  store.upsertConversation({
    ...(existing ?? {}),
    id:            state.groupId,
    type:          'group',
    name:          existing?.is_custom_name && existing.name ? existing.name : state.name,
    participants:  memberIds,
    unread_count:  existing?.unread_count ?? 0,
    is_muted:      existing?.is_muted ?? false,
    created_at:    existing?.created_at ?? new Date(state.createdAt).toISOString(),
    // Placeholder address — group routing is per-member fan-out, this
    // field is only used by legacy 1:1-shaped selectors.
    peer:          existing?.peer ?? {userId: otherMembers[0] ?? senderUserId, deviceId: 1},
    session_state: existing?.session_state ?? 'fresh',
  });
}

/**
 * A brand-new member whose owner `create` has not landed yet may receive
 * a wrapped group message first (stashed as `no_key`/`tamper`). Without
 * an inbox row the group is invisible on the Messages page AND every
 * self-heal trigger that walks `conversations` (WS-connect resync,
 * ChatScreen-open resync) skips it entirely. Upsert a minimal
 * placeholder so the thread shows in a syncing state; the real `create`
 * overwrites name/participants when it lands. Never overwrites an
 * existing row. Zustand-only write — safe inside the receive txn.
 */
export function upsertKeylessGroupPlaceholder(
  groupId: string,
  peer: SessionAddress,
): void {
  const store = useMessengerStore.getState();
  if (store.conversations[groupId]) {return;}
  store.upsertConversation({
    id:            groupId,
    type:          'group',
    name:          'Group',
    participants:  [peer.userId],
    unread_count:  0,
    is_muted:      false,
    created_at:    new Date().toISOString(),
    peer:          {userId: peer.userId, deviceId: peer.deviceId},
    session_state: 'fresh',
  });
}

/**
 * Target resolution for a group key-request. Participants normally come
 * from the conversation row; a keyless brand-new member may have NO row
 * (the row's only writer is the very `create` that never landed — the
 * catch-22 in handoff §2.5 Seam C), so the stash branch supplies the
 * envelope's sender as a direct fallback target.
 */
export function resolveKeyRequestTargets(
  participants: string[] | undefined,
  ownUserId: string,
  fallbackPeerUserId?: string,
): string[] {
  const fromConvo = (participants ?? []).filter(uid => uid && uid !== ownUserId);
  if (fromConvo.length > 0) {return fromConvo;}
  if (fallbackPeerUserId && fallbackPeerUserId !== ownUserId) {return [fallbackPeerUserId];}
  return [];
}
