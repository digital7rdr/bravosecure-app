import {
  runWithRatchetTxn,
  isInsideRatchetTxn,
  isTransientSqlError,
} from '../runtime/receiveTransaction';
import { SqlMessageStore } from '../store/sqlMessageStore';
import type { LocalMessage } from '../store/types';

/**
 * Stub DbHandle that records every SQL statement issued and lets us
 * simulate failures inside the transaction body. Mirrors the
 * op-sqlite execute(sql, params) signature.
 */
function makeStubDb() {
  const calls: string[] = [];
  return {
    calls,
    db: {
      async execute(sql: string): Promise<unknown> {
        calls.push(sql);
        return undefined;
      },
    },
  };
}

describe('runWithRatchetTxn — audit P0-N14 atomic ratchet+plaintext', () => {
  it('COMMITs when work resolves', async () => {
    const { db, calls } = makeStubDb();
    const result = await runWithRatchetTxn(db, async () => {
      await db.execute('INSERT INTO sessions VALUES (?)');
      await db.execute('INSERT INTO messages VALUES (?)');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toEqual([
      'BEGIN IMMEDIATE',
      'INSERT INTO sessions VALUES (?)',
      'INSERT INTO messages VALUES (?)',
      'COMMIT',
    ]);
  });

  it('ROLLBACKs and re-throws when work fails AFTER the ratchet write', async () => {
    // Scenario: libsignal advances the ratchet (INSERT INTO sessions)
    // and then the message-row UPSERT throws. The transaction must
    // unwind the session write so the redelivered ciphertext decrypts
    // cleanly on retry.
    const { db, calls } = makeStubDb();
    const boom = new Error('disk full');
    await expect(
      runWithRatchetTxn(db, async () => {
        await db.execute('INSERT INTO sessions VALUES (?)'); // ratchet
        throw boom; // plaintext write failed
      }),
    ).rejects.toBe(boom);
    expect(calls).toEqual([
      'BEGIN IMMEDIATE',
      'INSERT INTO sessions VALUES (?)',
      'ROLLBACK',
    ]);
  });

  it('ROLLBACKs when work fails BEFORE any write (cert/AAD check rejects)', async () => {
    const { db, calls } = makeStubDb();
    const reject = new Error('aad mismatch');
    await expect(
      runWithRatchetTxn(db, async () => {
        throw reject;
      }),
    ).rejects.toBe(reject);
    expect(calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });

  it('still re-throws the original error when ROLLBACK itself fails', async () => {
    // We promise to surface the user-meaningful error, not the cleanup
    // failure. WAL recovery on next open handles the orphaned BEGIN.
    const calls: string[] = [];
    const rollbackBoom = new Error('rollback failed');
    const workBoom = new Error('decrypt failed');
    const db = {
      async execute(sql: string): Promise<unknown> {
        calls.push(sql);
        if (sql === 'ROLLBACK') {throw rollbackBoom;}
        return undefined;
      },
    };
    await expect(
      runWithRatchetTxn(db, async () => { throw workBoom; }),
    ).rejects.toBe(workBoom); // NOT rollbackBoom
    expect(calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });

  it('uses BEGIN IMMEDIATE (acquires RESERVED up front, not on first write)', async () => {
    // Critical for correctness — BEGIN DEFERRED would let a concurrent
    // writer interleave, then SQLITE_BUSY us mid-decrypt after the
    // ratchet had already updated its in-memory copy.
    const { db, calls } = makeStubDb();
    await runWithRatchetTxn(db, async () => undefined);
    expect(calls[0]).toBe('BEGIN IMMEDIATE');
  });

  it('returns the work result on success', async () => {
    const { db } = makeStubDb();
    const out = await runWithRatchetTxn(db, async () => ({ msg: 'hello' }));
    expect(out).toEqual({ msg: 'hello' });
  });
});

/**
 * Audit P0-1 (2026-07-09) — the M-14 coalesced status-flush transaction
 * (SqlMessageStore.upsertBatch) and the receive transaction
 * (runWithRatchetTxn) run on the SAME single SQLCipher connection. The
 * M-14 fix serialized upsertBatch against itself via a store-local
 * static mutex but NOT against the receive txn, so under a reconnect-
 * drain + markRead burst the receive `BEGIN IMMEDIATE` landed inside an
 * open flush txn, threw "cannot start a transaction within a
 * transaction", the catch-all classified it terminal, and the relay
 * ack-`discarded` — DELETED — a committed inbound message.
 *
 * These tests pin both halves of the fix over the REAL SqlMessageStore
 * and the REAL txn runner on one txn-depth-tracking stub connection:
 *   (a) upsertBatch and the receive txn serialize on ONE shared mutex —
 *       interleaving them (either order, plus a second cross-instance
 *       M-14 flush) never produces a nested BEGIN;
 *   (b) a transient LOCAL SQL failure (nested-txn / SQLITE_BUSY / disk
 *       pressure) rolls back and classifies as leave-on-relay — it must
 *       NEVER produce the `discarded` ack that destroys the message.
 */

function makeMsg(id: string, convo = 'c1'): LocalMessage {
  return {
    id,
    conversation_id: convo,
    sender_id:       'peer-1',
    type:            'text',
    content:         'x',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      '2026-07-09T00:00:00.000Z',
    peer:            { userId: 'peer-1', deviceId: 1 },
  } as LocalMessage;
}

/**
 * Stub connection that behaves like op-sqlite/SQLite for transactions:
 * a second BEGIN while one is open throws the exact native error. Every
 * statement yields to the microtask queue first, so two UNSERIALIZED
 * callers genuinely interleave — which is what turns a missing shared
 * mutex into the nested-BEGIN throw the P0 documents.
 */
function makeTxnTrackingDb(opts?: { failOn?: RegExp; failWith?: Error }) {
  const calls: string[] = [];
  let txnDepth = 0;
  const db = {
    async execute(sql: string): Promise<{ rows: unknown[] }> {
      await Promise.resolve();
      await Promise.resolve();
      calls.push(sql);
      if (/^BEGIN/i.test(sql)) {
        if (txnDepth > 0) {
          throw new Error('cannot start a transaction within a transaction');
        }
        txnDepth += 1;
        return { rows: [] };
      }
      if (/^(COMMIT|ROLLBACK)/i.test(sql)) {
        txnDepth = Math.max(0, txnDepth - 1);
        return { rows: [] };
      }
      if (opts?.failOn?.test(sql)) {
        throw opts.failWith ?? new Error('database is locked (5) (SQLITE_BUSY)');
      }
      return { rows: [] };
    },
  };
  return { calls, db };
}

/** Walk a statement trace and assert at most ONE txn is ever open. */
function assertSerializedTrace(calls: string[]): void {
  let depth = 0;
  for (const sql of calls) {
    if (/^BEGIN/i.test(sql)) {
      depth += 1;
      expect(depth).toBe(1); // a nested BEGIN would have thrown anyway
    } else if (/^(COMMIT|ROLLBACK)/i.test(sql)) {
      depth -= 1;
    }
  }
  expect(depth).toBe(0);
}

describe('P0-1(a) — coalesced flush txn and receive txn share ONE per-connection mutex', () => {
  it('flush racing a receive txn serializes (no nested BEGIN, both commit)', async () => {
    const { calls, db } = makeTxnTrackingDb();
    const store = new SqlMessageStore(db as never);
    // Fire the flush FIRST so its BEGIN owns the connection, with the
    // receive txn immediately behind it. Pre-fix (independent mutexes)
    // the receive BEGIN IMMEDIATE landed inside the open flush txn and
    // threw — handledOk=false → ack 'discarded' → the relay destroyed a
    // committed inbound message.
    await Promise.all([
      store.upsertBatch([makeMsg('a'), makeMsg('b')]),
      runWithRatchetTxn(db, async () => {
        await db.execute('INSERT INTO sessions VALUES (?)'); // ratchet advance
        await db.execute('INSERT INTO messages VALUES (?)'); // plaintext row
      }),
    ]);
    assertSerializedTrace(calls);
    expect(calls.filter(c => /^BEGIN/i.test(c))).toHaveLength(2);
    expect(calls.filter(c => c === 'COMMIT')).toHaveLength(2);
  });

  it('receive txn racing a flush (reverse interleaving) also serializes — the status batch is not silently rolled back', async () => {
    const { calls, db } = makeTxnTrackingDb();
    const store = new SqlMessageStore(db as never);
    await Promise.all([
      runWithRatchetTxn(db, async () => {
        await db.execute('INSERT INTO sessions VALUES (?)');
        await db.execute('INSERT INTO messages VALUES (?)');
      }),
      store.upsertBatch([makeMsg('c'), makeMsg('d'), makeMsg('e')]),
    ]);
    assertSerializedTrace(calls);
    expect(calls.filter(c => c === 'COMMIT')).toHaveLength(2);
  });

  it('M-14 cross-instance flushes stay serialized too (restore-path store racing the live store + a receive txn)', async () => {
    const { calls, db } = makeTxnTrackingDb();
    const liveStore = new SqlMessageStore(db as never);
    const restoreStore = new SqlMessageStore(db as never);
    await Promise.all([
      liveStore.upsertBatch([makeMsg('f')]),
      restoreStore.upsertBatch([makeMsg('g'), makeMsg('h')]),
      runWithRatchetTxn(db, async () => {
        await db.execute('INSERT INTO sessions VALUES (?)');
      }),
    ]);
    assertSerializedTrace(calls);
    expect(calls.filter(c => /^BEGIN/i.test(c))).toHaveLength(3);
    expect(calls.filter(c => c === 'COMMIT')).toHaveLength(3);
  });

  it('flags isInsideRatchetTxn() during the flush so nested store writers (saveIdentity) skip their own BEGIN', async () => {
    const flags: boolean[] = [];
    const db = {
      async execute(sql: string): Promise<{ rows: unknown[] }> {
        // doUpsert emits `INSERT OR REPLACE INTO messages (…)`.
        if (/INTO messages/i.test(sql)) { flags.push(isInsideRatchetTxn()); }
        return { rows: [] };
      },
    };
    const store = new SqlMessageStore(db as never);
    await store.upsertBatch([makeMsg('i')]);
    expect(flags).toEqual([true]);
    expect(isInsideRatchetTxn()).toBe(false); // released after COMMIT
  });
});

describe('P0-1(b) — transient local SQL errors classify leave-on-relay, never a discarded ack', () => {
  it('a transient failure inside the receive txn rolls back and classifies leave-on-relay', async () => {
    const busy = new Error('database is locked (5) (SQLITE_BUSY)');
    const { calls, db } = makeTxnTrackingDb({ failOn: /INSERT INTO messages/, failWith: busy });
    let caught: unknown;
    try {
      await runWithRatchetTxn(db, async () => {
        await db.execute('INSERT INTO sessions VALUES (?)'); // ratchet advance
        await db.execute('INSERT INTO messages VALUES (?)'); // plaintext write hits BUSY
      });
    } catch (e) { caught = e; }
    expect(caught).toBe(busy);
    // The ratchet advance was undone — a relay redelivery decrypts clean.
    expect(calls[calls.length - 1]).toBe('ROLLBACK');
    // The ack sites consult this classifier: transient ⇒ leaveOnRelay
    // (the ack is SKIPPED — the relay keeps the envelope and redelivers).
    // Pre-fix this fell into the catch-all and acked 'discarded', telling
    // the relay to DELETE a message it still held.
    expect(isTransientSqlError(caught)).toBe(true);
  });

  it('classifies every documented transient local failure as leave-on-relay', () => {
    const transient = [
      'cannot start a transaction within a transaction', // nested-txn collision
      'database is locked (5) (SQLITE_BUSY)',
      'database table is locked',
      'SQLITE_BUSY',
      'SQLITE_LOCKED',
      'disk I/O error',
      'SQLITE_IOERR: disk I/O error',
      'database or disk is full',
      'SQLITE_FULL',
    ];
    for (const msg of transient) {
      expect(isTransientSqlError(new Error(msg))).toBe(true);
    }
  });

  it('keeps terminal message-specific failures on the discarded path', () => {
    const terminal = [
      'bad MAC',
      'sealed-sender aad mismatch',
      'sender certificate expired',
      'signature verification failed',
      'malformed envelope',
      'CryptoError: decrypt failed',
    ];
    for (const msg of terminal) {
      expect(isTransientSqlError(new Error(msg))).toBe(false);
    }
    expect(isTransientSqlError(undefined)).toBe(false);
    expect(isTransientSqlError(null)).toBe(false);
    expect(isTransientSqlError({})).toBe(false);
  });
});

describe('B-72 — saveIdentity BEGIN must ride the one per-connection txn chain', () => {
  // Field evidence (emulator-5556 logcat, 2026-07-11 00:28, rapid-send burst):
  // "[sqlMessageStore] coalesced flush failed — cannot start a transaction
  // within a transaction", repeatedly. Send-path saveIdentity (X3DH
  // processPreKey) opened a raw BEGIN IMMEDIATE outside the chain while the
  // 50ms coalesced flush ran its CHAINED BEGIN on the same connection.
  // Fix: saveIdentity's own-transaction case now queues on runWithRatchetTxn.

  /** Stub with real SQLite semantics: a second BEGIN while a txn is open throws. */
  function makeStrictTxnDb() {
    const calls: string[] = [];
    let open = false;
    const db = {
      async execute(sql: string): Promise<{rows: unknown[]}> {
        // Yield so concurrent callers interleave like op-sqlite's native dispatch.
        await Promise.resolve();
        if (/^BEGIN/i.test(sql)) {
          if (open) {
            throw new Error(
              '[op-sqlite] statement execution error: cannot start a transaction within a transaction',
            );
          }
          open = true;
        } else if (/^(COMMIT|ROLLBACK)/i.test(sql)) {
          open = false;
        }
        calls.push(sql);
        return {rows: []};
      },
    };
    return {calls, db};
  }

  it('send-path saveIdentity racing a chained flush txn does not nest BEGINs', async () => {
    const {calls, db} = makeStrictTxnDb();
    const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as
      typeof import('../crypto/sqlCipherStore');
    const store = new SqlCipherProtocolStore(db as never);

    // Outside-chain saveIdentity (send path) fired concurrently with a
    // chained transaction (the coalesced message flush).
    const race = Promise.all([
      store.saveIdentity('peer.1', new Uint8Array([1, 2, 3]).buffer),
      runWithRatchetTxn(db, async () => {
        await db.execute('INSERT INTO messages VALUES (?)');
      }),
    ]);
    await expect(race).resolves.toBeDefined();

    // Every BEGIN must be balanced by COMMIT/ROLLBACK before the next BEGIN.
    let depth = 0;
    for (const sql of calls) {
      if (/^BEGIN/i.test(sql)) {depth++;}
      if (/^(COMMIT|ROLLBACK)/i.test(sql)) {depth--;}
      expect(depth).toBeLessThanOrEqual(1);
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('saveIdentity called INSIDE a chain txn runs raw (single outer BEGIN)', async () => {
    const {calls, db} = makeStrictTxnDb();
    const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as
      typeof import('../crypto/sqlCipherStore');
    const store = new SqlCipherProtocolStore(db as never);

    await runWithRatchetTxn(db, async () => {
      // decrypt → storeSession → saveIdentity, inside the receive txn
      await store.saveIdentity('peer.1', new Uint8Array([4, 5, 6]).buffer);
    });

    expect(calls.filter(s => /^BEGIN/i.test(s))).toHaveLength(1);
    expect(calls.filter(s => /^COMMIT/i.test(s))).toHaveLength(1);
  });
});

describe('B-75 — saveIdentity reached from runOnTxnChain work must NOT deadlock the chain', () => {
  // Field regression from the B-72 fix (commit 3ae4790): saveIdentity's
  // own-transaction case queued on runWithRatchetTxn. When reached from
  // INSIDE a runOnTxnChain body (decrypt-recovery: initOutgoingSession →
  // libsignal processPreKey → saveIdentity), it appended itself behind the
  // very chain frame awaiting it → the global txnChain froze forever,
  // stalling every later DB write (inbound persistence, coalesced flush,
  // message backup/restore). Symptom the founder reported: "backup so slow".

  /** Strict SQLite-semantics stub: a second BEGIN while one is open throws. */
  function makeStrictTxnDb() {
    const calls: string[] = [];
    let open = false;
    const db = {
      async execute(sql: string): Promise<{rows: unknown[]}> {
        await Promise.resolve();
        if (/^BEGIN/i.test(sql)) {
          if (open) {
            throw new Error(
              '[op-sqlite] statement execution error: cannot start a transaction within a transaction',
            );
          }
          open = true;
        } else if (/^(COMMIT|ROLLBACK)/i.test(sql)) {
          open = false;
        }
        calls.push(sql);
        return {rows: []};
      },
    };
    return {calls, db};
  }

  it('runOnTxnChain body that awaits saveIdentity RESOLVES (no deadlock) in ONE atomic inline txn', async () => {
    const {calls, db} = makeStrictTxnDb();
    const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as
      typeof import('../crypto/sqlCipherStore');
    const {runOnTxnChain} = require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction');
    const store = new SqlCipherProtocolStore(db as never);

    // Mirrors runDecryptRecovery: runOnTxnChain(() => initOutgoingSession(...))
    // whose libsignal internals await storage.saveIdentity. Pre-fix this hung.
    // (If it deadlocks, this await never settles and Jest fails on timeout.)
    const result = await runOnTxnChain(async () => {
      await store.saveIdentity('peer.1', new Uint8Array([7, 8, 9]).buffer);
      return 'recovered';
    });

    expect(result).toBe('recovered');
    // B-75 fix: context (2) opens its OWN inline BEGIN/COMMIT (atomic, exclusive)
    // — not a raw autocommit (would lose P0-S6 atomicity) and not a chain re-queue
    // (would deadlock). Exactly one balanced transaction.
    expect(calls.filter(s => /^BEGIN/i.test(s))).toHaveLength(1);
    expect(calls.filter(s => /^COMMIT/i.test(s))).toHaveLength(1);
    expect(calls[0]).toBe('BEGIN IMMEDIATE');
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  it('wraps the trusted_identities UPSERT AND the identity_rotations INSERT in the SAME inline txn (P0-S6, key rotation)', async () => {
    // Regression for the review finding: on a key ROTATION during recovery, both
    // writes must be atomic so a crash can't desync the forensic rotation log.
    const {calls, db} = makeStrictTxnDb();
    const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as
      typeof import('../crypto/sqlCipherStore');
    const {runOnTxnChain} = require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction');
    // Strict stub that ALSO returns an existing (different) key for the snapshot
    // SELECT so saveIdentity sees changed===true and emits the rotation INSERT.
    let open = false;
    const rotCalls: string[] = [];
    const rotDb = {
      async execute(sql: string): Promise<{rows: unknown[]}> {
        await Promise.resolve();
        if (/^BEGIN/i.test(sql)) { if (open) {throw new Error('cannot start a transaction within a transaction');} open = true; }
        else if (/^(COMMIT|ROLLBACK)/i.test(sql)) { open = false; }
        rotCalls.push(sql);
        if (/SELECT identity_key FROM trusted_identities/i.test(sql)) {
          return {rows: [{identity_key: new Uint8Array([1, 2, 3])}]}; // differs from incoming
        }
        return {rows: []};
      },
    };
    void db; void calls;
    const store = new SqlCipherProtocolStore(rotDb as never);
    await runOnTxnChain(async () => {
      await store.saveIdentity('peer.1', new Uint8Array([9, 9, 9]).buffer); // new key ⇒ rotation
    });
    const beginIdx = rotCalls.findIndex(s => /^BEGIN/i.test(s));
    const commitIdx = rotCalls.findIndex(s => /^COMMIT/i.test(s));
    const upsertIdx = rotCalls.findIndex(s => /INSERT INTO trusted_identities/i.test(s));
    const rotationIdx = rotCalls.findIndex(s => /INSERT INTO identity_rotations/i.test(s));
    expect(beginIdx).toBe(0);
    expect(upsertIdx).toBeGreaterThan(beginIdx);
    expect(rotationIdx).toBeGreaterThan(upsertIdx);
    expect(commitIdx).toBeGreaterThan(rotationIdx); // both writes committed together
    expect(rotCalls.filter(s => /^BEGIN/i.test(s))).toHaveLength(1);
  });

  it('the chain is NOT frozen — a runWithRatchetTxn queued after recovery still runs', async () => {
    const {calls, db} = makeStrictTxnDb();
    const {SqlCipherProtocolStore} = require('../crypto/sqlCipherStore') as
      typeof import('../crypto/sqlCipherStore');
    const {runOnTxnChain} = require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction');
    const store = new SqlCipherProtocolStore(db as never);

    const recovery = runOnTxnChain(async () => {
      await store.saveIdentity('peer.1', new Uint8Array([1]).buffer);
    });
    // A normal receive txn queued right behind recovery. Pre-fix it never ran
    // because the chain was deadlocked on recovery's self-enqueued saveIdentity.
    const later = runWithRatchetTxn(db, async () => {
      await db.execute('INSERT INTO messages VALUES (?)');
    });

    await expect(Promise.all([recovery, later])).resolves.toBeDefined();
    // Two balanced txns ran in sequence — recovery's inline saveIdentity BEGIN
    // AND the later receive txn. Pre-fix the later txn never ran (chain frozen).
    expect(calls.filter(s => /^BEGIN/i.test(s))).toHaveLength(2);
    expect(calls.filter(s => /^COMMIT/i.test(s))).toHaveLength(2);
    // The last statements are the later txn — proof the chain advanced past recovery.
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  it('isOnTxnChain() is true only while a runOnTxnChain body runs, false after', async () => {
    const {isOnTxnChain, runOnTxnChain} = require('../runtime/receiveTransaction') as
      typeof import('../runtime/receiveTransaction');
    expect(isOnTxnChain()).toBe(false);
    let insideFlag = false;
    await runOnTxnChain(async () => { insideFlag = isOnTxnChain(); });
    expect(insideFlag).toBe(true);
    expect(isOnTxnChain()).toBe(false);
  });
});
