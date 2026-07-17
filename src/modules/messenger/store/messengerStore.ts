import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist, createJSONStorage } from 'zustand/middleware';
import { current as immerCurrent } from 'immer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StateStorage } from 'zustand/middleware';
import type { LocalConversation, LocalMessage, MessageStatus } from './types';
import type { GroupState } from '@bravo/messenger-core';

/**
 * Audit fix #13 — debounced AsyncStorage adapter.
 *
 * The persist middleware's `partialize` returns `{_ownUserId,
 * vaultByOwner}` — which can be multi-MB once a user accumulates a few
 * hundred conversations across multiple owners. zustand persist runs
 * setItem on every state mutation, so a busy chat session was paying
 * a JSON.stringify of the entire vault per keystroke (typing
 * indicators, message status flips). On low-end Android this stutters
 * the UI thread.
 *
 * The fix coalesces writes inside a 500 ms window: every setItem
 * resets the timer, and the actual flush happens once the user pauses.
 * Reads + removes go through immediately (rare anyway). The trade-off
 * is up to 500 ms of durability loss on a hard kill — acceptable
 * because messages live in SQLCipher (sqlMessageStore), not in this
 * AsyncStorage slice; the only thing at risk is the conversations /
 * groups vault which the next online tick will reconstitute from the
 * server-authoritative /conversations/mine call anyway.
 */
function makeDebouncedAsyncStorage(delayMs: number): StateStorage {
  let pendingKey: string | null = null;
  let pendingValue: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (pendingKey === null || pendingValue === null) {return;}
    const k = pendingKey;
    const v = pendingValue;
    pendingKey = null;
    pendingValue = null;
    void AsyncStorage.setItem(k, v).catch(e => {
      console.warn('[messengerStore] debounced persist failed', e);
    });
  };

  return {
    getItem: (name: string) => AsyncStorage.getItem(name),
    setItem: (name: string, value: string) => {
      pendingKey = name;
      pendingValue = value;
      if (timer) {clearTimeout(timer);}
      timer = setTimeout(flush, delayMs);
    },
    removeItem: async (name: string) => {
      if (pendingKey === name) {
        pendingKey = null;
        pendingValue = null;
        if (timer) {clearTimeout(timer); timer = null;}
      }
      await AsyncStorage.removeItem(name);
    },
  };
}

const PERSIST_DEBOUNCE_MS = 500;

/**
 * Audit P1-N20 — stable comparator: created_at ascending, with `id`
 * as the tie-break for equal timestamps. Without the tie-break, two
 * rapid-fire sends on the same millisecond would flip order on every
 * sort (V8's sort is no longer stable in all paths once the array
 * crosses ~10 elements). `id` is a random suffix so the resulting
 * order isn't meaningful in time — it's just consistent.
 */
const byCreatedAtThenId = (a: LocalMessage, b: LocalMessage): number => {
  if (a.created_at !== b.created_at) {return a.created_at < b.created_at ? -1 : 1;}
  if (a.id === b.id) {return 0;}
  return a.id < b.id ? -1 : 1;
};

/**
 * In-memory Zustand store for the messenger UI. SQLCipher persistence
 * is wired in separately by the runtime layer — this store is the fast
 * read path for ChatScreen and MessengerHomeScreen. When the runtime
 * hydrates from disk at boot it replays into this store via setAll().
 */

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unauthorized'
  // B-11 — this device was evicted by a newer session on the same
  // account (single-device takeover). Mirrors TransportState.
  | 'superseded';

interface MessengerState {
  /** The userId who owns these conversations. Used to detect user-switch
   * at boot and wipe stale data from the previous session. */
  _ownUserId: string | null;
  conversations: Record<string, LocalConversation>;
  conversationOrder: string[];
  messages: Record<string, LocalMessage[]>;
  /** currently foregrounded conversationId — used to suppress unread increments */
  activeConversationId: string | null;
  /** ephemeral typing indicators keyed by conversationId */
  typing: Record<string, boolean>;
  /**
   * Presence per peer (populated in M11). The wire protocol carries four
   * states (`online | active | away | offline`); we preserve them all so
   * the UI can distinguish "active now" (interacting), "online" (just
   * connected), and "away" (idle / backgrounded). `online` is kept as a
   * derived boolean for back-compat with existing consumers — true for
   * `online | active | away`, false for `offline`.
   *
   * The `lastSeen` alias mirrors `lastSeenMs` so older readers keep
   * working without changes.
   */
  presence: Record<string, {
    state:       'online' | 'active' | 'away' | 'offline';
    online:      boolean;
    lastSeen?:   number;
    lastSeenMs?: number;
  }>;
  /** live transport state — drives the connection banner in chat headers */
  connection: ConnectionState;
  ready: boolean;
  error: string | null;
  /**
   * Soft, non-fatal recovery banner — separate slot from `error` so a
   * transient identity-rotation hint ("rebuilding session …") doesn't
   * clobber a live red error banner (e.g. WS unauthorized) and vice
   * versa. Surfaces in the chat header next to / below the error
   * banner. Cleared by the runtime when the recovery completes.
   */
  recoveryBanner: string | null;
  /**
   * B-46 — count of envelopes this device DESTROYED because the outer
   * sealed wrap couldn't be opened (sealed to a previous identity:
   * reinstall / cleared data / failed restore). Sealed sender means the
   * sender is unknowable here, so no per-conversation placeholder is
   * possible — this counter drives the one-shot MessengerHome banner
   * ("N messages couldn't be decrypted — ask senders to resend").
   * Session-scoped (not persisted); cleared when the user dismisses.
   */
  undecryptableDropCount: number;
  /**
   * Per-group display-name overrides. Admin can rename a member's
   * shown name inside one group without affecting their profile or
   * other conversations: `{ [groupId]: { [userId]: displayName } }`.
   */
  groupMemberNames: Record<string, Record<string, string>>;
  /**
   * Per-group full state — membership, master key, epoch. Populated
   * from admin `create` / `add` / `remove` / `rekey` messages. The
   * masterKeyB64 field is the spec's "group master key shared via
   * pairwise Signal sessions" and is used to encrypt subsequent
   * group message bodies via AES-256-GCM. Persisted to the same
   * AsyncStorage as messages until SQLCipher message store lands.
   */
  groups: Record<string, GroupState>;
  /**
   * Per-user data vault. When the user switches accounts, the previous
   * owner's conversation list, conversation order, group state and
   * group-member-name overrides are saved here under their owner key
   * (email/phone) so re-login restores their thread list rather than
   * showing an empty inbox. Message bodies stay in SQLCipher (per-user
   * by `userId`-scoped DB filename); this vault holds only the lighter
   * AsyncStorage-resident slices.
   */
  vaultByOwner: Record<string, VaultSlice>;
}

interface VaultSlice {
  conversations:     Record<string, LocalConversation>;
  conversationOrder: string[];
  groups:            Record<string, GroupState>;
  groupMemberNames:  Record<string, Record<string, string>>;
}

