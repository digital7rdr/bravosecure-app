/**
 * Audit P0-N14 — atomic ratchet+plaintext writes.
 *
 * The receive path runs:
 *   1. own.decrypt(peer, ct)          → libsignal advances ratchet,
 *                                        writes new session row via
 *                                        storeSession (one SQL stmt)
 *   2. parse / verify cert / AAD / expiry
 *   3. sqlMessages.upsert(localMsg)   → writes plaintext row (another
 *                                        SQL stmt on the SAME DbHandle)
 *
 * Each step is autocommit. A crash between 1 and 3 advances the ratchet
 * without persisting the plaintext — the next time the relay redelivers
 * the SAME ciphertext (which it WILL, because we ack only after step 3),
 * libsignal throws "bad MAC" because the message key already burned.
 *
 * Fix: wrap the entire receive critical section in a single SQLite
 * transaction on the shared DbHandle. Both libsignal's session UPSERT
 * and our plaintext UPSERT run inside the transaction; either both
 * commit or neither does. On any throw, ROLLBACK undoes the ratchet
 * advance, and the redelivered ciphertext decrypts fine on retry.
 *
 * Implementation notes:
 *  - `BEGIN IMMEDIATE` acquires the RESERVED lock up front so a
 *    concurrent writer doesn't lock-step us into SQLITE_BUSY mid-decrypt
 *    after the ratchet has already advanced in JS-side state.
 *  - ROLLBACK is best-effort; if it fails the WAL will replay it on
 *    next open. We re-throw the original error either way.
 *  - The helper is intentionally generic — it does not import the
 *    runtime or the messenger store — so it can be unit-tested with a
 *    minimal stub DbHandle (see receiveTransaction.test.ts).
 */

