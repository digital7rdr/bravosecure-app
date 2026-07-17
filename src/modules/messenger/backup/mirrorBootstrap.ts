/**
 * Subscribe to the local messenger store and pump every new
 * conversation + message into messageMirror.ts.
 *
 * Why a store subscription instead of touching every appendMessage
 * call site (there are ~10 of them across productionRuntime + group
 * runtime + relay handlers): one hook covers send, receive, system
 * broadcasts, and group admin envelopes uniformly. Less code to
 * maintain and impossible to forget on a new code path.
 *
 * Round 8 changes:
 *   • Diff loop now mirrors mutations as well as new ids — previously
 *     status flips, reactions, and retract-token assignments only
 *     reached the mirror via the markDirty re-enqueue. Now the diff
 *     itself catches them via a content hash, which is more robust:
 *     even mutations that bypass the store (rare) get picked up if
 *     the row reads back differently next iteration.
 *   • Conversation diffs include GroupState so admin/owner/master
 *     key/epoch survive a backup-restore.
 *   • setCatchUpSweep is wired so messageMirror's enable-time sweep
 *     can re-mirror the full SQLCipher store. Closes the boot-window
 *     gap where messages arrive before setMirrorKey runs.
 */
import {useMessengerStore} from '../store/messengerStore';
import {useAuthStore} from '@store/authStore';
import {
  mirrorMessage,
  mirrorConversation,
  isMirrorEnabled,
  setMerkleAfterFlushHook,
  setCatchUpSweep,
  setMirrorOwner,
  clearMirrorDedupForOwner,
  seedMirrorDedup,
  drainMirrorOutbox,
  fireMerkleHookNow,
  fireMerkleHookNowIfPending,
  mirrorOutboxSize,
} from './messageMirror';
import {
  loadFlushedVersions,
  clearFlushedForOwner,
  readMerkleCommitPending,
} from './mirrorLedger';
import type {LocalMessage, LocalConversation} from '../store/types';

let unsubscribe: (() => void) | null = null;
/**
 * Round 8 — diff state keyed on a per-message version hash, not just
 * the id. status / reaction / retract / envelope-id mutations now
 * change the hash so the diff catches them.
 *
 * Conversations track a version hash too so mute/pin/TTL/custom-name
 * flips re-mirror automatically.
 */
let prevMessageVersions: Map<string, string> | null = null;
let prevConvVersions:    Map<string, string> | null = null;
// Finding 20b — the previous `state.messages` map by reference. immer
// preserves the array ref for a conversation whose messages didn't change,
// so we skip re-hashing every message in unchanged conversations (turns
// the per-mutation cost from O(total messages) into O(changed messages)).
let prevMessagesRef: Record<string, LocalMessage[]> | null = null;

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function messageVersion(m: LocalMessage): string {
  return fnv1a(JSON.stringify({
    s: m.status,
    r: m.reactions,
    t: m.retract_token,
    e: m.envelope_id,
    x: m.expires_at,
    c: m.content,
    mk: m.media_key,
    mi: m.media_iv,
  }));
}

function convVersion(c: LocalConversation): string {
  return fnv1a(JSON.stringify({
    n: c.name,
    p: c.is_pinned,
    m: c.is_muted,
    t: c.default_ttl_sec,
    u: c.unread_count,
    cn: c.is_custom_name,
    pp: c.participants?.length ?? 0,
  }));
}

/**
 * Start the subscription. Calling twice is idempotent — we drop the
 * previous handle. Stop via stop().
 */