interface MessengerActions {
  upsertConversation: (c: LocalConversation) => void;
  setActiveConversation: (id: string | null) => void;
  appendMessage: (conversationId: string, msg: LocalMessage) => void;
  updateMessageStatus: (conversationId: string, messageId: string, status: MessageStatus) => void;
  /** Flip many messages in one conversation in ONE store commit — the write-through subscriber diffs the whole store per commit, so per-message flips are O(N·M). */
  updateMessageStatusBulk: (conversationId: string, messageIds: readonly string[], status: MessageStatus) => void;
  updateMessageCiphertext: (conversationId: string, messageId: string, ciphertext: LocalMessage['ciphertext']) => void;
  /** Stash the relay's per-envelope retract capability token on the local message. */
  updateMessageRetractToken: (conversationId: string, messageId: string, token: string) => void;
  /** Backfill the relay's envelope id on an outbound message after accept. */
  updateMessageEnvelopeId: (conversationId: string, messageId: string, envelopeId: string) => void;
  removeMessage: (conversationId: string, messageId: string) => void;
  /** Drop every message in a conversation but keep the conversation row + name. */
  clearMessages: (conversationId: string) => void;
  updateMessageReactions: (conversationId: string, messageId: string, reactions: Record<string, string>) => void;
  /**
   * P2-12 — stamp the encrypted-attachment metadata onto an already-appended
   * bubble AFTER the upload completes. `sendMedia` appends an optimistic
   * bubble before the upload (so an upload failure has a durable failed
   * bubble), then patches the object key / per-file key+iv here so the row
   * mirrored to SQLCipher can be re-rendered/forwarded post-restore.
   */
  patchMessageMedia: (
    conversationId: string,
    messageId: string,
    fields: Partial<Pick<LocalMessage,
      'type' | 'media_mime' | 'media_object_key' | 'media_key' | 'media_iv' | 'media_meta'>>,
  ) => void;
  /** Toggle per-conversation mute — suppresses push + unread badge bumps. */
  setConversationMuted: (conversationId: string, muted: boolean) => void;
  /** Pin/unpin a conversation so it floats to the top of the list. */
  setConversationPinned: (conversationId: string, pinned: boolean) => void;
  /** Remove a conversation from the local list (does not delete history on peer). */
  removeConversation: (conversationId: string) => void;
  setTyping: (conversationId: string, typing: boolean) => void;
  /** Set or clear an admin-assigned display name for a member inside one group. */
  setGroupMemberName: (groupId: string, userId: string, name: string | null) => void;
  /** Set the conversation-level default disappearing-message TTL. */
  setConversationTtl: (conversationId: string, ttlSec: number | null) => void;
  /**
   * Update presence for a peer. Accepts the full server state — callers
   * that only know `online: bool` can pass `'online'` or `'offline'`.
   * Both `online` (boolean) and `lastSeen` are derived/aliased for
   * back-compat with consumers that haven't migrated to `state`.
   */
  setPresence: (
    userId: string,
    state: 'online' | 'active' | 'away' | 'offline',
    lastSeenMs?: number,
  ) => void;
  /**
   * Mark a list of peers offline without touching their `lastSeen`.
   * Used when the runtime stops receiving presence frames for a peer
   * (unsubscribe, socket reconnect): keeping the last-known `online`
   * value would pin a phantom green dot forever. We flip to `offline`
   * rather than deleting so consumers reading `presence[uid].state`
   * never see `undefined`.
   */
  clearPresence: (userIds: string[]) => void;
  /**
   * Wipe the entire presence map. Used on logout/owner-switch, where
   * any cached presence belongs to the previous user. Distinct from
   * `clearPresence` so reconnect paths can't accidentally nuke peers
   * we still want to track.
   */
  clearAllPresence: () => void;
  setConnection: (state: ConnectionState) => void;
  setReady: (ready: boolean) => void;
  setError: (error: string | null) => void;
  /** Soft recovery banner — see `recoveryBanner` on state. Pass null to clear. */
  setRecoveryBanner: (msg: string | null) => void;
  /**
   * B-46 — record one destroyed (undecryptable-outer) envelope. Deduped
   * by envelopeId so a WS-deliver / drain race on the same envelope
   * can't double-count.
   */
  noteUndecryptableDrop: (envelopeId: string) => void;
  /** B-46 — user dismissed the banner. */
  clearUndecryptableDrops: () => void;
  reset: () => void;
  /** Called by configureMessengerRuntime — clears stale data if a different user logs in. */
  setOwner: (userId: string) => void;
  /** Replace a group's full state (used on admin create + rekey). */
  setGroupState: (state: GroupState) => void;
  /** Drop a group entirely (member removed themselves, etc.). */
  removeGroupState: (groupId: string) => void;
  /**
   * Bulk replace the in-memory messages map. Used at runtime boot
   * after hydrating from SQLCipher so the UI paints with full
   * persisted history rather than the AsyncStorage-cached subset.
   *
   * Audit fix #16 — capped at MAX_HYDRATE_PER_CONVO most-recent
   * messages per conversation so a chat with 50 000 historical
   * messages doesn't lock the UI thread on boot serializing them all
   * into immer drafts. The runtime exposes `loadOlderMessages` for
   * the pagination path.
   *
   * Restore-after-reinstall fix: `bypassCap=true` keeps the FULL set
   * in memory. The boot-time cap is a UI-thread protection that's
   * load-bearing on cold start, but during restore the user is on a
   * progress screen and explicitly waiting — silently truncating to
   * 200 most-recent per conversation made restored chats look like
   * they only kept the tail. Restore now hydrates everything; the
   * next cold boot re-applies the cap from SQLCipher (loadRecent),
   * and the chat's scroll-back path pages older history on demand.
   */
  hydrateMessages: (map: Record<string, LocalMessage[]>, bypassCap?: boolean) => void;
  /**
   * Audit fix #16 — prepend a page of older messages to a conversation.
   * Used by the chat scroll-back path. Caller is responsible for
   * fetching `before`-bounded rows from sqlMessageStore.
   */
  prependOlderMessages: (conversationId: string, older: LocalMessage[]) => void;
}

/**
 * Audit fix #16 — at-rest cap for `hydrateMessages`. Loading every
 * persisted message at boot is fine for a few hundred rows but starts
 * to hurt visibly at ~5k messages per chat. 200 most-recent matches
 * what the user actually scrolls through on resume; older history
 * pages in via `loadOlderMessages` only if the user scrolls up.
 */
export const MAX_HYDRATE_PER_CONVO = 200;

/**
 * Audit fix #30 — wired hook into the backup mirror's dedup cache.
 *
 * Every store action that mutates an existing message (status flip,
 * reactions, retract token, removal) calls notifyBackupDirty so the
 * mirror's `markDirty(owner, msgId)` runs on the next tick. Lazy
 * import avoids a circular dep between store ↔ backup. The mirror
 * pulls the live `_ownUserId` itself; we just nudge it with the
 * messageId.
 */
function notifyBackupDirty(messageId: string): void {
  try {
    const owner = useMessengerStore.getState()._ownUserId;
    if (!owner) {return;}
    const {markDirty} = require('../backup/messageMirror') as
      typeof import('../backup/messageMirror');
    markDirty(owner, messageId);
  } catch { /* mirror not loaded — safe no-op */ }
}

/**
 * H-3 — explicit removal notification. Unlike notifyBackupDirty, this
 * carries the removed row's real conversation_id + created_at so the
 * mirror ships a well-formed tombstone (status='deleted'). It MUST be
 * called AFTER the immer commit — calling it inside the recipe made
 * markDirty read the pre-commit state, find the still-present row, and
 * re-mirror it as a LIVE message, so the tombstone was never sent and
 * restores resurrected "deleted for everyone" messages.
 */
