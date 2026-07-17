import {compareConversationsForList, conversationSortKey} from '../conversationListOrder';
import type {LocalConversation} from '@/modules/messenger/store';

function convo(over: Partial<LocalConversation> & {id: string}): LocalConversation {
  return {
    id: over.id,
    type: 'direct',
    name: over.id,
    created_at: over.created_at ?? '2026-01-01T00:00:00.000Z',
    unread_count: 0,
    is_pinned: over.is_pinned ?? false,
    last_message: over.last_message,
  } as unknown as LocalConversation;
}

const withLast = (id: string, iso: string | undefined, pinned = false) =>
  convo({id, is_pinned: pinned, last_message: iso ? ({created_at: iso, content: 'x'} as never) : undefined});

describe('conversationListOrder (B-78) — sort by real last-message time, not restore order', () => {
  it('orders newest last-message first regardless of input order', () => {
    const bowRani = withLast('bow-rani', '2026-06-27T10:00:00.000Z'); // old
    const jack    = withLast('jack',     '2026-07-10T23:52:00.000Z'); // newer
    // Simulate the restore scramble: bow-rani appears BEFORE jack in the input
    // (move-to-front put the old chat on top because it was re-processed last).
    const sorted = [bowRani, jack].sort(compareConversationsForList);
    expect(sorted.map(c => c.id)).toEqual(['jack', 'bow-rani']);
  });

  it('keeps pinned conversations above unpinned even when older', () => {
    const pinnedOld = withLast('pinned-old', '2026-05-01T00:00:00.000Z', true);
    const freshUnpinned = withLast('fresh', '2026-07-11T00:00:00.000Z', false);
    const sorted = [freshUnpinned, pinnedOld].sort(compareConversationsForList);
    expect(sorted.map(c => c.id)).toEqual(['pinned-old', 'fresh']);
  });

  it('sorts two pinned by recency', () => {
    const p1 = withLast('p1', '2026-06-01T00:00:00.000Z', true);
    const p2 = withLast('p2', '2026-07-01T00:00:00.000Z', true);
    expect([p1, p2].sort(compareConversationsForList).map(c => c.id)).toEqual(['p2', 'p1']);
  });

  it('falls back to conversation created_at when there is no last message', () => {
    const empty = convo({id: 'empty', created_at: '2026-07-05T00:00:00.000Z'});
    expect(conversationSortKey(empty)).toBe(Date.parse('2026-07-05T00:00:00.000Z'));
    const hasMsg = withLast('hasMsg', '2026-07-08T00:00:00.000Z');
    // empty (Jul 5) sorts below hasMsg (Jul 8)
    expect([empty, hasMsg].sort(compareConversationsForList).map(c => c.id)).toEqual(['hasMsg', 'empty']);
  });

  it('treats an unparseable timestamp as oldest (key 0), never NaN', () => {
    const bad = convo({id: 'bad', created_at: 'not-a-date'});
    expect(conversationSortKey(bad)).toBe(0);
    const good = withLast('good', '2026-07-01T00:00:00.000Z');
    expect([bad, good].sort(compareConversationsForList).map(c => c.id)).toEqual(['good', 'bad']);
  });
});
