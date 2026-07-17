/**
 * Backup boot — orchestrates the encrypted-backup state machine at
 * sign-in time. Runs BEFORE the messenger runtime initializes so we
 * can intercept the "fresh install with a server backup" case before
 * installIdentity() writes a brand-new Signal identity that would
 * mask the recoverable one.
 *
 * State machine (executed in order, first match wins):
 *
 *   • RESTORE (fresh install + server backup)
 *       Local SQLCipher key absent (clear-data, new device, reinstall)
 *       AND server has an identity_backups row.
 *       → Push BackupRestoreScreen, do NOT init the runtime yet. The
 *         restore screen will install the identity from the unwrapped
 *         bundle, then call onRuntimeReady() to boot the runtime, then
 *         pull the message mirror.
 *
 *   • RESUME (existing device + backup enabled)
 *       Local key present AND server backup present.
 *       → Init the runtime normally. Start the live mirror so new
 *         messages sync — but the master key isn't held in memory
 *         until the user re-enters their password (from Settings →
 *         Chat Backup → Unlock). Until then, mirror writes are no-ops.
 *
 *   • SUGGEST (existing device, backup not yet enabled, has chats)
 *       Local key present AND no server backup AND user has ≥1
 *       conversation AND has not explicitly skipped the prompt.
 *       → Init the runtime, then defer-navigate to BackupSetup.
 *
 *   • PASSTHROUGH (everything else)
 *       Init the runtime, do nothing else.
 *
 * On a service-disabled server (Supabase keys missing) we treat it
 * the same as PASSTHROUGH — the app keeps working without backup.
 *
 * Logcat: every decision logs `[bravo.backup.boot] <case> ...`.
 */
import type {NavigationContainerRef} from '@react-navigation/native';
import {backupClient, BackupError} from './backupClient';
import {startMirrorBootstrap} from './mirrorBootstrap';
import {hasDbKey, loadMirrorMasterKey} from '../runtime/keychain';
import {useMessengerStore} from '../store/messengerStore';
import {fromB64, importMasterKey} from './backupCrypto';
import {setMirrorKey} from './messageMirror';
import {isRestoreIncomplete, isArchiveReplayIncomplete} from './restoreResume';
import {
  readBackupEnabledSource, readBackupSkippedSource, migrateLegacyEnabledToOwner,
} from './backupFlags';

type Nav = NavigationContainerRef<Record<string, object | undefined>>;

export interface BackupBootOptions {
  ownerKey:           string;
  // Signal UUID (user.id). Builds <=1.0.36 saved the mirror key under
  // this instead of ownerKey; passed to loadMirrorMasterKey so a
  // legacy-keyed entry is migrated to the canonical owner on first boot.
  legacyOwnerId?:     string | null;
  getMessengerRuntime: (mode?: 'production') => Promise<unknown>;
}

// P3-B-4 — poll the navigation container until it's ready, up to
// `ceilingMs`. The old inline loop gave up after 2 s and FELL THROUGH to
// the runtime init, whose installIdentity would write a fresh identity
// over the recoverable one — after which the RESTORE gate never fires
// again (localKeyExists=true forever). Nav readiness is a local-render
// condition, not a network one, so a generous ceiling is safe.
async function waitForNavReady(navigationRef: Nav, ceilingMs: number): Promise<boolean> {
  const stepMs = 250;
  for (let waited = 0; waited < ceilingMs && !navigationRef.isReady(); waited += stepMs) {
    await new Promise(r => setTimeout(r, stepMs));
  }
  return navigationRef.isReady();
}

