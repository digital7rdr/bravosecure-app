/**
 * BackupRestoreScreen — entered after login when an existing backup
 * is found AND the local Signal store has no identity.
 *
 * Flow:
 *   1. GET /backup/identity/header → know if a backup exists, get
 *      lockout state.
 *   2. User enters their backup password.
 *   3. restoreBackup() — reinstall identity into the local store.
 *      • Wrong password → server bumps counter; UI shows attempts left.
 *      • 5 wrong → server returns 423; UI shows cool-down timer.
 *   4. restoreAllMessages() — rehydrate conversation list + messages.
 *   5. Navigate to MessengerHome.
 *
 * "Forgot password" → confirms wipe → DELETE /backup → user proceeds
 * with a fresh empty store, matching WhatsApp's "permanently lost" UX.
 */
import React, {useEffect, useState, useCallback, useRef} from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, StatusBar,
  ActivityIndicator, Platform, KeyboardAvoidingView, BackHandler,
  ScrollView,
} from 'react-native';
import {Alert} from '@utils/alert';
import RestoreProgressOverlay, {type RestoreProgressState} from './RestoreProgressOverlay';
import {useFocusEffect} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {runBackupBiometricGate} from '@/modules/messenger/backup/backupBiometricGate';
import type {MessengerScreenProps} from '@navigation/types';
import {restoreBackup} from '@/modules/messenger/backup/identityBackup';
import {restoreAllMessages} from '@/modules/messenger/backup/restoreMessages';
import {setMirrorKey, computeMirrorVersion} from '@/modules/messenger/backup/messageMirror';
import {startMirrorBootstrap} from '@/modules/messenger/backup/mirrorBootstrap';
import {clearRestoreState} from '@/modules/messenger/backup/restoreResume';
import {drainSealedArchive} from '@/modules/messenger/backup/archiveReplay';
import {setBackupEnabled, clearBackupEnabled} from '@/modules/messenger/backup/backupFlags';
import {humanizeBackupError} from '@/modules/messenger/backup/backupErrorCopy';
import {backupClient, BackupError} from '@/modules/messenger/backup/backupClient';
import {getOwnCryptoStore, getMessengerRuntime} from '@/modules/messenger/runtime';
import {useAuthStore} from '@store/authStore';
import {useKeyboardHeight, useRevealOnKeyboard} from '@hooks/useKeyboardHeight';
import {BACKUP_BASE} from './backupPalette';

type Props = MessengerScreenProps<'BackupRestore'>;

const C = {...BACKUP_BASE, ok: '#00C853'};

const MAX_ATTEMPTS = 5;