/** Minimal subset of the op-sqlite handle we depend on. */
export interface TxnDbHandle {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

// Why: op-sqlite (and SQLite in general) does NOT support nested
// transactions on the same connection — issuing `BEGIN IMMEDIATE`
// while another txn is already open throws "cannot start a transaction
// within a transaction". The receive path calls runWithRatchetTxn
// once per envelope; when the relay flushes N pending envelopes on
// reconnect they ALL dispatch in parallel via `void handleServerFrame`,
// and envelopes 2..N each crash on their BEGIN. Field evidence
// (Pixel 6a, v1.0.34) showed every catch-up envelope failing with
// exactly that error, leaving `handled=false` and the plaintext
// never rendered. Serialize with a single Promise-chain mutex so
// each txn runs to COMMIT/ROLLBACK before the next one starts.
let txnChain: Promise<unknown> = Promise.resolve();

// Why: op-sqlite has ONE connection per DB handle, and SQLite refuses
// nested BEGINs ("cannot start a transaction within a transaction").
// Other writers like `SqlCipherProtocolStore.saveIdentity` open their
// own BEGIN IMMEDIATE — when called from INSIDE a `runWithRatchetTxn`
// block (e.g. libsignal decrypt → storeSession → saveIdentity), the
// second BEGIN throws. This module-level flag lets those nested
// writers detect they're already inside a transaction and skip their
// own BEGIN/COMMIT (the outer block will commit/rollback the whole
// chain atomically).
let _txnOpen = false;

// Audit B-75 (2026-07-11) — a `runOnTxnChain` body executes AS a chain frame
// but opens NO BEGIN of its own (that is its whole purpose). The libsignal
// session ops it runs during decrypt-recovery (`closeSession` /
// `initOutgoingSession`) call `saveIdentity` internally. Before this counter
// existed, that inner `saveIdentity` saw `isInsideRatchetTxn() === false` and
// re-appended itself to `txnChain` via `runWithRatchetTxn` — i.e. it queued
// BEHIND the very chain frame that was awaiting it. Circular wait → `txnChain`
// froze for the process lifetime, stalling EVERY subsequent DB write (inbound
// receive txns, the coalesced status-flush, message backup/restore). This
// depth counter lets chain-resident writers detect that they already hold the
// chain exclusively and run their body directly (autocommit — safe, since no
// other chain frame can run concurrently) instead of deadlocking on a re-queue.
let _onChainDepth = 0;

export function isInsideRatchetTxn(): boolean {
  return _txnOpen;
}

/**
 * True while a `runOnTxnChain` body is executing — i.e. the caller already
 * holds the per-connection txn chain exclusively but has NO open BEGIN.
 * Chain-resident writers (`SqlCipherProtocolStore.saveIdentity`, reached via
 * libsignal `closeSession` / `initOutgoingSession` during recovery) consult
 * this to run their body directly rather than re-queue on the chain, which
 * would deadlock (B-75).
 */
export function isOnTxnChain(): boolean {
  return _onChainDepth > 0;
}

/**
 * Run `work` inside a `BEGIN IMMEDIATE` / `COMMIT` transaction on `db`.
 * Any throw inside `work` triggers `ROLLBACK` and re-throws the
 * original error. The transaction is per-connection, so all SQL
 * statements `work` issues on the same handle (directly or via stores
 * that share the handle) are atomic.
 *
 * Concurrent callers are serialized via `txnChain` — see the note
 * above. Each call appends to the chain and only resolves once its
 * own txn has committed (or rolled back).
 *
 * Audit P0-1 (2026-07-09) — this is THE per-connection exclusive-txn
 * runner. EVERY explicit multi-statement BEGIN…COMMIT on the shared
 * SQLCipher connection must run through it (or through runOnTxnChain).
 * The M-14 coalesced status-flush (`SqlMessageStore.upsertBatch`)
 * previously drove its own independent mutex, so a receive
 * `BEGIN IMMEDIATE` could land inside an open flush txn and throw
 * "cannot start a transaction within a transaction" — which the ack
 * classifier then treated as terminal, ack-`discarded`ing (destroying)
 * a committed inbound message. One chain ⇒ one open txn at a time.
 */
export async function runWithRatchetTxn<T>(
  db: TxnDbHandle,
  work: () => Promise<T>,
): Promise<T> {
  const run = async (): Promise<T> => {
    await db.execute('BEGIN IMMEDIATE');
    _txnOpen = true;
    try {
      const result = await work();
      await db.execute('COMMIT');
      return result;
    } catch (err) {
      try {
        await db.execute('ROLLBACK');
      } catch {
        // Best-effort; WAL recovery on next open will tidy up.
      }
      throw err;
    } finally {
      _txnOpen = false;
    }
  };
  // Chain on a swallowed-error tail so one caller's throw doesn't
  // poison subsequent callers — they see their OWN result/error.
  const next = txnChain.then(run, run);
  txnChain = next.catch(() => undefined);
  return next;
}

/**
 * Audit B-75 (2026-07-11) — open a `BEGIN IMMEDIATE`/`COMMIT` transaction on
 * `db` WITHOUT appending to `txnChain`. Only safe to call when the caller
 * ALREADY holds the chain exclusively (i.e. `isOnTxnChain()` — a runOnTxnChain
 * recovery frame is executing), so no other chain frame can open a competing
 * BEGIN. Used by `SqlCipherProtocolStore.saveIdentity` in the recovery context:
 * re-queuing on `runWithRatchetTxn` there would DEADLOCK (it would wait behind
 * the very frame awaiting it), and running raw would drop the P0-S6 atomicity of
 * the trusted_identities UPSERT + identity_rotations INSERT.
 *
 * Race-safety: `_txnOpen` is set SYNCHRONOUSLY as the first statement (before the
 * BEGIN await), and callers gate on `isInsideRatchetTxn()` before deciding to
 * open their own BEGIN. Because that check-and-set is contiguous and synchronous
 * on the single-threaded event loop, two writers can never both pass the check as
 * false — whoever runs first flips `_txnOpen` before yielding, so the other joins
 * the open txn (runs raw) instead of issuing a second, colliding BEGIN.
 */
export async function runRatchetTxnInline<T>(
  db: TxnDbHandle,
  work: () => Promise<T>,
): Promise<T> {
  _txnOpen = true;
  try {
    await db.execute('BEGIN IMMEDIATE');
    const result = await work();
    await db.execute('COMMIT');
    return result;
  } catch (err) {
    try {
      await db.execute('ROLLBACK');
    } catch {
      // Best-effort; WAL recovery on next open will tidy up.
    }
    throw err;
  } finally {
    _txnOpen = false;
  }
}

/**
 * Run `work` on the SAME serialization chain as runWithRatchetTxn but
 * WITHOUT wrapping in BEGIN IMMEDIATE / COMMIT. Use for follow-on
 * libsignal session writes (closeSession + initOutgoingSession) that
 * must NOT overlap with a concurrent envelope's open transaction — if
 * they do, op-sqlite reports "cannot start a transaction within a
 * transaction" because the open BEGIN holds the connection.
 *
 * Why this exists: runDecryptRecovery runs AFTER runWithRatchetTxn
 * commits, but other envelopes can be inside their own BEGIN IMMEDIATE
 * concurrently. Field evidence (Pixel 6a, v1.0.37): "[messenger]
 * recovery failed err=cannot start a transaction within a transaction"
 * fired repeatedly for the SAME peer because the recovery's session
 * writes raced a still-open receive txn. Queue the recovery on the
 * same chain so it waits its turn.
 */
export async function runOnTxnChain<T>(work: () => Promise<T>): Promise<T> {
  // Serializes work on the same chain as runWithRatchetTxn so concurrent
  // callers don't race the connection — but does NOT open a BEGIN.
  // Used for libsignal closeSession / initOutgoingSession during
  // recovery; those operations call saveIdentity internally, which
  // detects it is chain-resident (isOnTxnChain) and runs its body
  // directly (autocommit) — our serialization guarantees no other chain
  // frame runs concurrently, so no BEGIN can collide.
  //
  // B-75: mark chain residency for the duration of `work` so a nested
  // saveIdentity does NOT re-queue on the chain it already occupies
  // (which would deadlock — it would wait behind this frame).
  const run = async (): Promise<T> => {
    _onChainDepth += 1;
    try {
      return await work();
    } finally {
      _onChainDepth -= 1;
    }
  };
  const next = txnChain.then(run, run);
  txnChain = next.catch(() => undefined);
  return next;
}

/**
 * Audit P0-1(b) — transient LOCAL SQL failure classifier for the
 * receive ack sites.
 *
 * The relay's `discarded` disposition is a DELETE instruction: the
 * relay drops the envelope and tells the sender "undelivered". That is
 * only honest for terminal, message-specific failures (cert/AAD
 * reject, bad MAC, tamper-final). A transient LOCAL storage failure —
 * nested-transaction collision, SQLITE_BUSY/locked from a concurrent
 * handle, disk I/O pressure — says nothing about the message itself:
 * the relay still holds a perfectly deliverable copy, and the receive
 * txn rolled back (no ratchet advance), so a later redelivery decrypts
 * clean. Classifying these as leave-on-relay (skip the ack; the relay
 * redelivers within its 30-day dwell) instead of ack-`discarded`
 * prevents a local hiccup from permanently destroying a committed
 * inbound message.
 *
 * Deliberately matched on the message string: op-sqlite surfaces
 * native SQLite errors as plain `Error`s with the sqlite3 result text,
 * so there is no error class or code to switch on.
 */
const TRANSIENT_SQL_ERROR_RE =
  /cannot start a transaction within a transaction|database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED|disk i\/o error|SQLITE_IOERR|database or disk is full|SQLITE_FULL/i;

export function isTransientSqlError(err: unknown): boolean {
  if (err === null || err === undefined) {return false;}
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return TRANSIENT_SQL_ERROR_RE.test(msg);
}
