# Messenger Backup — Module Verification Loop

> **Run this loop EVERY time you touch the messenger backup module** — before you start
> (baseline) and after any change (regression). It is the module-specific companion to the
> repo-root `LOOP.md`: the root loop tells you _how_ to work; this loop tells you _what to
> prove works_ for backup/restore, and — critically — **which invariants keep the
> `root_mismatch` restore dead-end from ever coming back**.
>
> **Golden rule:** a backup change is not "done" until the §6 sign-off holds. The
> `root_mismatch` class has shipped FIVE times (B-45r3 → B-50 → B-67 → B-81 → B-94); each
> narrow patch left a structural window open. The invariants in §2 are the contract that
> closes the class — do not trade any of them away for a quick fix.

**Owner docs:** bug history = `sqa.md` (B-45, B-50, B-67, B-81, B-94); server audit =
`docs/audits` + `msng_backup_audit.md` remediation notes; architecture constraints =
CLAUDE.md **Security constraints** (Merkle/S8 items are stop-conditions).

---

## 0. When this loop applies (trigger files)

Run it if your change touches any of:

- **Mirror / ledger:** `src/modules/messenger/backup/messageMirror.ts`, `mirrorLedger.ts`,
  `mirrorBootstrap.ts`, `backupBoot.ts`, `backupFlags.ts`
- **Merkle / integrity:** `src/modules/messenger/backup/merkleCommit.ts`, `backupMerkle.ts`,
  `restoreMessages.ts`, `restoreResume.ts`
- **Identity / crypto:** `identityBackup.ts`, `backupCrypto.ts`, `backupWireV3.ts`,
  `sessionRatchetRecovery.ts`, `ratchetSnapshot*.ts`, `httpSnapshotTransport.ts`,
  `archiveReplay.ts`
- **Client plumbing:** `backupClient.ts`, `src/modules/messenger/crypto/db.ts` (schema —
  `mirror_flushed` lives here), `src/modules/messenger/runtime/keychain.ts` (mirror key,
  seq HMAC keys)
- **Screens:** `src/screens/messenger/BackupSetupScreen.tsx`, `BackupRestoreScreen.tsx`,
  `RestoreProgressOverlay.tsx`
- **Server:** `apps/messenger-service/src/backup/**` (controller, service, DTOs), any
  `supabase/migrations/**` touching `identity_backups`, `messages_backup`,
  `conversations_backup`, `backup_merkle_commits`, `backup_session_snapshots`

---

## 1. The pipeline in one screen (reference)

```
WRITE SIDE (live device)
  store mutation ──► mirrorBootstrap diff ──► mirrorMessage(owner, msg)
        │                                        │  dedup: seenIds (in-memory)
        │                                        │  hydrated at boot from mirror_flushed (B-94)
        │                                        ▼
        │                            queue ── 1.5s flush debounce ──► putMessages (AES-GCM,
        │                                        │                    fresh IV per upload!)
        │                                        ├─ on success: bump flushEpoch,
        │                                        │  record versions → mirror_flushed,
        │                                        │  set merkle-pending flag        (B-94)
        │                                        ▼
        │                            5s merkle debounce ──► commitMerkleRoot:
        │                                 walk server pages → root → sign(seq) →
        │                                 putMerkleCommit → clear pending flag
        │                                 ONLY if flushEpoch unchanged            (B-94)
        ▼
BOOT (RESUME-AUTO): startMirrorBootstrap → setMirrorKey → catch-up sweep:
   hydrate dedup from mirror_flushed → backupNow (only CHANGED rows enqueue) →
   drain → if pending flag set: commit NOW (heals a prior kill-window)          (B-94)

RESTORE SIDE (fresh install or unlock)
  header → password → verifyProof → identity bundle → walk messages →
  verifyMerkleCommit(rows, signed commit)
     ├─ ok                → hydrate SQLCipher → seed mirror_flushed (B-94) → done
     ├─ rows_count_grew   → self-heal IFF additive-prefix reproduces signed root (B-45r3/P2-B-1)
     ├─ stale_seq on any commit → adopt server seq+1, retry ONCE (B-50, B-67 for snapshots)
     ├─ root_mismatch (equal count) → B-81 repair IFF this device has local history:
     │      purge ledger → full re-upload → drain-check → direct sign → retry once
     └─ anything else     → hard fail (tamper posture — do NOT soften)
```

---

## 2. Invariants — the "never again" contract

Any change that breaks one of these re-opens the `root_mismatch` class. Check each one
against your diff, and keep the pinned test green (listed per invariant).

