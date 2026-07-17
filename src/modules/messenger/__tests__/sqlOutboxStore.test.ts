/**
 * Durable outbox unit tests. These exercise the SqlOutboxStore against
 * an in-memory fake DbHandle so we don't need op-sqlite/SQLCipher
 * available in the Jest harness. Coverage:
 *
 *   1. enqueue inserts a row; double-enqueue of the SAME composite key
 *      (clientMsgId, peerUserId, peerDeviceId) is idempotent
 *      (INSERT OR IGNORE).
 *   2. enqueue with the SAME clientMsgId but DIFFERENT peer creates
 *      independent rows (audit P0-N4 — group fan-out).
 *   3. dueRows returns rows with next_retry_at <= now in created_at
 *      order; filters out 'failed' status.
 *   4. markDelivered removes ONLY the row matching (clientMsgId, peer);
 *      sibling group-fanout rows survive.
 *   5. recordAttempt bumps attempts on the targeted row and schedules
 *      backoff; after MAX_ATTEMPTS it marks that row 'failed'.
 *   6. resetFailed flips one 'failed' row back to 'pending' without
 *      touching peer siblings.
 */

import {SqlOutboxStore} from '../store/sqlOutboxStore';

type Row = Record<string, string | number | null>;

/**
 * Hand-rolled mini SQLite engine that understands only the queries the
 * outbox store actually emits. Faster than spinning up sql.js and
 * isolates failures to the store's SQL strings rather than a generic
 * SQLite parser quirk.
 */
function makeFakeDb() {
  const table: Row[] = [];
  const sameKey = (r: Row, cmid: unknown, uid: unknown, did: unknown): boolean =>
    r.client_msg_id === cmid && r.peer_user_id === uid && r.peer_device_id === did;
  return {
    table,
    async execute(sql: string, params: (string | number)[] = []) {
      const trimmed = sql.trim().replace(/\s+/g, ' ');
      if (trimmed.startsWith('INSERT OR IGNORE INTO outbox')) {
        const [client_msg_id, conversation_id, message_id, peer_user_id,
               peer_device_id, payload, next_retry_at, created_at] = params;
        if (table.some(r => sameKey(r, client_msg_id, peer_user_id, peer_device_id))) {
          return {rows: []};
        }
        table.push({
          client_msg_id, conversation_id, message_id, peer_user_id,
          peer_device_id, payload, attempts: 0,
          next_retry_at, created_at, status: 'pending',
        });
        return {rows: []};
      }
      if (trimmed.startsWith('SELECT client_msg_id, conversation_id')) {
        const now = params[0] as number;
        const rows = table
          .filter(r => r.status === 'pending' && (r.next_retry_at as number) <= now)
          .sort((a, b) => (a.created_at as number) - (b.created_at as number));
        return {rows};
      }
      if (trimmed.startsWith('DELETE FROM outbox WHERE conversation_id')) {
        const [convId] = params;
        for (let i = table.length - 1; i >= 0; i--) {
          if (table[i].conversation_id === convId) {table.splice(i, 1);}
        }
        return {rows: []};
      }
      if (trimmed.startsWith('DELETE FROM outbox WHERE client_msg_id = ?') && params.length === 1) {
        const [cmid] = params;
        for (let i = table.length - 1; i >= 0; i--) {
          if (table[i].client_msg_id === cmid) {table.splice(i, 1);}
        }
        return {rows: []};
      }
      if (trimmed.startsWith('DELETE FROM outbox')) {
        const [cmid, uid, did] = params;
        const idx = table.findIndex(r => sameKey(r, cmid, uid, did));
        if (idx >= 0) {table.splice(idx, 1);}
        return {rows: []};
      }
      if (trimmed.startsWith('SELECT attempts FROM outbox')) {
        const [cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did));
        return {rows: match ? [{attempts: match.attempts}] : []};
      }
      if (trimmed.startsWith('UPDATE outbox SET attempts = ?, status = \'failed\'')) {
        const [attempts, cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did));
        if (match) { match.attempts = attempts; match.status = 'failed'; }
        return {rows: []};
      }
      if (trimmed.startsWith('UPDATE outbox SET attempts = ?, next_retry_at = ?')) {
        const [attempts, next_retry_at, cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did));
        if (match) { match.attempts = attempts; match.next_retry_at = next_retry_at; }
        return {rows: []};
      }
      if (trimmed.startsWith('UPDATE outbox SET attempts = 0')) {
        const [next_retry_at, cmid, uid, did] = params;
        const match = table.find(r => sameKey(r, cmid, uid, did) && r.status === 'failed');
        if (match) {
          match.attempts = 0;
          match.next_retry_at = next_retry_at;
          match.status = 'pending';
        }
        return {rows: []};
      }
      throw new Error(`unhandled SQL: ${trimmed}`);
    },
  };
}

function make(): {store: SqlOutboxStore; table: Row[]} {
  const fake = makeFakeDb();
  return {store: new SqlOutboxStore(fake as never), table: fake.table};
}

