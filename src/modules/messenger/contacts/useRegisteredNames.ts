import {useCallback, useEffect, useRef} from 'react';
import type {UsersHttpClient} from '@bravo/messenger-core';
import {useMessengerStore} from '../store';

/**
 * B-79 — resolve the peer's REGISTERED Bravo name for direct conversations that
 * are still sitting on the auto-generated `Bravo · <8hex>` placeholder (created
 * by the store's shadow-create when a stranger messages you before contact
 * sync). The address-book sweep (`useDiscoveredContacts`) only renames peers
 * whose phone is in your address book — everyone else stayed a cryptic hex label
 * forever. This sweep fills that gap using the public `/users/profiles` lookup.
 *
 * Name precedence (highest wins): user-set custom name (`is_custom_name`) >
 * saved address-book name (`localName`, from useDiscoveredContacts) > registered
 * Bravo display name (this hook) > `Bravo · <hex>` placeholder. This hook only
 * ever replaces a still-placeholder name, so it never clobbers a saved/custom
 * one — and the address-book sweep, which runs the same way, overwrites this
 * hook's registered name with the user's own label when the peer is a contact.
 */
export function isPlaceholderName(name: string | undefined, peerUserId?: string): boolean {
  if (typeof name !== 'string' || name.length === 0) {return false;}
  // messengerStore shadow-create placeholder ("Bravo · abcd1234").
  if (name.startsWith('Bravo · ')) {return true;}
  // Bare id-prefix placeholder — the call/sync path stamps `userId.slice(0,8)`
  // ("c700ccde") "until profile fetch fills it in" (MainNavigator), or the full
  // userId. Match against the peer so we never mistake a real name for one.
  if (peerUserId && (name === peerUserId || name === peerUserId.slice(0, 8))) {return true;}
  return false;
}

export function useRegisteredNames(opts: {users: UsersHttpClient | null; enabled?: boolean}): void {
  const {users, enabled = true} = opts;
  const conversations = useMessengerStore(s => s.conversations);
  // userIds already queried this session (resolved OR unknown) so a stranger who
  // isn't on the directory doesn't get re-fetched on every conversations change.
  const attemptedRef = useRef<Set<string>>(new Set());

  const run = useCallback(async () => {
    if (!enabled || !users) {return;}
    const store = useMessengerStore.getState();
    const pending = Object.values(store.conversations).filter(
      c => c.type === 'direct' &&
        !c.is_custom_name &&
        !!c.peer?.userId &&
        isPlaceholderName(c.name, c.peer.userId) &&
        !attemptedRef.current.has(c.peer.userId),
    );
    if (pending.length === 0) {return;}
    const ids = pending.map(c => c.peer.userId);
    let profiles;
    try {
      profiles = await users.getProfilesByIds(ids);
    } catch {
      return; // best-effort — retried on the next conversations change
    }
    // Mark every queried id attempted (success): ids the server omitted (unknown/
    // blocked) simply keep the placeholder without re-hammering the endpoint.
    for (const id of ids) {attemptedRef.current.add(id);}
    const nameById = new Map(profiles.map(p => [p.userId, p.displayName]));
    for (const c of pending) {
      const reg = nameById.get(c.peer.userId);
      if (!reg) {continue;}
      // Re-read: the address-book sweep may have set a saved name (which wins)
      // between our fetch and now — only replace a STILL-placeholder name.
      const fresh = store.conversations[c.id];
      if (fresh && !fresh.is_custom_name && isPlaceholderName(fresh.name, fresh.peer?.userId)) {
        store.upsertConversation({...fresh, name: reg});
      }
    }
  }, [enabled, users]);

  useEffect(() => { void run(); }, [run, conversations]);
}
