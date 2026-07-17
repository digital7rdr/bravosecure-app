/**
 * messageMirror — write-through replication of LocalMessage rows to
 * the encrypted backup. Decoupled from the runtime via an in-memory
 * queue + debounced flush so the hot send/receive paths never block
 * on a network call.
 *
 * Wire format (per row):
 *   ciphertext = AES-256-GCM(JSON.stringify({
 *     content, type, status, created_at, peer, reply_to_msg_id,
 *     reply_to_preview, reactions, call_meta, expires_at,
 *     media_object_key, media_mime, media_key, media_iv, retract_token,
 *   }), per-row subkey)
 *   wrappedSubkey = AES-256-GCM(subkey, master_key)
 *
 * The Supabase row stores the WRAPPED blob — the server cannot read
 * a single field. On restore we pull the row and reverse the wrap
 * with the same master_key recovered from the identity backup.
 *
 * Round 8 lifecycle changes (vs the R5 / R7 implementation):
 *   • markDirty no longer just clears the dedup — it RE-ENQUEUES the
 *     message for re-mirror, so status flips, reaction updates,
 *     retract-token assignment, and removals actually reach the
 *     server. Previously these were silent no-ops.
 *   • Owner gating: setMirrorOwner(userId) keys queue + dedup so a
 *     logout → re-login swap can never ship the previous user's
 *     in-flight queue under the new user.
 *   • disposeMirror() clears every module global. signOut wires this
 *     so cross-user contamination is impossible.
 *   • An AppState 'background' / 'inactive' hook forces a flush so
 *     the 1.5s debounce window can't leak when the OS suspends JS.
 *   • setMirrorKey now triggers a CATCH-UP SWEEP that walks the
 *     full SQLCipher store and re-mirrors any rows that were dropped
 *     while the mirror was disabled (boot window, dismissed unlock).
 *   • Media key + IV are serialized so restored attachments are
 *     decryptable. The retract token is also serialized so a
 *     restored device can still "delete for everyone" within dwell.
 */
import {AppState, type AppStateStatus} from 'react-native';
import {backupClient, BackupError} from './backupClient';
import {bumpFlushEpoch, recordFlushedVersions, setMerkleCommitPending} from './mirrorLedger';
import {aesGcmEncrypt, generateSubkey, toB64, backupAad} from './backupCrypto';
import {
  encryptGroupStateBlob,
  serializeMessageForBackup,
} from './backupWireV3';
import type {LocalMessage} from '../store/types';
import type {LocalConversation} from '../store/types';
import type {GroupState} from '@bravo/messenger-core';

// Round 5 / Security S8 — pluggable hook for the runtime to inject a
// "commit a Merkle root after a successful flush" callback. The
// mirror itself doesn't have access to the user's identity priv key
// or userId — those live in the runtime context. We expose the slot
// here and the runtime sets it once at boot.
type MerkleHook = () => Promise<void>;
let merkleAfterFlushHook: MerkleHook | null = null;
let merkleHookDebounce: ReturnType<typeof setTimeout> | null = null;
// B-45 R3 — was 30 s. Every second of lag between "rows uploaded" and
// "count signed" was a window where a kill/suspend left the server ahead
// of the last commit → the next restore hard-failed rows_count_mismatch.
// One curve25519 sign + one small POST per flush burst is cheap.
const MERKLE_DEBOUNCE_MS = 5_000;
export function setMerkleAfterFlushHook(hook: MerkleHook | null): void {
  merkleAfterFlushHook = hook;
}
function scheduleMerkleHook(): void {
  if (!merkleAfterFlushHook) {return;}
  if (merkleHookDebounce) {return;}
  merkleHookDebounce = setTimeout(() => {
    merkleHookDebounce = null;
    if (!merkleAfterFlushHook) {return;}
    void merkleAfterFlushHook().catch(e =>
      console.warn('[bravo.backup.mirror] merkle hook failed:', (e as Error).message),
    );
  }, MERKLE_DEBOUNCE_MS);
}

/**
 * B-45 R3 — run the pending Merkle commit NOW instead of waiting out the
 * debounce. Used by the AppState background handler (RN timers don't fire
 * while suspended, so an un-fast-forwarded timer dies with the process and
 * the server stays ahead of the signed count) and by fresh-setup callers
 * that need the baseline commit to cover what they just flushed.
 */