function row(overrides: Partial<{
  clientMsgId: string; conversationId: string; messageId: string;
  peerUserId: string; peerDeviceId: number; payload: string;
}> = {}) {
  return {
    clientMsgId:    overrides.clientMsgId    ?? 'cmid-1',
    conversationId: overrides.conversationId ?? 'direct:bob',
    messageId:      overrides.messageId      ?? 'mid-1',
    peerUserId:     overrides.peerUserId     ?? 'bob',
    peerDeviceId:   overrides.peerDeviceId   ?? 1,
    payload:        overrides.payload        ?? '{"outerSealed":"AAA"}',
  };
}

describe('SqlOutboxStore', () => {
  test('enqueue inserts a row and is idempotent on duplicate composite key', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'dup'}));
    await store.enqueue(row({clientMsgId: 'dup', payload: 'IGNORED'}));
    expect(table).toHaveLength(1);
    expect(table[0].payload).toBe('{"outerSealed":"AAA"}'); // first wins
  });

  test('audit P0-N4 — same clientMsgId, different peers => independent rows', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'alice'}));
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'bob'}));
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'carol'}));
    expect(table).toHaveLength(3);
    const peers = table.map(r => r.peer_user_id).sort();
    expect(peers).toEqual(['alice', 'bob', 'carol']);
  });

  test('audit P0-N4 — markDelivered removes ONLY the targeted peer row', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'alice'}));
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'bob'}));
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'carol'}));
    await store.markDelivered('group-1', 'bob', 1);
    const survivors = table.map(r => r.peer_user_id).sort();
    expect(survivors).toEqual(['alice', 'carol']);
  });

  test('dueRows returns pending rows with next_retry_at <= now in created order', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'a'}));
    // manually advance created_at on row a so b is newer
    table[0].created_at = 100;
    await store.enqueue(row({clientMsgId: 'b'}));
    table[1].created_at = 200;
    const due = await store.dueRows(Date.now() + 1_000_000);
    expect(due.map(r => r.clientMsgId)).toEqual(['a', 'b']);
  });

  test('dueRows skips status=failed', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'a'}));
    table[0].status = 'failed';
    const due = await store.dueRows(Date.now() + 1_000_000);
    expect(due).toHaveLength(0);
  });

  test('markDelivered removes the row', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'x'}));
    expect(table).toHaveLength(1);
    await store.markDelivered('x', 'bob', 1);
    expect(table).toHaveLength(0);
  });

  test('recordAttempt bumps attempts and schedules backoff', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'a'}));
    const before = table[0].next_retry_at as number;
    const r1 = await store.recordAttempt('a', 'bob', 1);
    expect(r1.attempts).toBe(1);
    expect(r1.failed).toBe(false);
    const after = table[0].next_retry_at as number;
    expect(after).toBeGreaterThan(before);
  });

  test('recordAttempt eventually marks failed after enough retries', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'a'}));
    let last = {attempts: 0, failed: false};
    for (let i = 0; i < 12 && !last.failed; i++) {
      last = await store.recordAttempt('a', 'bob', 1);
    }
    expect(last.failed).toBe(true);
    expect(table[0].status).toBe('failed');
  });

  test('audit P0-N4 — recordAttempt only affects the targeted peer row', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'alice'}));
    await store.enqueue(row({clientMsgId: 'group-1', peerUserId: 'bob'}));
    await store.recordAttempt('group-1', 'bob', 1);
    const alice = table.find(r => r.peer_user_id === 'alice');
    const bob = table.find(r => r.peer_user_id === 'bob');
    expect(alice?.attempts).toBe(0);
    expect(bob?.attempts).toBe(1);
  });

  test('resetFailed re-arms a failed row for immediate retry', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'a'}));
    table[0].status = 'failed';
    table[0].attempts = 11;
    await store.resetFailed('a', 'bob', 1);
    expect(table[0].status).toBe('pending');
    expect(table[0].attempts).toBe(0);
    expect((table[0].next_retry_at as number)).toBeLessThanOrEqual(Date.now() + 5);
  });

  test('recordAttempt on a deleted row is a no-op', async () => {
    const {store} = make();
    const r = await store.recordAttempt('does-not-exist', 'bob', 1);
    expect(r).toEqual({attempts: 0, failed: false});
  });

  test('audit MSG-05 — deleteByClientMsgId drops EVERY peer row for a clientMsgId', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'g1', peerUserId: 'alice'}));
    await store.enqueue(row({clientMsgId: 'g1', peerUserId: 'bob'}));
    await store.enqueue(row({clientMsgId: 'keep', peerUserId: 'carol'}));
    await store.deleteByClientMsgId('g1');
    expect(table).toHaveLength(1);
    expect(table[0].client_msg_id).toBe('keep');
  });

  test('P2-10 — deleteByConversation drops ALL rows for a conversation (any clientMsgId/peer)', async () => {
    const {store, table} = make();
    await store.enqueue(row({clientMsgId: 'g1', conversationId: 'grp:x', peerUserId: 'alice'}));
    await store.enqueue(row({clientMsgId: 'g1', conversationId: 'grp:x', peerUserId: 'bob'}));
    await store.enqueue(row({clientMsgId: 't2', conversationId: 'grp:x', peerUserId: 'carol'}));
    await store.enqueue(row({clientMsgId: 'other', conversationId: 'direct:dave', peerUserId: 'dave'}));
    await store.deleteByConversation('grp:x');
    expect(table).toHaveLength(1);
    expect(table[0].conversation_id).toBe('direct:dave');
  });
});