export function startMirrorBootstrap(): void {
  if (unsubscribe) {return;}
  prevMessageVersions = new Map();
  prevConvVersions = new Map();

  // Pin the live owner so messageMirror's owner gate can reject any
  // stale callbacks that fire after a logout.
  const owner = useAuthStore.getState().user?.id ?? null;
  if (owner) {setMirrorOwner(owner);}

  // Round 5 / Security S8 — install the Merkle-commit-after-flush hook.
  // B-81 — delegates to commitMerkleRootNow so the repair path can sign a
  // fresh root DIRECTLY: the restore screen is reachable without
  // startMirrorBootstrap ever running (backupBoot RESTORE/RESTORE-RESUME
  // branches), so the ambient hook is null exactly when repair needs it.
  setMerkleAfterFlushHook(async () => {
    const ownerUserId = useAuthStore.getState().user?.id;
    if (!ownerUserId) {return;}
    await commitMerkleRootNow(ownerUserId);
  });

  // Round 8 — install the catch-up sweep. setMirrorKey calls this when
  // the mirror flips disabled → enabled, re-walking SQLCipher to
  // re-mirror anything that was silently dropped while locked.
  setCatchUpSweep(async () => {
    const ownerUserId = useAuthStore.getState().user?.id;
    if (!ownerUserId) {return;}
    console.log('[bravo.backup.mirror] catch-up sweep starting');
    try {
      // B-94 — hydrate the dedup from the persistent flush ledger FIRST,
      // so the walk below only enqueues rows whose current version never
      // reached the server. Pre-B-94 the dedup was empty on every boot,
      // so the sweep re-encrypted + re-uploaded the ENTIRE history each
      // launch (fresh AES-GCM IV per row = new server bytes), re-opening
      // the "rows ahead of the signed root" kill-window every time — the
      // drift factory behind the recurring `root_mismatch` dead-end.
      seedMirrorDedup(ownerUserId, await loadFlushedVersions(ownerUserId));
      await backupNow(ownerUserId);
      // B-81 — drain + fast-forward the pending commit instead of leaving
      // uploads to the 1.5s flush + 5s merkle debounces. A kill inside that
      // window left the server rows AHEAD of the last signed root — every
      // later restore hard-failed `root_mismatch` on an honest backup.
      // `IfPending` keeps idle boots commit-free (no upload ⇒ no re-sign).
      await drainMirrorOutbox();
      // B-94 — a previous session killed between "rows uploaded" and
      // "commit shipped" left the pending flag set. Sign now even if THIS
      // sweep uploaded nothing, healing the drift before any restore
      // elsewhere can dead-end on it. Otherwise keep idle boots
      // commit-free (`IfPending`).
      if (await readMerkleCommitPending(ownerUserId)) {
        await fireMerkleHookNow();
      } else {
        await fireMerkleHookNowIfPending();
      }
      console.log('[bravo.backup.mirror] catch-up sweep done');
    } catch (e) {
      console.warn('[bravo.backup.mirror] catch-up sweep failed:', (e as Error).message);
    }
  });

  // Seed with the current store snapshot — mutations after this point
  // ship through the diff loop.
  const initial = useMessengerStore.getState();
  for (const list of Object.values(initial.messages)) {
    for (const m of list) {prevMessageVersions!.set(m.id, messageVersion(m));}
  }
  for (const [id, conv] of Object.entries(initial.conversations)) {
    prevConvVersions!.set(id, convVersion(conv));
  }
  prevMessagesRef = initial.messages;

  unsubscribe = useMessengerStore.subscribe(state => {
    if (!isMirrorEnabled()) {return;}
    const ownerUserId = useAuthStore.getState().user?.id;
    if (!ownerUserId) {return;}
    if (!prevMessageVersions || !prevConvVersions) {return;}

    // Diff messages — fire mirrorMessage on (new id) OR (changed hash).
    // Finding 20b — skip conversations whose message array is the SAME ref
    // as last time (immer only replaces the arrays that changed).
    for (const [cid, list] of Object.entries(state.messages)) {
      if (prevMessagesRef && prevMessagesRef[cid] === list) {continue;}
      for (const m of list) {
        const v = messageVersion(m);
        const prev = prevMessageVersions.get(m.id);
        if (prev === v) {continue;}
        prevMessageVersions.set(m.id, v);
        mirrorMessage(ownerUserId, m);
      }
    }
    prevMessagesRef = state.messages;
    // Diff conversations.
    for (const [convId, conv] of Object.entries(state.conversations)) {
      const v = convVersion(conv);
      const prev = prevConvVersions.get(convId);
      if (prev === v) {continue;}
      prevConvVersions.set(convId, v);
      // Group rooms — pass the matching GroupState so admin/master
      // key/epoch round-trip.
      const groupState = state.groups[convId];
      mirrorConversation(ownerUserId, conv, groupState);
    }
  });
}

/**
 * Audit fix #28 — clear the dedup state on logout so the next session
 * starts clean.
 */
export function stopMirrorBootstrap(): void {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  prevMessageVersions?.clear();
  prevConvVersions?.clear();
  prevMessageVersions = null;
  prevConvVersions    = null;
  prevMessagesRef     = null;
  setMerkleAfterFlushHook(null);
  setCatchUpSweep(null);
  setMirrorOwner(null);
}

/**
 * Force-mirror EVERYTHING currently in the local store + SQLCipher.
 * Used:
 *   • Once after backup setup so existing chat history reaches the
 *     server (not just future messages).
 *   • Round 8 — every time setMirrorKey enables the mirror, via the
 *     catch-up sweep, so messages dropped while locked still ship.
 */
export async function backupNow(
  ownerUserId: string,
): Promise<{messages: number; conversations: number}> {
  if (!isMirrorEnabled()) {return {messages: 0, conversations: 0};}
  const state = useMessengerStore.getState();
  let messages = 0;
  let conversations = 0;

  for (const conv of Object.values(state.conversations)) {
    const groupState = state.groups[conv.id];
    mirrorConversation(ownerUserId, conv, groupState);
    conversations++;
  }

  const {getOwnCryptoStore} = require('../runtime/runtime') as typeof import('../runtime/runtime');
  const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as typeof import('../crypto/sqlCipherStore');
  const {SqlMessageStore} = require('../store/sqlMessageStore') as typeof import('../store/sqlMessageStore');

  const ownStore = getOwnCryptoStore();
  if (ownStore && ownStore instanceof SqlCipherProtocolStore) {
    try {
      const sqlMessages = new SqlMessageStore(ownStore.getDb());
      const all = await sqlMessages.loadAll();
      for (const list of Object.values(all)) {
        for (const msg of list) {
          mirrorMessage(ownerUserId, msg);
          messages++;
        }
      }
      return {messages, conversations};
    } catch (e) {
      console.warn('[bravo.backup.mirror] SQL backupNow failed, falling back to memory:', (e as Error).message);
    }
  }

  for (const list of Object.values(state.messages)) {
    for (const msg of list) {
      mirrorMessage(ownerUserId, msg);
      messages++;
    }
  }
  return {messages, conversations};
}