export async function fireMerkleHookNow(): Promise<void> {
  if (merkleHookDebounce) {clearTimeout(merkleHookDebounce); merkleHookDebounce = null;}
  if (!merkleAfterFlushHook) {return;}
  try {
    await merkleAfterFlushHook();
  } catch (e) {
    console.warn('[bravo.backup.mirror] merkle hook failed:', (e as Error).message);
  }
}

/**
 * B-81 — fast-forward the debounced Merkle commit ONLY when a flush actually
 * scheduled one. Used by the boot catch-up sweep: an idle boot (nothing
 * re-mirrored) must NOT mint a fresh commit — the walk-and-sign should only
 * follow real uploads. Shrinks the "rows uploaded but commit still pending"
 * kill-window from (5s debounce + walk) to just the walk.
 */
export async function fireMerkleHookNowIfPending(): Promise<void> {
  if (!merkleHookDebounce) {return;}
  await fireMerkleHookNow();
}

let masterKey: CryptoKey | null = null;
let enabled = false;
let warnedNoKey = false;
/**
 * Round 8 — owner gate. signOut + setOwner BOTH set this so the
 * queue can never ship the previous user's pending mirror writes
 * under the new owner_user_id.
 */
let mirrorOwnerUserId: string | null = null;

const FLUSH_DEBOUNCE_MS = 1500;
const MAX_BATCH = 50;
const MAX_QUEUE_SIZE = 500;

interface Pending {
  ownerUserId: string;
  msg: LocalMessage;
  /**
   * B-94 — the version hash this enqueue represents ('__deleted__' for
   * tombstones). Carried so a successful flush can persist it to the
   * mirror_flushed ledger without re-serializing the message.
   */
  version: string;
}

const queue: Pending[] = [];
const seenIds = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const convQueue = new Map<string, {ownerUserId: string; conv: LocalConversation; groupState?: GroupState}>();
let convFlushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Round 8 — catch-up sweep callback. Wired by the runtime so when
 * setMirrorKey flips us from disabled → enabled, we re-walk the
 * full local store and re-mirror anything that was silently dropped
 * during the boot window (or any session that ran with the mirror
 * locked).
 */
let catchUpSweep: (() => Promise<void>) | null = null;
export function setCatchUpSweep(fn: (() => Promise<void>) | null): void {
  catchUpSweep = fn;
}

/**
 * Round 8 — AppState 'background'/'inactive' handler. Without this,
 * a debounced 1.5s queue would lose every queued message when the
 * OS suspended JS. The handler subscription is installed once (idempotent
 * via `appStateSub`) and removed by disposeMirror.
 */
let appStateSub: {remove: () => void} | null = null;
function installAppStateHook(): void {
  if (appStateSub) {return;}
  const onChange = (state: AppStateStatus): void => {
    if (state === 'background' || state === 'inactive') {
      // Force-flush both queues. Cancel the pending debounce timers
      // first so the immediate flush isn't double-invoked.
      if (flushTimer) {clearTimeout(flushTimer); flushTimer = null;}
      if (convFlushTimer) {clearTimeout(convFlushTimer); convFlushTimer = null;}
      void (async () => {
        try { await flush(); } catch { /* logged inside flush */ }
        try { await flushConversations(); } catch { /* logged inside */ }
        // B-45 R3 — ship the pending Merkle commit too. Force-flushing
        // ROWS while abandoning the commit timer guaranteed the server
        // ended up ahead of the signed count (RN timers don't fire in
        // the background) → rows_count_mismatch on the next restore.
        // Only when a commit is actually owed (timer pending) — a plain
        // backgrounding with nothing mirrored must not hit the network.
        if (merkleHookDebounce) {
          await fireMerkleHookNow();
        }
      })();
    }
  };
  appStateSub = AppState.addEventListener('change', onChange);
}

/**
 * Wire the master key. Called by:
 *   • setupBackup() success path → first wrap of newly-generated key
 *   • restoreBackup() success path → key recovered from backup
 *   • app-resume bootstrap if both backup is enabled AND the user has
 *     re-entered their backup password to unlock for the session.
 *
 * Without a master key, mirror calls are no-ops (logged once).
 *
 * Round 8 — flipping enabled false → true triggers a catch-up sweep
 * so messages dropped while the mirror was locked still reach the
 * server. The sweep callback is installed by the runtime via
 * setCatchUpSweep; if it isn't wired, the flip is purely cosmetic.
 */