function notifyBackupRemoved(messageId: string, conversationId: string, createdAt: string): void {
  try {
    const owner = useMessengerStore.getState()._ownUserId;
    if (!owner) {return;}
    const {mirrorRemoval} = require('../backup/messageMirror') as
      typeof import('../backup/messageMirror');
    mirrorRemoval(owner, {id: messageId, conversation_id: conversationId, created_at: createdAt});
  } catch { /* mirror not loaded — safe no-op */ }
}

/**
 * Audit P0-S3 / P0-S5 — pluggable sink for the on-disk wrapped
 * group-key store. The runtime registers the SQLCipher-backed
 * GroupMasterKeyStore at boot; the messenger store calls it from
 * `setGroupState` / `removeGroupState` so the wrapped row stays in
 * sync with the in-memory `s.groups[gid].masterKeyB64`.
 *
 * The sink is module-scoped (not in Zustand state) because:
 *   - Zustand state should hold serializable data only; a SQLCipher
 *     handle and an imported WebCrypto key are neither.
 *   - We want the AsyncStorage partialize to remain dumb — it strips
 *     masterKeyB64 unconditionally, regardless of whether the sink
 *     is wired yet (loopback dev mode skips the sink, and that's fine
 *     because there's no SQLCipher to write to anyway).
 *
 * Registration is idempotent + replaceable. The runtime wires it
 * inside buildProductionRuntime; on logout, `clearGroupMasterKeySink`
 * removes it so a stray late mutation doesn't write under the
 * previous user's wrap key.
 */
interface GroupMasterKeySink {
  setKey(groupId: string, masterKeyB64: string): Promise<void>;
  deleteKey(groupId: string): Promise<void>;
}
let groupMasterKeySink: GroupMasterKeySink | null = null;
export function registerGroupMasterKeySink(sink: GroupMasterKeySink): void {
  groupMasterKeySink = sink;
}
export function clearGroupMasterKeySink(): void {
  groupMasterKeySink = null;
}

const initialState: MessengerState = {
  _ownUserId: null,
  conversations: {},
  conversationOrder: [],
  messages: {},
  activeConversationId: null,
  typing: {},
  presence: {},
  connection: 'disconnected',
  ready: false,
  error: null,
  recoveryBanner: null,
  undecryptableDropCount: 0,
  groupMemberNames: {},
  groups: {},
  vaultByOwner: {},
};

// B-46 — envelopeIds already counted toward `undecryptableDropCount`,
// so a WS-deliver / HTTP-drain race on the same envelope is one drop.
// Module-level (not in immer state): it's a dedup guard, not UI data.
const countedUndecryptableDrops = new Set<string>();
const COUNTED_DROPS_CAP = 512;

