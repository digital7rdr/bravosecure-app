/**
 * Round 5 / Security S8 — produce + commit a signed Merkle root over
 * the user's mirrored backup messages.
 *
 * Called after a successful mirror-flush burst (debounced — see
 * MERKLE_DEBOUNCE_MS in messageMirror.ts — so we don't sign once per
 * message), on AppState backgrounding when a commit is pending (B-45
 * R3), AND once at backup setup time after the outbox drains.
 * Restore-side verifyMerkleCommit checks the signed root against the
 * rows the server hands back — divergence is treated as a tampering /
 * rollback attack and the restore is refused.
 *
 * Sequence numbers are local-monotonic per (userId, deviceId), kept
 * in AsyncStorage so a re-login on the same device can detect a
 * server replay (server returns an older `seq` than the device last
 * sent). Fresh-device restore can't catch a replay — that's covered
 * elsewhere by the user's awareness of their own message volume.
 *
 * Failures are best-effort: a network blip during the commit upload
 * doesn't block the user; the next commit will overwrite + bring us
 * back into sync. The server stores at most one commit per user.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';
import {hmac} from '@noble/hashes/hmac.js';
import {sha256} from '@noble/hashes/sha2.js';
import {backupClient, BackupError} from './backupClient';
import {getFlushEpoch, clearMerkleCommitPendingIfNoFlushSince} from './mirrorLedger';
import {computeMerkleRoot, computeRootFromLeaves, canonicalCommitDigest, computeLeaf, sortMerkleLeaves, type MerkleRow, type MerkleLeaf} from './backupMerkle';
import {toB64, fromB64} from './backupCrypto';
import {getOrCreateMerkleSeqHmacKey} from '../runtime/keychain';

const curve = new AsyncCurve25519Wrapper();

const SEQ_KEY_PREFIX = 'bravo:backup:merkle-seq:';

/**
 * Audit P1-N12 — the Merkle commit sequence number used to live in
 * unencrypted AsyncStorage as a plain decimal string. An attacker with
 * write access to AsyncStorage (rooted device, sibling app via shared
 * storage on some Android builds, or a malicious developer-mode user)
 * could flip the cached value backwards and silently defeat the
 * rollback-detection in verifyMerkleCommit at line 201: the server
 * replays an OLD commit, the cached seq has been lowered to match, and
 * the `commit.seq < cached` check no longer fires.
 *
 * Mitigation: store the seq alongside an HMAC-SHA256 tag computed over
 * `userId || ":" || seq` keyed by a per-user keychain secret. The tag
 * is verified on load; any tampering (or a missing tag — i.e. the
 * legacy value-only format from before P1-N12) is treated as "seq
 * unknown", which forces `verifyMerkleCommit` to skip the local
 * rollback check rather than trust an unauthenticated value.
 *
 * The HMAC secret lives in the keychain via `getOrCreateMerkleSeqHmacKey`
 * (see voipWakeVerify-style accessor) so even an attacker who can write
 * to AsyncStorage cannot mint a valid tag for an arbitrary seq.
 */
const SEQ_FORMAT_VERSION = 'v2';

function tagSeq(secretB64: string, userId: string, seq: number): string {
  const key = Buffer.from(secretB64, 'base64');
  const msg = Buffer.from(`${userId}:${seq}`, 'utf8');
  return Buffer.from(hmac(sha256, key, msg)).toString('base64');
}

