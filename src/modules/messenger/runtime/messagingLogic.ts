/**
 * Pure decision helpers for the messaging receive/send paths, extracted
 * so they're unit-testable without standing up the full production
 * runtime (transport, libsignal, SQLCipher, keys). The runtime is a thin
 * caller; all the branching that produced the audited bugs lives here.
 *
 * No React / react-native / store imports — callers pass plain state.
 */

export interface SessionAddressLike {
  userId:   string;
  deviceId: number;
}

interface ConversationLike {
  type?:         string;
  participants?: string[];
}

export interface MessagingStateLike {
  conversations: Record<string, ConversationLike | undefined>;
  groups:        Record<string, unknown | undefined>;
}

/**
 * Group detection — the single rule mirrored from sendText. A direct
 * conversation stores both participants ([self, peer]), so the legacy
 * `participants.length > 1` fallback must be gated behind `type !==
 * 'direct'` or every 1:1 would mis-route into the group path.
 */
export function isGroupConversation(
  state: MessagingStateLike,
  conversationId: string,
): boolean {
  const convo = state.conversations[conversationId];
  const hasGroupState = !!state.groups[conversationId];
  return (
    convo?.type === 'group' ||
    convo?.type === 'ops_channel' ||
    hasGroupState ||
    (convo?.type !== 'direct' && (convo?.participants?.length ?? 0) > 1)
  );
}

/**
 * BS-RX1 — recipient set for a reaction. For a group, every member
 * except self (server-authoritative list); for a direct chat, just the
 * passed peer. Empty-group falls back to [peer] so a reaction still
 * lands before /conversations/mine sync resolves membership.
 */
export function reactionRecipients(
  state: MessagingStateLike,
  conversationId: string,
  ownUserId: string,
  peer: SessionAddressLike,
): SessionAddressLike[] {
  if (!isGroupConversation(state, conversationId)) {return [peer];}
  const convo = state.conversations[conversationId];
  const members = (convo?.participants ?? [])
    .filter(uid => uid && uid !== ownUserId)
    .map(uid => ({userId: uid, deviceId: 1}));
  return members.length > 0 ? members : [peer];
}

/**
 * BS-TY1 — the set of conversation ids a typing frame from `senderUid`
 * affects: the synthetic direct key, the canonical direct id (resolved
 * by the caller and passed in), and every group the sender participates
 * in. De-duplicated.
 */
export function typingAffectedConversationIds(
  state: MessagingStateLike,
  senderUid: string,
  syntheticDirectId: string,
  canonicalDirectId: string,
): string[] {
  const out = new Set<string>([syntheticDirectId, canonicalDirectId]);
  for (const [convId, convo] of Object.entries(state.conversations)) {
    if ((convo?.participants ?? []).includes(senderUid)) {out.add(convId);}
  }
  return Array.from(out);
}

/**
 * BS-TY2 — typing watchdog. A peer's `typing: start` with no trailing
 * `stop` (app backgrounded mid-type, dropped frame) would otherwise
 * leave the "typing…" bubble on forever. Arm a per-conversation timer on
 * every `start`; if no `stop` (or inbound message — cleared by the
 * caller) lands within the window, force the flag off. 8s comfortably
 * covers the client's own 6s typing-debounce re-emit cadence.
 *
 * Lives here (not inline in the runtime) so it can be driven with Jest
 * fake timers without importing the whole production runtime.
 */
export const TYPING_WATCHDOG_MS = 8000;

export class TypingWatchdog {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly windowMs: number = TYPING_WATCHDOG_MS) {}

  /** Arm (or re-arm) the timer for a conversation. `onExpire` fires once. */
  arm(conversationId: string, onExpire: () => void): void {
    this.clear(conversationId);
    const h = setTimeout(() => {
      this.timers.delete(conversationId);
      onExpire();
    }, this.windowMs);
    this.timers.set(conversationId, h);
  }

  /** Cancel the timer for a conversation (e.g. on `stop` or a message). */
  clear(conversationId: string): void {
    const existing = this.timers.get(conversationId);
    if (existing) {clearTimeout(existing); this.timers.delete(conversationId);}
  }

  /** True iff a timer is currently armed for the conversation. */
  isArmed(conversationId: string): boolean {
    return this.timers.has(conversationId);
  }
}

/**
 * BS-RR1 — should a read-receipt from `receipterUid` be allowed to flip
 * THIS message to `read`? Preserves the P0-E1 ownership guard (the
 * receipter must belong to the thread the message lives in):
 *   - direct chat: the receipter must equal the message's stored peer.
 *   - group chat:  every outbound row stores peer = participants[0], so
 *     matching the single peer only ever accepted the first member's
 *     receipt. Validate against the conversation's participant list
 *     instead — any member's read counts, but a non-member's is rejected.
 *
 * Caller still gates on envelope-id match, sender_id === 'self', and
 * not-already-read; this is purely the ownership predicate.
 */
export function readReceiptAccepted(args: {
  state:          MessagingStateLike;
  conversationId: string;
  receipterUid:   string;
  messagePeerUserId?: string;
}): boolean {
  const {state, conversationId, receipterUid, messagePeerUserId} = args;
  if (isGroupConversation(state, conversationId)) {
    const members = state.conversations[conversationId]?.participants ?? [];
    return members.includes(receipterUid);
  }
  return messagePeerUserId === receipterUid;
}