export function setMirrorKey(key: CryptoKey | null): void {
  const wasEnabled = enabled;
  masterKey = key;
  enabled = !!key;
  warnedNoKey = false;
  installAppStateHook();
  console.log(`[bravo.backup.mirror] setMirrorKey enabled=${enabled}`);
  if (!wasEnabled && enabled && catchUpSweep) {
    // Round 8 — gap recovery. Boot-window messages, dismissed-unlock
    // sessions, and FCM-headless-wake deliveries all silently dropped
    // before the key arrived. Re-walking the local store catches them.
    void catchUpSweep().catch(e =>
      console.warn('[bravo.backup.mirror] catch-up sweep failed:', (e as Error).message),
    );
  }
}

/**
 * Round 8 — owner gate. Pin the userId allowed to flow through the
 * mirror queue. Mismatches between mirrorMessage's ownerUserId and
 * this owner are silently dropped (the user just signed out and a
 * stale callback fired with the previous user's id).
 */
export function setMirrorOwner(userId: string | null): void {
  mirrorOwnerUserId = userId;
}

export function isMirrorEnabled(): boolean { return enabled; }

/**
 * Round 8 — total dispose. Wired into authStore.signOut so cross-
 * user contamination is impossible. Clears: queue, dedup, master
 * key handle, owner gate, conv queue, all timers, AppState hook.
 * Does NOT clear the merkle hook — that's owned by mirrorBootstrap
 * and cleared in stopMirrorBootstrap.
 */
export function disposeMirror(): void {
  masterKey = null;
  enabled = false;
  warnedNoKey = false;
  mirrorOwnerUserId = null;
  queue.length = 0;
  convQueue.clear();
  seenIds.clear();
  if (flushTimer) {clearTimeout(flushTimer); flushTimer = null;}
  if (convFlushTimer) {clearTimeout(convFlushTimer); convFlushTimer = null;}
  if (merkleHookDebounce) {clearTimeout(merkleHookDebounce); merkleHookDebounce = null;}
  if (appStateSub) {appStateSub.remove(); appStateSub = null;}
  catchUpSweep = null;
}

/**
 * Enqueue a message for mirroring. Cheap — wraps + flushes happen on
 * the debounced timer.
 *
 * Audit fix #30 — dedup gate keyed on `(owner, msgId, version)` where
 * version is a hash of the serialized message. Re-shipping the same
 * wire bytes is a no-op; ANY semantic change goes through.
 */
export function mirrorMessage(ownerUserId: string, msg: LocalMessage): void {
  if (!enabled) {
    if (!warnedNoKey) {
      console.log('[mirror] disabled — backup not unlocked this session');
      warnedNoKey = true;
    }
    return;
  }
  if (!ownerUserId || !msg.id) {return;}
  // Round 8 — owner gate. Reject mismatched owners so a stale
  // callback fired with the previous user's id can't ship under the
  // new user.
  if (mirrorOwnerUserId && mirrorOwnerUserId !== ownerUserId) {
    console.warn(`[mirror] owner mismatch: got ${ownerUserId} expected ${mirrorOwnerUserId} — dropped`);
    return;
  }
  const version = versionHash(msg);
  const dedupKey = `${ownerUserId}:${msg.id}:${version}`;
  if (seenIds.has(dedupKey)) {return;}
  seenIds.add(dedupKey);
  queue.push({ownerUserId, msg, version});
  scheduleFlush();
}

/**
 * B-94 — seed the in-memory dedup from the persistent mirror_flushed
 * ledger, so the boot catch-up sweep skips every row whose CURRENT
 * version already reached the server in a previous session. Without
 * this, every boot re-encrypted + re-uploaded the entire history (the
 * drift factory behind the recurring `root_mismatch` dead-end).
 */
export function seedMirrorDedup(ownerUserId: string, versions: ReadonlyMap<string, string>): void {
  if (!ownerUserId) {return;}
  for (const [messageId, version] of versions) {
    seenIds.add(`${ownerUserId}:${messageId}:${version}`);
  }
}