export const useMessengerStore = create<MessengerState & MessengerActions>()(
  persist(
    immer(set => ({
    ...initialState,

    upsertConversation: c =>
      set(s => {
        const existed = !!s.conversations[c.id];
        s.conversations[c.id] = c;
        if (!existed) {s.conversationOrder.unshift(c.id);}

        // B-18 — when /conversations/mine syncs a server-UUID direct row
        // for a peer that already has a synthetic `direct:<peer>` row,
        // MERGE the synthetic slot into this canonical one. Why: the
        // inbound-append reroute (see appendMessage) only catches NEW
        // messages once the UUID row exists; history that accumulated in
        // the synthetic slot BEFORE the sync would otherwise strand there,
        // leaving the home list with two rows for one peer — the stale
        // synthetic one showing "(encrypted)" — and split-braining the
        // thread until the next append. Fold the messages + last_message +
        // unread into the UUID row and drop the synthetic row so there is
        // exactly one canonical 1:1 thread per peer.
        const peerUid = c.type === 'direct' ? c.peer?.userId : undefined;
        if (peerUid && !c.id.startsWith('direct:')) {
          const synthId = `direct:${peerUid}`;
          if (synthId !== c.id && s.conversations[synthId]) {
            const synthMsgs = s.messages[synthId] ?? [];
            if (synthMsgs.length) {
              if (!s.messages[c.id]) {s.messages[c.id] = [];}
              const dest = s.messages[c.id];
              const seenId  = new Set(dest.map(m => m.id));
              const seenEnv = new Set(dest.map(m => m.envelope_id).filter(Boolean));
              for (const m of synthMsgs) {
                if (seenId.has(m.id)) {continue;}
                if (m.envelope_id && seenEnv.has(m.envelope_id)) {continue;}
                dest.push({...m, conversation_id: c.id});
              }
              dest.sort((a, b) =>
                a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
              );
              const last = dest[dest.length - 1];
              const dst = s.conversations[c.id];
              if (last && (!dst.last_message || dst.last_message.created_at <= last.created_at)) {
                dst.last_message = last;
              }
            }
            const synthConvo = s.conversations[synthId];
            if (synthConvo && s.activeConversationId !== c.id) {
              s.conversations[c.id].unread_count =
                (s.conversations[c.id].unread_count ?? 0) + (synthConvo.unread_count ?? 0);
            }
            delete s.messages[synthId];
            delete s.conversations[synthId];
            const oi = s.conversationOrder.indexOf(synthId);
            if (oi >= 0) {s.conversationOrder.splice(oi, 1);}
          }
        }
      }),

    setActiveConversation: id =>
      set(s => {
        s.activeConversationId = id;
        if (!id) {return;}
        const active = s.conversations[id];
        if (active) {active.unread_count = 0;}
        // L20 — a 1:1 thread can transiently exist under two slots for the
        // same peer: the synthetic `direct:<peer>` row (push-tap / incoming
        // -call deep link) and the canonical server-UUID row. Opening either
        // must clear the badge on BOTH, otherwise the home list keeps an
        // unread count on the sibling slot the user didn't tap. Resolve the
        // peer and zero every direct slot that maps to it.
        const peerUid =
          active?.type === 'direct'
            ? active.peer?.userId
            : id.startsWith('direct:')
              ? id.slice('direct:'.length)
              : undefined;
        if (!peerUid) {return;}
        const synthId = `direct:${peerUid}`;
        if (s.conversations[synthId]) {s.conversations[synthId].unread_count = 0;}
        for (const cid of Object.keys(s.conversations)) {
          const c = s.conversations[cid];
          if (c?.type === 'direct' && c.peer?.userId === peerUid) {c.unread_count = 0;}
        }
      }),

    appendMessage: (conversationId, msg) =>
      set(s => {
        if (!s.messages[conversationId]) {s.messages[conversationId] = [];}
        // Audit P0-T4 — dedup by both `id` AND `envelope_id`. The
        // crypto-layer `seenEnvelopeStore` (P0-N6) suppresses redundant
        // ratchet advances on reconnect-flush, but the UI path mints a
        // fresh local `id` per decode so two passes through the same
        // envelope would otherwise push two bubbles into the list. We
        // skip the second push so a reconnect storm doesn't render
        // duplicates even if the receive pipeline re-enters the append
        // before the seen-set guard has committed.
        //
        // Audit P2-N4 — content-bound dedup gate. The group fan-out's
        // `clientMsgId` is sender-supplied (see groupClient.broadcastToGroup
        // line 128 `genId()`), so a malicious sender could ship two
        // DIFFERENT bodies under one clientMsgId; the second body would
        // hit the `m.id === msg.id` check and silently drop. We now
        // also compare `(sender_id, content)` for the matching id —
        // if the content differs the second is treated as a NEW message
        // (different local id minted at decode, see receive path).
        // For same-content replays the existing id/envelope_id check
        // still fires first.
        const list = s.messages[conversationId];
        const collision = list.find(m => m.id === msg.id);
        if (collision) {
          if (collision.sender_id === msg.sender_id && collision.content === msg.content) {return;}
          // Content diverges — emerge as a fresh row with a derived id
          // so both bodies are visible. Recipient can flag the sender
          // for inconsistency; we prefer over-rendering to silent loss.
          msg = {...msg, id: `${msg.id}#${list.length}`};
        }
        if (msg.envelope_id && list.some(m => m.envelope_id === msg.envelope_id)) {return;}
        // L18 GROUP-DRAIN-RECEIVE-TIME-ORDERING — keep send-order even for a
        // late insert. The common case appends to the end (created_at >= tail);
        // only an OUT-OF-ORDER row (a stashed no_key group message draining
        // after newer messages, carrying its real send-time created_at) is
        // binary-spliced into its chronological slot so it doesn't render at
        // the bottom. The fast append path is unchanged.
        const tail = list[list.length - 1];
        if (tail && msg.created_at < tail.created_at) {
          let lo = 0;
          let hi = list.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (list[mid].created_at <= msg.created_at) {lo = mid + 1;} else {hi = mid;}
          }
          list.splice(lo, 0, msg);
        } else {
          list.push(msg);
        }

        // Auto-create the conversation row if this is the first time we
        // hear about it. Without this, a message from someone who found
        // us via contact discovery (before we found them) lands in
        // `s.messages` but the conversation never appears in the chat
        // list because it's not in `s.conversations` / `s.conversationOrder`.
        //
        // Audit fix #14 — extend the shadow-create to GROUP conversations
        // too. The original code only handled `direct:` ids; if a group
        // text envelope races ahead of its admin.create (e.g. backup
        // restore order, missed-and-redelivered admin envelope), the
        // message body landed in `s.messages` but ChatScreen crashed
        // when it tried to read `conversations[groupId].name`. Place a
        // minimal placeholder row so navigation works; the real group
        // metadata patches over it as soon as the admin.create lands.
        let convo = s.conversations[conversationId];
        if (!convo && conversationId.startsWith('direct:') && msg.peer && msg.sender_id !== 'self') {
          // Why: before shadow-creating a synthetic `direct:<peer>` row,
          // check if a server-UUID row already exists for the same peer
          // (from /conversations/mine sync). Without this guard the
          // home list ends up with TWO rows for the same peer — the
          // server-UUID one (which the user sees + taps) and the
          // synthetic one (which is where messages actually land but
          // never gets seen). Production runtime's inbound routing
          // already prefers the server-UUID when found, so this branch
          // should only fire on first-contact-before-sync.
          const peerId = conversationId.slice('direct:'.length);
          let serverRowId: string | undefined;
          for (const [id, existing] of Object.entries(s.conversations)) {
            if (existing.type === 'direct' && existing.peer?.userId === peerId && !id.startsWith('direct:')) {
              serverRowId = id;
              break;
            }
          }
          if (serverRowId) {
            // Re-route this message to the server-UUID slot. Update the
            // msg's conversation_id so SQLite persistence + downstream
            // selectors all agree.
            const rerouted = {...msg, conversation_id: serverRowId};
            if (!s.messages[serverRowId]) {s.messages[serverRowId] = [];}
            const serverList = s.messages[serverRowId];
            if (!serverList.some(m => m.id === rerouted.id || (rerouted.envelope_id && m.envelope_id === rerouted.envelope_id))) {
              serverList.push(rerouted);
            }
            // Drop the duplicate push into the synthetic slot we just
            // made above appendMessage's main `list.push(msg)`. We
            // already pushed there; remove it.
            const idx = list.findIndex(m => m.id === msg.id);
            if (idx >= 0) {list.splice(idx, 1);}
            // Also bump the server row's metadata + ordering.
            const serverConvo = s.conversations[serverRowId];
            if (serverConvo) {
              serverConvo.last_message = rerouted;
              if (s.activeConversationId !== serverRowId) {serverConvo.unread_count += 1;}
              const oi = s.conversationOrder.indexOf(serverRowId);
              if (oi > 0) {
                s.conversationOrder.splice(oi, 1);
                s.conversationOrder.unshift(serverRowId);
              }
            }
            return;
          }
          // Friendlier placeholder than a bare UUID prefix. The Home
          // screen runs a passive contact-discovery sweep (see
          // useDiscoveredContacts({passive:true})) which will overwrite
          // this label with the user's saved contact name as soon as
          // it pairs the peer's phone number to an address-book entry.
          // For peers we don't have in contacts the row stays as
          // "Bravo · abcd1234" so the user can still recognise it as
          // an inbound message from a Bravo account, not a cryptic
          // hex string.
          const shortId = peerId.slice(0, 8);
          convo = {
            id:             conversationId,
            type:           'direct',
            name:           `Bravo · ${shortId}`,
            participants:   [peerId],
            peer:           msg.peer,
            session_state:  'established',
            unread_count:   0,
            is_muted:       false,
            created_at:     msg.created_at,
          };
          s.conversations[conversationId] = convo;
          if (!s.conversationOrder.includes(conversationId)) {
            s.conversationOrder.unshift(conversationId);
          }
        } else if (!convo && !conversationId.startsWith('direct:') && msg.sender_id !== 'self') {
          // Non-direct id with no existing row → assume group placeholder.
          // ChatScreen reads conversations[id] for name + participants;
          // a missing row means a JS crash on render. Stamp a stub.
          convo = {
            id:             conversationId,
            type:           'group',
            name:           'Group chat',
            participants:   msg.peer ? [msg.peer.userId] : [],
            // The carry-over `peer` field is required by LocalConversation;
            // for groups the legitimate routing is per-member fan-out so
            // this is just a placeholder to satisfy the schema.
            peer:           msg.peer ?? {userId: '', deviceId: 1},
            session_state:  'fresh',
            unread_count:   0,
            is_muted:       false,
            created_at:     msg.created_at,
          };
          s.conversations[conversationId] = convo;
          if (!s.conversationOrder.includes(conversationId)) {
            s.conversationOrder.unshift(conversationId);
          }
        }

        if (convo) {
          convo.last_message = msg;
          // BS-MUTE-UNREAD — a muted conversation must NOT bump its unread
          // badge (the store's documented contract). Inbound messages still
          // append + reorder, just without inflating the badge.
          if (msg.sender_id !== 'self' && s.activeConversationId !== conversationId && !convo.is_muted) {
            convo.unread_count += 1;
          }
          const idx = s.conversationOrder.indexOf(conversationId);
          if (idx > 0) {
            s.conversationOrder.splice(idx, 1);
            // Audit MSG-12 (2026-07-02): insert AFTER the pinned prefix, not at
            // index 0. Unconditionally unshifting made any inbound message to
            // an unpinned chat jump ABOVE pinned chats (Home renders the raw
            // conversationOrder). A pinned conversation still moves to the top
            // of the pinned block via setConversationPinned's reorder.
            let insertAt = 0;
            if (!s.conversations[conversationId]?.is_pinned) {
              while (insertAt < s.conversationOrder.length &&
                     s.conversations[s.conversationOrder[insertAt]]?.is_pinned) {
                insertAt++;
              }
            }
            s.conversationOrder.splice(insertAt, 0, conversationId);
          }
        }
        // BS-TY2 — clear any "typing…" flag for this conversation the
        // moment a real message lands. A peer who sends without a
        // trailing `stop` frame (common when the app backgrounds
        // mid-type) would otherwise leave the bubble stuck "typing…"
        // even though their message is already in the thread. Only
        // clear for an INBOUND message (our own send never reflects the
        // peer's typing state).
        if (msg.sender_id !== 'self' && s.typing[conversationId]) {
          s.typing[conversationId] = false;
        }
      }),

    updateMessageStatus: (conversationId, messageId, status) =>
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (msg) {msg.status = status;}
        // Audit fix #30 — invalidate backup-mirror dedup so the next
        // tick re-ships this row with its new state. Wired here (and
        // in updateMessageReactions / updateMessageRetractToken /
        // removeMessage below) so a single store action reaches both
        // the local store AND the backup mirror without callers
        // having to remember to call markDirty by hand.
        notifyBackupDirty(messageId);
      }),

    updateMessageStatusBulk: (conversationId, messageIds, status) =>
      set(s => {
        const list = s.messages[conversationId];
        if (!list || messageIds.length === 0) {return;}
        const wanted = new Set(messageIds);
        for (const m of list) {
          if (wanted.has(m.id) && m.status !== status) {
            m.status = status;
            notifyBackupDirty(m.id);
          }
        }
      }),

    updateMessageCiphertext: (conversationId, messageId, ciphertext) =>
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (msg) {msg.ciphertext = ciphertext;}
      }),

    updateMessageRetractToken: (conversationId, messageId, token) =>
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (msg) {msg.retract_token = token;}
        notifyBackupDirty(messageId);
      }),

    updateMessageEnvelopeId: (conversationId, messageId, envelopeId) =>
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (msg) {msg.envelope_id = envelopeId;}
        notifyBackupDirty(messageId);
      }),

    patchMessageMedia: (conversationId, messageId, fields) =>
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (!msg) {return;}
        if (fields.type !== undefined) {msg.type = fields.type;}
        if (fields.media_mime !== undefined) {msg.media_mime = fields.media_mime;}
        if (fields.media_object_key !== undefined) {msg.media_object_key = fields.media_object_key;}
        if (fields.media_key !== undefined) {msg.media_key = fields.media_key;}
        if (fields.media_iv !== undefined) {msg.media_iv = fields.media_iv;}
        if (fields.media_meta !== undefined) {msg.media_meta = fields.media_meta;}
        notifyBackupDirty(messageId);
      }),

    removeMessage: (conversationId, messageId) => {
      // H-3 — capture the row BEFORE the immer commit so the tombstone
      // carries the real conversation_id + created_at, then emit it
      // AFTER the commit (see notifyBackupRemoved).
      const existing = useMessengerStore.getState().messages[conversationId]?.find(m => m.id === messageId);
      set(s => {
        const list = s.messages[conversationId];
        if (!list) {return;}
        s.messages[conversationId] = list.filter(m => m.id !== messageId);
      });
      notifyBackupRemoved(messageId, conversationId, existing?.created_at ?? new Date().toISOString());
    },

    clearMessages: (conversationId) =>
      set(s => {
        // Empties the message list for one chat without dropping the
        // conversation row — the chat stays in the list but the bubbles
        // (text + media + call records) are gone. The runtime's
        // SQLCipher write-through subscriber sees the [] and DELETEs
        // every persisted row for this conversation, so the clear
        // survives restart.
        if (!s.messages[conversationId]) {return;}
        s.messages[conversationId] = [];
        const convo = s.conversations[conversationId];
        if (convo) {
          convo.last_message = undefined;
          convo.unread_count = 0;
        }
      }),

    updateMessageReactions: (conversationId, messageId, reactions) =>
      set(s => {
        const msg = s.messages[conversationId]?.find(m => m.id === messageId);
        if (msg) {msg.reactions = reactions;}
        notifyBackupDirty(messageId);
      }),

    setConversationMuted: (conversationId, muted) =>
      set(s => {
        const c = s.conversations[conversationId];
        if (c) {c.is_muted = muted;}
      }),

    setConversationPinned: (conversationId, pinned) =>
      set(s => {
        const c = s.conversations[conversationId];
        if (!c) {return;}
        c.is_pinned = pinned;
        // Re-order: pinned rows always sit above unpinned, newest first.
        const order = s.conversationOrder.filter(id => id !== conversationId);
        const head  = order.filter(id => s.conversations[id]?.is_pinned);
        const tail  = order.filter(id => !s.conversations[id]?.is_pinned);
        s.conversationOrder = pinned ? [conversationId, ...head, ...tail] : [...head, conversationId, ...tail];
      }),

    removeConversation: conversationId =>
      set(s => {
        delete s.conversations[conversationId];
        delete s.messages[conversationId];
        s.conversationOrder = s.conversationOrder.filter(id => id !== conversationId);
      }),

    setTyping: (conversationId, typing) =>
      set(s => {
        s.typing[conversationId] = typing;
      }),

    setConversationTtl: (conversationId, ttlSec) =>
      set(s => {
        const c = s.conversations[conversationId];
        if (!c) {return;}
        c.default_ttl_sec = ttlSec;
      }),

    setGroupMemberName: (groupId, userId, name) =>
      set(s => {
        if (!name?.trim()) {
          if (s.groupMemberNames[groupId]) {
            delete s.groupMemberNames[groupId][userId];
            if (Object.keys(s.groupMemberNames[groupId]).length === 0) {
              delete s.groupMemberNames[groupId];
            }
          }
          return;
        }
        if (!s.groupMemberNames[groupId]) {s.groupMemberNames[groupId] = {};}
        s.groupMemberNames[groupId][userId] = name.trim();
      }),

    setPresence: (userId, state, lastSeenMs) =>
      set(s => {
        // Round 7 / presence audit fix #7 — preserve the server's
        // 4-state granularity. `online` stays as a derived boolean so
        // existing consumers (`presence.online ? 'green' : 'grey'`)
        // keep working until they migrate to `state`. `lastSeen` is
        // mirrored from `lastSeenMs` for the same reason.
        const online = state !== 'offline';
        s.presence[userId] = { state, online, lastSeen: lastSeenMs, lastSeenMs };
      }),

    clearPresence: (userIds) =>
      set(s => {
        for (const uid of userIds) {
          const prev = s.presence[uid];
          // Preserve lastSeen — the user really was last seen at that
          // time; only the `online` claim is no longer trustworthy.
          s.presence[uid] = {
            state:      'offline',
            online:     false,
            lastSeen:   prev?.lastSeen,
            lastSeenMs: prev?.lastSeenMs,
          };
        }
      }),

    clearAllPresence: () =>
      set(s => {
        s.presence = {};
      }),

    setConnection: state =>
      set(s => {
        s.connection = state;
      }),

    setReady: ready =>
      set(s => {
        s.ready = ready;
      }),

    setError: error =>
      set(s => {
        s.error = error;
      }),

    setRecoveryBanner: msg =>
      set(s => {
        s.recoveryBanner = msg;
      }),

    noteUndecryptableDrop: (envelopeId: string) => {
      if (!envelopeId || countedUndecryptableDrops.has(envelopeId)) {return;}
      countedUndecryptableDrops.add(envelopeId);
      if (countedUndecryptableDrops.size > COUNTED_DROPS_CAP) {
        const oldest = countedUndecryptableDrops.values().next().value;
        if (oldest !== undefined) {countedUndecryptableDrops.delete(oldest);}
      }
      set(s => {
        s.undecryptableDropCount += 1;
      });
    },

    clearUndecryptableDrops: () =>
      set(s => {
        s.undecryptableDropCount = 0;
      }),

    reset: () => set(() => ({ ...initialState })),

    setOwner: (userId: string) =>
      set(s => {
        const prev = s._ownUserId;
        if (prev === userId) {return;} // same owner — nothing to swap
        // Snapshot the current owner's slice into the vault so it
        // survives the upcoming swap (and the next AsyncStorage flush).
        //
        // Audit fix #15 — store a PLAIN snapshot, not the immer drafts.
        // Stuffing the live drafts into vaultByOwner means later
        // mutations to s.conversations / s.groups also mutate the
        // vault entry (drafts share the same underlying proxies), which
        // poisoned the previous owner's vault state and surfaced as
        // "vault entries grew while user wasn't logged in". `current()`
        // returns a structurally-shared but plain (non-draft) copy.
        if (prev) {
          s.vaultByOwner[prev] = {
            conversations:     immerCurrent(s.conversations),
            conversationOrder: immerCurrent(s.conversationOrder),
            groups:            immerCurrent(s.groups),
            groupMemberNames:  immerCurrent(s.groupMemberNames),
          };
        }
        // Load the incoming owner's slice if we've seen them before;
        // otherwise start with empty slots. Live state (messages,
        // presence, typing, connection, error) is intentionally NOT
        // vaulted — it's transient + the runtime re-hydrates messages
        // from SQLCipher under the new ownerKey-scoped DB.
        const incoming = s.vaultByOwner[userId];
        s.conversations     = incoming?.conversations     ?? {};
        s.conversationOrder = incoming?.conversationOrder ?? [];
        s.groups            = incoming?.groups            ?? {};
        s.groupMemberNames  = incoming?.groupMemberNames  ?? {};
        // Reset transient slices on switch so we don't leak the
        // previous user's typing/presence/error state.
        s.messages             = {};
        s.activeConversationId = null;
        s.typing               = {};
        s.presence             = {};
        s.error                = null;
        s.ready                = false;
        s._ownUserId           = userId;
        if (prev) {
          console.log(`[messengerStore] user changed (${prev} → ${userId}), swapped vault (had vault: ${!!incoming})`);
        }
      }),

    setGroupState: (state: GroupState) =>
      set(s => {
        s.groups[state.groupId] = state;
        // L9 send-recipients-decoupled-from-crypto-membership — keep the
        // conversation's SEND recipient set (convo.participants) in lockstep
        // with the crypto membership (groupState.members). Without this an
        // ADDED member received the key + admin events but no actual text
        // messages (the fan-out targets participants, not members), and a
        // REMOVED member kept being fanned out to. Single choke point: every
        // add / remove / received-admin-action commits group state here.
        const gconvo = s.conversations[state.groupId];
        if (gconvo && (gconvo.type === 'group' || gconvo.type === 'ops_channel')) {
          gconvo.participants = Object.keys(state.members);
        }
        // Audit P0-S3 / P0-S5 — mirror the master key into the SQLCipher
        // group_master_keys table, AES-GCM-wrapped under the per-user
        // wrap secret. Best-effort + fire-and-forget; if the sink isn't
        // wired (loopback dev mode, tests) we no-op silently. The
        // partialize step strips masterKeyB64 from the AsyncStorage
        // snapshot regardless, so a missed sink write just means the
        // key has to be re-learned from the next admin envelope rather
        // than restored on cold start — never a plaintext leak.
        if (groupMasterKeySink && state.masterKeyB64) {
          const sink = groupMasterKeySink;
          const gid = state.groupId;
          const mk = state.masterKeyB64;
          queueMicrotask(() => {
            void sink.setKey(gid, mk).catch(e => {
              console.warn('[messengerStore] groupMasterKey sink.setKey failed', e);
            });
          });
        }
      }),

    removeGroupState: (groupId: string) =>
      set(s => {
        // Audit P1-G5 — when the group goes away, evict its master key
        // from the in-process keyCache so a captured pre-removal
        // ciphertext can't `groupDecrypt` against a leftover live key.
        // Captured here BEFORE the `delete` so the lookup still works;
        // dispose runs OUTSIDE the immer producer to avoid mutating
        // module state during the draft commit (we just queue the call).
        const stale = s.groups[groupId]?.masterKeyB64;
        delete s.groups[groupId];
        if (stale) {
          // Best-effort dispose — defer to a microtask so the immer
          // commit lands first and any concurrent `groupDecrypt` against
          // the SAME key for an in-flight envelope completes before we
          // evict. Required because `keyCache` returns a Promise<CryptoKey>
          // and an in-flight resolution is shared across awaiters.
          queueMicrotask(() => {
            try {
              const {disposeGroupKey} = require('@bravo/messenger-core') as
                typeof import('@bravo/messenger-core');
              disposeGroupKey(stale);
            } catch { /* fine — package may not be linked in tests */ }
          });
        }
        // Audit P0-S3 / P0-S5 — purge the wrapped row so a captured
        // SQLCipher file from a phone the user has since left this
        // group on can't be replayed against future intercepted group
        // ciphertext.
        if (groupMasterKeySink) {
          const sink = groupMasterKeySink;
          queueMicrotask(() => {
            void sink.deleteKey(groupId).catch(e => {
              console.warn('[messengerStore] groupMasterKey sink.deleteKey failed', e);
            });
          });
        }
      }),

    hydrateMessages: (map, bypassCap) =>
      set(s => {
        // Merge into existing — preserves any in-flight unsaved
        // messages the runtime appended before hydration completed.
        //
        // Audit fix #16 — cap each conversation at the
        // MAX_HYDRATE_PER_CONVO most-recent messages. A user with
        // years of history shouldn't pay the cost of every row at
        // boot; the chat scroll-back path uses prependOlderMessages
        // to page in older content on demand.
        //
        // bypassCap is set by the restore-from-backup path so all
        // restored rows reach the UI in one shot. Without it, restoring
        // 5 000 messages would land in SQLCipher fine but only the last
        // 200 per conversation would render — looking exactly like the
        // "most messages disappeared after reinstall" bug.
        for (const [conversationId, list] of Object.entries(map)) {
          const existing = s.messages[conversationId] ?? [];
          const seen = new Set(existing.map(m => m.id));
          const merged = [...existing];
          for (const m of list) {
            if (!seen.has(m.id)) {merged.push(m);}
          }
          // Audit P1-N20 — break ties on `id` so two messages stamped
          // with the same millisecond stay in a deterministic order
          // across hydrations. Without this, equal timestamps fall back
          // to the JS engine's unstable sort and the bubbles swap on
          // every reload.
          merged.sort(byCreatedAtThenId);
          const capped = (!bypassCap && merged.length > MAX_HYDRATE_PER_CONVO)
            ? merged.slice(-MAX_HYDRATE_PER_CONVO)
            : merged;
          s.messages[conversationId] = capped;
          // B-78 — repopulate the conversation's `last_message` from the freshest
          // hydrated row. Persist strips the body (MSG-10), so after a restart or
          // a backup restore `last_message` is missing → the home list showed no
          // preview/timestamp AND the ordering fell back to the conversation's
          // (stale) `created_at`, sinking an actively-used chat below empty ones.
          // SQLCipher is the source of truth for the body on boot; seed it here so
          // both the preview and the last-activity ordering are correct. Guarded
          // to only move forward in time so a capped page can't stale the pointer.
          const convo = s.conversations[conversationId];
          const newest = capped[capped.length - 1];
          if (convo && newest) {
            const cur = convo.last_message;
            if (!cur || Date.parse(cur.created_at) <= Date.parse(newest.created_at)) {
              convo.last_message = newest;
            }
          }
        }
      }),

    prependOlderMessages: (conversationId, older) =>
      set(s => {
        // Audit fix #16 — insert older messages in front of the
        // existing list and dedupe by id. Caller handles "no more to
        // load" by passing an empty array (we no-op).
        if (!older.length) {return;}
        const existing = s.messages[conversationId] ?? [];
        const seen = new Set(existing.map(m => m.id));
        const fresh = older.filter(m => !seen.has(m.id));
        if (!fresh.length) {return;}
        const combined = [...fresh, ...existing];
        // Audit P1-N20 — `id` tie-break for stable order on equal ts.
        combined.sort(byCreatedAtThenId);
        s.messages[conversationId] = combined;
      }),
    })),
    {
      name: 'messenger-store-v1',
      // Audit fix #13 — debounced storage adapter coalesces a burst of
      // mutations into one AsyncStorage write per 500ms. See the
      // makeDebouncedAsyncStorage doc comment for the durability tradeoff.
      storage: createJSONStorage(() => makeDebouncedAsyncStorage(PERSIST_DEBOUNCE_MS)),
      // Persist the per-user vault. The current owner's live data is
      // continuously folded into vaultByOwner[ownerKey] on every flush
      // so re-login restores their threads. MESSAGES are NOT in the
      // vault — they live in SQLCipher (see sqlMessageStore.ts) per
      // the architecture spec, scoped per-user via the DB filename.
      partialize: (s) => {
        // Audit fix #15 — partialize runs against the latest committed
        // snapshot (already a plain object after immer's produce
        // returns), so the structural reference here is fine. We
        // explicitly take a SHALLOW copy of vaultByOwner so the
        // serializer doesn't accidentally share the live owner slice
        // with the in-memory state when the next mutation fires
        // BEFORE the AsyncStorage debounce flushes.
        //
        // Audit P0-S3 / P0-S5 — strip `masterKeyB64` from every group
        // before persisting to AsyncStorage. The real master key now
        // lives in the SQLCipher `group_master_keys` table, wrapped
        // under a separate keychain entry. AsyncStorage retains the
        // rest of the GroupState (membership, epoch, name, etc.) so
        // UI surfaces (group list, member chips) render with no
        // SQLCipher round-trip; the runtime warm-up path re-hydrates
        // masterKeyB64 into the live store from disk via
        // GroupMasterKeyStore.loadAll() at boot.
        const owner = s._ownUserId;
        const stripGroups = (groups: Record<string, GroupState>): Record<string, GroupState> => {
          const out: Record<string, GroupState> = {};
          for (const [gid, gs] of Object.entries(groups)) {
            out[gid] = {...gs, masterKeyB64: ''};
          }
          return out;
        };
        // Audit MSG-10 (2026-07-02): AsyncStorage is NOT encrypted, but each
        // conversation embeds `last_message` including the PLAINTEXT `content`
        // (and media keys). Persisting it here contradicts the store's own
        // contract that message bodies live only in SQLCipher, and it survives
        // a disappearing-message burn. Strip the body + media material from the
        // persisted last_message, keeping only the metadata the home list needs
        // for ordering/type; SQLCipher's loadRecent rehydrates the preview text
        // on boot.
        const stripLastMessage = (convos: Record<string, LocalConversation>): Record<string, LocalConversation> => {
          const out: Record<string, LocalConversation> = {};
          for (const [id, c] of Object.entries(convos)) {
            if (c.last_message) {
              out[id] = {...c, last_message: {
                ...c.last_message,
                content: '',   // MSG-10 — no plaintext body persisted at rest
              }};
            } else {
              out[id] = c;
            }
          }
          return out;
        };
        const liveSlice: VaultSlice = {
          conversations:     stripLastMessage(s.conversations),
          conversationOrder: s.conversationOrder,
          groups:            stripGroups(s.groups),
          groupMemberNames:  s.groupMemberNames,
        };
        // Defensive: also strip masterKeyB64 from any vaulted (inactive
        // owner) slice in case an older app version wrote them in plain.
        // This makes the migration self-healing without a one-shot script.
        const safeVault: Record<string, VaultSlice> = {};
        for (const [k, v] of Object.entries(s.vaultByOwner)) {
          safeVault[k] = {
            ...v,
            groups:        stripGroups(v.groups ?? {}),
            conversations: stripLastMessage(v.conversations ?? {}),  // MSG-10
          };
        }
        const vaultByOwner = owner
          ? {...safeVault, [owner]: liveSlice}
          : safeVault;
        return {
          _ownUserId:    s._ownUserId,
          vaultByOwner,
        } as typeof s;
      },
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.log('[messengerStore] rehydrate error', error);
          return;
        }
        // Hydrate the active live slice from the vault for whoever was
        // last active. setOwner will swap to a different vault entry
        // shortly after (and snapshot back), so this is just a paint-
        // time placeholder for the most-recent-user.
        const owner = state?._ownUserId ?? null;
        const slice = owner ? state?.vaultByOwner?.[owner] : undefined;
        if (state && slice) {
          state.conversations     = slice.conversations     ?? {};
          state.conversationOrder = slice.conversationOrder ?? [];
          state.groups            = slice.groups            ?? {};
          state.groupMemberNames  = slice.groupMemberNames  ?? {};
        }
        const convoCount = Object.keys(state?.conversations ?? {}).length;
        const vaultCount = Object.keys(state?.vaultByOwner ?? {}).length;
        console.log(`[messengerStore] rehydrated: ${convoCount} conversations · ${vaultCount} vaulted owners`);
      },
    },
  ),
);

