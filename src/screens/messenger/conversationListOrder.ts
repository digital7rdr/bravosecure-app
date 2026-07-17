import type {LocalConversation} from '@/modules/messenger/store';

/**
 * B-78 — the messenger store keeps `conversationOrder` as a move-to-front (MRU)
 * list: appending a message `unshift`s its conversation to the top. That equals
 * "most-recent first" during LIVE use, but a bulk backup RESTORE re-appends every
 * conversation's messages in processing order, so the resulting MRU order no
 * longer matches real last-message time — an old chat (e.g. last message Jun 27)
 * can land ABOVE a newer one purely because it was re-processed last during the
 * restore. Sort the DISPLAY list by the last message's real timestamp instead
 * (pinned always first); the message timestamps themselves survive restore intact,
 * so this is correct for both live and restored state.
 */
export function conversationSortKey(c: LocalConversation): number {
  const ts = c.last_message?.created_at ?? c.created_at;
  const parsed = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Pinned conversations first, then most-recent activity by real last-message time. */
export function compareConversationsForList(a: LocalConversation, b: LocalConversation): number {
  if (!!a.is_pinned !== !!b.is_pinned) {return a.is_pinned ? -1 : 1;}
  return conversationSortKey(b) - conversationSortKey(a);
}