/**
 * B-94 — the exact version hash the mirror dedup uses for a message.
 * Exposed so the restore path can seed the ledger with the versions the
 * server verifiably holds (the rows it just decrypted), keeping the
 * first post-restore boot sweep a no-op.
 */
export function computeMirrorVersion(msg: LocalMessage): string {
  return versionHash(msg);
}

/**
 * Round 8 — markDirty now RE-ENQUEUES the message via the live store
 * snapshot. Previously it only invalidated the dedup, which was
 * useless: nothing called mirrorMessage afterwards, so status flips,
 * reaction updates, retract-token assignment, and removals never
 * reached the server. Restored chats showed every outbound message
 * stuck at 'sending', no reactions, no retract capability.
 *
 * The new behaviour: drop every cached version for this messageId
 * AND read the current LocalMessage from the store and push it onto
 * the queue. Lazy require breaks the store ↔ backup circular dep.
 */
/**
 * B-81 — rows still waiting in the outbox (messages + conversations). The
 * repair flow checks this AFTER drainMirrorOutbox: a non-empty outbox means
 * the drain bailed (flaky network) and signing now would commit a root over
 * a half-overwritten server set.
 */
export function mirrorOutboxSize(): number {
  return queue.length + convQueue.size;
}

/**
 * B-81 — drop EVERY dedup key for an owner so a follow-up `backupNow` walk
 * re-enqueues the owner's full local history (fresh AES-GCM wrap + upsert per
 * row). Used by the backup-repair flow: when the server's row bytes have
 * drifted from the last signed commit (equal-count `root_mismatch`), the
 * honest reconciliation is to overwrite the server rows with LOCAL truth and
 * re-sign — never to re-sign the server's bytes as-is.
 */
export function clearMirrorDedupForOwner(ownerUserId: string): void {
  const prefix = `${ownerUserId}:`;
  for (const k of seenIds) {
    if (k.startsWith(prefix)) {seenIds.delete(k);}
  }
}

export function markDirty(ownerUserId: string, messageId: string): void {
  // Strip every entry whose key starts with this ownerUserId:messageId:
  const prefix = `${ownerUserId}:${messageId}:`;
  for (const k of seenIds) {
    if (k.startsWith(prefix)) {seenIds.delete(k);}
  }
  // Legacy un-versioned keys from earlier sessions.
  seenIds.delete(`${ownerUserId}:${messageId}`);

  if (!enabled) {return;}
  if (mirrorOwnerUserId && mirrorOwnerUserId !== ownerUserId) {return;}

  // Round 8 — fetch the live message and re-enqueue it.
  try {
    const {useMessengerStore} = require('../store/messengerStore') as
      typeof import('../store/messengerStore');
    const state = useMessengerStore.getState();
    let found: LocalMessage | undefined;
    for (const list of Object.values(state.messages)) {
      const hit = list.find(m => m.id === messageId);
      if (hit) {found = hit; break;}
    }
    if (found) {
      // Use mirrorMessage so the version-hash dedup gate still holds
      // (idempotent across many markDirty calls between flushes).
      mirrorMessage(ownerUserId, found);
    } else {
      // Removed locally but we weren't handed the row details (a dirty
      // nudge racing a concurrent removal). Emit a best-effort tombstone
      // through the shared, deduped path. The authoritative removal path
      // (store.removeMessage → mirrorRemoval) carries the real
      // conversation_id + created_at.
      mirrorRemoval(ownerUserId, {id: messageId, conversation_id: '', created_at: new Date().toISOString()});
    }
  } catch {
    /* store not ready yet — safe no-op */
  }
}

/**
 * H-3 — enqueue a removal tombstone (status='deleted') so a restore
 * doesn't resurrect a message the user deleted (incl. "delete for
 * everyone"). Called from store.removeMessage AFTER the commit with the
 * real conversation_id + created_at. Deduped per (owner,id) so repeated
 * removals don't flood the queue, and any queued LIVE version of the
 * same id is stripped first so the tombstone isn't shadowed.
 */