export async function runBackupBoot(
  navigationRef: Nav,
  opts: BackupBootOptions,
): Promise<void> {
  console.log('[bravo.backup.boot] start');

  // 1. Pre-runtime probes — both checks happen WITHOUT touching the
  // CryptoStore, so we can decide before installIdentity runs.
  const localKeyExists = await hasDbKey(opts.ownerKey);
  let serverBackupExists = false;
  let serverProbeUsable = true;
  try {
    await backupClient.getIdentityHeader();
    serverBackupExists = true;
  } catch (e) {
    if (e instanceof BackupError && e.kind === 'no_backup') {
      serverBackupExists = false;
    } else if (e instanceof BackupError && e.kind === 'service_disabled') {
      console.log('[bravo.backup.boot] service_disabled — skipping backup logic');
      serverProbeUsable = false;
    } else {
      // Network / 5xx — don't block runtime, but also don't treat as
      // "no backup" (which would let SUGGEST overwrite a real one).
      console.warn('[bravo.backup.boot] header probe failed:', (e as Error).message);
      serverProbeUsable = false;
    }
  }

  console.log(
    `[bravo.backup.boot] probe localKey=${localKeyExists} serverBackup=${serverBackupExists} serverUsable=${serverProbeUsable}`,
  );

  // 2. RESTORE — fresh install + recoverable backup. DO NOT boot the
  // runtime yet. BackupRestoreScreen owns the next step.
  //
  // BackupRestore is registered inside MessengerNavigator (a nested
  // stack inside Main → MessengerTab). A bare
  // navigationRef.navigate('BackupRestore') from the root fails to
  // resolve when the active stack is still on Auth or has just barely
  // landed on Main without the MessengerTab having mounted yet — the
  // navigate silently no-ops and the user sees MessengerHome instead
  // of the password prompt. We have to address it via the explicit
  // nested-route form. We also wait for the navigator to actually
  // settle (not just `isReady`) by polling up to 2s — `isReady` flips
  // true the moment the container mounts, before the first nested
  // tab/screen has loaded.
  if (serverProbeUsable && serverBackupExists && !localKeyExists) {
    console.log('[bravo.backup.boot] case=RESTORE → push BackupRestore (runtime gated)');
    // P3-B-4 — generous readiness ceiling (60 s), and NEVER fall through
    // past this gate: booting the runtime here runs installIdentity,
    // which writes a fresh identity over the recoverable one and
    // permanently disarms the RESTORE gate (localKeyExists=true on every
    // later boot). If navigation genuinely never readies, we return
    // WITHOUT booting the runtime — the gate re-arms on the next boot
    // because no local key was written. The only legitimate exits from
    // this state are a completed restore or the user's explicit
    // "start fresh" wipe on BackupRestoreScreen.
    const ready = await waitForNavReady(navigationRef, 60_000);
    if (!ready) {
      console.warn('[bravo.backup.boot] nav never ready — HOLDING the restore gate (runtime NOT booted; will retry next boot)');
      return;
    }
    // Nested-route navigate: descend through Main → MessengerTab →
    // MessengerStack → BackupRestore. The runtime intentionally is
    // NOT booted here; BackupRestoreScreen.handleRestore() boots
    // it AFTER successfully unwrapping the identity.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        (navigationRef as unknown as {navigate: (n: string, p?: unknown) => void}).navigate('Main', {
          screen: 'MessengerTab',
          params: {screen: 'BackupRestore'},
        });
        console.log('[bravo.backup.boot] navigated to BackupRestore (nested route)');
        return;
      } catch (e) {
        console.warn(`[bravo.backup.boot] navigate attempt ${attempt + 1} failed:`, (e as Error).message);
        await new Promise(r => setTimeout(r, 500));
      }
    }
    // P3-B-4 — navigate kept throwing. Still do NOT boot the runtime;
    // hold the gate so the identity stays recoverable next boot.
    console.warn('[bravo.backup.boot] navigate failed repeatedly — HOLDING the restore gate (runtime NOT booted)');
    return;
  }

  // 2b. RESTORE-RESUME (H-2) — an interrupted restore (crash / OOM / Doze
  // kill after the identity was installed but before the message walk
  // completed) leaves localKeyExists=true, so the RESTORE gate above
  // misses it and the normal RESUME path below would land the user on a
  // partial/empty history with the restore never finishing. The
  // restore-incomplete marker (set at the top of restoreAllMessages,
  // cleared only on a fully-complete run) detects it; route back into the
  // restore flow, which re-runs idempotently and completes.
  //
  // P1-B-1 — the sealed-archive replay has its own incomplete marker
  // (armed before the drain, cleared only after a natural end), so a
  // kill/error mid-drain also re-enters the restore flow here instead of
  // silently abandoning the un-replayed archive tail.
  const restoreUserId = opts.legacyOwnerId ?? null;
  const interruptedRestore = !!restoreUserId && (
    (await isRestoreIncomplete(restoreUserId)) ||
    (await isArchiveReplayIncomplete(restoreUserId))
  );
  if (serverProbeUsable && serverBackupExists && interruptedRestore) {
    console.log('[bravo.backup.boot] case=RESTORE-RESUME → interrupted restore/archive-drain detected, re-entering BackupRestore');
    if (await waitForNavReady(navigationRef, 15_000)) {
      try {
        (navigationRef as unknown as {navigate: (n: string, p?: unknown) => void}).navigate('Main', {
          screen: 'MessengerTab',
          params: {screen: 'BackupRestore'},
        });
        return;
      } catch (e) {
        console.warn('[bravo.backup.boot] restore-resume navigate failed, falling through:', (e as Error).message);
      }
    }
    // Falling through is tolerable here (unlike the RESTORE gate): the
    // identity already exists locally, and the markers persist so the
    // next boot retries this branch.
  }

  // 3. PASSTHROUGH or RESUME or SUGGEST — all of these need the
  // runtime. Boot it now, then decide secondary actions.
  try {
    await opts.getMessengerRuntime('production');
  } catch (e) {
    console.warn('[bravo.backup.boot] runtime init failed:', (e as Error).message);
    return;
  }

  // RESUME: backup exists on server AND on this device historically.
  // Start the mirror subscription so new messages sync once the user
  // unlocks. Without unlock, mirror writes are no-ops.
  //
  // Round 5 / CRITICAL-2 fix: previously this just kicked off the
  // subscription and walked away. The master key lives in module
  // memory only, so every cold start (and there's been many — the
  // user said "I set up backup at the start") left the mirror DEAD
  // even though the user thought it was working. Every send between
  // app restarts silently no-op'd. Result: a user sets up backup
  // day 1, sends 7 messages that day, closes the app, sends thousands
  // more over weeks — and only the original 7 reach the server.
  // On restore they think they lost 99% of their history.
  //
  // The fix: when backup is enabled (the AsyncStorage flag is set),
  // navigate to BackupSetup in unlock mode at boot. The user enters
  // their password, setMirrorKey loads the key into memory, and the
  // mirror starts working again. WhatsApp does this — every cold
  // start prompts for the backup password if backup is enabled.
  if (serverProbeUsable && serverBackupExists && localKeyExists) {
    // P3-B-2 — owner-scoped flag, with a legacy-global fallback that is
    // safe HERE because this branch already server-confirmed a backup
    // exists for this owner; adopt the legacy flag into owner scope.
    const enabledSource = await readBackupEnabledSource(opts.ownerKey);
    if (enabledSource === 'legacy') {
      await migrateLegacyEnabledToOwner(opts.ownerKey);
    }
    if (enabledSource !== null) {
      // Round 6 / restore-after-reinstall fix — try to auto-resume the
      // mirror from the OS keychain BEFORE falling back to the password
      // prompt. The previous implementation forced the user through the
      // unlock screen on every cold start; if they dismissed it (a swipe
      // away, or "I'll do it later"), the mirror silently no-op'd and
      // every message they sent that session never reached the server.
      // Result on reinstall: most chat history was missing because most
      // sessions never had a live master key.
      const rawB64 = await loadMirrorMasterKey(opts.ownerKey, opts.legacyOwnerId);
      if (rawB64) {
        try {
          const raw = fromB64(rawB64);
          const masterKey = await importMasterKey(raw);
          // Burn after import — CryptoKey is the live handle.
          (raw as Uint8Array).fill(0);
          // F5 — start the mirror subscription (which installs the
          // catch-up sweep via setCatchUpSweep) BEFORE flipping the key
          // live. setMirrorKey fires the disabled→enabled catch-up sweep
          // that recovers boot-window messages, but ONLY if the sweep is
          // already wired; the previous order (setMirrorKey first) left it
          // null at flip time, so the gap recovery never ran and
          // offline-delivered messages were silently missing from backups.
          startMirrorBootstrap();
          setMirrorKey(masterKey);
          console.log('[bravo.backup.boot] case=RESUME-AUTO → mirror unlocked from keychain');
          return;
        } catch (e) {
          console.warn('[bravo.backup.boot] keychain mirror import failed, falling back to prompt:', (e as Error).message);
        }
      }
      console.log('[bravo.backup.boot] case=RESUME-LOCKED → prompting for backup password');
      // Start the subscription anyway so future post-unlock writes
      // get picked up; mirror writes will no-op until setMirrorKey
      // runs inside BackupSetupScreen.handleUnlock.
      startMirrorBootstrap();
      // Navigate after a beat so MessengerHome has time to mount —
      // the user backgrounding the unlock screen lands them on Home,
      // not a black void. They can re-enter via Settings → Chat
      // Backup if they dismiss the prompt.
      if (navigationRef.isReady()) {
        setTimeout(() => {
          try {
            (navigationRef as unknown as {navigate: (n: string, p?: unknown) => void}).navigate('Main', {
              screen: 'MessengerTab',
              params: {screen: 'BackupSetup'},
            });
          } catch { /* ignore */ }
        }, 600);
      }
      return;
    }
    console.log('[bravo.backup.boot] case=RESUME → mirror subscription up (no enabled flag)');
    startMirrorBootstrap();
    return;
  }

  // SUGGEST: no server backup, but user has chats and hasn't dismissed.
  // Defer the suggestion modal so MessengerHome paints first.
  if (serverProbeUsable && !serverBackupExists) {
    // P3-B-2 — `skipped` honors owner OR legacy scope (legacy skips
    // persist from pre-migration app versions; ignoring them would
    // re-prompt on every boot). `enabled` honors OWNER scope ONLY:
    // reaching SUGGEST means the server has NO backup for this owner, so
    // a legacy global enabled flag here is another account's (the exact
    // cross-account bleed this fix closes) or stale — either way the
    // prompt is correct.
    const skippedSource = await readBackupSkippedSource(opts.ownerKey);
    const enabledSource = await readBackupEnabledSource(opts.ownerKey);
    if (skippedSource !== null || enabledSource === 'owner') {
      console.log('[bravo.backup.boot] case=PASSTHROUGH (skipped/enabled flag set)');
      return;
    }
    const convCount = Object.keys(useMessengerStore.getState().conversations).length;
    if (convCount === 0) {
      console.log('[bravo.backup.boot] case=PASSTHROUGH (no chats yet)');
      return;
    }
    console.log('[bravo.backup.boot] case=SUGGEST → BackupSetup');
    if (navigationRef.isReady()) {
      setTimeout(() => {
        try {
          // Nested-route navigate (same reason as RESTORE branch above).
          (navigationRef as unknown as {navigate: (n: string, p?: unknown) => void}).navigate('Main', {
            screen: 'MessengerTab',
            params: {screen: 'BackupSetup'},
          });
        } catch { /* ignore */ }
      }, 800);
    }
    return;
  }

  console.log('[bravo.backup.boot] case=PASSTHROUGH (server unusable or no decision)');
}