export default function BackupRestoreScreen({navigation}: Props) {
  const insets = useSafeAreaInsets();
  // B-84 / KB-01 — edge-to-edge nulls adjustResize and the previous KAV
  // had no Android behavior, so the keyboard covered the password field.
  // ChatScreen pattern: manual kb padding + reveal once the IME is up.
  const scrollRef = useRef<ScrollView>(null);
  const kbHeight = useKeyboardHeight();
  const revealField = useRevealOnKeyboard(scrollRef);
  const ownerUserId = useAuthStore(s => s.user?.id ?? null);
  // Key-storage owner — MUST match the runtime's persistence identity
  // (MainNavigator passes `email ?? phone ?? id` as ownerKey to both
  // configureMessengerRuntime and runBackupBoot). The keychain DB key,
  // mirror key, and boot RESTORE gate are all scoped on this. Using the
  // bare UUID here writes the mirror key under a service no reader ever
  // checks → mirror never auto-resumes + boot re-enters RESTORE.
  // Why: distinct from ownerUserId (the Signal UUID) which restore still
  // needs for peer/self address matching against conversation members.
  const ownerKey = useAuthStore(s => s.user?.email ?? s.user?.phone_e164 ?? s.user?.id ?? null);
  const [pwd, setPwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [headerLoading, setHeaderLoading] = useState(true);
  const [attemptsLeft, setAttemptsLeft] = useState(MAX_ATTEMPTS);
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);
  // B-44 — legacy pre-verifier row (P0-1 hard cut). The server 409s every
  // proof for these, so NO password can restore; showing the form is a
  // dead end. When set, the password UI is replaced by a start-fresh panel.
  const [legacyBackup, setLegacyBackup] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Finding 5 — forces a 1s re-render while locked so the countdown ticks.
  const [, setNowTick] = useState(0);
  // Premium full-screen restore overlay. null = not shown (password
  // input visible); any state value = overlay covers the screen.
  const [overlay, setOverlay] = useState<RestoreProgressState | null>(null);
  // Live counter the restore loop bumps as messages stream in. Held
  // in a ref so the high-frequency emit calls don't trigger a render
  // per message — we merge it into the overlay state via setOverlay
  // with a short batching debounce.
  const lastEmitAtRef = useRef<number>(0);
  // B-81 — one repair-and-retry per screen mount; a second root_mismatch
  // after a successful repair is a real integrity signal, not drift.
  const merkleRepairTriedRef = useRef(false);
  // Round 5 UX-fix: show/hide eye toggle so the user can verify what
  // they actually typed (especially critical given Android's autofill
  // can substitute the saved account password into a secure field).
  const [showPwd, setShowPwd] = useState(false);

  const refreshHeader = useCallback(async () => {
    setHeaderLoading(true);
    try {
      const h = await backupClient.getIdentityHeader();
      setAttemptsLeft(Math.max(0, MAX_ATTEMPTS - h.failedAttempts));
      setLockedUntil(h.lockedUntil);
      setLegacyBackup(h.verifierMissing === true);
    } catch (e) {
      if (e instanceof BackupError && e.kind === 'no_backup') {
        // No backup — should never reach here, but degrade gracefully.
        navigation.replace('MessengerHome');
        return;
      }
      setErr(`header_fetch_failed: ${(e as Error).message}`);
    } finally {
      setHeaderLoading(false);
    }
  }, [navigation]);

  // BKRES-19 — refetch on every focus, not just mount, so a backup wiped
  // or changed while this screen was unfocused (e.g. from another device)
  // is picked up instead of serving a stale header until remount.
  useFocusEffect(
    useCallback(() => { void refreshHeader(); }, [refreshHeader]),
  );

  // Round 7 / back-button audit fix #1 — trap the Android hardware back
  // button. Without this, the user can press back and pop the screen,
  // which exits the restore flow with a freshly-installed Signal
  // identity already written by `getMessengerRuntime('production')`
  // inside handleRestore. Subsequent runtime boots see `localKeyExists`
  // and skip the restore branch, permanently losing every previously
  // mirrored conversation. Instead: prompt the user for explicit
  // confirmation; the only legitimate way out is "Forgot password —
  // start fresh" (which already wipes the server backup intentionally)
  // or successfully restoring.
  // Shared back-press guard used by BOTH the Android hardware back button
  // AND the header back arrow. Previously only the hardware button was
  // trapped; the visible arrow called navigation.goBack() directly, so a
  // single tap on it was the exact data-loss path (fresh identity written,
  // mirrored history stranded) the trap was built to prevent.
  const handleBackPress = useCallback((): boolean => {
    if (busy) {
      // While restore is in flight, swallow back entirely — popping
      // mid-restore corrupts the SQL store and leaves a half-built
      // identity. The user can only wait or cancel from the overlay.
      return true;
    }
    Alert.alert(
      'Skip restore?',
      'Going back without restoring leaves you on a fresh empty account. Your encrypted backup stays on our servers until you wipe it from this screen.',
      [
        {text: 'Stay', style: 'cancel'},
        {text: 'Skip restore', style: 'destructive', onPress: () => navigation.goBack()},
      ],
    );
    return true;
  }, [busy, navigation]);

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', handleBackPress);
      return () => sub.remove();
    }, [handleBackPress]),
  );

  const lockedRemainingSec = (() => {
    if (!lockedUntil) {return 0;}
    const ms = new Date(lockedUntil).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / 1000));
  })();

  // Finding 5 — the lockout countdown was computed once per render but
  // nothing re-rendered, so "Try again in Xm Ys" froze and the form
  // stayed hidden even after the cool-down elapsed. Tick every second
  // while locked; when it reaches zero, clear the lock and re-fetch the
  // header so the password form reappears without leaving the screen.
  useEffect(() => {
    if (!lockedUntil) {return;}
    const id = setInterval(() => {
      if (new Date(lockedUntil).getTime() - Date.now() <= 0) {
        setLockedUntil(null);
        void refreshHeader();
      } else {
        setNowTick(t => (t + 1) % 1_000_000);
      }
    }, 1_000);
    return () => clearInterval(id);
  }, [lockedUntil, refreshHeader]);

  /**
   * Audit P1-B1 — second-factor gate before the password unlock fires.
   * Requires a fresh biometric / device-passcode prompt right BEFORE we
   * even start the Argon2 derive, so an attacker who recovered the
   * backup password (shoulder-surf, phish, found-on-a-sticky-note)
   * still needs the user's actual device unlock to complete the restore.
   *
   * Soft-fails when the device has no biometric hardware OR no
   * enrolled credential — restoring a backup on a brand-new device
   * that hasn't yet been enrolled is a legitimate first-boot flow we
   * don't want to brick. The password-only path is unchanged in that
   * case (matches the legacy behaviour pre-P1-B1).
   */
  const requireBiometricUnlock = useCallback(
    () => runBackupBiometricGate('Confirm to restore backup'),
    [],
  );

  const handleRestore = async (opts?: {retryAfterRepair?: boolean}): Promise<void> => {
    // B-81 — the post-repair retry re-enters while `busy` is still true
    // (we're inside the failed attempt's catch); only that path may bypass
    // the guard. The biometric gate below still runs on the retry.
    if (!opts?.retryAfterRepair && busy) {return;}
    if (!pwd) {return;}
    if (lockedRemainingSec > 0) {return;}
    if (!ownerUserId) { setErr('not_logged_in'); return; }
    setBusy(true);
    setErr(null);
    // Audit P1-B1 — biometric gate. Fires BEFORE Argon2 so a wrong
    // password attempt costs the attacker the biometric prompt too.
    const bio = await requireBiometricUnlock();
    if (!bio.ok) {
      setBusy(false);
      setErr('Biometric verification required');
      // B-81 — the post-repair retry re-enters under the "Repairing backup
      // integrity…" progress overlay; clear it so a cancelled biometric
      // doesn't strand a full-screen spinner over the real error.
      setOverlay(null);
      return;
    }
    try {
      // Step 1 — boot the messenger runtime if it hasn't been booted
      // yet (the RESTORE branch in backupBoot.ts skips runtime init,
      // because installIdentity() would overwrite the bundle we're
      // about to recover). This call:
      //   • generates a fresh SQLCipher key + opens the encrypted DB
      //   • runs installIdentity which writes a NEW Signal identity
      //     (we deliberately overwrite this in step 2)
      //   • opens the WebSocket, primes sender cert, etc.
      // Step 2 (restoreBackup) then re-installs the OLD identity from
      // the wrapped bundle on top, so the X3DH session keys our peers
      // hold remain valid.
      //
      // Round 8 — defer the bundle upload until AFTER restoreBackup
      // installs the recovered identity. Without the defer, the fresh
      // installIdentity bundle gets uploaded to auth-service first;
      // the rotation detector then WIPES every server-side OPK public
      // (peers built sessions against). End result: peers can't decrypt
      // anything they send to us until they re-fetch our bundle.
      console.log('[bravo.restore] booting runtime (bundle publish deferred)');
      setOverlay({kind: 'progress', step: 'Preparing secure store…'});
      const {setDeferBundlePublish, publishOwnBundleAfterRestore} =
        require('@/modules/messenger/runtime/productionRuntime') as
        typeof import('@/modules/messenger/runtime/productionRuntime');
      setDeferBundlePublish(true);
      try {
        await getMessengerRuntime('production');
      } catch (e) {
        setDeferBundlePublish(false);
        throw e;
      }
      const store = getOwnCryptoStore();
      if (!store) { setErr('messenger_not_ready'); setBusy(false); return; }

      console.log('[bravo.restore] verifying password + unwrapping identity');
      setOverlay({kind: 'progress', step: 'Verifying password…'});
      const {masterKey, identity, rawB64} = await restoreBackup(store, pwd);
      // Round 8 — NOW publish the recovered bundle. The deferred
      // initial upload from getMessengerRuntime is replaced with this
      // one, which carries the OLD identity restored from the backup.
      // The auth-service rotation detector sees the SAME identity it
      // had on file, treats it as a no-op upsert, and DOES NOT wipe
      // any OPK pool. Peer sessions remain intact.
      try {
        await publishOwnBundleAfterRestore();
      } catch (e) {
        console.warn('[bravo.restore] publishOwnBundleAfterRestore failed:', (e as Error).message);
      } finally {
        setDeferBundlePublish(false);
      }
      // Why: the runtime was booted earlier (line ~203) BEFORE restoreBackup
      // overwrote the SQLCipher identity row with the recovered one. The
      // live SessionManager + SenderCertCache + cached ownIdentity pubKey
      // are still keyed off the FRESH identity that installIdentity wrote
      // before we replaced it. Any send from this stale runtime issues
      // certs bound to the wrong identity → receiver's verifySenderCert
      // fails → red "sender identity key mismatch" banner on MessengerHome.
      // Force-closing + relaunching used to be the only fix because that
      // rebuilt the runtime fresh from the restored SQLCipher state.
      // Tear down the stale runtime + rebuild it now so MessengerHome
      // mounts against the restored identity.
      try {
        const {disposeLiveRuntime} = require('@/modules/messenger/runtime/productionRuntime') as
          typeof import('@/modules/messenger/runtime/productionRuntime');
        // BS-RESTORE — keep the production config that MainNavigator already
        // set. The full _resetMessengerRuntime() nulled it, so the rebuild
        // below threw "requires configureMessengerRuntime(cfg) first" and
        // MessengerHome showed the red error bar until a manual close+reopen.
        const {_resetMessengerRuntimeKeepConfig} = require('@/modules/messenger/runtime') as
          typeof import('@/modules/messenger/runtime');
        console.log('[bravo.restore] rebuilding runtime against restored identity');
        setOverlay({kind: 'progress', step: 'Finalising secure session…'});
        disposeLiveRuntime();
        _resetMessengerRuntimeKeepConfig();
        await getMessengerRuntime('production');
      } catch (e) {
        console.warn('[bravo.restore] runtime rebuild failed:', (e as Error).message);
      }
      setMirrorKey(masterKey);
      // Persist the raw key in the OS keychain so the mirror auto-resumes
      // on the next cold start without re-prompting for the password.
      try {
        const {saveMirrorMasterKey} = require('@/modules/messenger/runtime/keychain') as
          typeof import('@/modules/messenger/runtime/keychain');
        await saveMirrorMasterKey(ownerKey ?? ownerUserId, rawB64);
      } catch (e) {
        console.warn('[bravo.restore] saveMirrorMasterKey failed:', (e as Error).message);
      }
      // M-11 — the mirror subscription is intentionally NOT started here.
      // Starting it before restoreAllMessages would treat every restored
      // row as "new" and re-upload the ENTIRE history (re-encrypting each
      // row + invalidating the Merkle commit). We start it AFTER the full
      // restore below, seeded from the restored store, so only genuinely
      // new post-restore messages mirror.

      console.log('[bravo.restore] pulling messages from server');
      setOverlay({kind: 'progress', step: 'Restoring messages…'});
      // CRITICAL-12 fix (Round 5): pass `cryptoStore` so restoreAllMessages
      // takes the SQL-backed durable path (`SqlMessageStore.upsertBatch`).
      // Without this, restored messages live in Zustand-memory only, and
      // the next cold start hydrates from a SQLCipher that was never
      // written to — so the user sees "Restore complete" then loses
      // every restored message on the second app launch. The bug was
      // present since restoreMessages.ts:103 added the SQL path but
      // both screen call sites forgot to pass the store reference.
      //
      // Round 5 / Security S8: pass `identityPubKey` so the restore
      // verifies the server's signed Merkle commit against the rows
      // we get back. A tampered or rolled-back row set throws
      // MerkleCommitMismatchError and we surface a clear error to
      // the user rather than silently importing untrusted history.
      // The identity pub key is the one we just unwrapped from the
      // backup bundle — base64 → ArrayBuffer.
      const idPubBytes = Buffer.from(identity.identityKey.pub, 'base64');
      const idPubAb = idPubBytes.buffer.slice(idPubBytes.byteOffset, idPubBytes.byteOffset + idPubBytes.byteLength);
      // Round 9 / S8 self-heal — also hand the identity PRIVATE key so
      // restore can re-sign + reconcile a benign root_mismatch (signed
      // root drifted from the live row byte-form since the seq=1 setup
      // commit). Same bundle source as the pub key.
      const idPrivBytes = Buffer.from(identity.identityKey.priv, 'base64');
      const idPrivAb = idPrivBytes.buffer.slice(idPrivBytes.byteOffset, idPrivBytes.byteOffset + idPrivBytes.byteLength);
      const counts = await restoreAllMessages(masterKey, ownerUserId, {
        cryptoStore:    store,
        identityPubKey: idPubAb as ArrayBuffer,
        identityPrivKey: idPrivAb as ArrayBuffer,
        onProgress: (p) => {
          // Throttle UI updates to ~10/s — restore can emit per-page
          // (every 1000 messages) which is well below that, but on a
          // legacy server that ships small pages we don't want a render
          // per ~10 messages either.
          const nowMs = Date.now();
          if (nowMs - lastEmitAtRef.current < 100 && p.step === 'messages') {return;}
          lastEmitAtRef.current = nowMs;
          setOverlay({
            kind: 'progress',
            step: p.label,
            current: p.current,
          });
        },
      });
      console.log(`[bravo.restore] done — ${counts.messages} messages, ${counts.conversations} conversations, ${counts.skipped} skipped, incomplete=${counts.incomplete}`);

      // P1-B-1 / P2-B-6 — a truncated walk (page-cap or defer-buffer-cap)
      // must NOT fall through to the success overlay: the restore-
      // incomplete marker and resume cursor are still set, so surface a
      // retry state and let the user continue from where it stopped
      // (next boot re-enters this screen too, via RESTORE-RESUME).
      if (counts.incomplete) {
        const msg = `Restored ${counts.messages.toLocaleString()} messages so far — more remain. Tap CLOSE, then RESTORE to continue (progress is saved).`;
        setErr(msg);
        setOverlay({kind: 'error', message: msg});
        return;
      }

      // Phase-2 ratchet-snapshot APPLY — replay the encrypted per-peer
      // Double Ratchet snapshot BEFORE draining the sealed archive. The
      // archive (and any live inbound that arrives during this screen)
      // is encrypted under the OLD ratchet state, which a fresh install
      // doesn't have. Applying the snapshot first restores those chain
      // keys so those envelopes libsignal-decrypt cleanly instead of
      // hitting DecryptError → ack-and-drop. Anything NOT covered by the
      // snapshot (messages sent after the last capture) still falls
      // through to the rehandshake-nudge recovery path as before.
      //
      // Non-fatal: a missing / older / undecryptable snapshot just leaves
      // the pre-Phase-2 gap open for the un-captured delta. The raw
      // master key comes from the keychain entry saveMirrorMasterKey
      // just wrote, so the apply uses the SAME key the capture used.
      try {
        setOverlay({kind: 'progress', step: 'Restoring secure sessions…'});
        const {applyRatchetSnapshot} = require('@/modules/messenger/backup/sessionRatchetRecovery') as
          typeof import('@/modules/messenger/backup/sessionRatchetRecovery');
        const {readPersistedSnapshotSeq, persistAppliedSnapshotSeq} =
          require('@/modules/messenger/backup/ratchetSnapshotScheduler') as
          typeof import('@/modules/messenger/backup/ratchetSnapshotScheduler');
        const {loadMirrorMasterKey} = require('@/modules/messenger/runtime/keychain') as
          typeof import('@/modules/messenger/runtime/keychain');
        const {fromB64} = require('@/modules/messenger/backup/backupCrypto') as
          typeof import('@/modules/messenger/backup/backupCrypto');
        // C-3 — the mirror key was saved under the CANONICAL owner
        // (email ?? phone ?? id), and the snapshot capture scheduler is
        // armed with that same owner (productionRuntime: ownerKey ??
        // ownUserId). Loading under the bare Signal UUID missed for
        // every user with an email/phone, so applyRatchetSnapshot never
        // ran in production. Load under the canonical owner (UUID as
        // legacy fallback) and key the seq floor on the SAME owner the
        // capture side writes.
        const snapshotOwner = ownerKey ?? ownerUserId;
        const rawB64Key = snapshotOwner
          ? await loadMirrorMasterKey(snapshotOwner, ownerUserId)
          : null;
        if (rawB64Key && store && snapshotOwner) {
          const masterKeyRaw = fromB64(rawB64Key);
          const floor = await readPersistedSnapshotSeq(snapshotOwner);
          const res = await applyRatchetSnapshot(store, masterKeyRaw, floor);
          masterKeyRaw.fill(0);
          console.log(`[bravo.restore.ratchet] applied=${res.applied} seq=${res.seq ?? '-'} reason=${res.reason}`);
          if (res.reason === 'ok' && typeof res.seq === 'number') {
            await persistAppliedSnapshotSeq(snapshotOwner, res.seq);
          }
        } else {
          // Loud signal — this is the exact failure mode that made the
          // whole Phase-2 feature a silent no-op for a year.
          console.warn(`[bravo.restore.ratchet] snapshot key unavailable owner=${snapshotOwner ? 'set' : 'null'} — skipping ratchet restore`);
        }
      } catch (e) {
        console.warn('[bravo.restore.ratchet] snapshot apply skipped:', (e as Error).message);
      }

      // Restore-after-reinstall fix #3 — drain the server-side sealed
      // envelope archive. These are the messages the user was sent
      // during sessions where the client mirror was locked / never
      // unlocked — the live relay delivered them and they were on file
      // server-side, but messages_backup never received them because
      // it depends on the master key being live in the sender's
      // session. The archive is recipient-keyed, opaque to the server,
      // and unsealed locally with the just-restored identity priv key.
      //
      // P1-B-1 — the drain is now resumable and fail-loud:
      //   • drainSealedArchive arms a per-owner archive-replay-incomplete
      //     marker before the first page and clears it only after a
      //     natural end, so a kill mid-drain re-enters this screen on the
      //     next boot instead of silently losing the un-replayed tail;
      //   • the (timestampMs, envelopeId) cursor persists per page, so a
      //     retry resumes instead of re-walking from envelope 0;
      //   • a page-fetch error surfaces a RETRY state below instead of
      //     falling through to the success overlay.
      try {
        setOverlay({kind: 'progress', step: 'Restoring server-side history…'});
        const {replayArchivedEnvelope} = require('@/modules/messenger/runtime/productionRuntime') as
          typeof import('@/modules/messenger/runtime/productionRuntime');
        const {replayed} = await drainSealedArchive(ownerUserId, replayArchivedEnvelope);
        console.log(`[bravo.restore.archive] replayed ${replayed} sealed envelopes`);
      } catch (e) {
        console.warn('[bravo.restore.archive] drain failed:', (e as Error).message);
        // Marker + cursor survive inside drainSealedArchive; retry resumes.
        const msg = 'Your messages were restored, but some server-side history could not be fetched. Tap CLOSE, then RESTORE to retry — progress is saved.';
        setErr(msg);
        setOverlay({kind: 'error', message: msg});
        return;
      }

      // Orphan-row warning. Triggers when the server has rows that
      // were encrypted under a PREVIOUS master key — re-setup after
      // a network blip or password rotation before the v1.0.7 fix
      // that wipes stale rows on key rotation server-side. They
      // can't be recovered — only flagged so the user understands
      // the count is lower than expected.
      //
      // Fix #5 — additionally surface how many envelopes from the
      // sealed-archive replay couldn't be decrypted. These aren't
      // password-mismatch orphans; they're messages that arrived
      // during the user's reinstall window before the new ratchet
      // was published. Phase 2 (Sender Keys / ratchet snapshot) will
      // recover these too.
      let undecryptable = 0;
      try {
        const {getUndecryptableCount} = require('@/modules/messenger/backup/sessionRatchetRecovery') as
          typeof import('@/modules/messenger/backup/sessionRatchetRecovery');
        undecryptable = getUndecryptableCount();
      } catch { /* module missing — fine */ }

      // B-94 — seed the persistent flush ledger with the versions of the
      // rows we JUST restored: the server verifiably holds them (the
      // Merkle gate passed), so the next boot's catch-up sweep must not
      // re-encrypt + re-upload the entire history — that re-upload is the
      // drift factory behind the recurring `root_mismatch` dead-end.
      // Non-fatal: a failed seed degrades to one extra full re-upload.
      try {
        const {SqlCipherProtocolStore} = require('@/modules/messenger/crypto/sqlCipherStore') as
          typeof import('@/modules/messenger/crypto/sqlCipherStore');
        const {SqlMessageStore} = require('@/modules/messenger/store/sqlMessageStore') as
          typeof import('@/modules/messenger/store/sqlMessageStore');
        const {recordFlushedVersions} = require('@/modules/messenger/backup/mirrorLedger') as
          typeof import('@/modules/messenger/backup/mirrorLedger');
        const liveStore = getOwnCryptoStore();
        if (liveStore && liveStore instanceof SqlCipherProtocolStore) {
          const all = await new SqlMessageStore(liveStore.getDb()).loadAll();
          const entries = Object.values(all).flat()
            .map(m => ({messageId: m.id, version: computeMirrorVersion(m)}));
          if (entries.length > 0) {
            await recordFlushedVersions(ownerUserId, entries);
            console.log(`[bravo.restore] B-94 mirror ledger seeded (${entries.length} rows)`);
          }
        }
      } catch (e) {
        console.warn('[bravo.restore] B-94 ledger seed failed (non-fatal):', (e as Error).message);
      }

      // M-11 — NOW start the mirror subscription, seeded from the fully-
      // restored store, so only genuinely-new post-restore messages
      // mirror (no re-upload of restored history).
      startMirrorBootstrap();
      // H-1 — mark backup enabled so the NEXT cold start auto-resumes the
      // mirror (RESUME-AUTO). Without this the fresh-install restore left
      // the flag unset, so every later launch skipped the resume branches,
      // setMirrorKey never ran, and new messages silently stopped reaching
      // the backup — the exact CRITICAL-2 failure the boot path documents.
      // P3-B-2 — owner-scoped via backupFlags (legacy global key is also
      // written for the not-yet-migrated readers).
      await setBackupEnabled(ownerKey ?? ownerUserId);
      // Premium success screen — replaces the legacy Alert. The overlay
      // continues to mask BackupRestoreScreen until the user taps
      // "Open Messenger", giving them a polished hand-off instead of
      // a system dialog popping over the password input.
      setOverlay({
        kind:          'success',
        messages:      counts.messages,
        conversations: counts.conversations,
        skipped:       counts.skipped + undecryptable,
      });
    } catch (e) {
      // Tear down the splash on error so the user can read what went
      // wrong on the inline form (and retry without restarting).
      // Wrong-password / locked errors render naturally on the password
      // form; other failures bubble through the overlay's error state
      // so the user gets a styled message instead of just a tiny red line.
      setOverlay(null);
      if (e instanceof BackupError) {
        if (e.kind === 'unauthorized') {
          setErr('Wrong password');
          await refreshHeader();
        } else if (e.kind === 'locked') {
          setErr(null);
          await refreshHeader();
        } else if (e.kind === 'verifier_missing') {
          // B-44 — the header probe missed it (race / cached state) but the
          // restore path hit the legacy row. Flip to the hard-cut panel
          // instead of a generic error the user can't act on.
          setErr(null);
          setLegacyBackup(true);
        } else if (e.kind === 'no_backup') {
          // BKRES-19 — the backup was deleted after this screen loaded
          // (e.g. wiped from another device). Same handling as the
          // mount-time probe: nothing left to restore, so inform + move
          // on instead of a generic error overlay the user can only retry.
          setErr(null);
          Alert.alert(
            'No backup found',
            'Your backup no longer exists on the server. You can set up a new one later from Settings → Chat Backup.',
            [{text: 'OK', onPress: () => navigation.replace('MessengerHome')}],
          );
        } else {
          // BKRES-27 — humanize the wrapped kind now so a known code
          // (e.g. nonce_expired) keeps its dedicated copy in BOTH the
          // inline error and the overlay, instead of collapsing into
          // the generic 'Restore failed' prefix match.
          const msg = humanizeBackupError(`Restore failed: ${e.kind}`);
          setErr(msg);
          setOverlay({kind: 'error', message: msg});
        }
      } else if ((e as Error).name === 'MerkleCommitMismatchError') {
        // Round 5 / Security S8 — restore aborted because the
        // server's row set didn't match the signed Merkle commit.
        // This indicates either tampering, a server-side rollback,
        // or a stale snapshot. User can retry (in case the server
        // was mid-write); persistent failures are escalated.
        const reason = (e as Error & {reason?: string}).reason ?? 'unknown';
        // B-81 — equal-count `root_mismatch` on the LIVE OWNER device is,
        // in practice, self-inflicted drift: a re-mirror (fresh AES-GCM IV
        // per upload) landed but the app died before the debounced Merkle
        // re-commit, so the server rows sit ahead of the signed root
        // forever and every retry fails. When this device holds the local
        // history + unlocked mirror, repair honestly — re-upload local
        // truth over the server rows, re-sign, then retry ONCE.
        // `repairBackupCommit` refuses (returns false) on a fresh device
        // with nothing local, so the hard-fail posture there is unchanged.
        if (reason === 'root_mismatch' && !merkleRepairTriedRef.current && ownerUserId) {
          try {
            setOverlay({kind: 'progress', step: 'Repairing backup integrity…'});
            const {repairBackupCommit} = require('@/modules/messenger/backup/mirrorBootstrap') as
              typeof import('@/modules/messenger/backup/mirrorBootstrap');
            if (await repairBackupCommit(ownerUserId)) {
              // Spend the one-per-mount retry budget ONLY on a repair that
              // actually signed a fresh commit: a refused/aborted repair
              // (locked mirror, empty local store, undrained outbox) leaves
              // the budget so a later manual RETRY can attempt it again.
              merkleRepairTriedRef.current = true;
              console.log('[bravo.restore] B-81 repair committed — retrying restore');
              await handleRestore({retryAfterRepair: true});
              return;
            }
          } catch (repairErr) {
            console.warn('[bravo.restore] B-81 repair failed:', (repairErr as Error).message);
          }
        }
        const msg = `Backup integrity check failed (${reason}). Retry, or contact support if it keeps failing.`;
        setErr(msg);
        setOverlay({kind: 'error', message: msg});
      } else {
        const msg = `Restore failed: ${(e as Error).message}`;
        setErr(msg);
        setOverlay({kind: 'error', message: msg});
      }
    } finally {
      setBusy(false);
    }
  };

  const handleForgot = (): void => {
    Alert.alert(
      'Backup permanently lost?',
      'Without your password we cannot decrypt your backup. Continuing wipes the encrypted backup from our servers and starts you fresh — your old messages cannot be recovered.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Wipe & Start Fresh', style: 'destructive', onPress: () => {
          void (async () => {
            try {
              await backupClient.forget();
              // M-17 — clear ALL local backup/restore state so a later
              // fresh setup can't inherit a stale resume cursor (which
              // would silently skip rows at/before it) or a dangling
              // enabled flag / keychain key from the wiped backup.
              try {
                if (ownerUserId) { await clearRestoreState(ownerUserId); }
                // P3-B-2 — clears the owner-scoped AND legacy enabled flags.
                await clearBackupEnabled((ownerKey ?? ownerUserId ?? '') as string);
                const {clearMirrorMasterKey} = require('@/modules/messenger/runtime/keychain') as
                  typeof import('@/modules/messenger/runtime/keychain');
                if (ownerKey ?? ownerUserId) { await clearMirrorMasterKey((ownerKey ?? ownerUserId) as string); }
                // B-94 — the server mirror is gone; a stale flush ledger
                // would make a future sweep skip rows the server no longer
                // holds (silent restore data loss). Purge it with the rest.
                const {clearFlushedForOwner} = require('@/modules/messenger/backup/mirrorLedger') as
                  typeof import('@/modules/messenger/backup/mirrorLedger');
                if (ownerUserId) { await clearFlushedForOwner(ownerUserId); }
              } catch (e) {
                console.warn('[bravo.restore] forget local-state cleanup failed:', (e as Error).message);
              }
              // Boot the runtime now so MessengerHome has a working
              // CryptoStore + WS connection to operate against. The
              // RESTORE branch in backupBoot.ts deferred this exact
              // step, expecting either restore or wipe to complete it.
              try { await getMessengerRuntime('production'); } catch { /* surfaced later */ }
              Alert.alert('Backup wiped', 'You can set up a new backup later from Settings → Chat Backup.', [
                {text: 'OK', onPress: () => navigation.replace('MessengerHome')},
              ]);
            } catch (e) {
              Alert.alert('Could not wipe backup', (e as Error).message);
            }
          })();
        }},
      ],
    );
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      {/* Top bar — same shape as BackupSetup so the two screens read
          as siblings in the same flow rather than two unrelated UIs. */}
      <View style={s.topBar}>
        <TouchableOpacity
          style={s.iconBtn}
          onPress={() => { handleBackPress(); }}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          activeOpacity={0.7}>
          <Icon name="arrow-left" size={22} color={C.tx1} />
        </TouchableOpacity>
        <Text style={s.title}>RESTORE BACKUP</Text>
        <View style={{width: 38}} />
      </View>
      <KeyboardAvoidingView
        style={[{flex: 1}, Platform.OS === 'android' && {paddingBottom: kbHeight}]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={s.body}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          {legacyBackup ? (
            /* B-44 — P0-1 hard cut. No password can unlock a pre-verifier
               backup (the server rejects every proof), and Settings is
               unreachable behind this gate — so don't render a form that
               can only fail. The single way forward is the existing wipe. */
            <>
              <View style={s.heroIconWrap}>
                <Icon name="shield-alert-outline" size={56} color={C.warn} />
              </View>
              <Text style={s.h1}>This backup can't be unlocked</Text>
              <Text style={s.p}>
                It was created before a security upgrade that changed how
                backup passwords are verified, so it can no longer be
                restored — with any password.
              </Text>
              <View style={[s.notice, {borderColor: C.warn}]}>
                <Icon name="alert-circle-outline" size={18} color={C.warn} />
                <Text style={[s.noticeTxt, {color: C.warn}]}>
                  Your old backed-up messages cannot be recovered.
                </Text>
              </View>
              <View style={s.bullet}>
                <Icon name="lock-check-outline" size={18} color={C.ok} />
                <Text style={s.bulletTxt}>
                  Start fresh, then set a new backup password from Settings →
                  Chat Backup. New backups use the upgraded protection.
                </Text>
              </View>
              <TouchableOpacity
                style={s.primaryBtn}
                onPress={handleForgot}
                activeOpacity={0.85}>
                <Text style={s.primaryBtnTxt}>START FRESH</Text>
              </TouchableOpacity>
            </>
          ) : (
          <>
          <View style={s.heroIconWrap}>
            <Icon name="cloud-download-outline" size={56} color={C.act} />
          </View>
          <Text style={s.h1}>Restore your chats</Text>
          <Text style={s.p}>
            We found an encrypted backup on your account. Enter the password
            you set when you enabled chat backup.
          </Text>

          <View style={s.bullet}>
            <Icon name="lock-check-outline" size={18} color={C.ok} />
            <Text style={s.bulletTxt}>argon2id key derivation — server can't read your messages.</Text>
          </View>
          <View style={s.bullet}>
            <Icon name="cloud-download-outline" size={18} color={C.ok} />
            <Text style={s.bulletTxt}>Restoring re-installs your Signal identity, then pulls every mirrored message back.</Text>
          </View>
          <View style={s.bullet}>
            <Icon name="alert-circle-outline" size={18} color={C.warn} />
            <Text style={s.bulletTxt}>5 wrong attempts triggers a 1-hour cool-down.</Text>
          </View>

          {headerLoading ? (
            <ActivityIndicator color={C.tx2} style={{marginVertical: 16}} />
          ) : lockedRemainingSec > 0 ? (
            <View style={[s.notice, {borderColor: C.err}]}>
              <Icon name="lock-clock" size={18} color={C.err} />
              <Text style={[s.noticeTxt, {color: C.err}]}>
                Too many wrong attempts. Try again in {formatDuration(lockedRemainingSec)}.
              </Text>
            </View>
          ) : (
            <>
              <Text style={s.label}>BACKUP PASSWORD</Text>
              <View style={s.pwdRow}>
                <TextInput
                  style={[s.input, s.pwdInput]}
                  value={pwd}
                  onChangeText={setPwd}
                  placeholder="Enter your backup password"
                  placeholderTextColor={C.tx3}
                  secureTextEntry={!showPwd}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="oneTimeCode"
                  importantForAutofill="no"
                  editable={!busy}
                  onFocus={revealField}
                />
                <TouchableOpacity
                  style={s.eyeBtn}
                  onPress={() => setShowPwd(v => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={showPwd ? 'Hide password' : 'Show password'}
                  activeOpacity={0.7}>
                  <Icon name={showPwd ? 'eye-off-outline' : 'eye-outline'} size={20} color={C.tx2} />
                </TouchableOpacity>
              </View>
              {attemptsLeft < MAX_ATTEMPTS && attemptsLeft > 0 && (
                <Text style={[s.warn, {color: attemptsLeft <= 2 ? C.err : C.warn}]}>
                  {attemptsLeft} {attemptsLeft === 1 ? 'attempt' : 'attempts'} left.
                </Text>
              )}
              {err && <Text style={s.err} accessibilityLiveRegion="polite">{humanizeBackupError(err)}</Text>}
              <TouchableOpacity
                style={[s.primaryBtn, (busy || !pwd) && s.primaryBtnDisabled]}
                disabled={busy || !pwd}
                onPress={() => { void handleRestore(); }}
                activeOpacity={0.85}>
                <Text style={s.primaryBtnTxt}>RESTORE</Text>
              </TouchableOpacity>
            </>
          )}

          <TouchableOpacity style={s.linkBtn} onPress={handleForgot} activeOpacity={0.7}>
            <Text style={s.linkBtnTxt}>Forgot password — start fresh</Text>
          </TouchableOpacity>
          </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      {/* Full-screen overlay during/after restore. While `overlay`
          is set the password input is hidden behind a premium splash;
          on success or error the overlay owns the hand-off action. */}
      {overlay && (
        <RestoreProgressOverlay
          state={overlay}
          onContinue={() => navigation.replace('MessengerHome')}
          onClose={() => setOverlay(null)}
        />
      )}
    </View>
  );
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) {return `${s}s`;}
  return `${m}m ${s}s`;
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg},
  // flexGrow (not flex:1) so the ScrollView content fills the viewport
  // when short but can still scroll when the keyboard shrinks it —
  // otherwise the password input + RESTORE button hide behind the keyboard.
  body: {flexGrow: 1, padding: 20, gap: 12, paddingBottom: 40},
  heroIconWrap: {alignItems: 'center', paddingVertical: 20},
  h1: {color: C.tx1, fontSize: 18, fontWeight: '800', textAlign: 'center'},
  p:  {color: C.tx2, fontSize: 13, lineHeight: 19, textAlign: 'center'},
  label: {color: C.tx3, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginTop: 16},
  input: {
    backgroundColor: C.surf2, borderWidth: 1, borderColor: C.bd,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    color: C.tx1, fontSize: 14,
  },
  // Round 5 UX: see BackupSetupScreen for full reasoning.
  pwdRow: {position: 'relative'},
  pwdInput: {paddingRight: 44},
  eyeBtn: {
    position: 'absolute', right: 4, top: 0, bottom: 0,
    width: 40, alignItems: 'center', justifyContent: 'center',
  },
  warn: {color: C.warn, fontSize: 12, marginTop: 4},
  err:  {color: C.err,  fontSize: 12, marginTop: 4},
  notice: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 14, borderRadius: 10, borderWidth: 1,
    backgroundColor: C.surf2, marginTop: 10,
  },
  noticeTxt: {fontSize: 13, fontWeight: '600', flex: 1},
  primaryBtn: {
    marginTop: 18, paddingVertical: 14, borderRadius: 12,
    alignItems: 'center', backgroundColor: C.act,
  },
  primaryBtnDisabled: {opacity: 0.4},
  primaryBtnTxt: {color: '#FFF', fontSize: 13, fontWeight: '800', letterSpacing: 1},
  linkBtn: {paddingVertical: 14, alignItems: 'center', marginTop: 8},
  linkBtnTxt: {color: C.tx3, fontSize: 13, fontWeight: '600', textDecorationLine: 'underline'},
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10,
  },
  iconBtn: {
    width: 38, height: 38, borderRadius: 10,
    backgroundColor: 'rgba(22,47,84,0.85)',
    borderWidth: 1, borderColor: '#1C3B66',
    alignItems: 'center', justifyContent: 'center',
  },
  title: {color: C.tx1, fontSize: 13, fontWeight: '700', letterSpacing: 1.4},
  bullet: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start',
    backgroundColor: '#162F54', borderWidth: 1, borderColor: '#1C3B66',
    borderRadius: 10, padding: 12,
  },
  bulletTxt: {color: C.tx2, fontSize: 12, lineHeight: 17, flex: 1},
});