export function mirrorRemoval(
  ownerUserId: string,
  msg: {id: string; conversation_id: string; created_at: string},
): void {
  if (!enabled) {
    if (!warnedNoKey) {
      console.log('[mirror] disabled — backup not unlocked this session');
      warnedNoKey = true;
    }
    return;
  }
  if (!ownerUserId || !msg.id) {return;}
  if (mirrorOwnerUserId && mirrorOwnerUserId !== ownerUserId) {return;}
  // Strip any queued/deduped live versions for this id so a same-tick
  // live enqueue can't shadow the tombstone.
  const prefix = `${ownerUserId}:${msg.id}:`;
  for (const k of seenIds) {
    if (k.startsWith(prefix)) {seenIds.delete(k);}
  }
  // B-94 — '__deleted__' doubles as the ledger version for tombstones,
  // so a boot sweep after the flush doesn't re-enqueue the removal.
  const tombKey = `${ownerUserId}:${msg.id}:__deleted__`;
  if (seenIds.has(tombKey)) {return;}   // already tombstoned this session
  seenIds.add(tombKey);
  const tombstone: LocalMessage = {
    id:              msg.id,
    conversation_id: msg.conversation_id || '',
    sender_id:       '',
    type:            'text',
    content:         '',
    status:          'deleted' as LocalMessage['status'],
    is_encrypted:    false,
    created_at:      msg.created_at || new Date().toISOString(),
    peer:            {userId: '', deviceId: 1},
  } as LocalMessage;
  queue.push({ownerUserId, msg: tombstone, version: '__deleted__'});
  scheduleFlush();
}

/**
 * Audit fix #30 — quick FNV-1a 32-bit hash of the serialized message
 * shape. Cheap (no async crypto), good enough to disambiguate "same
 * message, different state" inside one in-memory dedup window.
 * Collisions cost an unnecessary re-mirror; not a security boundary.
 */