// Stable empty-array singleton — returning a fresh `[]` from a Zustand
// selector on every render creates a new reference each time, which
// triggers "Maximum update depth exceeded" in React 18+. Keep one
// frozen reference and hand it out for every empty conversation.
export const EMPTY_MESSAGES: readonly LocalMessage[] = Object.freeze([]);

/**
 * Audit fix #17 — selectMessages used to return a freshly minted closure
 * every render: `useMessengerStore(selectMessages(id))` allocated a new
 * selector function each time, which forced zustand to re-run the inner
 * lookup and re-subscribe. The recommended pattern is to inline at the
 * call site: `useMessengerStore(s => s.messages[id] ?? EMPTY_MESSAGES)`.
 *
 * This export remains for backward compat (ChatScreen still uses it),
 * but new call sites should inline the selector. Marked `@deprecated`
 * so future eslint rules can catch it.
 *
 * @deprecated inline at call site:
 *   `useMessengerStore(s => s.messages[id] ?? EMPTY_MESSAGES)`
 */
export const selectMessages = (conversationId: string) =>
  (s: MessengerState): readonly LocalMessage[] =>
    s.messages[conversationId] ?? EMPTY_MESSAGES;

export const selectConversation = (conversationId: string) =>
  (s: MessengerState): LocalConversation | undefined => s.conversations[conversationId];