function timingSafeEqB64(a: string, b: string): boolean {
  if (a.length !== b.length) {return false;}
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function readSeq(userId: string, secretB64: string): Promise<number> {
  const raw = await AsyncStorage.getItem(`${SEQ_KEY_PREFIX}${userId}`);
  if (!raw) {return 0;}
  // Try the v2 tagged form first.
  try {
    const parsed = JSON.parse(raw) as {v?: string; seq?: number; tag?: string};
    if (parsed?.v === SEQ_FORMAT_VERSION && typeof parsed.seq === 'number' && typeof parsed.tag === 'string') {
      const expected = tagSeq(secretB64, userId, parsed.seq);
      if (timingSafeEqB64(parsed.tag, expected)) {
        return parsed.seq > 0 ? parsed.seq : 0;
      }
      // Tag mismatch — tampered or wrong secret. Treat as unknown so
      // the verifier downgrades to "no local anchor" instead of
      // trusting a forged value.
      console.warn('[backup.merkle] cached seq tag invalid — treating as unknown');
      return 0;
    }
  } catch {
    // Not JSON — could be a legacy v1 raw-number value.
  }
  // Legacy v1 — plain decimal. We don't trust the value (P1-N12) but
  // we also don't want to lose the user's anchor entirely on the
  // version upgrade; return 0 so the next commit re-establishes the
  // tagged form, and the FIRST verify after upgrade tolerates the
  // missing anchor.
  return 0;
}

async function writeSeq(userId: string, secretB64: string, seq: number): Promise<void> {
  const payload = JSON.stringify({
    v:   SEQ_FORMAT_VERSION,
    seq,
    tag: tagSeq(secretB64, userId, seq),
  });
  await AsyncStorage.setItem(`${SEQ_KEY_PREFIX}${userId}`, payload);
}


/**
 * Compute, sign, and ship the Merkle commit. Returns the (rootB64,
 * seq) pair so callers can stash it locally as the latest committed
 * snapshot — used for cross-session rollback detection.
 *
 *   identityPrivKey: 32-byte Curve25519 priv key. Same key the
 *     sender cert signing uses; recovered from the local CryptoStore
 *     via getIdentityKeyPair().
 *   userId:          for the per-user seq counter
 *
 * Throws on failure; callers wrap in try/catch + log so a network
 * blip doesn't surface as a user-visible error.
 */
export async function commitMerkleRoot(p: {
  identityPrivKey: ArrayBuffer;
  userId:          string;
  /**
   * Round 9 / S8 self-heal — optional pre-collected rows. When the
   * restore path re-commits to reconcile a benign drift, it passes the
   * EXACT rows it will re-verify against, so the signed root is computed
   * over the identical byte-form (no second /backup/messages re-fetch
   * that could itself drift). When omitted, the function page-walks the
   * server as normal (the live mirror-flush commit path).
   */
  rows?:           MerkleRow[];
  /**
   * M-12 — pre-hashed leaves (memory-bounded self-heal). The restore path
   * keeps only 32-byte leaves, not full ciphertext; when it re-commits it
   * passes those leaves so we sign the identical root without needing the
   * ciphertext back.
   */
  leaves?:         MerkleLeaf[];
}): Promise<{rootB64: string; seq: number; rowCount: number} | null> {
  // B-94 — snapshot the flush epoch BEFORE the server walk. If a flush
  // lands while we're walking/signing, this commit covers a stale byte
  // set; the pending flag must survive so the follow-up commit (or the
  // next boot sweep) re-signs over the newer bytes.
  const flushEpochAtStart = getFlushEpoch();
  let root: Uint8Array;
  let rowCount: number;
  if (p.leaves) {
    // M-12 fast path — root from pre-hashed leaves.
    root = computeRootFromLeaves(p.leaves);
    rowCount = p.leaves.length;
  } else {
  // 1. Pull every committed row. We page-cursor through /backup/messages
  // because the endpoint caps at 1000 per call. Empty backups return
  // a constant root — still worth committing so the user has a baseline
  // for future delta detection.
  const allRows: MerkleRow[] = [];
  // Round 9 / S8 self-heal — when the caller supplies the rows (restore
  // reconciliation), sign exactly those; skip the server re-walk so the
  // signed root is byte-identical to what the restore re-verifies.
  if (p.rows) {
    allRows.push(...p.rows);
  } else {
  // Tuple cursor (msg_created_at, message_id) — MUST match the paging
  // restoreMessages.ts uses. A timestamp-only cursor drops rows that
  // share a msg_created_at across a page boundary, so this side would
  // sign a root over fewer rows than the restore side recomputes →
  // every restore for a >1000-message account fails verifyMerkleCommit
  // with `root_mismatch` even with no tampering.
  let cursorTs: string | undefined;
  let cursorId: string | undefined;
  for (let page = 0; page < 1000; page++) {
    let chunk: {messages: Array<{message_id: string; msg_created_at: string; ciphertext: string}>};
    try {
      chunk = await backupClient.getMessages(cursorTs, 1000, cursorId);
    } catch (e) {
      if (e instanceof BackupError && (e.kind === 'no_backup' || e.kind === 'service_disabled')) {
        // No backup yet — nothing to commit.
        return null;
      }
      throw e;
    }
    if (chunk.messages.length === 0) {break;}
    for (const m of chunk.messages) {
      allRows.push({
        message_id:     m.message_id,
        msg_created_at: m.msg_created_at,
        ciphertext:     m.ciphertext,
      });
    }
    const tail = chunk.messages[chunk.messages.length - 1];
    cursorTs = tail.msg_created_at;
    cursorId = tail.message_id;
    if (chunk.messages.length < 1000) {break;}
  }
  }
  root = computeMerkleRoot(allRows);
  rowCount = allRows.length;
  }

  // 2. Sign the root.
  const rootB64 = toB64(root);
  // Audit P1-N12 — tagged seq backed by a keychain HMAC secret. The
  // secret is provisioned lazily on first commit so existing accounts
  // upgrade transparently; the FIRST verify after the upgrade has no
  // cached anchor (legacy untagged value drops to "unknown"), which
  // matches the no-prior-session-on-this-device case the function
  // already handles. After that every subsequent commit + verify pair
  // uses tagged storage.
  const seqHmacKey = await getOrCreateMerkleSeqHmacKey(p.userId);
  // F8 — compute the next seq but DON'T persist it until the commit
  // actually ships. Persisting first meant a failed upload advanced the
  // local seq past the server's stored commit, so a later same-device
  // restore saw `commit.seq < cached` and hard-failed with a false
  // 'rollback' on a perfectly healthy backup (contrast the ratchet
  // scheduler, which already persists seq only after a successful upload).
  const curSeq = await readSeq(p.userId, seqHmacKey);
  const seq = curSeq > 0 ? curSeq + 1 : 1;
  const sentAtMs = Date.now();
  const digest = canonicalCommitDigest({
    rootB64,
    rowCount,
    seq,
    sentAtMs,
  });
  const digestAb = new ArrayBuffer(digest.byteLength);
  new Uint8Array(digestAb).set(digest);
  const sig = await curve.sign(p.identityPrivKey, digestAb);
  const sigB64 = toB64(new Uint8Array(sig));

  // 3. Ship.
  let shippedSeq = seq;
  try {
    await backupClient.putMerkleCommit({
      rootB64,
      rowCount,
      seq,
      sentAtMs,
      sigB64,
    });
  } catch (e) {
    if (e instanceof BackupError && e.kind === 'service_disabled') {
      // Server doesn't have the merkle endpoint yet (deployment lag).
      // Don't error the caller; just log.
      console.warn('[backup.merkle] commit endpoint not enabled on server — skipping');
      return null;
    }
    // B-50 — the server's monotonic guard 409'd because our LOCAL seq
    // cache is behind the stored commit (fresh install / reinstall: the
    // keychain cache starts at 0, so the first commit ships seq=1 while
    // the old device's commits pushed the server far past that). The 409
    // body carries the stored seq — adopt currentSeq+1, re-sign, retry
    // ONCE. This is what let the restore S8 self-heal hard-fail with
    // root_mismatch on every fresh-device restore, and would have made
    // every post-restore live mirror commit 409 forever.
    const staleSeq = e instanceof BackupError && e.kind === 'stale_seq'
      ? Number((e.meta as {currentSeq?: number} | undefined)?.currentSeq)
      : NaN;
    if (!Number.isFinite(staleSeq)) {throw e;}
    const adopted = staleSeq + 1;
    console.warn(`[backup.merkle] stale_seq local=${seq} server=${staleSeq} — adopting seq=${adopted} and retrying once`);
    const retrySentAtMs = Date.now();
    const retryDigest = canonicalCommitDigest({rootB64, rowCount, seq: adopted, sentAtMs: retrySentAtMs});
    const retryDigestAb = new ArrayBuffer(retryDigest.byteLength);
    new Uint8Array(retryDigestAb).set(retryDigest);
    const retrySig = await curve.sign(p.identityPrivKey, retryDigestAb);
    await backupClient.putMerkleCommit({
      rootB64,
      rowCount,
      seq:      adopted,
      sentAtMs: retrySentAtMs,
      sigB64:   toB64(new Uint8Array(retrySig)),
    });
    shippedSeq = adopted;
  }
  // F8 — persist the seq ONLY after a successful ship.
  await writeSeq(p.userId, seqHmacKey, shippedSeq);
  // B-94 — a signed commit is now on the server; retire the pending
  // flag unless a flush interleaved with the walk (epoch guard).
  await clearMerkleCommitPendingIfNoFlushSince(p.userId, flushEpochAtStart);
  return {rootB64, seq: shippedSeq, rowCount};
}

/**
 * Round 5 / Security S8 — verify the server-stored commit against the
 * rows we just restored. Returns `{ok: true}` if the recomputed root
 * matches the signed one AND the signature verifies under the user's
 * identity public key.
 *
 * Returns `{ok: false, reason}` on:
 *   • no_commit       — server GENUINELY has no commit row yet (legacy
 *                       account / pre-S8 server responding cleanly)
 *   • commit_fetch_failed — the commit endpoint ERRORED (network / 5xx /
 *                       auth). P2-B-1: distinct from no_commit so a server
 *                       cannot skip S8 entirely by erroring the endpoint;
 *                       callers must treat this as a hard verification
 *                       failure, never a soft-pass.
 *   • bad_sig         — signature doesn't verify under the identity pub key
 *   • root_mismatch   — recomputed root doesn't match the signed root
 *   • rollback        — local cached seq is HIGHER than the server's
 *                       (i.e. the server gave us an older commit than
 *                       we last shipped from this device)
 *
 * Caller is expected to ABORT the restore on any !ok return.
 */
export async function verifyMerkleCommit(p: {
  identityPubKey:  ArrayBuffer;     // 32-byte Curve25519 pub key
  userId:          string;
  /**
   * Rows the server returned during restore. The verifier sorts them
   * the same way the committer does, recomputes the root, and
   * compares against the signed value.
   */
  rows:            MerkleRow[];
  /**
   * M-12 — pre-hashed leaves. When supplied, they are used instead of
   * `rows` (which may then be empty) so the restore path can verify
   * without holding every row's full ciphertext in memory.
   */
  leaves?:         MerkleLeaf[];
  /**
   * Optional override for the server commit (test injection). When
   * omitted, fetches from the server.
   */
  commit?:         {rootB64: string; rowCount: number; seq: number; sentAtMs: number; sigB64: string} | null;
  /**
   * Audit P0-B3 — optional override for the server-anchored sessions
   * seq (test injection). When omitted, fetches via
   * backupClient.getSessions. `null` means "treat as legacy / no
   * server anchor" and skips the new gate (degrades to the local-only
   * check above).
   */
  serverSeq?:      number | null;
}): Promise<{ok: true} | {ok: false; reason: 'no_commit' | 'commit_fetch_failed' | 'bad_sig' | 'root_mismatch' | 'rows_count_mismatch' | 'rows_count_grew' | 'rollback' | 'server_rollback' | 'malformed'}> {
  // P2-B-1 — a fetch ERROR must not collapse into the no_commit
  // soft-pass (the previous `.catch(() => null)` let a server skip S8
  // wholesale by 500ing the endpoint). Only a clean "no commit stored"
  // response (null) is the legacy soft-pass case.
  let commit: {rootB64: string; rowCount: number; seq: number; sentAtMs: number; sigB64: string} | null;
  if (p.commit !== undefined) {
    commit = p.commit;
  } else {
    try {
      commit = await backupClient.getMerkleCommit();
    } catch (e) {
      console.warn('[backup.merkle] commit fetch errored — hard verification failure:', (e as Error).message);
      return {ok: false, reason: 'commit_fetch_failed'};
    }
  }
  if (!commit) {return {ok: false, reason: 'no_commit'};}

  // 1. Verify the signature first — protects against a server that
  // forges a "matching root" by hashing-then-shipping their tampered
  // rows: without our priv key they can't sign the canonical bytes.
  let sigBytes: Uint8Array;
  try { sigBytes = new Uint8Array(fromB64(commit.sigB64)); }
  catch { return {ok: false, reason: 'malformed'}; }
  if (sigBytes.byteLength !== 64) {return {ok: false, reason: 'malformed'};}
  const digest = canonicalCommitDigest({
    rootB64:  commit.rootB64,
    rowCount: commit.rowCount,
    seq:      commit.seq,
    sentAtMs: commit.sentAtMs,
  });
  const digestAb = new ArrayBuffer(digest.byteLength);
  new Uint8Array(digestAb).set(digest);
  const sigAb = new ArrayBuffer(sigBytes.byteLength);
  new Uint8Array(sigAb).set(sigBytes);
  // Strip the 0x05 DJB type byte if libsignal-prefixed.
  const pubBytes = new Uint8Array(p.identityPubKey);
  let rawPub: Uint8Array;
  if (pubBytes.byteLength === 33 && pubBytes[0] === 0x05) {
    rawPub = pubBytes.subarray(1);
  } else if (pubBytes.byteLength === 32) {
    rawPub = pubBytes;
  } else {
    return {ok: false, reason: 'malformed'};
  }
  const pubAb = new ArrayBuffer(rawPub.byteLength);
  new Uint8Array(pubAb).set(rawPub);

  const sigInvalid = await curve.verify(pubAb, digestAb, sigAb);
  if (sigInvalid) {return {ok: false, reason: 'bad_sig'};}

  // 2. Recompute the root and compare. M-12 — prefer pre-hashed leaves.
  const rowCount = p.leaves ? p.leaves.length : p.rows.length;
  const root = p.leaves ? computeRootFromLeaves(p.leaves) : computeMerkleRoot(p.rows);
  if (toB64(root) !== commit.rootB64) {
    // Operational warn (non-sensitive: counts + seq only) — a count
    // delta points at a row-set divergence; equal counts at a per-row
    // serialization drift, which the restore self-heal re-commit covers.
    console.warn(
      `[backup.merkle] root_mismatch rows=${rowCount} committed=${commit.rowCount} seq=${commit.seq}`,
    );
    // H-4 / B-45 R3 — a row-count divergence is direction-sensitive:
    //   • FEWER fetched rows than signed = omission/rollback — precisely
    //     the tamper the Merkle layer exists to catch. Hard failure; must
    //     NOT be self-healed by re-signing over the reduced set.
    //   • MORE fetched rows than signed = the mirror kept uploading after
    //     the last commit (post-flush debounce lag / background kill —
    //     the normal state, proven with live staging data 2026-07-05:
    //     committed=3 vs server=14 on an untampered account).
    //
    // P2-B-1 — growth alone is no longer enough to unlock the self-heal:
    // a server could substitute rows AND pad the count. `rows_count_grew`
    // is returned only when the growth is VERIFIABLY ADDITIVE — the
    // sorted (msg_created_at, message_id) prefix of the fetched set, at
    // the committed row count, must reproduce the signed root exactly
    // (post-commit mirror uploads always sort after the committed tail).
    // Any grown set that fails the prefix check gets the hard
    // 'rows_count_mismatch' so the restore surfaces it instead of
    // re-signing over a substituted history.
    if (rowCount !== commit.rowCount) {
      if (rowCount > commit.rowCount) {
        const allLeaves = p.leaves ?? p.rows.map(computeLeaf);
        const prefix = sortMerkleLeaves(allLeaves).slice(0, commit.rowCount);
        if (toB64(computeRootFromLeaves(prefix)) === commit.rootB64) {
          return {ok: false, reason: 'rows_count_grew'};
        }
        console.warn('[backup.merkle] grown set is NOT an additive superset of the signed root — hard fail');
      }
      return {ok: false, reason: 'rows_count_mismatch'};
    }
    return {ok: false, reason: 'root_mismatch'};
  }

  // 3. Local rollback detection — if we have a cached seq from a
  // prior session on this device, the server's seq must be >= that.
  // A lower seq means the server replayed an old commit.
  //
  // Audit P1-N12 — read through the HMAC-tagged accessor so a tampered
  // AsyncStorage value (lowered by an attacker to silence the check)
  // fails tag verification and is reported as `cached = 0`. The
  // verifier then degrades to "no local anchor" rather than trusting
  // the forged value.
  const seqHmacKey = await getOrCreateMerkleSeqHmacKey(p.userId);
  const cached = await readSeq(p.userId, seqHmacKey);
  if (Number.isFinite(cached) && commit.seq < cached) {
    return {ok: false, reason: 'rollback'};
  }

  // BS-BACKUP-ROLLBACK (was Audit P0-B3) — the server-anchored gate that
  // used to live here cross-compared TWO UNRELATED monotonic counters and
  // produced false-positive "server_rollback" failures on healthy backups:
  //
  //   • commit.seq  — the Merkle-COMMIT seq (bravo:backup:merkle-seq:*),
  //     bumped only when a backup COMMIT is made (merkleCommit.nextSeq).
  //   • serverSeq   — the SESSION-SNAPSHOT seq (/backup/identity/sessions),
  //     bumped by the ratchet-snapshot SCHEDULER on routine session
  //     activity (ratchetSnapshotScheduler.ts), far more frequently.
  //
  // These advance at different rates by design — the session-snapshot seq
  // legitimately races ahead of the commit seq (observed live: commit=2 vs
  // sessions=6 on an account that had just backed up successfully). The old
  // gate `commit.seq < serverSeq → server_rollback` therefore rejected
  // valid restores. The premise ("when commitSeq lags sessionsSeq the
  // server is replaying") was wrong: they are not comparable.
  //
  // The GENUINE anti-rollback protection is unaffected and still enforced:
  //   - the commit signature (verified above) covers `seq`, so the server
  //     can't FORGE a higher commit seq, only replay an older one; and
  //   - the local rollback check above (commit.seq < cached COMMIT seq)
  //     catches a same-device replay — that's a like-for-like comparison
  //     of the SAME counter, which is the correct one.
  //
  // `checkServerSeqAnchor` is retained (exported + unit-tested) for any
  // future gate that compares like-for-like server-anchored COMMIT seqs,
  // but we no longer feed it the incomparable session-snapshot seq.
  void p.serverSeq; // retained in the signature for test injection compat

  return {ok: true};
}

/**
 * Audit P0-B3 — pure check for the server-anchored Merkle seq gate.
 * Returns ok=true when:
 *   • serverSeq is null (legacy account / pre-Sprint-6 server) — degrade
 *     to local-only mode, and
 *   • commitSeq >= serverSeq otherwise.
 *
 * Exported as its own function so unit tests can exercise the gate
 * without standing up a real curve identity. The integration into
 * `verifyMerkleCommit` above is the production caller.
 */
export function checkServerSeqAnchor(p: {
  commitSeq: number;
  serverSeq: number | null;
}): {ok: true} | {ok: false; reason: 'server_rollback'} {
  if (p.serverSeq === null || !Number.isFinite(p.serverSeq)) {return {ok: true};}
  if (p.commitSeq < p.serverSeq) {return {ok: false, reason: 'server_rollback'};}
  return {ok: true};
}
