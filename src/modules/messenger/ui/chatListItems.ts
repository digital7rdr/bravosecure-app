/**
 * MX-05 — pure builders for the ChatScreen message list. Free of React /
 * react-native imports so the interleave + inversion logic is
 * unit-testable in a node env (same convention as chatListLayout.ts).
 *
 * The chat FlatList is INVERTED (index 0 renders at the visual bottom =
 * newest message), which is how WhatsApp/Signal land at the bottom
 * instantly with zero scroll-to-end hacks. Items are therefore built in
 * chronological order (so day separators and the unread divider slot in
 * exactly as before) and then REVERSED for display: reversal flips
 * render order, so a separator pushed BEFORE a day's first message still
 * paints ABOVE it on screen.
 */
import type {LocalMessage} from '../store';
import {unreadDividerIndex} from './chatListLayout';

export type ChatListItem =
  | {kind: 'msg'; key: string; msg: LocalMessage; index: number}
  | {kind: 'day'; key: string; label: string}
  | {kind: 'unread'; key: string; count: number};

/**
 * MX-07 — identity-stable rows. A single status/receipt flip replaces
 * one message object; every other row object is reused verbatim so
 * FlatList's cell memoisation (and the MessageBubble comparator) can
 * bail out on reference equality instead of re-walking props.
 */
const msgItemCache = new WeakMap<LocalMessage, Extract<ChatListItem, {kind: 'msg'}>>();
const sepItemCache = new Map<string, ChatListItem>();
// Why: day keys are date-strings shared across conversations; the cache
// can only grow by distinct days/unread anchors, but cap it anyway so a
// pathological long session can't accumulate unbounded entries.
const SEP_CACHE_MAX = 512;

function msgItem(msg: LocalMessage, index: number): ChatListItem {
  const cached = msgItemCache.get(msg);
  if (cached && cached.index === index) {return cached;}
  const item = {kind: 'msg' as const, key: msg.id, msg, index};
  msgItemCache.set(msg, item);
  return item;
}

function sepItem(item: Extract<ChatListItem, {kind: 'day'} | {kind: 'unread'}>): ChatListItem {
  const cached = sepItemCache.get(item.key);
  if (cached) {
    if (cached.kind === 'day' && item.kind === 'day' && cached.label === item.label) {return cached;}
    if (cached.kind === 'unread' && item.kind === 'unread' && cached.count === item.count) {return cached;}
  }
  if (sepItemCache.size >= SEP_CACHE_MAX) {sepItemCache.clear();}
  sepItemCache.set(item.key, item);
  return item;
}

/**
 * Chronological interleave: one day separator per day boundary + a
 * one-shot "Unread N messages" divider at the boundary where the user
 * left off (Rank 13 semantics, unchanged from the pre-inverted list).
 */
export function buildChatListItems(
  messages: ReadonlyArray<LocalMessage>,
  initialUnread: number,
): ChatListItem[] {
  const out: ChatListItem[] = [];
  const unreadStart = unreadDividerIndex(messages, initialUnread);
  let lastDayKey: string | null = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const d = new Date(msg.created_at);
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      out.push(sepItem({kind: 'day', key: `day:${dayKey}`, label: formatDaySep(d)}));
    }
    if (i === unreadStart) {
      out.push(sepItem({kind: 'unread', key: `unread:${msg.id}`, count: initialUnread}));
    }
    out.push(msgItem(msg, i));
  }
  return out;
}

/** Display order for the inverted FlatList: newest first (index 0 = visual bottom). */
export function buildInvertedChatListItems(
  messages: ReadonlyArray<LocalMessage>,
  initialUnread: number,
): ChatListItem[] {
  return buildChatListItems(messages, initialUnread).reverse();
}

export function sameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear()
      && da.getMonth()    === db.getMonth()
      && da.getDate()     === db.getDate();
}

/**
 * Day-separator label. Yesterday/Today get friendly names; older dates
 * paint as "Mon, Mar 5" so the column stays narrow. Compared against
 * the actual clock at render time so the labels stay correct as the
 * day rolls over with a chat still open.
 */
export function formatDaySep(d: Date): string {
  const now = new Date();
  const sameDayAsNow = d.getFullYear() === now.getFullYear()
                    && d.getMonth()    === now.getMonth()
                    && d.getDate()     === now.getDate();
  if (sameDayAsNow) {return 'Today';}
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  const isYesterday = d.getFullYear() === yest.getFullYear()
                   && d.getMonth()    === yest.getMonth()
                   && d.getDate()     === yest.getDate();
  if (isYesterday) {return 'Yesterday';}
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'});
  }
  return d.toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});
}