/**
 * Resolve the canonical conversation id for a 1:1 chat with `peerUserId`.
 *
 * Why: navigation, send, and receive all need to agree on ONE
 * conversation id per peer. Some entry points have historically passed
 * the synthetic `direct:<peerUserId>` key (NewChat / push tap / incoming
 * call) while others pass the server-issued UUID (Home list tap /
 * /conversations/mine sync). When both rows exist for the same peer,
 * inbound messages, outbound messages, and the open ChatScreen could
 * each land on different slots — split-brain. Centralise the rule:
 * if a server-UUID direct row exists for this peer, that's the
 * canonical id; otherwise fall back to the synthetic `direct:<peer>`
 * which the runtime's shadow-create branch will auto-mint on first
 * inbound.
 *
 * Callers: see `resolveDirectConversationIdFromState` for an
 * imperative variant usable from non-React code (productionRuntime
 * receive path, sendText resolver, MainNavigator push tap, etc.).
 */
export function resolveDirectConversationIdFromState(
  s: Pick<MessengerState, 'conversations'>,
  peerUserId: string,
): string {
  for (const [id, convo] of Object.entries(s.conversations)) {
    if (convo.type !== 'direct') {continue;}
    if (convo.peer?.userId !== peerUserId) {continue;}
    // Prefer server-UUID over synthetic `direct:` key.
    if (!id.startsWith('direct:')) {return id;}
  }
  // No server-UUID row found — try the synthetic key directly.
  const synthetic = `direct:${peerUserId}`;
  if (s.conversations[synthetic]) {return synthetic;}
  // Cold contact, no row yet — caller can use this as the shadow-create
  // key; subsequent /conversations/mine sync will replace with UUID.
  return synthetic;
}

