import {useActivityStore, selectUnreadCount, recordActivity} from '@store/activityStore';

function reset() {
  useActivityStore.setState({ownerKey: null, rows: []});
}

const base = {id: 'e1', eventClass: 'dispatch' as const, kind: 'dispatch-offer', title: 'New job offer'};

describe('activityStore (Step 18 B2)', () => {
  beforeEach(reset);

  it('appends a row (newest first) defaulting to unread + a timestamp', () => {
    recordActivity({...base, id: 'a'});
    recordActivity({...base, id: 'b', title: 'Second'});
    const rows = useActivityStore.getState().rows;
    expect(rows.map(r => r.id)).toEqual(['b', 'a']); // newest first
    expect(rows[0].read).toBe(false);
    expect(typeof rows[0].ts).toBe('string');
  });

  it('dedupes by eventId — a re-delivered wake updates in place, never doubles', () => {
    recordActivity({...base, id: 'x', title: 'First'});
    useActivityStore.getState().markRead('x');
    recordActivity({...base, id: 'x', title: 'Updated'});
    const rows = useActivityStore.getState().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Updated');
    expect(rows[0].read).toBe(true); // keeps prior read state
  });

  it('tracks unread count and clears it on markAllRead', () => {
    recordActivity({...base, id: 'a'});
    recordActivity({...base, id: 'b'});
    recordActivity({...base, id: 'c'});
    expect(selectUnreadCount(useActivityStore.getState())).toBe(3);
    useActivityStore.getState().markRead('b');
    expect(selectUnreadCount(useActivityStore.getState())).toBe(2);
    useActivityStore.getState().markAllRead();
    expect(selectUnreadCount(useActivityStore.getState())).toBe(0);
  });

  it('is identity-scoped: a different owner wipes the previous user\'s feed', () => {
    useActivityStore.getState().setOwner('user-A');
    recordActivity({...base, id: 'a'});
    recordActivity({...base, id: 'b'});
    expect(useActivityStore.getState().rows).toHaveLength(2);
    // Same user re-keying (e.g. token refresh) keeps the feed.
    useActivityStore.getState().setOwner('user-A');
    expect(useActivityStore.getState().rows).toHaveLength(2);
    // A different identity signs in on the same device → feed wiped.
    useActivityStore.getState().setOwner('user-B');
    expect(useActivityStore.getState().rows).toHaveLength(0);
    expect(useActivityStore.getState().ownerKey).toBe('user-B');
  });

  it('remove + clear work', () => {
    recordActivity({...base, id: 'a'});
    recordActivity({...base, id: 'b'});
    useActivityStore.getState().remove('a');
    expect(useActivityStore.getState().rows.map(r => r.id)).toEqual(['b']);
    useActivityStore.getState().clear();
    expect(useActivityStore.getState().rows).toEqual([]);
  });
});