| #      | Invariant                                                                                                                                                                                                                                                                                                                    | Pinned by                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **I1** | **Idle boots upload NOTHING.** The catch-up sweep must hydrate its dedup from `mirror_flushed` and skip every row whose current version already reached the server. Re-uploading an unchanged row re-encrypts it (fresh IV → new server bytes) and re-opens the drift window.                                                | `mirrorLedgerBootSweep.test.ts` ("skips unchanged rows", "idle boots are silent")      |
| **I2** | **Every flush owes a commit.** A successful `putMessages` sets the persistent pending flag; only a commit whose server-walk saw no interleaved flush (flush-epoch guard) may clear it. The boot sweep fires a commit whenever the flag survived a kill.                                                                      | `mirrorLedgerBootSweep.test.ts` ("pending flag fires a commit", "flush-epoch-guarded") |
| **I3** | **Never weaken `verifyMerkleCommit`.** Equal-count divergence stays a hard fail (indistinguishable from per-row substitution / tombstone-resurrect replay). `rows_count_grew` self-heals ONLY with the additive-prefix proof. Fewer rows than signed is always a hard fail. This is a CLAUDE.md architecture stop-condition. | `merkleRecommitReconcile.test.ts`, `merkleSeqTamper.test.ts`                           |
| **I4** | **Repair never launders.** `repairBackupCommit` runs only on a device holding local history + unlocked mirror; it purges the ledger, re-uploads EVERYTHING, aborts on an undrained outbox, and signs directly (`commitMerkleRootNow`), never via the ambient hook. A fresh device refuses with zero side effects.            | `backupRepairCommit.test.ts`, `mirrorLedgerBootSweep.test.ts` ("purges the ledger")    |
| **I5** | **Server wipe ⇒ ledger purge.** Every path that wipes or rotates the server mirror (forget/wipe on either screen, fresh `setupBackup`) must `clearFlushedForOwner` — a stale ledger makes the sweep skip rows the server no longer holds (silent restore data loss).                                                         | code-review checklist (grep `clearFlushedForOwner` call sites)                         |
| **I6** | **Seq counters adopt, never hammer.** Any 409 `stale_seq` (merkle commits AND ratchet snapshots) adopts `currentSeq + 1`, re-signs, retries exactly once. No infinite retry loops (B-67's 4s hammer froze snapshots + drained batteries).                                                                                    | `merkleStaleSeqAdopt.test.ts`, `ratchetSnapshotScheduler.test.ts`                      |
| **I7** | **Restore seeds the ledger.** After the Merkle gate passes, the restored rows' versions are recorded in `mirror_flushed` so the first post-restore boot does not re-upload (and re-encrypt) the entire history.                                                                                                              | `mirrorLedgerBootSweep.test.ts` ("round-trips … restore seeding path")                 |
| **I8** | **Ledger is best-effort, never authoritative for content.** A missing/failed ledger degrades to re-upload (pre-B-94 behaviour) — NEVER to skipping an upload it can't prove happened.                                                                                                                                        | `mirrorLedgerBootSweep.test.ts` ("degrades … DB unavailable")                          |
| **I9** | **No plaintext in logs or ledger.** `mirror_flushed` stores FNV hashes only; log lines carry counts/seqs/kinds only. The static log-audit test enforces this.                                                                                                                                                                | `logAudit.test.ts`                                                                     |

---

## 3. Failure-class history (read before "fixing" anything here)

| Bug         | Date  | Root cause                                                                                                                                                                                                         | Fix                                                                                                                                                                  |
| ----------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-45 r3** | 07-05 | Rows uploaded continuously, signed count trailed on a 30s debounce; AppState background flushed rows but abandoned the commit timer                                                                                | Direction-aware `rows_count_grew` self-heal (additive-prefix proof), commit-on-background, drain-before-baseline, debounce 30s→5s                                    |
| **B-50**    | 07-06 | Fresh install ships commit `seq=1`; server monotonic guard 409s; client mapped every 409 to `verifier_missing` → hard `root_mismatch` on a healthy backup                                                          | `stale_seq` kind + adopt `currentSeq+1`, retry once (`merkleStaleSeqAdopt.test.ts`)                                                                                  |
| **B-67**    | 07-10 | Ratchet-snapshot upload path lacked the B-50 adopt — infinite 4s retry, snapshots frozen at old seq                                                                                                                | Same adopt-and-retry in `ratchetSnapshotScheduler.ts`                                                                                                                |
| **B-81**    | 07-11 | Re-mirrors re-encrypt (fresh IV) and the commit trails by debounce + server walk; kill in the window → equal-count drift → permanent restore dead-end (verifier hard-fails, nothing re-commits)                    | `repairBackupCommit` on the owner device + one auto-retry on the restore screen                                                                                      |
| **B-94**    | 07-17 | **The drift factory:** in-memory-only dedup meant EVERY boot sweep re-uploaded the entire history, re-opening the B-81 window on every single launch; a fresh-install restore hitting the drift had no repair path | Persistent `mirror_flushed` ledger (schema v14) + pending-commit flag with flush-epoch guard + boot heal + restore-side seeding + ledger purge on wipe/rotate/repair |

Pattern to internalize: **B-45/B-50/B-81 patched the restore side; the class only died when
the WRITE side stopped manufacturing drift (B-94).** If you see a new `root_mismatch`, first
ask "what is writing server bytes without a covering commit?", not "how do I make restore
tolerate it?" — tolerating it is usually laundering (I3/I4).

---

## 4. Automated gates (run all, in this order)

```bash
# 1. The backup/merkle suites — fastest signal
npx jest --selectProjects messenger-crypto --testPathPattern \
  "mirrorLedgerBootSweep|messageMirrorMerkleFlush|backupRepairCommit|merkle|backupHardening|restoreDeferResume|ratchetSnapshotScheduler|wipeAtRest|backupKdfHardening"

# 2. Full crypto project (the pre-existing suite-level flake reruns green in isolation;
#    0 failing TESTS is the bar)
npm run test:crypto

# 3. Server backup spec (from apps/messenger-service)
cd apps/messenger-service && npm test -- --testPathPattern backup

# 4. Type + lint gates (baseline in .tsc-baseline.json)
npm run typecheck   # error count must be ≤ baseline
npm run lint        # your files must add zero problems
```

---

## 5. Device / data verification

### 5.1 Idle-boot silence check (I1/I2 — the B-94 regression gate)

1. Install the build, unlock backup, let it settle (60s), then **relaunch the app** and
   capture logcat:
   `adb logcat -s ReactNativeJS | grep -E "bravo.backup|backup.merkle"`
2. **Expected on the second launch:** `catch-up sweep starting` → `catch-up sweep done`
   with **NO** `flushed N messages` and **NO** merkle commit between them (unless a pending
   flag from a killed session is being healed — that logs exactly one commit).
3. **Forbidden:** `flushed <full-history-count> messages` on every launch — that is the
   drift factory back from the dead.

### 5.2 Kill-window heal check (I2)

1. Send a message; within ~2s (after `flushed 1 messages`, before the 5s commit) force-kill:
   `adb shell am force-stop com.bravosecure.app`.
2. Relaunch → expect one merkle commit during the sweep (`pending` heal).
3. Reinstall + restore → must succeed (no `root_mismatch`).

### 5.3 Restore round-trip gate (always run before release)

1. `adb uninstall` → install → sign in → restore with the backup password.
2. Expect a clean restore. `root_mismatch` on the FIRST try on a fresh install means the
   write side drifted — investigate with §5.4 before touching the verifier.
3. On the owner's own device, a `root_mismatch` should trigger `Repairing backup
integrity…` then a successful retry (B-81); a SECOND mismatch after a repair is a real
   integrity signal — stop and escalate.

### 5.4 SQL drift probes (Supabase — read-only)

```sql
-- Commit vs actual rows, per account (count drift):
SELECT c.user_id, c.row_count AS committed, c.seq, c.updated_at,
       (SELECT count(*) FROM messages_backup m WHERE m.owner_user_id = c.user_id) AS actual
FROM backup_merkle_commits c ORDER BY c.updated_at DESC;

-- Rows uploaded AFTER the last signed commit (byte drift suspects at equal count):
SELECT m.owner_user_id, count(*) AS rows_after_commit
FROM messages_backup m
JOIN backup_merkle_commits c ON c.user_id = m.owner_user_id
WHERE m.updated_at > c.updated_at
GROUP BY m.owner_user_id;
```

Non-zero `rows_after_commit` that persists for more than ~10s of activity = a client not
honouring I2. (The full byte-exact root-recompute recipe lives in sqa.md §B-81.)

---

## 6. Sign-off criteria

- [ ] §4 gates all green (0 failing tests; tsc ≤ baseline; lint adds nothing)
- [ ] §5.1 idle-boot silence verified on-device (or explicitly stated as not exercisable)
- [ ] §5.3 fresh-install restore round-trip verified (ditto)
- [ ] Every §2 invariant re-checked against the diff — name any you touched in the
      commit/PR body and why the change preserves it
- [ ] Nothing in the diff softens `verifyMerkleCommit`, `verifyProof`, the biometric gate,
      or seq monotonicity (CLAUDE.md stop-conditions — architecture approval required)
- [ ] `sqa.md` updated if a bug was found/fixed; this file updated if an invariant changed