/**
 * B-18 — every store slot that may hold a given conversation's messages.
 *
 * A 1:1 (direct) thread can have its history SPLIT across two slots: the
 * synthetic `direct:<peer>` key and a server-UUID row. The canonical slot
 * (`resolveDirectConversationIdFromState`, used by both `sendText` and the
 * inbound append) shifts to the UUID the moment `/conversations/mine` syncs
 * a row — so a message sent before the sync lands in the synthetic slot and
 * one received after lands in the UUID slot. ChatScreen is pinned to its
 * route-param id, so without merging one side goes invisible.
 *
 * Returns every direct slot that maps to this peer (route id + synthetic +
 * any server-UUID direct row for the peer) so render + mark-read can cover
 * them all. Groups and ids with no resolvable peer return `[conversationId]`.
 */
export function directConversationSlots(
  s: Pick<MessengerState, 'conversations'>,
  conversationId: string,
): string[] {
  const conv = s.conversations[conversationId];
  if (conv?.type === 'group' || conv?.type === 'ops_channel') {return [conversationId];}
  const peerUid = conv?.peer?.userId
    ?? (conversationId.startsWith('direct:') ? conversationId.slice('direct:'.length) : undefined);
  if (!peerUid) {return [conversationId];}
  const slots = new Set<string>([conversationId, `direct:${peerUid}`]);
  for (const [id, c] of Object.entries(s.conversations)) {
    if (c.type === 'direct' && c.peer?.userId === peerUid) {slots.add(id);}
  }
  return Array.from(slots);
}