function versionHash(msg: LocalMessage): string {
  const json = JSON.stringify(serializeMessage(msg));
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function mirrorConversation(ownerUserId: string, conv: LocalConversation, groupState?: GroupState): void {
  if (!enabled) {return;}
  if (!ownerUserId || !conv.id) {return;}
  if (mirrorOwnerUserId && mirrorOwnerUserId !== ownerUserId) {return;}
  // De-dup by id — the latest snapshot wins.
  convQueue.set(`${ownerUserId}:${conv.id}`, {ownerUserId, conv, groupState});
  scheduleConvFlush();
}

function scheduleFlush(): void {
  if (flushTimer) {return;}
  flushTimer = setTimeout(() => { void flush(); }, FLUSH_DEBOUNCE_MS);
}

function scheduleConvFlush(): void {
  if (convFlushTimer) {return;}
  convFlushTimer = setTimeout(() => { void flushConversations(); }, FLUSH_DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (queue.length === 0) {return;}
  if (!masterKey) {return;}

  // Group by owner so we can ship a single POST per user.
  const byOwner = new Map<string, Pending[]>();
  while (queue.length > 0 && (byOwner.size === 0 || sumValues(byOwner) < MAX_BATCH)) {
    const item = queue.shift();
    if (!item) {break;}
    const list = byOwner.get(item.ownerUserId) ?? [];
    list.push(item);
    byOwner.set(item.ownerUserId, list);
  }

  for (const [ownerId, items] of byOwner) {
    try {
      const rows = await Promise.all(items.map(async ({msg}) => {
        // Audit P0-B4 — outer-row metadata blinding. Use the v3
        // serializer so sender_id / recipient_id / conversation_id /
        // msg_type ship as a single opaque sentinel; the real values
        // are kept ONLY inside the encrypted payload. ciphertext_type
        // becomes 3. The DB schema's NOT NULL columns are satisfied
        // by the sentinel string.
        const v3 = serializeMessageForBackup(msg);
        const {key: subkey, raw: subkeyRaw} = await generateSubkey();
        // M-3 — bind BOTH the payload and the wrapped subkey to
        // (owner, message_id). A server that swaps a (ciphertext,
        // wrappedSubkey) pair into a different row's slot yields tags
        // that no longer verify under the target row's AAD, so the swap
        // is rejected on restore instead of silently accepted.
        const aadMsg = backupAad('msg', ownerId, v3.message_id);
        const wrappedPayload = await aesGcmEncrypt(subkey, new TextEncoder().encode(v3.payloadJson), aadMsg);
        const wrappedSubkey = await aesGcmEncrypt(masterKey!, subkeyRaw, aadMsg);
        subkeyRaw.fill(0);
        return {
          message_id:      v3.message_id,
          conversation_id: v3.conversation_id,
          sender_id:       v3.sender_id,
          recipient_id:    v3.recipient_id,
          msg_type:        v3.msg_type,
          ciphertext:      toB64(wrappedPayload),
          ciphertext_type: v3.ciphertext_type,
          envelope_meta:   {
            // Audit P0-B4 — `has_reactions` removed from plaintext
            // envelope_meta; it leaked which messages had reactions,
            // letting an attacker reconstruct partial conversation
            // activity from a server snapshot. Receivers reconstruct
            // the reactions array from the decrypted payload anyway.
            // (`expires_at` was already removed in Round 8 for the
            // same reason.)
            wrappedSubkey: toB64(wrappedSubkey),
          },
          msg_created_at:  v3.msg_created_at,
        };
      }));
      await backupClient.putMessages(rows);
      console.log(`[bravo.backup.mirror] flushed ${rows.length} messages`);
      // B-94 — the server bytes just changed, so (1) bump the flush epoch
      // (an in-flight commit walk must NOT clear the pending flag over
      // them), (2) persist which versions the server now holds so the
      // next boot sweep skips them, (3) raise the pending-commit flag so
      // a kill before the debounced commit is healed at next boot.
      bumpFlushEpoch();
      try {
        await recordFlushedVersions(
          ownerId,
          items.map(({msg, version}) => ({messageId: msg.id, version})),
        );
        await setMerkleCommitPending(ownerId);
      } catch { /* best-effort — degraded = pre-B-94 re-upload behaviour */ }
      scheduleMerkleHook();
    } catch (e) {
      const kind = e instanceof BackupError ? e.kind : 'network';
      // M-16 — treat auth/lockout as retry-later (requeue), not drop:
      // the batch is still valid; the token refreshes / lockout expires.
      const retryable = kind === 'network' || kind === 'server' || kind === 'unauthorized' || kind === 'locked';
      if (retryable) {
        for (const item of items) {queue.push(item);}
        if (queue.length > MAX_QUEUE_SIZE) {
          // Round 8 — drop the NEWEST entries instead of the oldest.
          // The OLDEST messages are the ones the user can least afford to
          // lose; the newest tail lives durably in SQLCipher and the
          // catch-up sweep re-mirrors it.
          const drop = queue.length - MAX_QUEUE_SIZE;
          const dropped = queue.splice(MAX_QUEUE_SIZE, drop);
          // H-7 — remove the dropped entries' dedup keys. They were added
          // at enqueue time; leaving them made the overflow catch-up
          // sweep (which re-enqueues via mirrorMessage) a NO-OP, so the
          // dropped rows were lost for the rest of the session. Clearing
          // the keys lets the sweep re-mirror them from SQLCipher.
          clearDedupForItems(dropped);
          surfaceBackupBehind(true);
          console.warn(`[mirror] queue overflow — dropped ${drop} newest entries; backup behind`);
          if (catchUpSweep) {
            // Fire-and-forget; setTimeout-deferred so we don't reenter
            // flush while still inside the current flush's microtask.
            setTimeout(() => {
              void catchUpSweep!().catch(err =>
                console.warn('[mirror] overflow-triggered catch-up sweep failed:', (err as Error).message));
            }, 1_000);
          }
        }
        scheduleFlushRetry();
      } else {
        // Genuinely non-retryable for this row right now (e.g. no_backup /
        // service_disabled). Drop the batch BUT clear its dedup keys so a
        // later catch-up sweep can re-attempt from the durable store —
        // otherwise the keys pin the rows out of the backup forever.
        clearDedupForItems(items);
        console.warn('[mirror] flush failed (dropped, dedup cleared):', (e as Error).message);
      }
    }
  }
  if (queue.length === 0) {surfaceBackupBehind(false);}
  if (queue.length > 0) {scheduleFlush();}
}

/**
 * B-45 R3 — synchronously drain BOTH outbox queues (messages +
 * conversations), bypassing the debounce timers. Used by the backup-setup
 * flow so the baseline Merkle commit signs the set that actually reached
 * the server — `backupNow()` only ENQUEUES, and committing while flushes
 * were still in flight signed a near-empty baseline (live evidence:
 * committed=3 vs server=14), bricking every later restore.
 *
 * `flush()` handles ≤ MAX_BATCH rows per call and re-queues on retryable
 * errors, so loop until both queues are empty — bailing out if an
 * iteration makes no progress (persistent network failure: leave the rest
 * to the jittered retry machinery rather than spin).
 */
export async function drainMirrorOutbox(): Promise<void> {
  if (flushTimer) {clearTimeout(flushTimer); flushTimer = null;}
  if (convFlushTimer) {clearTimeout(convFlushTimer); convFlushTimer = null;}
  let guard = 0;
  while ((queue.length > 0 || convQueue.size > 0) && guard < 200) {
    const before = queue.length + convQueue.size;
    try { await flush(); } catch { /* logged inside flush */ }
    try { await flushConversations(); } catch { /* logged inside */ }
    guard += 1;
    if (queue.length + convQueue.size >= before) {break;}
  }
}

/**
 * H-7 — drop every dedup key for the given items so they can be
 * re-enqueued later (by the catch-up sweep or a fresh mutation). Clears
 * BOTH the version-hash keys (`owner:id:<version>`) and the tombstone key
 * (`owner:id:__deleted__`) by prefix.
 */
function clearDedupForItems(items: Pending[]): void {
  for (const {ownerUserId, msg} of items) {
    const prefix = `${ownerUserId}:${msg.id}:`;
    for (const k of seenIds) {
      if (k.startsWith(prefix)) {seenIds.delete(k);}
    }
  }
}

/** M-16 — jittered retry so many clients don't stampede the relay on recovery. */
function scheduleFlushRetry(): void {
  const delay = 5_000 + Math.floor(Math.random() * 3_000);
  setTimeout(() => scheduleFlush(), delay);
}

async function flushConversations(): Promise<void> {
  convFlushTimer = null;
  if (convQueue.size === 0) {return;}
  // Round 8 — snapshot then clear so a new mutation arriving DURING
  // the await doesn't lose its event. Failed entries get re-set into
  // the queue in the catch path.
  const snapshot = Array.from(convQueue.values());
  convQueue.clear();
  const byOwner = new Map<string, Array<{conv: LocalConversation; groupState?: GroupState}>>();
  for (const {ownerUserId, conv, groupState} of snapshot) {
    const list = byOwner.get(ownerUserId) ?? [];
    list.push({conv, groupState});
    byOwner.set(ownerUserId, list);
  }
  for (const [ownerUserId, items] of byOwner) {
    try {
      const rows = await Promise.all(items.map(async ({conv, groupState}) => {
        const t = conv.type as unknown as string;
        const kind: 'direct' | 'group' | 'system' =
          t === 'group' ? 'group' : t === 'system' ? 'system' : 'direct';
        let members: Array<{userId: string; displayName?: string}> = [];
        if (kind === 'group' && Array.isArray(conv.participants)) {
          members = conv.participants
            .filter((uid): uid is string => typeof uid === 'string' && uid.length > 0 && uid !== 'self')
            .map(uid => ({userId: uid}));
        } else if (conv.peer) {
          members = [{userId: conv.peer.userId, displayName: conv.name ?? undefined}];
        }
        // Audit P0-B5 — group_state is AES-GCM-encrypted under the
        // backup master key before it leaves the device. The plaintext
        // exposed groupId + member list + the GROUP MASTER KEY in raw
        // base64; anyone with DB read access could decrypt every
        // message ever sent in the group. With v3 the server stores
        // only ciphertext + a `v: 3` marker. Legacy plaintext blobs on
        // older accounts continue to deserialize via decryptGroupStateBlob.
        let groupStateOut: Record<string, unknown> | null = null;
        if (groupState && masterKey) {
          try {
            groupStateOut = (await encryptGroupStateBlob(
              masterKey,
              serializeGroupState(groupState),
              backupAad('group', ownerUserId, conv.id),
            )) as unknown as Record<string, unknown>;
          } catch (e) {
            console.warn('[mirror] group_state encrypt failed; dropping:', (e as Error).message);
            groupStateOut = null;
          }
        }
        return {
          conversation_id: conv.id,
          kind,
          name:            conv.name ?? null,
          members,
          last_message_at: (conv as unknown as {last_message_at?: string}).last_message_at ?? null,
          // Round 8 — round-trip the conversation-level UX state.
          is_muted:        conv.is_muted ?? false,
          is_pinned:       conv.is_pinned ?? false,
          default_ttl_sec: conv.default_ttl_sec ?? null,
          unread_count:    conv.unread_count ?? 0,
          is_custom_name:  conv.is_custom_name ?? false,
          // Audit P0-B5 — v3 envelope. Legacy plaintext shape decoded
          // by decryptGroupStateBlob via the legacy-passthrough branch.
          group_state:     groupStateOut,
        };
      }));
      await backupClient.putConversations(rows);
    } catch (e) {
      const kind = e instanceof BackupError ? e.kind : 'network';
      const retryable = kind === 'network' || kind === 'server' || kind === 'unauthorized' || kind === 'locked';
      if (retryable) {
        for (const {conv, groupState} of items) {
          const key = `${ownerUserId}:${conv.id}`;
          // F11 — do NOT clobber a newer snapshot that arrived during the
          // await (e.g. a mute toggle or group rekey). Only requeue the
          // failed one when nothing fresher is already pending; otherwise
          // the stale state would ship and overwrite the newer one.
          if (!convQueue.has(key)) {
            convQueue.set(key, {ownerUserId, conv, groupState});
          }
        }
        const delay = 5_000 + Math.floor(Math.random() * 3_000);
        setTimeout(() => scheduleConvFlush(), delay);
      } else {
        console.warn('[mirror] conv flush failed:', (e as Error).message);
      }
    }
  }
}

/**
 * Round 8 — serialize GroupState for the backup. The masterKeyB64 is
 * encrypted-at-rest under the master key (the conversation row goes
 * through Supabase, not the per-row subkey wrap). The data is INSIDE
 * the user's encrypted backup blob conceptually — but the conv table
 * hasn't migrated to subkey wrapping yet. We pass the JSON through
 * straight; the server cannot do anything with the master key without
 * the user's password (the row column is bytea-equivalent JSONB
 * inside the user's owner_user_id row, which the auth guard scopes).
 *
 * Phase 2 will wrap the group_state column with a per-row subkey
 * the same way messages_backup is wrapped today.
 */
function serializeGroupState(g: GroupState): Record<string, unknown> {
  return {
    groupId:      g.groupId,
    owner:        g.owner,
    members:      g.members,
    masterKeyB64: g.masterKeyB64,
    epoch:        g.epoch,
    name:         g.name,
  };
}

function sumValues<T>(m: Map<unknown, T[]>): number {
  let n = 0; for (const v of m.values()) {n += v.length;} return n;
}

/**
 * Audit fix #29 — surface a "backup behind" flag the UI can render.
 */
function surfaceBackupBehind(behind: boolean): void {
  try {
    const {useMessengerStore} = require('../store/messengerStore') as
      typeof import('../store/messengerStore');
    if (behind) {
      useMessengerStore.getState().setError('Backup is behind — some messages may be missing on restore');
    } else {
      const cur = useMessengerStore.getState().error;
      if (cur?.startsWith('Backup is behind')) {
        useMessengerStore.getState().setError(null);
      }
    }
  } catch { /* store not ready yet; safe to ignore */ }
}

function serializeMessage(msg: LocalMessage): Record<string, unknown> {
  // Round 8 — full-fidelity serialization. Previously omitted fields
  // (`media_key`, `media_iv`, `retract_token`) caused restored
  // attachments to render as broken bubbles and stripped the user's
  // ability to retract messages from a freshly-restored device.
  return {
    id:               msg.id,
    conversation_id:  msg.conversation_id,
    sender_id:        msg.sender_id,
    type:             msg.type,
    content:          msg.content,
    status:           msg.status,
    created_at:       msg.created_at,
    is_encrypted:     msg.is_encrypted,
    peer:             msg.peer,
    envelope_id:      msg.envelope_id,
    expires_at:       msg.expires_at,
    reply_to_msg_id:  msg.reply_to_msg_id,
    reply_to_preview: msg.reply_to_preview,
    reactions:        msg.reactions,
    call_meta:        msg.call_meta,
    media_object_key: msg.media_object_key,
    media_mime:       msg.media_mime,
    media_key:        msg.media_key,
    media_iv:         msg.media_iv,
    retract_token:    msg.retract_token,
  };
}