/**
 * B-81 — walk the server rows and sign a fresh Merkle root NOW, without
 * depending on the ambient after-flush hook (which only exists once
 * startMirrorBootstrap has run — NOT on the backupBoot RESTORE /
 * RESTORE-RESUME paths that lead to the restore screen). Throws when the
 * identity store isn't available so callers fail loudly instead of
 * pretending a commit happened.
 */
export async function commitMerkleRootNow(ownerUserId: string): Promise<void> {
  const {getOwnCryptoStore} = require('../runtime/runtime') as typeof import('../runtime/runtime');
  const ownStore = getOwnCryptoStore();
  if (!ownStore) {throw new Error('crypto_store_unavailable');}
  const ident = await ownStore.getIdentityKeyPair();
  const {commitMerkleRoot} = require('./merkleCommit') as typeof import('./merkleCommit');
  await commitMerkleRoot({
    identityPrivKey: ident.privKey,
    userId:          ownerUserId,
  });
}

/**
 * B-81 — count the local rows the repair would re-upload, WITHOUT enqueuing
 * anything. Mirrors backupNow's source selection (SQLCipher when available,
 * else the in-memory store) so the refusal check runs before any side
 * effect — a fresh device must refuse with its dedup and queues untouched.
 */
async function countLocalMessages(): Promise<number> {
  const {getOwnCryptoStore} = require('../runtime/runtime') as typeof import('../runtime/runtime');
  const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as typeof import('../crypto/sqlCipherStore');
  const {SqlMessageStore} = require('../store/sqlMessageStore') as typeof import('../store/sqlMessageStore');
  const ownStore = getOwnCryptoStore();
  if (ownStore && ownStore instanceof SqlCipherProtocolStore) {
    try {
      const sqlMessages = new SqlMessageStore(ownStore.getDb());
      const all = await sqlMessages.loadAll();
      return Object.values(all).reduce((n, list) => n + list.length, 0);
    } catch { /* fall through to memory */ }
  }
  const state = useMessengerStore.getState();
  return Object.values(state.messages).reduce((n, list) => n + list.length, 0);
}

/**
 * B-81 — repair a backup whose server rows drifted from the last signed
 * Merkle commit (the equal-count `root_mismatch` restore dead-end).
 *
 * How the drift happens: every re-mirror re-encrypts a row with a fresh
 * AES-GCM IV (new bytes for the same message_id), and the signed commit
 * trails the upload by a debounced server walk. An app kill inside that
 * window leaves the server rows AHEAD of the last signed root — with the
 * row COUNT unchanged when the uploads were updates (status flips, read
 * receipts, reactions). The restore verifier deliberately hard-fails
 * equal-count divergence (P2-B-1: indistinguishable from per-row
 * substitution) and nothing ever re-commits, so "Retry" fails forever.
 *
 * The honest reconciliation — run ONLY on a device that already holds the
 * decrypted local history and the unlocked mirror key (the live owner):
 *   1. refuse OUTRIGHT (no side effects) when there is nothing local,
 *   2. clear the owner's mirror dedup so the full local store re-enqueues,
 *   3. re-upload EVERY local row (local truth overwrites the server bytes),
 *   4. drain the outbox synchronously and ABORT unless it fully drained —
 *      signing over a half-overwritten server set would leave a torn root
 *      that the retry (and any later restore) still rejects,
 *   5. sign a fresh root directly via commitMerkleRootNow (the ambient
 *      after-flush hook does NOT exist on the restore paths).
 * The restore verifier is untouched: we never re-sign the server's bytes
 * as-is — we overwrite them with locally-held plaintext truth first, which
 * is the same attestation the live post-flush hook already performs.
 *
 * Returns false (without committing) when the mirror is locked, the local
 * store has nothing to upload — e.g. a fresh-device restore, where blessing
 * the server's set would launder exactly what the verifier exists to catch —
 * or the outbox could not fully drain (flaky network). Throws when the
 * commit itself fails, so the caller surfaces the error instead of retrying.
 */
export async function repairBackupCommit(ownerUserId: string): Promise<boolean> {
  if (!isMirrorEnabled()) {return false;}
  if ((await countLocalMessages()) === 0) {return false;}
  clearMirrorDedupForOwner(ownerUserId);
  // B-94 — purge the persistent flush ledger too: repair exists because
  // the server bytes can no longer be trusted to match what the ledger
  // claims was flushed, so nothing may short-circuit the full re-upload.
  await clearFlushedForOwner(ownerUserId);
  await backupNow(ownerUserId);
  await drainMirrorOutbox();
  if (mirrorOutboxSize() > 0) {
    console.warn('[bravo.backup.repair] outbox did not fully drain — refusing to sign a torn set');
    return false;
  }
  await commitMerkleRootNow(ownerUserId);
  return true;
}