/**
 * Round 6 / perf — memoised cross-conversation derivations.
 *
 * Three screens (CallsLog, Files, Groups) need to fold every
 * conversation's message list into a single derived view. The naive
 * pattern `useMessengerStore(s => s.messages)` re-rendered the whole
 * screen on EVERY message append — including appends to chats the
 * screen doesn't display — because zustand's default ref-equality flips
 * whenever immer mints a new `messages` map (which happens on every
 * mutation).
 *
 * Solution: per-screen selector that returns a NARROW derived shape;
 * cached via WeakMap keyed on the live `messages` map. Because immer
 * produces a fresh top-level reference whenever any nested message
 * changes, the WeakMap key naturally invalidates → recompute happens at
 * most ONCE per state change, not per consumer. Consumers wrap the
 * selector in `useShallow` so two recomputes that produce the same
 * shape (e.g. an append to a different conversation that doesn't move
 * any of OUR derived rows) skip the re-render.
 *
 * The WeakMap also bounds memory: when the store mutates again, the old
 * `messages` reference becomes unreachable and the GC can collect the
 * cache entry. Net cost: one extra reference per derivation, freed on
 * the next mutation.
 */
type MessagesMap = Record<string, LocalMessage[]>;

const callMessagesCache = new WeakMap<MessagesMap, readonly LocalMessage[]>();
/**
 * All `type === 'call'` messages across every conversation, sorted
 * newest-first by `created_at`. Used by CallsLogScreen.
 */
export const selectCallMessages = (s: MessengerState): readonly LocalMessage[] => {
  const map = s.messages;
  const cached = callMessagesCache.get(map);
  if (cached) {return cached;}
  const out: LocalMessage[] = [];
  for (const list of Object.values(map)) {
    for (const m of list) {
      if (m.type === 'call' && m.call_meta) {out.push(m);}
    }
  }
  out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const frozen = Object.freeze(out);
  callMessagesCache.set(map, frozen);
  return frozen;
};

const mediaMessagesCache = new WeakMap<MessagesMap, readonly LocalMessage[]>();
/**
 * All attachment-bearing messages (`type` ∈ {image, audio, file}) across
 * every conversation, sorted newest-first by `created_at`. Used by
 * FilesScreen. The screen still buckets by mime type at the call site.
 */
export const selectMediaMessages = (s: MessengerState): readonly LocalMessage[] => {
  const map = s.messages;
  const cached = mediaMessagesCache.get(map);
  if (cached) {return cached;}
  const out: LocalMessage[] = [];
  for (const list of Object.values(map)) {
    for (const m of list) {
      // Audit MSG-13 — 'video' was omitted, so videos never appeared in the
      // per-chat media/Files surface.
      if (m.type === 'image' || m.type === 'audio' || m.type === 'video' || m.type === 'file') {out.push(m);}
    }
  }
  out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const frozen = Object.freeze(out);
  mediaMessagesCache.set(map, frozen);
  return frozen;
};

const lastByConvCache = new WeakMap<MessagesMap, Record<string, LocalMessage>>();
/**
 * `{conversationId: lastMessage}` map. Used by GroupsScreen for
 * preview text + sort key. Returning the last bubble (not the whole
 * list) means an append to a chat we already reflect doesn't churn
 * the derived shape unless the LAST message of that chat changed.
 */
export const selectLastMessageByConv = (s: MessengerState): Record<string, LocalMessage> => {
  const map = s.messages;
  const cached = lastByConvCache.get(map);
  if (cached) {return cached;}
  const out: Record<string, LocalMessage> = {};
  for (const [id, list] of Object.entries(map)) {
    const last = list[list.length - 1];
    if (last) {out[id] = last;}
  }
  lastByConvCache.set(map, out);
  return out;
};
