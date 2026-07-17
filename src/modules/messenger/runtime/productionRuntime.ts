import {KeyHelper} from '@privacyresearch/libsignal-protocol-typescript';
import {
  SessionManager,
  installIdentity,
  buildOwnPreKeyBundle,
  // Audit P0-I1 — signed-prekey rotation primitives.
  shouldRotateSignedPreKey,
  rotateSignedPreKey,
  currentSignedPreKeyId,
  sealPayload,
  unsealPayload,
  verifySealedAad,
  verifySenderCert,
  wrapOuter,
  unwrapOuter,
  toBase64,
  fromBase64,
  computeSafetyNumber,
  type CryptoStore,
  type Ciphertext,
  type SessionAddress,
} from '../crypto';
import {DecryptError, IdentityKeyMismatchError, parseGroupMessage, applyAdminAction, broadcastToGroup, makeNewGroup, makeAssignedGroup, signGroupCreate, verifyGroupCreateSignature, groupEncrypt, disposeGroupKey, signCallOfferAuth as coreSignCallOfferAuth, isGroupMember, type CallOfferAuth, type GroupState, type SealedAttachment} from '@bravo/messenger-core';
import {
  rememberSuccessfulDecrypt, hasRecentSuccessfulDecrypt,
  shouldAttemptRebuild, markRebuildAttempt, clearRebuildAttempt,
  attachHealthStore,
} from './sessionWipeProtection';
import {unwrapPlaintextGroupInnerBody} from './groupInboundBody';
import {
  isRecoverableDecryptError,
  decideRecoveryDisposition,
  LeaveOnRelayError,
  clear as clearFirstMsgRetryBudget,
} from './firstMessageRetryBudget';
import {selectGroupIdsToDrain} from './bootGroupStashDrain';
import {selectUndeliverableResend} from './undeliverableResend';
import {PeerSessionHealthStore} from '../store/peerSessionHealthStore';
import {
  PendingGroupEnvelopeStore,
  PENDING_GROUP_MAX_ATTEMPTS,
} from '../store/pendingGroupEnvelopeStore';
import {
  PendingAdminActionStore,
  PENDING_ADMIN_MAX_ATTEMPTS,
} from '../store/pendingAdminActionStore';
import {
  TransportClient,
  RelayHttpClient,
  KeysHttpClient,
  SenderCertClient,
  SenderCertCache,
  RevokedJtiCache,
  UsersHttpClient,
  type ServerFrame,
  type ServerEnvelopeAccepted,
  type ServerEnvelopeDeliver,
} from '@bravo/messenger-core';
import {ExpirySweeper} from './expirySweeper';
import {
  hydratePeerIdentityAcks,
  notePeerIdentityChanged,
  hasPendingIdentityAck,
  acknowledgePeerIdentity,
  isIdentitySendGateEnabled,
} from '../store/peerIdentityAckStore';
import {runWithRatchetTxn, runOnTxnChain, isTransientSqlError, type TxnDbHandle} from './receiveTransaction';
import {isCallFrame} from './callFrameRouter';
import {applyEnvelopeDelivered} from './envelopeDelivered';
import {
  upsertGroupConversationFromState,
  upsertKeylessGroupPlaceholder,
  resolveKeyRequestTargets,
} from './groupConversationUpsert';
import {
  noteDestroyedEnvelope,
  takeDestroyedEnvelope,
  insertDecryptFailurePlaceholder,
  applyEnvelopeUndeliverable,
} from './decryptFailureSignal';
import {useMessengerStore, directConversationSlots} from '../store/messengerStore';
import {getReadReceiptsEnabledCached, loadReadReceiptsEnabled} from '../store/privacySettings';
import {isPeerBlocked, loadBlockedPeers, setBlockedPeers} from './blockedPeers';
import {isRestoreTombstoned, loadRestoreTombstones} from '../backup/restoreTombstones';
import {SqlMessageStore} from '../store/sqlMessageStore';
import {SqlOutboxStore} from '../store/sqlOutboxStore';
import {SeenEnvelopeStore} from '../store/seenEnvelopeStore';
import {SqlCipherProtocolStore} from '../crypto/sqlCipherStore';
import {resolveExpectedSenderIdentity} from '../crypto/expectedSenderIdentity';
import {MediaBlobCache} from '../media/mediaBlobCache';
import {MediaClient} from '../media/mediaClient';
import {log as crashLog, recordError as crashRecord} from '../../observability/crashlytics';
import type {LocalMessage} from '../store/types';
import type {MessengerRuntime, SendTextOptions} from './runtime';

/**
 * Production MessengerRuntime — wires all four pieces together:
 *
 *   1. Crypto (M0):     own SessionManager + SQLCipher/InMemory store
 *   2. Auth keys (M5):  upload own bundle, fetch peer bundles on demand
 *   3. Sealed sender:   cert from auth-service, cached + refreshed
 *   4. Transport (M2/3): WS for push + real-time deliver, HTTP for
 *                       submit fallback and reconnect batch pull
 *
 * The runtime is a singleton per-user-session. Swap modes by calling
 * `_resetMessengerRuntime()` (test utility) or tearing the app down.
 */

export interface ProductionConfig {
  authBaseUrl:          string;   // e.g. http://10.0.2.2:3001
  messengerBaseUrl:     string;   // e.g. http://10.0.2.2:3100
  wsUrl:                string;   // e.g. ws://10.0.2.2:3100/ws
  getToken:             () => Promise<string | null>;
  /**
   * Round 2 fix: optional refresh hook plumbed into every HTTP client
   * (Keys / SenderCert / Relay / Users) and the WS transport. Without
   * this, the access-token expires silently mid-session and the user
   * is stuck — every HTTP fetch 401s, the WS unauthorized close stops
   * retrying, and the next backup mirror flush silently dies. Should
   * point at `refreshAccessTokenShared` from `@/services/api`.
   */
  refreshToken?:        () => Promise<void>;
  signalDeviceId?:      number;   // default 1 (Phase-1 single-device)
  authorityPubKeyB64:   string;   // 32-byte Curve25519 pubkey, base64 — verifies XEd25519 sender certs
  /**
   * The logged-in user's userId — needed to build our own address and
   * to prevent us from fetching our own bundle by accident. This is
   * the auth-service UUID; it can rotate across re-registrations in
   * dev, so we don't use it for local persistence — see `ownerKey`.
   */
  ownUserId:            string;
  /**
   * Stable persistence key — typically the user's email or phone, the
   * same value used by `messengerStore.setOwner`. Used to scope the
   * SQLCipher DB filename and the keychain entry so messages survive
   * a re-register that mints a new ownUserId. Falls back to ownUserId
   * if not provided (matches Phase-1 behavior).
   */
  ownerKey?:            string;
}

export interface ProductionRuntimeDeps {
  ownStore: CryptoStore;
  config:   ProductionConfig;
}

// Audit S10 — sealed-sender AAD policy. The previous fail-open path
// at the receive site silently accepted ciphertexts that omitted the
// AAD block, defeating the replay-protection feature documented in
// the threat model. We now require AAD by default; the EXPO_PUBLIC_
// SEALED_AAD_LEGACY env var re-enables the legacy fail-open path for
// the rare case that an older sender is still in flight.
const SEALED_AAD_LEGACY: boolean = (() => {
  const raw = (globalThis as {process?: {env?: Record<string, string | undefined>}})
    ?.process?.env?.EXPO_PUBLIC_SEALED_AAD_LEGACY;
  return raw === 'true';
})();
if (SEALED_AAD_LEGACY && typeof console !== 'undefined') {

  console.warn('[productionRuntime] SEALED_AAD_LEGACY enabled — sealed envelopes without AAD will be accepted. This MUST be off in production.');
}

// Module-level handle for the AppState subscription tied to the live
// runtime. Set inside buildProductionRuntime, removed before a new
// runtime is built. Without this, every re-login would stack another
// listener and the next foreground transition would call connect() N
// times in a tight loop.
let liveAppStateSub: {remove?: () => void} | null = null;
// Heartbeat ping interval. Mirrors `liveAppStateSub` — without a
// module-level slot, every re-login (auth state flip, restore-from-
// backup) would build a NEW runtime + a NEW heartbeat interval while
// the previous interval kept hitting `transport.send()` on a dead
// transport. Over a dozen re-logins (common in dev) we'd accumulate
// dozens of timers all firing every 4s.
let liveHeartbeat: ReturnType<typeof setInterval> | null = null;
// Restore-after-reinstall fix #3 — replay handle for archived sealed
// envelopes. Set by buildProductionRuntime to a closure that funnels a
// synthetic ServerEnvelopeDeliver frame through the live `deps`. The
// restore screen calls this after restoreAllMessages to drain the
// server-side sealed_envelope_archive into the local store.
let liveReplayArchive:
  ((env: {envelopeId: string; outerSealed: string; timestampMs: number}) => Promise<void>)
  | null = null;
/**
 * Round 8 — defer the initial publishOwnBundle. Set to true by
 * BackupRestoreScreen via `setDeferBundlePublish(true)` BEFORE it
 * calls getMessengerRuntime, then back to false after restore completes
 * via `publishOwnBundleAfterRestore()`. Without this, the fresh
 * installIdentity bundle gets uploaded to auth-service and the server
 * detects "identity rotation" — wiping every OPK public the user's
 * peers hold sessions against.
 */
let deferBundlePublish = false;
let livePublishOwnBundle: (() => Promise<void>) | null = null;
export function setDeferBundlePublish(defer: boolean): void {
  deferBundlePublish = defer;
}
export async function publishOwnBundleAfterRestore(): Promise<void> {
  if (!livePublishOwnBundle) {
    console.warn('[bravo.runtime] publishOwnBundleAfterRestore — no live runtime yet');
    return;
  }
  await livePublishOwnBundle();
}
// Pending live runtime disposers — every subscribe()/setInterval()/
// setTimeout()/AppState-listener that the runtime owns adds its
// teardown fn here. _resetMessengerRuntime() unwinds them before
// constructing a new runtime so we never leak across rebuilds.
let liveDisposers: Array<() => void> = [];
// Live ExpirySweeper handle — must be `.stop()`-ed before installing
// a new one, otherwise the previous sweeper keeps firing against the
// previous user's store/db (already closed, so each sweep throws).
let liveSweeper: {stop: () => void} | null = null;
// BS-DISPOSE-LEAK — live RevokedJtiCache poll. Parked here so the NEXT
// disposeLiveRuntime() stops it; otherwise each logout→login leaks another
// 5-min revocation poll pinning the prior certClient/tokens in memory.
let liveRevokedJtiCache: {stop: () => void} | null = null;
/**
 * Round 6 / race fix — owner epoch. Every `buildProductionRuntime` call
 * bumps this counter and captures the value in its closures (transport
 * onFrame, onStateChange, AppState handler, coalescedDrain catch
 * blocks). Async work that fires AFTER a logout / user-switch checks
 * `myEpoch === currentOwnerEpoch` and bails when stale, so frames in
 * flight at the moment of signOut can never land on the new user's
 * store. signOut → disposeLiveRuntime sets currentOwnerEpoch to a
 * sentinel `-1` so even before the next `buildProductionRuntime` runs,
 * any in-flight closure sees a mismatch and aborts.
 *
 * Without this guard the failure mode is: User A logs out mid-receive;
 * User B logs in 100 ms later; an `envelope.deliver` frame for User A
 * was already in the socket.io receive queue and gets handled AFTER
 * User B's runtime has wired up the store — `useMessengerStore.getState()`
 * returns User B's state; `handleDeliver` writes A's plaintext into
 * B's `messages` map. Audit caught it as a MEDIUM, but the bug surface
 * is closer to HIGH: cross-user data bleed.
 */
let currentOwnerEpoch = 0;
/**
 * Highest epoch ever assigned. Strictly monotonic — never reset.
 * `currentOwnerEpoch` flips to NO_OWNER_EPOCH on dispose, but the next
 * `buildProductionRuntime` derives its epoch from `lastOwnerEpoch + 1`
 * so it can never collide with a value still captured by a stale
 * closure from a previous runtime.
 */
let lastOwnerEpoch = 0;
const NO_OWNER_EPOCH = -1;

// BS-TY2 — typing watchdog singleton. Forces a stranded "typing…" flag
// off if no `stop` frame / inbound message clears it within the window.
// The class lives in messagingLogic so it's unit-testable with fake
// timers; here we just hold one process-wide instance.
const typingWatchdog = new (require('./messagingLogic') as typeof import('./messagingLogic')).TypingWatchdog();

// P1-BR-4 (B-58) — live-call guard + resume decision shared by the
// AppState-'active' handler and the WS send-ack watchdog. Lives in
// callResumeGuard.ts so it's unit-testable without the runtime's native
// graph. See that module for the full rationale.
const {hasLiveCall, decideResumeAction} =
  require('./callResumeGuard') as typeof import('./callResumeGuard');

/**
 * Read the live owner epoch — exposed for tests and for cross-module
 * gates (e.g. callDispatcher / sfuDispatcher could subscribe later).
 */
export function getCurrentOwnerEpoch(): number {
  return currentOwnerEpoch;
}

/**
 * Restore-after-reinstall fix #3 — replay one archived sealed envelope
 * through the live runtime's deliver path. The archive replay path is
 * exposed publicly because the BackupRestoreScreen needs to drain the
 * server-side sealed_envelope_archive after the restore-from-mirror
 * step completes. Each replay walks the same unseal + decrypt + store
 * path as a live envelope.deliver, just sourced from a Supabase row
 * instead of Redis.
 *
 * Returns false if the runtime is not built yet (caller should boot
 * via getMessengerRuntime first) or if the runtime was torn down mid-
 * batch. The caller is responsible for batching + cursor tracking; we
 * intentionally keep the API per-envelope because the archive list
 * already includes the cursor (timestampMs) and surfacing a batched
 * "replayN" here would force the runtime to know about the archive
 * shape.
 */
export async function replayArchivedEnvelope(env: {
  envelopeId: string; outerSealed: string; timestampMs: number;
}): Promise<boolean> {
  if (!liveReplayArchive) {return false;}
  await liveReplayArchive(env);
  return true;
}

/**
 * Tear down the previous runtime's module-level handles. Called at
 * the top of buildProductionRuntime AND from _resetMessengerRuntime
 * (test utility / logout path).
 */
export function disposeLiveRuntime(): void {
  // Round 6 / race fix — flip the epoch to a sentinel BEFORE running
  // disposers. Any in-flight onFrame / onStateChange / coalescedDrain
  // callback that wakes up between now and the next runtime build will
  // observe `myEpoch !== currentOwnerEpoch` and bail. Disposers
  // themselves don't read the epoch (they only tear down their own
  // resources), but the asynchronous work they CANCEL might still
  // resolve after the cancellation took effect — those resolutions all
  // funnel through the closures that check the epoch.
  currentOwnerEpoch = NO_OWNER_EPOCH;
  // Run disposers in reverse-install order — symmetry with how a
  // normal stack unwind would handle nested resources.
  for (let i = liveDisposers.length - 1; i >= 0; i--) {
    try { liveDisposers[i](); } catch { /* swallow — best-effort */ }
  }
  liveDisposers = [];
  if (liveHeartbeat) {
    clearInterval(liveHeartbeat);
    liveHeartbeat = null;
  }
  liveAppStateSub?.remove?.();
  liveAppStateSub = null;
  if (liveSweeper) {
    try { liveSweeper.stop(); } catch { /* ignore */ }
    liveSweeper = null;
  }
  // BS-DISPOSE-LEAK (F13) — stop the prior runtime's revocation poll.
  if (liveRevokedJtiCache) {
    try { liveRevokedJtiCache.stop(); } catch { /* ignore */ }
    liveRevokedJtiCache = null;
  }
  // BS-DISPOSE-LEAK (F14) — drop the module-level group-key self-heal signal
  // handler so a signOut-without-relogin can't pin the whole runtime graph
  // (SessionManager / SQLCipher handle / transport / caches) via its closure.
  try { setGroupKeySignalHandler(null); } catch { /* ignore */ }
  try { setResendSignalHandler(null); } catch { /* ignore */ }
  // Round 8 — drop the per-runtime publish-bundle handle so a stale
  // closure can't smuggle the previous user's keys + tokens to the
  // server after logout.
  livePublishOwnBundle = null;
  // Audit P0-S3 / P0-S5 — drop the group-master-key sink so a stray
  // late `setGroupState` (e.g. an in-flight admin envelope that lands
  // after logout) doesn't write under the previous user's wrap key
  // into the previous user's SQLCipher handle.
  try {
    const {clearGroupMasterKeySink} = require('../store/messengerStore') as
      typeof import('../store/messengerStore');
    clearGroupMasterKeySink();
  } catch { /* store not loaded yet — fine */ }
  // Phase-2 ratchet-snapshot — drop the scheduler's store handle so a
  // stray capture after logout can't read the previous user's sessions
  // or write under the next user's keychain entry.
  try {
    const {disarmRatchetSnapshotScheduler} = require('../backup/ratchetSnapshotScheduler') as
      typeof import('../backup/ratchetSnapshotScheduler');
    disarmRatchetSnapshotScheduler();
  } catch { /* scheduler not loaded — fine */ }
}

/**
 * Build a production runtime. Performs all side-effecting init:
 *   - installIdentity (idempotent — no-op if identity already in store)
 *   - publish own bundle to auth-service
 *   - prime sender-cert cache
 *   - open WS to messenger-service
 *   - on WS open: issue envelope.pull to catch up any pending messages
 */
export async function buildProductionRuntime(
  deps: ProductionRuntimeDeps,
): Promise<MessengerRuntime> {
  const {ownStore, config} = deps;
  const signalDeviceId = config.signalDeviceId ?? 1;
  const ownAddress: SessionAddress = {userId: config.ownUserId, deviceId: signalDeviceId};

  // Audit P1-T3 — hydrate the read-receipts privacy cache so the first
  // markRead after boot reads the user's stored choice rather than the
  // safe default. Best-effort: a failed load leaves the cache at the
  // default (true), which matches legacy behaviour.
  await loadReadReceiptsEnabled().catch(() => { /* fall through to default */ });

  // M-07 — hydrate the blocked-peer set so the FIRST inbound frame after boot
  // can drop a blocked peer's message synchronously. M-08 — hydrate the
  // restore-tombstone set so the sealed-archive replay (which runs right after
  // a restore) won't resurrect a message the user deleted before reinstalling.
  // Both best-effort: a failed load leaves an empty set (fail-open — never
  // drops a message we aren't sure about).
  // Audit P1-10 — scope the blocked-peer cache to THIS owner (email/phone or
  // uuid). A device-global cache let account B inherit account A's blocks and
  // silently drop the wrong user's messages; passing the owner both scopes the
  // storage key AND resets the in-memory set on an owner switch.
  await loadBlockedPeers(config.ownerKey ?? config.ownUserId).catch(() => { /* empty set */ });
  await loadRestoreTombstones(config.ownUserId).catch(() => { /* empty set */ });

  await installIdentity(ownStore, {preKeyCount: 50});

  // Audit P0-I1 — rotate the signed pre-key when it's older than
  // SIGNED_PRE_KEY_ROTATION_INTERVAL_MS (30 days). Without rotation a
  // one-shot SQLCipher compromise (rooted device, ADB backup, lost-
  // and-recovered handset) yields the SPK private scalar and lets the
  // attacker passively decrypt every X3DH initial handshake message
  // ever sent to this user. Rotation bounds that damage to ~30 days.
  //
  // Failure here is non-fatal — a missed rotation leaves the user on a
  // still-valid (just older) SPK rather than breaking message receive
  // on boot. The next boot retries. The rotation runs BEFORE
  // publishOwnBundle so the upload carries the fresh SPK; the
  // upload itself reads `currentSignedPreKeyId(store)` so a rotation
  // that happens later in life (timer, app foreground) just needs to
  // trigger another publishOwnBundle to take effect server-side.
  try {
    if (await shouldRotateSignedPreKey(ownStore)) {
      const res = await rotateSignedPreKey(ownStore);
      console.log(
        '[bravo.crypto] signed pre-key rotated',
        `new=${res.newKeyId}`,
        `prev=${res.prevKeyId ?? '-'}`,
        `pruned=[${res.prunedKeyIds.join(',')}]`,
      );
    }
  } catch (e) {
    console.warn('[bravo.crypto] signed pre-key rotation skipped:', (e as Error).message);
  }

  const own = new SessionManager(ownStore);

  // Transport clients
  // Round 2 fix: pass `config.refreshToken` to every HTTP client so
  // their already-implemented 401-retry path actually fires. Without
  // this, X3DH bundle fetches, sender-cert refreshes, and HTTP relay
  // fallbacks all silently 401-loop after the access token expires.
  const keys = new KeysHttpClient({
    baseUrl:      config.authBaseUrl,
    getToken:     config.getToken,
    refreshToken: config.refreshToken,
    // Audit G-02 / P0-I2 (2026-07-02): ARM the authority bundle-binding check.
    // Previously the client was built without authorityPubKeyB64, so
    // verifyOrThrow early-returned and accepted ANY peer bundle — a
    // malicious/coerced keys-service could swap a peer's identity key during
    // X3DH (MITM) and the client trusted it. The deployed auth-service signs
    // every bundle binding over (userId, identityKey, signedPreKey) with the
    // authority key whose PUBLIC half is config.authorityPubKeyB64 (verified:
    // SENDER_CERT_PRIVATE_KEY_B64 is set on the server, and sender-cert
    // verification already uses this same public key end-to-end). requireBundle
    // binding:true (default) rejects an unsigned/stripped-sig bundle so a MITM
    // can't bypass by omitting the signature.
    authorityPubKeyB64:   config.authorityPubKeyB64,
    requireBundleBinding: true,
  });
  const certClient = new SenderCertClient({
    baseUrl:      config.authBaseUrl,
    getToken:     config.getToken,
    refreshToken: config.refreshToken,
  });
  const relay = new RelayHttpClient({
    baseUrl:        config.messengerBaseUrl,
    getToken:       config.getToken,
    refreshToken:   config.refreshToken,
    signalDeviceId,
  });
  // Audit P0-V5 / row #3 (M2) — runtime-owned MediaClient instance
  // used only for grant registration on send. Upload/download flows
  // construct their own client (with attachment cache wired). The
  // grant-only client doesn't need a cache.
  const mediaClient = new MediaClient({
    baseUrl:        config.messengerBaseUrl,
    getToken:       config.getToken,
    signalDeviceId,
  });
  // Upload/download-capable client, wired to the persistent blob cache
  // (constructed later in this function — captured lazily so a second
  // view of an attachment skips the network round-trip). Distinct from
  // the grant-only `mediaClient` above which never needs the cache.
  let _uploadMediaClient: MediaClient | null = null;
  const getUploadMediaClient = (): MediaClient => {
    if (_uploadMediaClient) {return _uploadMediaClient;}
    _uploadMediaClient = new MediaClient({
      baseUrl:        config.messengerBaseUrl,
      getToken:       config.getToken,
      signalDeviceId,
      cache:          mediaCache ?? undefined,
    });
    return _uploadMediaClient;
  };

  // Sprint-6 backend hand-off — install the HTTP-backed snapshot
  // transport so `applyRatchetSnapshot` (post-restore) and any future
  // capture-cadence hook upload through real backend endpoints. Safe
  // pre-migration: `httpSnapshotTransport` swallows 503/404 and the
  // recovery path falls through to `no_snapshot` cleanly.
  try {
    const {setSnapshotTransport} = require('../backup/ratchetSnapshot') as typeof import('../backup/ratchetSnapshot');
    const {makeHttpSnapshotTransport} = require('../backup/httpSnapshotTransport') as typeof import('../backup/httpSnapshotTransport');
    setSnapshotTransport(makeHttpSnapshotTransport());
  } catch (e) {
    // Non-fatal — the previous in-memory transport (if any) remains
    // active and the restore path simply reports `no_transport`.
    console.warn('[bravo.runtime] snapshot transport install skipped:', (e as Error).message);
  }

  // Round 8 — defer the bundle upload when we're booting in the middle
  // of a restore-from-backup flow. The identity that installIdentity
  // just wrote is a FRESH random one — uploading it now (then having
  // restoreBackup overwrite local with the OLD identity moments later)
  // makes the server flag the user as having rotated their identity.
  // The auth-service rotation handler then WIPES every server-side
  // OPK public, which catastrophically breaks every peer who held a
  // session against the user's previous bundle. The restore screen
  // calls `publishOwnBundleAfterRestore` once it has installed the
  // recovered identity; that call is idempotent for the bundle and
  // brings the server back in sync with the locally-restored privates.
  // Audit P1-2 — the boot bundle upload is BEST-EFFORT. `keys.uploadBundle`
  // uses a bare fetch that throws offline (or on a transient auth-service
  // 5xx); an unguarded await here rejected the whole runtime build BEFORE
  // history hydration, and runtime.ts cached the rejected promise forever —
  // bricking the messenger (zero history, no sends) for the process lifetime.
  // On failure we log (id slices only) and arm a one-shot retry that the
  // onStateChange('connected') handler fires once the socket comes up.
  let bootBundlePublishPending = false;
  if (!deferBundlePublish) {
    try {
    const uploadRes = await publishOwnBundle(ownStore, keys, ownAddress);
    // Handoff §4.5-2/-3 — own-identity rotation detected by the server:
    // every envelope still queued on the relay was wrapped to the OLD
    // identity and is permanently undecryptable. Purge them in one server
    // call BEFORE the transport connects and the first drainRelay churns
    // through them one ack-drop at a time. Best-effort end to end: the
    // helper never throws, and a missing MFA proof (no attestation
    // provider yet — production) degrades to 'unavailable' (dead
    // envelopes then simply TTL out via the 30-day dwell, today's
    // behavior). Deliberately NOT wired into the restore-path republish
    // (publishOwnBundleAfterRestore) — a restored OLD identity returns
    // identityRotated=false anyway, and those envelopes are readable.
    if (uploadRes.identityRotated && uploadRes.previousIdentityKey) {
      try {
        const {purgeStaleRecipientQueue: purgeStaleQueue} =
          require('../crypto/ownIdentityRotation') as typeof import('../crypto/ownIdentityRotation');
        const proof = await keys.mintActionToken('recipient_purge');
        const outcome = await purgeStaleQueue(relay, uploadRes.previousIdentityKey, proof?.actionToken);
        console.log(`[bravo.runtime] identity rotated — stale-queue purge result=${outcome.result} count=${outcome.count ?? 0} reason=${outcome.reason ?? '-'}`);
      } catch (e) {
        console.warn('[bravo.runtime] stale-queue purge skipped:', asErrorMessage(e));
      }
    }
    } catch (e) {
      // P1-2 — best-effort: keep the runtime build alive so history hydrates
      // and sends work offline-queued; retry the upload once the socket
      // reconnects (armed below in onStateChange('connected')).
      console.warn('[bravo.runtime] boot bundle publish failed (will retry on reconnect):', asErrorMessage(e).slice(0, 80));
      bootBundlePublishPending = true;
    }
  } else {
    console.log('[bravo.runtime] deferBundlePublish=true — bundle upload deferred to post-restore');
  }
  // Capture handles needed by publishOwnBundleAfterRestore so the
  // restore screen can re-run the upload with the recovered identity
  // without re-building the runtime.
  // Why: discards the rotation flag on purpose — the restore republish
  // presents the restored OLD identity, and the purge must never fire here.
  livePublishOwnBundle = async (): Promise<void> => { await publishOwnBundle(ownStore, keys, ownAddress); };

  // Sender cert cache — lazily fetches on first send.
  const ownIdentity = await ownStore.getIdentityKeyPair();
  const certCache = new SenderCertCache(certClient, signalDeviceId, toBase64(ownIdentity.pubKey));
  // Audit 1:1 P1-1 — sender-cert revocation polling. `verifySenderCert`
  // already accepts a `revokedJtis: ReadonlySet<string>`; the missing
  // producer is added here. Default 5-min cadence trims a leaked-cert
  // window from the cert TTL down to ~5 min (the audit's stated target).
  const revokedJtiCache = new RevokedJtiCache({
    client:  certClient,
    onError: e => console.warn('[bravo.runtime] revocation-list fetch failed:', e.message),
  });
  revokedJtiCache.start();

  // Tear down any prior runtime's module-level handles BEFORE we
  // construct new ones — without this the previous heartbeat /
  // appstate / subscriber keeps firing against a torn-down transport
  // and SQLCipher DB. (Idempotent — first run is a no-op.)
  disposeLiveRuntime();
  // BS-DISPOSE-LEAK (F13) — park THIS runtime's revocation poll AFTER the
  // prior-runtime teardown (which stopped the previous one), so the next
  // disposeLiveRuntime() stops this one too.
  liveRevokedJtiCache = revokedJtiCache;

  // Round 6 / race fix — bump owner epoch so async work spawned by
  // this runtime can prove "I am the live runtime" before mutating the
  // store. Epoch is strictly monotonic and never recycled: we track
  // the highest value ever seen via `lastOwnerEpoch` so even after a
  // dispose set `currentOwnerEpoch = NO_OWNER_EPOCH`, the next build
  // gets a value greater than every previous runtime's `myEpoch`. A
  // recycled epoch would create a false-negative bail: a stale closure
  // captured `myEpoch=N`, dispose set live to -1, new build assigned
  // live=N again → stale closure sees match → frame leaks through.
  lastOwnerEpoch += 1;
  currentOwnerEpoch = lastOwnerEpoch;
  const myEpoch = currentOwnerEpoch;
  const isOurEpoch = (): boolean => myEpoch === currentOwnerEpoch;

  // Audit P1-10 — reconcile the blocked-peer set from auth-service so blocks
  // are enforced after a reinstall / owner-switch WITHOUT the user visiting
  // the blocked-list screen. Best-effort + non-blocking (P1-2's lesson): a
  // fetch failure keeps the persisted local set and NEVER bricks the boot.
  // The epoch guard stops a late-resolving fetch from writing the previous
  // owner's list under the new owner's key after a fast account switch.
  void (async () => {
    try {
      const usersClient = new UsersHttpClient({
        baseUrl:      config.authBaseUrl,
        getToken:     config.getToken,
        refreshToken: config.refreshToken,
      });
      const blocked = await usersClient.listBlocked();
      if (!isOurEpoch()) {return;}
      await setBlockedPeers(blocked.map(b => b.userId));
    } catch { /* offline / backend down — keep the persisted local set */ }
  })();

  // Track pending client-side msgIds → messageId so envelope.accepted
  // can flip the local message's status.
  //
  // Fix #3: extended value type carries the WS-ack watchdog timer so
  // handleAccepted + httpFallback success can clear it; without that
  // the 5s timer fires AFTER we've already flipped to 'sent' and
  // forces a duplicate HTTP retry.
  //
  // Fix #8: bounded LRU. The Map was previously unbounded — long-
  // running session with thousands of failed sends would balloon. We
  // cap at MAX_PENDING and evict oldest on insert.
  // Audit P0-N4: `peer` is now required so handleAccepted can resolve
  // the per-peer outbox row (composite PK includes peer_user_id +
  // peer_device_id). For group sends the same clientMsgId maps to many
  // outbox rows; the WS path is 1:1 only so only one peer is recorded.
  const pendingByClientMsgId = new Map<string, {
    conversationId: string;
    messageId: string;
    peer: SessionAddress;
    ackTimer?: ReturnType<typeof setTimeout>;
  }>();
  const MAX_PENDING = 1000;
  const trackPending = (clientMsgId: string, entry: {
    conversationId: string;
    messageId: string;
    peer: SessionAddress;
    ackTimer?: ReturnType<typeof setTimeout>;
  }): void => {
    if (pendingByClientMsgId.size >= MAX_PENDING && !pendingByClientMsgId.has(clientMsgId)) {
      // Evict oldest. Map preserves insertion order so the first key
      // returned by `keys()` is the oldest.
      const oldest = pendingByClientMsgId.keys().next().value;
      if (oldest !== undefined) {
        const ev = pendingByClientMsgId.get(oldest);
        if (ev?.ackTimer) { clearTimeout(ev.ackTimer); }
        // Round 5 / Security S5 — surface an evicted-still-sending
        // entry as 'failed' so the user can retry. Previously the
        // message sat in 'sending' state forever (silent self-DoS),
        // which an attacker could weaponise: sustained fan-out at
        // > MAX_PENDING/sec evicts every legitimate pending entry,
        // and the user never sees an error to retry.
        if (ev) {
          try {
            const store = useMessengerStore.getState();
            const list = store.messages[ev.conversationId];
            const msg = list?.find(m => m.id === ev.messageId);
            // Only flip to failed if it's still in flight; an entry
            // that was already 'sent' (and just hadn't been cleared)
            // shouldn't be re-marked.
            if (msg && msg.status === 'sending') {
              store.updateMessageStatus(ev.conversationId, ev.messageId, 'failed');
              store.setError('A pending message timed out — please retry');
              console.warn(`[messenger] LRU-evicted pending msg=${ev.messageId} convo=${ev.conversationId} flipped to failed`);
            }
          } catch (e) {
            console.warn('[messenger] LRU-evict surface failed:', (e as Error).message);
          }
        }
        pendingByClientMsgId.delete(oldest);
      }
    }
    pendingByClientMsgId.set(clientMsgId, entry);
  };
  const clearPending = (clientMsgId: string): void => {
    const entry = pendingByClientMsgId.get(clientMsgId);
    if (entry?.ackTimer) { clearTimeout(entry.ackTimer); }
    pendingByClientMsgId.delete(clientMsgId);
  };

  // Fix #22: retry queue for failed SQLCipher upserts. Keyed
  // `${conversationId}:${messageId}`. Drained on next store change.
  //
  // Audit fix #39 — once the queue grows beyond UPSERT_BACKPRESSURE_THRESHOLD
  // we surface a sticky banner via store.error so the user knows their
  // local saves are falling behind. We do NOT await each upsert in the
  // hot store-subscriber path because that would block UI updates on
  // disk fsync; we DO surface the failure mode loudly so silent data
  // loss can't happen.
  const upsertRetryQueue = new Map<string, LocalMessage>();
  const UPSERT_BACKPRESSURE_THRESHOLD = 100;

  // Fix #4: drainRelay mutex. Coalesces WS-reconnect, AppState 'active'
  // foreground push, and ChatScreen pullEnvelopes() into ONE in-flight
  // call. Without this, three sources can fire concurrent pulls; the
  // server is idempotent on ack but the cost is needless network
  // chatter and triple-decryption of the same envelope.
  let drainInflight: Promise<void> | null = null;

  // Audit P1-G2 — per-group mutex for multi-step admin operations.
  //
  // The original remove/rekey + add/rekey + leave/rekey flows are each
  // two broadcast envelopes (`{remove, rekey}`, `{add, rekey}`,
  // `{leave, rekey}`) with a `setGroupState(intermediate)` between
  // them. A concurrent `sendText` to the same group that lands in the
  // tick BETWEEN the two state writes encrypts under the
  // INTERMEDIATE-state master key (which is still the OLD key for
  // remove + leave, or the OLD key for add too) — that part is fine,
  // but the EPOCH stamped into the AAD reflects only step 1's advance
  // (E+1), not the post-rekey value (E+2). A receiver who has already
  // applied BOTH admin envelopes will reject the in-flight text with
  // `epoch_stale` (see P0-G1 in sealedSender). Result: silently
  // dropped messages during admin churn.
  //
  // Mutex per group: any admin op + any send for the same group are
  // serialised. Cross-group ops remain parallel. Held only for the
  // duration of the two-step plan, so the steady-state send path is
  // unaffected.
  const groupAdminLocks = new Map<string, Promise<unknown>>();
  const runWithGroupAdminLock = async <T>(groupId: string, work: () => Promise<T>): Promise<T> => {
    const prev = groupAdminLocks.get(groupId) ?? Promise.resolve();
    const next = prev.then(work, work);
    // Track the next promise so callers see linear ordering, but drop
    // the entry once it settles so the Map doesn't grow per group-op.
    groupAdminLocks.set(groupId, next);
    void next.finally(() => {
      if (groupAdminLocks.get(groupId) === next) {
        groupAdminLocks.delete(groupId);
      }
    });
    return next;
  };

  // Fix #11: short-lived peer identity-key cache. Without this, EVERY
  // outbound message hits /auth/keys/:userId which atomically pops a
  // one-time pre-key. Sending 50 messages exhausts a peer's OPK pool
  // (50 keys at install) in a single chat session.
  // Pool exhaustion → next X3DH stalls until the peer comes back
  // online to refill. Cache the identity for 8 minutes (well under
  // the cert-cache 60-min refresh window).
  const peerIdentityCache = new Map<string, {idKey: string; fetchedAt: number}>();
  const PEER_IDENTITY_TTL_MS = 8 * 60 * 1000;

  // A4 — re-seal + ship a DEFERRED group outbox row. Captures the runtime
  // crypto context so drainOutbox (a module-level function) can recover a
  // member whose session couldn't be established at send time. Re-establishes
  // the pairwise session, re-seals the stored group body to THIS peer with a
  // FRESH AAD timestamp (the re-send is happening now), and returns the outer
  // sealed envelope for the drain to ship. A throw (peer still unprovisioned)
  // propagates to the drain's recordAttempt/backoff. Declared at the factory
  // top level so both the reconnect handler and the boot/timer drains see it.
  const resealDeferredGroupRow: ResealDeferredFn = async (row, payload) => {
    const peer: SessionAddress = {userId: row.peerUserId, deviceId: row.peerDeviceId};
    await ensureOutgoingSession(own, keys, peer, ownStore);
    const freshCert = await certCache.get();
    const sealed = sealPayload(freshCert, payload.sealedBody, {
      expiresAtSec: payload.expiresAtSec,
      clientMsgId:  payload.clientMsgId,
      attachment:   payload.attachment,
      group: {groupId: payload.groupId, kind: payload.kind, clientMsgId: payload.clientMsgId},
      aad: {
        to:             peer,
        ts:             Date.now(),
        sender:         ownAddress,
        conversationId: payload.groupId,
        groupId:        payload.groupId,
      },
    });
    const ct = await own.encrypt(peer, sealed);
    const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS);
    const outerSealed = await wrapOuter({
      recipientIdentityKeyB64: recipientIdKeyB64,
      sender:                  ownAddress,
      ciphertext:              ct,
      cert:                    freshCert,
    });
    return {outerSealed, expiresAtSec: payload.expiresAtSec};
  };

  // B-46 — sender-side auto-resend on `envelope.undeliverable`. The
  // recipient's device destroyed our envelope (identity churn: they
  // reinstalled / cleared data / restored a fresh identity), but WE
  // still hold the plaintext. Eligibility + the one-attempt budget are
  // decided in undeliverableResend.ts; this closure executes the
  // recovery: overwrite the dead trusted identity + session with the
  // peer's CURRENT authority-signed bundle, re-seal the same row's
  // plaintext, and submit under a NEW clientMsgId (the old id is
  // dedup-claimed on the relay for the dwell window — reusing it would
  // coalesce into the destroyed envelope and silently drop). Ships via
  // HTTP relay for a deterministic accept (no WS ack race). Failures
  // leave the bubble at `undelivered` — the ChatScreen retry chip is
  // the manual fallback.
  const resendUndeliverable = (envelopeId: string): void => {
    void (async () => {
      if (!isOurEpoch()) {return;}
      const st = useMessengerStore.getState();
      const decision = selectUndeliverableResend(
        {messages: st.messages, conversations: st.conversations},
        envelopeId,
        Date.now(),
      );
      if (decision.action === 'skip') {
        // Reason codes only — never content.
        console.log(`[messenger] undeliverable-resend skip env=${envelopeId.slice(0, 8)} reason=${decision.reason}`);
        return;
      }
      const {conversationId, message, peer, expiresAtSec} = decision;
      try {
        // The cached identity is what the DEAD wrap was built from.
        peerIdentityCache.delete(peer.userId);
        await forceRefreshOutgoingSession(own, keys, peer, ownStore);
        const cert = await certCache.get();
        const newClientMsgId = makeId();
        const sealed = sealPayload(cert, message.content, {
          expiresAtSec,
          clientMsgId: newClientMsgId,
          replyTo: message.reply_to_msg_id
            ? {msgId: message.reply_to_msg_id, preview: (message.reply_to_preview ?? '').slice(0, 200)}
            : undefined,
          aad: {
            to:             peer,
            ts:             Date.now(),
            sender:         ownAddress,
            conversationId: directConvoAadId(ownAddress.userId, peer.userId),
          },
        });
        const ct = await own.encrypt(peer, sealed);
        const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS);
        const outerSealed = await wrapOuter({
          recipientIdentityKeyB64: recipientIdKeyB64,
          sender:                  ownAddress,
          ciphertext:              ct,
          cert,
        });
        const r = await relay.send({recipient: peer, outerSealed, clientMsgId: newClientMsgId, expiresAtSec});
        if (!isOurEpoch()) {return;}
        const st2 = useMessengerStore.getState();
        if (r.envelopeId) {st2.updateMessageEnvelopeId(conversationId, message.id, r.envelopeId);}
        if (r.retractToken) {st2.updateMessageRetractToken(conversationId, message.id, r.retractToken);}
        st2.updateMessageStatus(conversationId, message.id, 'sent');
        crashLog(`[messenger] undeliverable-resend ok msg=${message.id.slice(0, 8)} env=${envelopeId.slice(0, 8)}->${(r.envelopeId ?? '').slice(0, 8)}`);
      } catch (e) {
        // Bubble stays `undelivered` (honest); budget already consumed so
        // a discard of a FAILED resend can't ping-pong.
        crashLog(`[messenger] undeliverable-resend failed msg=${message.id.slice(0, 8)} err=${asErrorMessage(e).slice(0, 80)}`);
      }
    })();
  };

  // Fix #7: track when we last received a pong so AppState 'active'
  // can skip the force-reconnect when the socket is genuinely live.
  let lastPongAt = 0;

  // Round 7 / presence audit fix #1 — track every userId we've asked
  // the server to watch. On socket reconnect, the server's `watch:<id>`
  // room membership is tied to the *socket id*, not our auth pid;
  // every fresh socket joins zero rooms and we'd see every contact go
  // offline forever after the first network blip. The runtime now owns
  // the source-of-truth subscription set and resubscribes on every
  // `connected` transition so watchers stay current across Doze, force
  // reconnect, server restart, supersession, etc.
  // Audit MSG-16 — REFCOUNTED presence subscriptions (userId → count). Home
  // subscribes a peer while its row is visible AND ChatScreen subscribes the
  // same peer on open; a flat Set meant closing the Chat (unsubscribe) removed
  // the shared entry, so the server dropped us from watch:<peer> and Home's
  // dot went dead until remount. Refcounting only releases the wire watch when
  // the LAST subscriber for that peer unsubscribes.
  const presenceSubscriptions = new Map<string, number>();
  // Audit MSG-06 — read receipts emitted while the socket was down were lost
  // forever (markRead flips the local bubble to 'read', which then skips it on
  // every future markRead, and the best-effort emit dropped silently). Queue
  // the (peer → envelopeIds) that couldn't be sent and flush on reconnect so
  // the sender eventually gets blue ticks.
  //
  // Audit P2-7 (2026-07-09) — the MSG-06 queue was memory-only (an app kill
  // while offline permanently lost the receipts — the bubble is already
  // 'read' so they are never re-collected) and was cleared even when the
  // flush emit threw. Mirror the queue to AsyncStorage per owner, remove an
  // entry only AFTER its emit succeeded, restore on boot, and flush on
  // reconnect AND app-foreground.
  const pendingReadReceipts = new Map<string, {peer: SessionAddress; envelopeIds: Set<string>}>();
  const pendingReadReceiptsKey = `messenger.pendingReadReceipts.v1.${config.ownerKey ?? config.ownUserId}`;
  const persistPendingReadReceipts = async (): Promise<void> => {
    try {
      const AsyncStorage = (require('@react-native-async-storage/async-storage') as
        {default: {setItem(k: string, v: string): Promise<void>; removeItem(k: string): Promise<void>}}).default;
      if (pendingReadReceipts.size === 0) {
        await AsyncStorage.removeItem(pendingReadReceiptsKey);
        return;
      }
      // Only envelope ids + peer addresses — never message content.
      const rows = [...pendingReadReceipts.values()]
        .map(s => ({peer: s.peer, envelopeIds: [...s.envelopeIds]}));
      await AsyncStorage.setItem(pendingReadReceiptsKey, JSON.stringify(rows));
    } catch { /* AsyncStorage unavailable (tests) — memory queue still works */ }
  };
  // Hoisted (function declaration) — referenced from the transport
  // onStateChange callback and the AppState handler; both fire only after
  // the factory finished constructing `transport`.
  function flushPendingReadReceipts(): void {
    if (pendingReadReceipts.size === 0) {return;}
    if (transport.state !== 'connected') {return;}
    let flushedAny = false;
    for (const [key, {peer, envelopeIds}] of [...pendingReadReceipts.entries()]) {
      try {
        transport.sendReadReceipt(peer, [...envelopeIds]);
        // Why: delete only after the emit didn't throw — a half-open socket
        // keeps the entry queued for the next reconnect/foreground flush.
        pendingReadReceipts.delete(key);
        flushedAny = true;
      } catch { /* socket race — entry stays queued */ }
    }
    if (flushedAny) {void persistPendingReadReceipts();}
  }
  // Round 7 / presence audit fix #2 — track our own activity state so
  // we can re-emit it on reconnect (otherwise we'd revert to plain
  // `online` after every blip even while the user is mid-conversation).
  let lastActivity: 'active' | 'away' = 'active';
  // Round 8 / presence false-active audit — reconnect bookkeeping.
  //   `wasDisconnected` flips true on the first `disconnected` state and
  //   gates the post-reconnect store-clear so the very first connect
  //   doesn't pointlessly flicker a fresh subscription set.
  //   `lastClearAtMs` debounces back-to-back clears so a flaky network's
  //   exponential-backoff cycle (1-30s) doesn't strobe presence dots —
  //   one clear per 3s window is enough; the next snapshot will repaint
  //   regardless.
  let wasDisconnected = false;
  let lastPresenceClearAtMs = 0;
  const PRESENCE_CLEAR_DEBOUNCE_MS = 3_000;

  // Pre-declare the durable-outbox handle in the runtime scope so the
  // transport's onFrame closure below can reference it without hitting
  // a TDZ error if a frame arrives between transport.connect() and the
  // later block that actually constructs the store. Constructed below
  // once the SQLCipher DB handle is available.
  let sqlOutbox: SqlOutboxStore | null = null;

  // Why: transport.connect() fires at line ~791, but seven FrameDeps
  // (sqlMessages, seenEnvelopes, txnDb, sqlOutbox, pendingGroupEnvelopes,
  // pendingAdminActions, mediaCache) aren't constructed until lines
  // ~982-1012. Any envelope.deliver that arrives in that ~1-2s window
  // hits handleDeliver against null deps. The non-txn fallback path
  // *should* still ack — but if any subtle ordering throw fires (e.g.
  // libsignal needs txnDb to commit a session UPSERT and silently no-ops
  // when null, leaving the ratchet half-advanced), the envelope is
  // silently dropped without an ack. Buffer inbound frames here until
  // the deps init block flips depsReady=true; drain in FIFO order.
  let depsReady = false;
  const pendingFrames: ServerFrame[] = [];

  // Single dispatch helper — used by both the live `onFrame` callback
  // and the post-deps `drainPendingFrames` call. Hoisted via `function`
  // declaration so it's available inside the TransportClient closure.
  function dispatchFrame(frame: ServerFrame): void {
    void handleServerFrame(frame, {
      own, ownStore, pendingByClientMsgId, config, relay, keys, peerIdentityCache,
      rehandshakeNudge: (peer) => sendRehandshakeNudge({
        own, ownStore, keys, peer, ownAddress, certCache, transport, relay,
      }),
      // B-46 — auto-resend destroyed-on-recipient envelopes.
      resendUndeliverable,
      onPong: ts => { lastPongAt = ts; },
      outbox: sqlOutbox,
      // Audit P0-N14 — both writers share the same SQLCipher handle,
      // so handleIncoming can wrap the decrypt → upsert pair in a
      // single BEGIN IMMEDIATE / COMMIT.
      txnDb: ownStore instanceof SqlCipherProtocolStore ? ownStore.getDb() : null,
      sqlMessages,
      // Audit P0-N6 — persistent receive-side envelope-id dedup.
      seenEnvelopes,
      // Audit 1:1 P1-1 — cert revocation cache.
      revokedJtiCache,
      // Bug-hunt #3 — stash for pre-master-key group envelopes +
      // out-of-epoch admin actions.
      pendingGroupEnvelopes,
      pendingAdminActions,
    }).catch(e => {
      // Round 6 / race fix — re-check the epoch in the .catch
      // because handleServerFrame is async and could resolve AFTER
      // logout. Without this, an error mid-frame would set a banner
      // on the new user's store.
      if (!isOurEpoch()) {return;}
      // Bug-hunt — log every frame-processing failure so we can see
      // silent drops in JS console / Crashlytics. The catch handler
      // is the last line of defence; anything reaching here is a bug.
      console.warn('[messenger.dispatchFrame] event=' + (frame as {event: string}).event + ' err=' + asErrorMessage(e));
      if (isRecoverableFrameError(e)) {
        useMessengerStore.getState().setRecoveryBanner(asErrorMessage(e));
      } else {
        useMessengerStore.getState().setError(asErrorMessage(e));
      }
    });
  }

  function drainPendingFrames(): void {
    if (pendingFrames.length === 0) {return;}
    const toRun = pendingFrames.splice(0, pendingFrames.length);
    console.log('[messenger.boot] depsReady — draining ' + toRun.length + ' buffered frame(s)');
    for (const f of toRun) {
      try { dispatchFrame(f); } catch (e) {
        console.warn('[messenger.boot] drain-dispatch threw:', asErrorMessage(e));
      }
    }
  }

  // socket.io transport for push delivery + fast send. The server runs
  // socket.io 4.x with the Redis adapter, so any replica in the cluster
  // can service this connection.
  const transport = new TransportClient({
    url:            config.wsUrl,
    signalDeviceId,
    getToken:       config.getToken,
    refreshToken:   config.refreshToken,
    onFrame: frame => {
      // Round 6 / race fix — drop frames that arrive after our owner
      // epoch was bumped (logout / user-switch in flight). Without
      // this, a frame that was already in the socket.io receive queue
      // at signOut() can run through handleServerFrame AFTER the next
      // user's runtime has wired up the store, writing the prior
      // user's plaintext into the new user's `messages` map. Silent
      // drop is correct: the prior user's transport will be torn
      // down, and they'll re-pull on next login if anything was
      // mid-flight.
      if (!isOurEpoch()) {
        return;
      }
      // Why: buffer until SQLCipher-backed deps (sqlMessages,
      // seenEnvelopes, txnDb, etc.) are wired (see depsReady declaration
      // above). Call frames are exempt — they have their own dispatcher
      // that doesn't need these deps, and any delay would drop a ringing
      // call. Drain runs at end of SQLCipher init block.
      if (!depsReady && !isCallFrame((frame as {event: string}).event)) {
        pendingFrames.push(frame);
        return;
      }
      dispatchFrame(frame);
    },
    onStateChange: state => {
      // Round 6 / race fix — drop state callbacks that fire after our
      // epoch was bumped. socket.io's disconnect can take a tick or
      // two to propagate; a `disconnected` callback that lands AFTER
      // logout would mistakenly flip the NEW user's connection state.
      if (!isOurEpoch()) {return;}
      // Mirror into the store so the chat header banner can observe it
      // through a Zustand selector (no prop-drilling through navigation).
      useMessengerStore.getState().setConnection(state);
      if (state === 'superseded') {
        // Single-device takeover (WhatsApp model): a newer login of this
        // account on ANOTHER device evicted this socket. Don't leave the
        // user on the soft "reopen to switch back" banner — the auth-service
        // now REVOKES this device's token on the new login, so "switch back"
        // would re-login here and ping-pong the new device off. Fully sign
        // out so this device drops to the login screen instead. Deferred +
        // lazy-required so we don't re-enter this very state callback while
        // signOut() tears the runtime + transport down; the epoch re-check
        // skips it if a legit user-switch already happened.
        setTimeout(() => {
          if (!isOurEpoch()) {return;}
          try {
            const {useAuthStore} = require('@/store/authStore') as typeof import('@/store/authStore');
            void useAuthStore.getState().signOut();
          } catch { /* best-effort — next /auth/me 401 still ends the session */ }
        }, 0);
        return;
      }
      if (state === 'disconnected') {
        // Mark that the next connect is a RE-connect, not a fresh boot
        // — gates the presence-clear below.
        wasDisconnected = true;
      }
      if (state === 'connected') {
        // Catch-up pull on (re)connect — in case the socket was offline
        // while envelopes piled up on the relay. Failures are silent —
        // a transient pull error must not red-banner the chat surface;
        // next AppState active / WS reconnect retries automatically.
        coalescedDrain().catch(e => {
          if (!isOurEpoch()) {return;}
          console.warn('[bravo.drainRelay] reconnect drain failed:', asErrorMessage(e));
        });
        // P1-2 — retry the boot bundle upload that failed offline. One-shot
        // per reconnect; re-arms on a repeated failure so a still-flaky
        // auth-service is retried on the next `connected` transition.
        if (bootBundlePublishPending && livePublishOwnBundle) {
          bootBundlePublishPending = false;
          void livePublishOwnBundle().catch(e => {
            if (!isOurEpoch()) {return;}
            console.warn('[bravo.runtime] reconnect bundle-publish retry failed:', asErrorMessage(e).slice(0, 80));
            bootBundlePublishPending = true;
          });
        }
        // Durable outbox replay — on every reconnect, re-ship anything
        // that piled up while the socket was down (or from a previous
        // crashed session). Best-effort: failures keep the row in the
        // outbox so the NEXT reconnect retries.
        if (sqlOutbox) {
          void drainOutbox(sqlOutbox, relay, isOurEpoch, resealDeferredGroupRow);
        }
        // Self-heal — a reconnect is the natural moment for a member that
        // came back online (or just logged in) to ask the owner to
        // re-share the key for any group it has no master key for. The
        // helper is defined later in this factory but this closure only
        // fires after construction, so the reference is safe. Rate-limited
        // per group inside; best-effort.
        if (isOurEpoch()) {
          void requestGroupKeyResyncImpl().catch(() => { /* best-effort */ });
        }
        // Phase-2 ratchet-snapshot capture — a reconnect implies the
        // socket was down for a spell, during which the peer likely
        // advanced our ratchets via inbound. Request a (debounced)
        // capture so a reinstall right after wouldn't lose that delta.
        try {
          const {requestCapture} = require('../backup/ratchetSnapshotScheduler') as
            typeof import('../backup/ratchetSnapshotScheduler');
          void requestCapture().catch(() => { /* best-effort */ });
        } catch { /* scheduler not loaded yet — fine */ }
        // B-48 — push-token self-heal. The server may have reaped this
        // device's FCM token rows while we were offline/killed (dead-token
        // GC, logout tombstone from an account switch elsewhere); the
        // client-side `serverRegistered` flag can't see that. Re-assert
        // both /push/register* rows on every reconnect — throttled inside
        // (60s min interval), idempotent POSTs, best-effort.
        try {
          const {ensurePushRegistered} = require('../push/fcmBootstrap') as
            typeof import('../push/fcmBootstrap');
          void ensurePushRegistered().catch(() => { /* best-effort */ });
        } catch { /* push module not loaded (tests) — fine */ }
        // Round 8 / false-active audit fix #2 — flip subscribed peers
        // to `offline` BEFORE resubscribing on a real reconnect. While
        // the socket was down we received zero presence frames; any
        // peer who went offline mid-disconnect would otherwise stay
        // pinned at the last-known `online`/`active` value forever.
        // The server's `presence.subscribe` snapshot will repaint the
        // truly-online ones in ~1 RTT.
        //
        // Two guards keep this from flickering the UI:
        //   1. `wasDisconnected` — skip on the initial connect, where
        //      there's nothing stale to clear.
        //   2. `PRESENCE_CLEAR_DEBOUNCE_MS` — under poor networks
        //      socket.io retries every 1-5s; without debounce the
        //      chat-list dots would strobe through every backoff cycle.
        if (
          wasDisconnected
          && presenceSubscriptions.size > 0
          && Date.now() - lastPresenceClearAtMs > PRESENCE_CLEAR_DEBOUNCE_MS
        ) {
          try {
            useMessengerStore.getState().clearPresence([...presenceSubscriptions.keys()]);
            lastPresenceClearAtMs = Date.now();
          } catch { /* store may be mid-swap during owner switch */ }
        }
        wasDisconnected = false;
        // Round 7 / presence audit fix #1 — replay every presence
        // subscription so the new socket joins the right `watch:<id>`
        // rooms. Without this, watchers go silent after any blip.
        if (presenceSubscriptions.size > 0) {
          try {
            transport.subscribePresence([...presenceSubscriptions.keys()]);
          } catch { /* socket reconnect race — next state-change retries */ }
        }
        // Round 7 / presence audit fix #2 — re-assert our own activity
        // so peers see us light up immediately after a reconnect rather
        // than after the next AppState change.
        try { transport.setActivity(lastActivity); } catch { /* socket race */ }
        // Audit MSG-06 / P2-7 — flush read receipts that couldn't be sent
        // while the socket was down. Entries are removed per-peer only
        // after their emit succeeded; failures stay queued (durably) for
        // the next reconnect/foreground flush.
        flushPendingReadReceipts();
      }
    },
  });

  // Audit P2-7 — restore the durable read-receipt queue from a previous
  // process (app killed while offline) and flush it once connected.
  void (async () => {
    try {
      const AsyncStorage = (require('@react-native-async-storage/async-storage') as
        {default: {getItem(k: string): Promise<string | null>}}).default;
      const raw = await AsyncStorage.getItem(pendingReadReceiptsKey);
      if (!raw || !isOurEpoch()) {return;}
      const rows = JSON.parse(raw) as Array<{peer: SessionAddress; envelopeIds: string[]}>;
      if (!Array.isArray(rows)) {return;}
      for (const r of rows) {
        if (!r?.peer?.userId || !Array.isArray(r.envelopeIds)) {continue;}
        const key = `${r.peer.userId}.${r.peer.deviceId}`;
        const slot = pendingReadReceipts.get(key) ?? {peer: r.peer, envelopeIds: new Set<string>()};
        for (const id of r.envelopeIds) {if (typeof id === 'string') {slot.envelopeIds.add(id);}}
        pendingReadReceipts.set(key, slot);
      }
      flushPendingReadReceipts();
    } catch { /* AsyncStorage unavailable / corrupt row — memory queue still works */ }
  })();

  // Fix #4: coalesce concurrent drains. WS reconnect, AppState 'active',
  // and ChatScreen.pullEnvelopes() can all race; without a mutex the
  // server logs three back-to-back GET /envelopes from the same device.
  // While inflight, every caller gets the same Promise.
  // Fix #5: paginate — keep pulling until the server has nothing left
  // (or 10 iterations as a hard cap; anything more is symptomatic of
  // an ack failure loop and we want to break out cleanly).
  const coalescedDrain = (): Promise<void> => {
    // Round 6 / race fix — bail before kicking off a drain when we're
    // no longer the live runtime. drainRelay walks the relay queue and
    // funnels each envelope through handleIncoming → store mutations,
    // any of which would land on the new user's store if our epoch is
    // stale.
    if (!isOurEpoch()) {return Promise.resolve();}
    if (drainInflight) { return drainInflight; }
    const run = async (): Promise<void> => {
      try {
        // Re-check inside the async — between the synchronous gate
        // above and the first await, signOut could have flipped the
        // epoch. Cheap.
        if (!isOurEpoch()) {return;}
        await drainRelay(
          own, ownStore, relay, config, keys,
          (peer) => {
            if (!isOurEpoch()) {return;}
            void sendRehandshakeNudge({own, ownStore, keys, peer, ownAddress, certCache, transport, relay});
          },
          peerIdentityCache,
          // Audit P0-N14 — atomic ratchet+plaintext on the drain path too.
          ownStore instanceof SqlCipherProtocolStore ? ownStore.getDb() : null,
          sqlMessages,
          // Audit P0-N6 — dedup on the HTTP catch-up path too.
          seenEnvelopes,
          // Audit 1:1 P1-1 — cert revocation cache on the drain path too.
          revokedJtiCache,
          // Bug-hunt #3 — pending-stash threading on the drain path too.
          pendingGroupEnvelopes,
          pendingAdminActions,
        );
      } finally {
        drainInflight = null;
      }
    };
    drainInflight = run();
    return drainInflight;
  };

  await transport.connect();

  // Network-handover fix: subscribe to NetInfo so a Wi-Fi ↔ cellular
  // swap kicks the WS off the dead route inside ~1s instead of waiting
  // for socket.io's 25s heartbeat to notice. Symptom we're fixing: the
  // user's logcat (05-14 07:42:56) showed sockets destroyed at the OS
  // layer while the JS-side ws still believed itself connected — the
  // next `call.offer` queued forever because the underlying TCP was
  // dead. NetInfo fires immediately on the OS-level connectivity-change
  // broadcast (the same source ConnectivityService.broadcastDNS uses),
  // so we get the signal long before socket.io would.
  //
  // We unsubscribe at runtime teardown (epoch flip / logout); the
  // subscription lifetime is bound to this transport.
  let netInfoUnsub: (() => void) | null = null;
  try {
    const NetInfo = (require('@react-native-community/netinfo') as typeof import('@react-native-community/netinfo')).default;
    let lastType: string | undefined;
    let lastReachable: boolean | null | undefined;
    netInfoUnsub = NetInfo.addEventListener((state) => {
      // Only act on actual transitions — NetInfo emits an initial
      // snapshot at subscribe time and a noisy stream of duplicates
      // during steady state.
      const changed =
        state.type !== lastType ||
        state.isInternetReachable !== lastReachable;
      lastType = state.type;
      lastReachable = state.isInternetReachable;
      if (!changed) {return;}
      if (state.isConnected && state.isInternetReachable !== false) {
        // Why: Android's NetInfo is chatty — `isInternetReachable` can
        // flap on captive-portal probes, transient DNS hiccups, and
        // 4G/5G band changes even on a steady connection. Every flap
        // used to fire notifyNetworkChange() → forceReconnect() which
        // destroys + rebuilds the WS, blowing away in-flight `envelope.send`
        // emits and forcing a fresh handshake. Skip the rebuild when
        // our server-pong is recent (≤10s): the socket is genuinely
        // alive and the OS-level connectivity-change is a false alarm.
        // Real handovers (Wi-Fi → cellular) drop pings so pong staleness
        // catches them within one heartbeat interval (25s).
        const pongFresh = transport.state === 'connected'
          && lastPongAt > 0
          && (Date.now() - lastPongAt) < 10_000;
        if (pongFresh) {return;}
        void transport.notifyNetworkChange().catch(() => { /* best-effort */ });
      }
    });
  } catch (e) {
    // NetInfo missing (web / test) — skip the optimisation, transport
    // still has its own 25s heartbeat-based reconnect.
    console.warn('[productionRuntime] NetInfo subscribe failed:', (e as Error)?.message);
  }
  // Stash so teardown can release it.
  (transport as unknown as {_netInfoUnsub?: () => void})._netInfoUnsub = netInfoUnsub ?? undefined;

  // Restore-after-reinstall fix #3 — wire up the sealed-archive replay
  // closure now that all the deps exist. The closure feeds a synthetic
  // ServerEnvelopeDeliver through handleDeliver, which unseals + calls
  // handleIncoming + writes to the local store + acks the relay. The
  // archive replay does not call ack(envelopeId) because the IDs come
  // from the long-term Supabase mirror, not Redis — so handleDeliver's
  // ack is a no-op against an unknown id, which the relay's ack path
  // already handles idempotently. See sealed_envelope_archive.sql.
  liveReplayArchive = async (env) => {
    if (!isOurEpoch()) {return;}
    const fakeFrame: ServerEnvelopeDeliver = {
      event: 'envelope.deliver',
      data: {
        envelopeId:  env.envelopeId,
        outerSealed: env.outerSealed,
        timestamp:   env.timestampMs,
      },
    };
    await handleDeliver(fakeFrame, {
      own, ownStore, pendingByClientMsgId, config, relay, keys, peerIdentityCache,
      // Audit §12.4 (2026-07-10) — the replay path previously stripped SIX
      // deps the live WS path carries, so replayed envelopes (a) skipped the
      // wasSeen gate and double-decrypted live-processed envelopes (Bad MAC
      // → spurious rehandshake resets of healthy sessions), (b) ack-dropped
      // keyless group envelopes instead of durably stashing them, (c)
      // dropped out-of-epoch admin actions, (d) lost the atomic
      // ratchet+plaintext receive txn (P0-N14), and (e) skipped sender-cert
      // revocation enforcement (P3-B-1). Thread them all, same as the live
      // dispatchFrame.
      txnDb: ownStore instanceof SqlCipherProtocolStore ? ownStore.getDb() : null,
      sqlMessages,
      seenEnvelopes,
      revokedJtiCache,
      pendingGroupEnvelopes,
      pendingAdminActions,
      rehandshakeNudge: async (peer) => {
        // Audit §12.4 — suppress replay-sourced Bad-MAC nudges for envelopes
        // the wasSeen gate would have caught (already processed live: the
        // message key is burned, the session is HEALTHY — a nudge would
        // reset it). Only genuinely-unseen replay failures still nudge.
        try {
          if (seenEnvelopes && await seenEnvelopes.wasSeen(env.envelopeId)) {return;}
        } catch { /* dedup-store hiccup — fall through to the nudge */ }
        await sendRehandshakeNudge({
          own, ownStore, keys, peer, ownAddress, certCache, transport, relay,
        });
      },
    });
  };
  liveDisposers.push(() => { liveReplayArchive = null; });

  // Publish the live socket so non-runtime surfaces (CallScreen,
  // useTransportRtt) can ride the same authenticated channel for
  // call.offer/answer/ice signalling and ping-pong RTT.

  const {setLiveTransport} = require('./transportRegistry') as typeof import('./transportRegistry');
  setLiveTransport(transport);

  // Foreground/background hook. On Android Doze and iOS background
  // suspend, the socket fd often gets torn down silently — socket.io's
  // own reconnect logic only fires when the OS lets it run again, which
  // can be many seconds after the user reopens the app. Eagerly
  // re-asserting the connection on AppState 'active' makes the
  // resume-from-lock-screen flow snappy and avoids the user staring at
  // a "Reconnecting…" banner that won't budge until the next heartbeat.

  const {AppState} = require('react-native') as typeof import('react-native');
  const appStateSub = AppState.addEventListener('change', (s: string) => {
    // Round 6 / race fix — disposeLiveRuntime removes this subscription
    // synchronously, but if a pending AppState change is already
    // queued in RN's event loop it could fire after dispose. Bail.
    if (!isOurEpoch()) {return;}
    if (s === 'active') {
      // Fix #7: skip force-reconnect when the socket is genuinely live.
      // Previously we ALWAYS tore the socket down on every foreground
      // transition — even a 2-second swipe-up-and-back would burn a
      // full handshake + replay. Use the heartbeat-pong recency to
      // decide: if we've heard from the server within 8s, the socket
      // is healthy and the Doze-thaw safety net isn't needed. If
      // the pong is older (or never observed), tear down + reconnect.
      const pongFresh = transport.state === 'connected'
        && (Date.now() - lastPongAt) < 8000
        && lastPongAt > 0;
      const resumeAction = decideResumeAction(pongFresh, hasLiveCall());
      if (resumeAction === 'drain') {
        // Still kick a coalesced drain to catch any envelopes that
        // piled up while the app was background. Cheap; idempotent.
        coalescedDrain().catch(() => { /* silent */ });
      } else if (resumeAction === 'probe') {
        // P1-BR-4 (B-58) — a live call's foreground service kept the
        // socket alive even though the backgrounded heartbeat left the
        // pong stale. forceReconnect() here would disconnect() the healthy
        // socket, and the gateway then hangs up the peer with a
        // call.hangup{failed}. Instead PROBE: send one ping and only
        // rebuild if no pong arrives within ~3 s (a genuinely dead socket).
        const probeAt = Date.now();
        try { transport.send({event: 'ping', data: {ts: probeAt}}); } catch { /* not open */ }
        setTimeout(() => {
          if (!isOurEpoch()) {return;}
          const pongLanded = lastPongAt >= probeAt;
          // Only tear down if the probe went unanswered AND the socket
          // isn't reporting connected — never rip a still-live call's
          // socket out from under it on the strength of a stale pong.
          if (!pongLanded && transport.state !== 'connected') {
            void transport.forceReconnect().catch(() => { /* surfaces via state machine */ });
          }
          coalescedDrain().catch(() => { /* silent */ });
        }, 3000);
        // Drain immediately too so queued envelopes aren't held for 3 s.
        coalescedDrain().catch(() => { /* silent */ });
      } else {
        void transport.forceReconnect().catch(() => { /* surfaces via state machine */ });
      }
      // Audit P2-7 — foreground is a flush point for queued read receipts
      // (no-op when the socket isn't connected; the onStateChange
      // 'connected' branch flushes after the reconnect instead).
      flushPendingReadReceipts();
      // Round 7 / presence audit fix #2 — flip back to active on every
      // foreground transition so the user reports `active` to peers
      // for the entire time they're using the app, not just when they
      // happen to have a chat thread open. If the socket isn't ready
      // yet the onStateChange('connected') branch will replay this.
      lastActivity = 'active';
      try { transport.setActivity('active'); } catch { /* socket not open */ }
    } else if (s === 'background' || s === 'inactive') {
      lastActivity = 'away';
      try { transport.setActivity('away'); } catch { /* socket not open */ }
    }
  });
  // Park the subscription on a module-level slot so a future runtime
  // reset can dispose it — leaking listeners would re-fire on every
  // login and bombard the socket with redundant connect() calls.
  // Fix #1: also register on liveDisposers so the test/_reset path
  // unwinds it without needing to know about every individual slot.
  liveAppStateSub?.remove?.();
  liveAppStateSub = appStateSub;
  liveDisposers.push(() => { appStateSub.remove?.(); });

  // Heartbeat ping every 4s while the socket is open. The server's
  // pong handler echoes the original ts; the frame loop above turns
  // that into an RTT sample published to rttRegistry. We deliberately
  // don't bail on send failures — TransportClient buffers in
  // 'reconnecting' state and the next interval picks up cleanly.
  //
  // Park the handle on a module slot so disposeLiveRuntime() can
  // clear it on logout / runtime rebuild — otherwise the previous
  // interval keeps firing against a torn-down transport (Fix #1).
  // Bail on 'unauthorized' so we don't ping a dead socket forever
  // after the user signs out / token-revoke (Fix #20).
  if (liveHeartbeat) { clearInterval(liveHeartbeat); }
  liveHeartbeat = setInterval(() => {
    // Round 6 / race fix — even though disposeLiveRuntime clears this
    // interval, a final tick can fire between the schedule decision
    // and the clearInterval taking effect. Bail when our epoch is
    // stale so we don't ping a torn-down transport with a token that
    // belongs to the previous user.
    if (!isOurEpoch()) {return;}
    if (transport.state === 'unauthorized') { return; }
    try { transport.send({event: 'ping', data: {ts: Date.now()}}); } catch { /* not open */ }
    // Phase-2 ratchet-snapshot capture — piggy-back the heartbeat as the
    // capture cadence. requestCapture() self-debounces to one upload per
    // MIN_CAPTURE_INTERVAL_MS, so calling it every 4s is effectively a
    // ~5-min capture loop with no extra timer to manage / dispose.
    try {
      const {requestCapture} = require('../backup/ratchetSnapshotScheduler') as
        typeof import('../backup/ratchetSnapshotScheduler');
      void requestCapture().catch(() => { /* best-effort */ });
    } catch { /* scheduler not loaded — fine */ }
  }, 4000);

  // SQLCipher message store — spec compliance for §2.2 ("Message store:
  // SQLCipher-encrypted local SQLite database"). Only available when
  // ownStore is the production SqlCipherProtocolStore (loopback runs
  // entirely in memory and skips this path).
  let sqlMessages: SqlMessageStore | null = null;
  let seenEnvelopes: SeenEnvelopeStore | null = null;
  // Bug-hunt #1.B/C — persistent session-wipe-protection state. Lives
  // in the same SQLCipher DB so the in-process Map cache in
  // `sessionWipeProtection` can be lazily filled from disk on cold
  // start instead of evaporating with the process.
  let peerSessionHealth: PeerSessionHealthStore | null = null;
  // Bug-hunt #3 — durable stash for group envelopes that arrived before
  // we held the master key, and admin actions that arrived out-of-epoch
  // order. Both live in the same SQLCipher DB so stash writes can
  // commit atomically with the receive transaction.
  let pendingGroupEnvelopes: PendingGroupEnvelopeStore | null = null;
  let pendingAdminActions: PendingAdminActionStore | null = null;
  // Durable outbox is declared earlier in the function so the
  // transport's onFrame closure can capture it without TDZ; here we
  // just construct it once the SQLCipher DB is available below.
  // Persistent media blob cache — keyed by R2 object key, lives in the
  // same SQLCipher DB so disk forensics can't recover the encrypted
  // bytes without the keychain key. The expiry sweeper, retract path,
  // and conversation-clear handler purge entries here when their
  // backing message is removed.
  let mediaCache: MediaBlobCache | null = null;
  if (ownStore instanceof SqlCipherProtocolStore) {
    sqlMessages = new SqlMessageStore(ownStore.getDb());
    sqlOutbox   = new SqlOutboxStore(ownStore.getDb());
    mediaCache  = new MediaBlobCache(ownStore.getDb());
    // Audit P0-N6 — persistent envelope-id dedup. Pruned to 35 days
    // on each boot so the table stays bounded.
    seenEnvelopes = new SeenEnvelopeStore(ownStore.getDb());
    seenEnvelopes.prune().catch(e =>
      console.warn('[messenger.seenEnvelopes] boot prune failed:', asErrorMessage(e)));
    // Bug-hunt #1 — warm the persistent peer-session-health store and
    // attach it to `sessionWipeProtection`. The warm is cheap (single
    // SELECT bounded by distinct-peer count); doing it once on boot
    // lets the synchronous hot path (`hasRecentSuccessfulDecrypt`,
    // `shouldAttemptRebuild`) consult the rows from before this restart
    // without an SQL round-trip per envelope. Failure here just leaves
    // the cold-start window open (the legacy behaviour) — don't block
    // boot on it.
    peerSessionHealth = new PeerSessionHealthStore(ownStore.getDb());
    try {
      await peerSessionHealth.warm();
      attachHealthStore(peerSessionHealth);
    } catch (e) {
      console.warn('[messenger.peerSessionHealth] boot warm failed:', asErrorMessage(e));
    }
    // TOFU send-gate — hydrate the persisted pending-identity-ack map so a
    // change noted in a prior session survives restart (no-op unless the gate
    // flag is enabled; hydration is cheap and fail-open).
    try { await hydratePeerIdentityAcks(); } catch { /* fail-open */ }
    // Bug-hunt #3 — pending-group-envelope + pending-admin-action stash.
    // Boot prune trims anything older than RETENTION_MS (7 days);
    // the matching relay copies have long since expired by then, so
    // these rows would never be drainable. Prune is fire-and-forget
    // so a slow DELETE doesn't block the receive path coming online.
    pendingGroupEnvelopes = new PendingGroupEnvelopeStore(ownStore.getDb());
    pendingAdminActions   = new PendingAdminActionStore(ownStore.getDb());
    pendingGroupEnvelopes.prune().catch(e =>
      console.warn('[messenger.pendingGroupEnvelopes] boot prune failed:', asErrorMessage(e)));
    pendingAdminActions.prune().catch(e =>
      console.warn('[messenger.pendingAdminActions] boot prune failed:', asErrorMessage(e)));
    // Startup outbox drain. If the previous session crashed between
    // transport.send and envelope.accepted, rows still live in the DB
    // — replay them so the user doesn't see stuck single-tick after a
    // crash. Best-effort: if the socket isn't connected yet, the rows
    // stay pending and the next `socket.on('connected')` retries.
    void drainOutbox(sqlOutbox, relay, isOurEpoch, resealDeferredGroupRow);
    // F4 outbox-retry-reconnect-only — a periodic retry so a row whose
    // relay.send failed transiently (500/timeout) on a STABLE long-lived
    // socket isn't stuck for hours until the next reconnect. drainOutbox is
    // self-guarded (drainOutboxInflight) and dueRows() only returns rows past
    // next_retry_at, so an idle tick is a cheap no-op; isOurEpoch() bails after
    // a runtime rebuild. Parked on liveDisposers so the next disposeLiveRuntime
    // clears it (no leaked interval across logout→login). Capture the non-null
    // handle so the timer closure (which loses the control-flow narrowing)
    // still sees SqlOutboxStore.
    const outboxLive = sqlOutbox;
    const outboxRetryTimer = setInterval(() => {
      void drainOutbox(outboxLive, relay, isOurEpoch, resealDeferredGroupRow);
    }, 60_000);
    liveDisposers.push(() => { try { clearInterval(outboxRetryTimer); } catch { /* ignore */ } });
    try {
      // Audit fix #16 — load only the most recent N rows per chat at
      // boot. The chat scroll-back path pages older messages in via
      // sqlMessages.loadOlder + store.prependOlderMessages.
      const {MAX_HYDRATE_PER_CONVO} = require('../store/messengerStore') as
        typeof import('../store/messengerStore');
      const persisted = await sqlMessages.loadRecent(MAX_HYDRATE_PER_CONVO);
      useMessengerStore.getState().hydrateMessages(persisted);
      // Audit MSG-07 (2026-07-02): boot sweep — a hydrated bubble still in
      // 'sending' whose message has NO outbox row is unrecoverable (the
      // previous session died between append and enqueue, or the crypto
      // pipeline threw pre-enqueue on an older build). Flip it to 'failed' so
      // the user gets a retry chip instead of a forever-spinning tick. Rows
      // WITH an outbox entry are left alone — the startup drain re-ships them.
      try {
        const outboxIds = await sqlOutbox.allMessageIds();
        const st = useMessengerStore.getState();
        for (const [cid, list] of Object.entries(st.messages)) {
          for (const m of list) {
            if (m.status === 'sending' && !outboxIds.has(m.id)) {
              st.updateMessageStatus(cid, m.id, 'failed');
            }
          }
        }
      } catch (e) {
        console.warn('[messenger] MSG-07 sending-sweep failed:', asErrorMessage(e));
      }
    } catch (e) {
      // Hydration failure is non-fatal — UI still functions, the user
      // just doesn't see history. Surface so we can debug if it bites.
      console.warn('[messenger] SQL hydrate failed', e);
    }
    // Audit P0-S3 / P0-S5 — wire the GroupMasterKeyStore. Group master
    // keys no longer ride in plaintext AsyncStorage: they live in the
    // SQLCipher `group_master_keys` table, AES-GCM-wrapped under a
    // second keychain entry (`getOrCreateGroupWrapKey`). Warm the
    // in-memory `s.groups[*].masterKeyB64` slots from disk before the
    // first ChatScreen render so inbound group envelopes find the key
    // they need without the rehydration path falling into the no_key
    // stash branch (which is correct behaviour but adds round-trip
    // latency every cold boot).
    try {
      const {getOrCreateGroupWrapKey} = require('./keychain') as
        typeof import('./keychain');
      const {GroupMasterKeyStore} = require('../store/groupMasterKeyStore') as
        typeof import('../store/groupMasterKeyStore');
      const {registerGroupMasterKeySink} = require('../store/messengerStore') as
        typeof import('../store/messengerStore');
      const wrapOwnerKey = config.ownerKey ?? config.ownUserId;
      const wrapKeyB64 = await getOrCreateGroupWrapKey(wrapOwnerKey);
      const groupKeyStore = new GroupMasterKeyStore(ownStore.getDb(), wrapKeyB64);
      registerGroupMasterKeySink(groupKeyStore);
      // Warm the live store with every wrapped key already on disk so
      // group decrypt doesn't have to wait for a re-broadcast of an
      // admin envelope. Then opportunistically wrap any keys that are
      // currently in memory but missing from disk — handles upgrade
      // from a pre-P0-S3 install where the AsyncStorage vault still
      // carries plaintext masterKeyB64 values for already-joined groups.
      const wrapped = await groupKeyStore.loadAll();
      const live = useMessengerStore.getState().groups;
      const merged: Record<string, import('@bravo/messenger-core').GroupState> = {};
      const migratedToDisk: Array<{gid: string; mk: string}> = [];
      for (const [gid, gs] of Object.entries(live)) {
        const fromDisk = wrapped[gid];
        const hasInMem = !!gs.masterKeyB64;
        if (fromDisk) {
          merged[gid] = {...gs, masterKeyB64: fromDisk};
        } else if (hasInMem) {
          // Legacy in-memory key (from a pre-P0-S3 AsyncStorage row
          // that hadn't been stripped yet). Keep it live AND migrate
          // it to disk so the next cold boot doesn't need AsyncStorage
          // to hold it any more.
          merged[gid] = gs;
          migratedToDisk.push({gid, mk: gs.masterKeyB64});
        } else {
          merged[gid] = gs;
        }
      }
      useMessengerStore.setState({groups: merged});
      for (const {gid, mk} of migratedToDisk) {
        void groupKeyStore.setKey(gid, mk).catch(() => { /* best-effort */ });
      }
      // B-31 — drain group envelopes stashed (no_key/tamper) in a PRIOR
      // session for a group whose master key we just restored from disk. The
      // live drain only fires from an admin create/rekey post-txn request;
      // once that admin envelope is ACKed off the relay it is never
      // redelivered, so a stash row left undrained across a restart has nothing
      // to re-trigger it. Re-run the EXISTING per-row drain now that `merged`
      // carries the keys in memory (replayGroupSealedDecode reads the in-memory
      // masterKeyB64). NOT a key-distribution change: selectGroupIdsToDrain
      // only picks groups whose key is already on this device; a group with no
      // key stays fail-closed (Scenario B — owner-side resync is
      // architecture-gated, see sqa.md B-26(a)/B-13).
      const txnDbForDrain =
        ownStore instanceof SqlCipherProtocolStore ? ownStore.getDb() : null;
      if (pendingGroupEnvelopes && txnDbForDrain && sqlMessages) {
        for (const gid of selectGroupIdsToDrain(merged)) {
          void drainPendingGroup(
            gid, config, txnDbForDrain, sqlMessages, seenEnvelopes,
            pendingGroupEnvelopes, pendingAdminActions,
          ).catch(err =>
            console.warn('[messenger] boot group-stash drain failed',
              gid.slice(0, 8), asErrorMessage(err)));
        }
      }
    } catch (e) {
      // Non-fatal — the runtime still works, group decrypt for newly
      // joined groups falls through to the existing pending-stash path.
      console.warn('[messenger] groupMasterKey store wire-up failed', e);
    }
    // Flip the gate: SQLCipher-backed deps are now wired. Live frames
    // from this point on go straight to dispatchFrame; any frame that
    // landed in the buffer between transport.connect() and here is
    // drained in FIFO order.
    depsReady = true;
    drainPendingFrames();
    // Phase-2 ratchet-snapshot capture — arm the scheduler now that the
    // SQLCipher store (which exposes listSessions) is open. Capture is
    // gated on the message mirror being enabled (active backup) and
    // self-debounces, so arming here is cheap. Triggered below on the
    // heartbeat timer + on every reconnect; disarmed in disposeLiveRuntime.
    try {
      const {armRatchetSnapshotScheduler} = require('../backup/ratchetSnapshotScheduler') as
        typeof import('../backup/ratchetSnapshotScheduler');
      armRatchetSnapshotScheduler(config.ownerKey ?? config.ownUserId, ownStore);
    } catch (e) {
      console.warn('[messenger] ratchet-snapshot scheduler arm failed:', asErrorMessage(e));
    }
    // Write-through mirror: every message-list change in Zustand is
    // diffed against the previous snapshot and persisted to SQLCipher.
    // This keeps the SQL store the durable source of truth without
    // touching every mutation site.
    //
    // Owner guard: this subscribe is owned by the per-user runtime
    // we're building right now. If the user switches accounts, the
    // store's _ownUserId flips before we get torn down — at which
    // point setOwner clears `s.messages` to {} for the incoming
    // user. Without the guard, the diff below sees "all conversations
    // removed" and DELETEs every row in THIS user's SQLCipher DB
    // before we close the connection. The guard scopes writes to the
    // owner that built this runtime, so a stale subscribe can't poison
    // the previous owner's DB.
    const subscribeOwner = config.ownerKey ?? config.ownUserId;
    let prev = useMessengerStore.getState().messages;
    // M-13 — captured once (not per-fire) so the hot subscriber can cheaply
    // check whether a restore is currently hydrating.
    const {isRestoreWriteThroughSuppressed} =
      require('../backup/restoreWriteThrough') as typeof import('../backup/restoreWriteThrough');
    // Fix #2: capture the unsubscribe so a runtime rebuild stops the
    // OLD subscriber before the new one starts. Without this, every
    // re-login stacks another diff loop — N subscribers all trying
    // to write each message change to N now-stale SQLCipher handles.
    const unsubscribeStore = useMessengerStore.subscribe((s) => {
      const next = s.messages;
      if (next === prev) {return;}
      // M-13 — during a restore's final hydrate, every restored row was
      // already durably written via SqlMessageStore.upsertBatch. Skip the
      // per-row write-through so we don't fire thousands of redundant
      // autocommit INSERTs (and trip the disk-pressure banner) right after
      // restore. Advance prev so post-restore mutations diff cleanly.
      if (isRestoreWriteThroughSuppressed()) {
        prev = next;
        return;
      }
      // Bail if the active owner changed — this runtime is stale and
      // its sqlMessages handle is bound to the previous user's DB.
      const liveOwner = s._ownUserId;
      if (liveOwner && liveOwner !== subscribeOwner) {
        prev = next; // keep prev current so we don't double-react if we resume
        return;
      }
      const store = sqlMessages!;
      const cache = mediaCache;
      // Removed conversations — drop every persisted message AND every
      // cached attachment blob for the conversation. Without the cache
      // sweep here, "Clear chat" leaves the encrypted R2 bytes sitting
      // in SQLCipher even though the user can't see the bubbles anymore.
      for (const cid of Object.keys(prev)) {
        if (!(cid in next)) {
          for (const m of prev[cid] ?? []) {
            void store.remove(cid, m.id);
            if (cache && m.media_object_key) {
              void cache.remove(m.media_object_key).catch(() => { /* best-effort */ });
            }
            // Audit MEDIA-A2 — also delete the DECRYPTED plaintext cache file.
            if (m.media_object_key) {
              try { void (require('../media/mediaFiles') as typeof import('../media/mediaFiles')).deleteTempBytes(m.id); } catch { /* best-effort */ }
            }
          }
        }
      }
      for (const [cid, list] of Object.entries(next)) {
        const prevList = prev[cid] ?? [];
        // N-30 (M-14 residual) — skip conversations whose message list is
        // referentially unchanged. zustand+immer keep untouched lists
        // reference-stable, so appending one message to ONE conversation used
        // to still walk EVERY conversation (rebuilding a Map + Set each) on the
        // JS thread. A reconnect drain of N messages = N full-store walks; this
        // one check makes the write-through diff O(changed) instead of O(total).
        if (list === prevList) {continue;}
        const prevById = new Map(prevList.map(m => [m.id, m]));
        const nextIds = new Set<string>();
        for (const m of list) {
          nextIds.add(m.id);
          const before = prevById.get(m.id);
          if (before && before !== m) {
            // M-14 — row UPDATE (status flip, reaction, envelope-id backfill):
            // ship through the 50ms coalesced batch (one txn per burst,
            // latest-wins). Losing one on a crash only reverts a tick.
            store.upsertCoalesced(m);
            continue;
          }
          if (!before) {
            // Fix #22: top-level error boundary around the SQLCipher
            // write-through. A failed `upsert` previously rejected
            // unhandled — RN's promise-rejection handler then surfaced
            // as a yellowbox while the message stayed in memory only,
            // so on app restart the user "lost" the message. Track
            // failures in a retry queue and surface via store.error.
            store.upsert(m).catch(err => {
              upsertRetryQueue.set(`${cid}:${m.id}`, m);
              console.warn('[messenger] upsert failed; queued for retry', cid, m.id, asErrorMessage(err));
              // Audit fix #39 — escalate the message once we cross the
              // back-pressure threshold so the user can take action
              // (free disk space, force-restart, etc.) instead of
              // silently losing more writes.
              if (upsertRetryQueue.size > UPSERT_BACKPRESSURE_THRESHOLD) {
                useMessengerStore.getState().setError(
                  `Local save backlog ${upsertRetryQueue.size} — disk pressure or SQLCipher lock. Restart may help.`,
                );
              } else {
                useMessengerStore.getState().setError(
                  `Local save failed (${upsertRetryQueue.size} pending). Will retry on next change.`,
                );
              }
            });
          }
        }
        // Per-message removal — same as above, scoped to single bubbles
        // (covers retract, expiry sweeper, and "delete one message"
        // affordances). The sweeper has its own purgeBlob callback so
        // this branch fires for the non-sweep paths.
        for (const m of prevList) {
          if (!nextIds.has(m.id)) {
            void store.remove(cid, m.id);
            upsertRetryQueue.delete(`${cid}:${m.id}`);
            if (cache && m.media_object_key) {
              void cache.remove(m.media_object_key).catch(() => { /* best-effort */ });
            }
            // Audit MEDIA-A2 — delete the DECRYPTED plaintext cache file too
            // (covers retract, disappearing-expiry sweep, delete-one-message).
            if (m.media_object_key) {
              try { void (require('../media/mediaFiles') as typeof import('../media/mediaFiles')).deleteTempBytes(m.id); } catch { /* best-effort */ }
            }
          }
        }
      }
      // Drain the retry queue best-effort whenever the store changes —
      // hopefully the transient SQLCipher hiccup has passed by now.
      if (upsertRetryQueue.size > 0) {
        for (const [key, msg] of upsertRetryQueue) {
          store.upsert(msg).then(
            () => { upsertRetryQueue.delete(key); },
            () => { /* keep queued */ },
          );
        }
        if (upsertRetryQueue.size === 0) {
          // Clear the error banner once we've drained.
          const cur = useMessengerStore.getState().error;
          if (cur?.startsWith('Local save failed')) {
            useMessengerStore.getState().setError(null);
          }
        }
      }
      prev = next;
    });
    // Fix #2: register the disposer so logout / runtime-rebuild can
    // stop this subscriber before SQLCipher gets torn down.
    liveDisposers.push(unsubscribeStore);
  }

  // Idempotent safety net for the non-SqlCipher (loopback) branch and
  // any future code path that skips the SqlCipher init block: flipping
  // depsReady here guarantees buffered frames are drained even if
  // ownStore is not a SqlCipherProtocolStore. If already set above this
  // is a no-op; if not, this drains the buffer with deps still null
  // (matching legacy behaviour for loopback runs).
  if (!depsReady) {
    depsReady = true;
    drainPendingFrames();
  }

  // M7 + retract: kick off the disappearing-message sweeper. Runs
  // forever until _resetMessengerRuntime(). Sweeps once immediately
  // so any expired messages carried over from a previous session
  // are cleared. The retract callback purges sealed envelopes from
  // the relay queue when self messages expire — best-effort, the
  // server returns retracted:false without error if the recipient
  // already pulled. The purgeBlob callback drops cached attachment
  // ciphertext for messages that carried `media_object_key`, so an
  // expired voice note or photo can't outlive the chat bubble.
  const sweeper = new ExpirySweeper({
    retract:   async (token)     => { await relay.retract(token); },
    // A10 r2-media-never-purged — drop the LOCAL cache AND ask the server to
    // hard-delete the R2 object so a disappearing/retracted attachment's
    // ciphertext doesn't linger (re-downloadable with the in-band key inside
    // the 30-day grant window). The server purge is owner-checked: on the
    // SENDER's device it deletes; on a recipient's it 403s harmlessly. Both
    // legs best-effort — a failure just defers to the LRU / 30-day grant TTL.
    purgeBlob: async (objectKey) => {
      if (mediaCache) { try { await mediaCache.remove(objectKey); } catch { /* LRU catches it */ } }
      try { await mediaClient.purge(objectKey); } catch { /* non-owner 403 / offline — best-effort */ }
    },
  });
  sweeper.sweep();
  sweeper.start();
  // Fix #9: park the live sweeper instance on a module slot so the
  // next runtime build (logout / re-login / test reset) can call
  // .stop() before the new one is installed. Without this we'd run
  // two sweepers in parallel: the old one against the previous
  // user's (now-closed) DB, throwing once per second forever.
  liveSweeper = sweeper;

  useMessengerStore.getState().setReady(true);

  // ───────────────────────────────────────────────────────────────────
  // Self-heal group-key recovery engine (architecture-approved owner re-
  // share; reuses the proven `admin: create` unwrapped key carrier).
  //
  // Two halves:
  //   reshareGroupKeyState — OWNER re-DELIVERS the CURRENT key (no epoch
  //     bump) to specific members over their pairwise Signal session.
  //     Roster-gated to current members; owner-gated (only the owner can
  //     mint a verifying create signature); rate-limited per (group,peer).
  //   sendKeyRequest — a member that LOST the key asks the owner/admins to
  //     re-share it. Carries no key material; ships plaintext under the
  //     pairwise session like `create`. Rate-limited per group.
  //
  // Never logs key bytes. Never advances the epoch (a re-delivery of the
  // existing key must not disturb current holders). Never re-shares to a
  // non-member (forward-secrecy after removal is preserved).
  // ───────────────────────────────────────────────────────────────────
  const RESHARE_COOLDOWN_MS = 15 * 1000;
  const KEY_REQUEST_COOLDOWN_MS = 20 * 1000;
  const reshareAtByPeer = new Map<string, number>();
  const keyRequestSentAt = new Map<string, number>();
  // Why: these are cooldown ledgers — once an entry is older than the
  // cooldown it can never gate again, so it is pure garbage. Prune stale
  // entries when the map grows large to keep a long-lived session (many
  // groups/peers over weeks) from leaking memory. Cheap: only scans past
  // the size threshold, which a normal roster never reaches.
  const pruneCooldownMap = (m: Map<string, number>, maxAgeMs: number, now: number): void => {
    if (m.size < 512) {return;}
    for (const [k, t] of m) {
      if (now - t > maxAgeMs) {m.delete(k);}
    }
  };

  const reshareGroupKeyState = async (
    state: GroupState,
    targetUserIds?: string[],
  ): Promise<number> => {
    // Audit G-05 (2026-07-02): the OWNER signs a fresh create; ANY other member
    // RELAYS the owner's persisted signature (state.creatorSigB64) so a keyless
    // peer can recover the key even when the owner is offline. A non-owner with
    // no persisted owner signature can't help (nothing to relay) — bail. The
    // receiver verifies the relayed signature against the owner's identity, so
    // this never lets a member forge a key.
    const isOwnerReshare = state.owner === ownAddress.userId;
    if (!isOwnerReshare && !state.creatorSigB64) {return 0;}
    // Roster-gate: never re-share to anyone who isn't a CURRENT member (and a
    // relayer must themselves be a member holding the key).
    if (!isOwnerReshare && !state.members[ownAddress.userId]) {return 0;}
    // Roster-gate: never re-share to anyone who isn't a CURRENT member.
    const now = Date.now();
    pruneCooldownMap(reshareAtByPeer, 10 * 60 * 1000, now);
    const targets = (targetUserIds ?? Object.keys(state.members))
      .filter(uid => uid && uid !== ownAddress.userId && !!state.members[uid])
      .filter(uid => {
        const k = `${state.groupId}:${uid}`;
        if (now - (reshareAtByPeer.get(k) ?? 0) < RESHARE_COOLDOWN_MS) {return false;}
        reshareAtByPeer.set(k, now);
        return true;
      });
    if (targets.length === 0) {return 0;}
    const cert = await certCache.get();
    // G-05 — owner signs fresh; a member relays the persisted owner signature.
    let creatorSignature: string | undefined;
    if (isOwnerReshare) {
      const creatorIdentity = await ownStore.getIdentityKeyPair();
      creatorSignature = await signGroupCreate(creatorIdentity.privKey, state);
    } else {
      creatorSignature = state.creatorSigB64;
    }
    if (!creatorSignature) {return 0;}
    let delivered = 0;
    try {
      await broadcastToGroup({
        group:   state,
        self:    ownAddress,
        cert,
        body:    '',
        admin:   {type: 'create', state, creatorSignature},
        session: own,
        only:    targets,
        ensureSession: async (peer) => {
          const had = await own.hasSession(peer);
          if (!had) { await ensureOutgoingSession(own, keys, peer, ownStore); }
        },
        deliver: async (peer, ct, clientMsgId) => {
          try {
            const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(
              ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS,
            );
            const outerSealed = await wrapOuter({
              recipientIdentityKeyB64: recipientIdKeyB64,
              sender:                  ownAddress,
              ciphertext:              ct,
              cert,
            });
            try { transport.send({event: 'envelope.send', data: {to: peer, outerSealed, clientMsgId, urgent: false}}); }
            catch { await relay.send({recipient: peer, outerSealed, clientMsgId, urgent: false}); }
            delivered += 1;
          } catch (e) {
            console.warn('[group-key-reshare:runtime] delivery failed', peer.userId, asErrorMessage(e));
          }
        },
      });
    } catch (e) {
      console.warn('[group-key-reshare:runtime] broadcast failed', asErrorMessage(e));
    }
    console.log('[group-key-reshare:runtime] re-shared key for', state.groupId.slice(0, 12), 'to', targets.length, 'member(s), delivered=', delivered);
    return delivered;
  };

  const sendKeyRequest = async (
    groupId: string,
    participantUserIds: string[],
    atEpochSeen?: number,
  ): Promise<number> => {
    const targets = Array.from(new Set(
      participantUserIds.filter(uid => uid && uid !== ownAddress.userId),
    ));
    if (targets.length === 0) {return 0;}
    const cert = await certCache.get();
    // Synthetic state: a `key-request` carries NO key, so masterKeyB64 is
    // never read (skipGroupKey) and epoch=0 keeps it out of the AAD epoch
    // binding. members drive the fan-out; owner is unknown to us (that's
    // the whole point — whoever owns it will answer, others no-op).
    const synthetic: GroupState = {
      groupId,
      name:         '',
      owner:        '',
      members:      Object.fromEntries(targets.map(uid => [uid, {deviceId: 1, admin: false, joinedAt: 0}])),
      masterKeyB64: '',
      epoch:        0,
      createdAt:    0,
      updatedAt:    0,
    };
    let delivered = 0;
    try {
      await broadcastToGroup({
        group:   synthetic,
        self:    ownAddress,
        cert,
        body:    '',
        admin:   {type: 'key-request', groupId, atEpochSeen},
        session: own,
        ensureSession: async (peer) => {
          const had = await own.hasSession(peer);
          if (!had) { await ensureOutgoingSession(own, keys, peer, ownStore); }
        },
        deliver: async (peer, ct, clientMsgId) => {
          try {
            const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(
              ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS,
            );
            const outerSealed = await wrapOuter({
              recipientIdentityKeyB64: recipientIdKeyB64,
              sender:                  ownAddress,
              ciphertext:              ct,
              cert,
            });
            try { transport.send({event: 'envelope.send', data: {to: peer, outerSealed, clientMsgId, urgent: false}}); }
            catch { await relay.send({recipient: peer, outerSealed, clientMsgId, urgent: false}); }
            delivered += 1;
          } catch (e) {
            console.warn('[group-key-request:runtime] delivery failed', peer.userId, asErrorMessage(e));
          }
        },
      });
    } catch (e) {
      console.warn('[group-key-request:runtime] broadcast failed', asErrorMessage(e));
    }
    console.log('[group-key-request:runtime] requested key for', groupId.slice(0, 12), 'from', targets.length, 'participant(s), delivered=', delivered);
    return delivered;
  };

  const requestGroupKeyResyncImpl = async (
    groupId?: string,
    fallbackPeer?: SessionAddress,
  ): Promise<void> => {
    const store = useMessengerStore.getState();
    const conversations = store.conversations;
    const candidateIds = groupId
      ? [groupId]
      : Object.keys(conversations).filter(id => {
          const c = conversations[id];
          return (c?.type === 'group' || c?.type === 'ops_channel') && !store.groups[id]?.masterKeyB64;
        });
    const now = Date.now();
    pruneCooldownMap(keyRequestSentAt, 10 * 60 * 1000, now);
    for (const gid of candidateIds) {
      // Already have the key — nothing to recover.
      if (store.groups[gid]?.masterKeyB64) {continue;}
      // Rate-limit per group so opening a chat repeatedly / reconnect
      // storms don't amplify into a request flood.
      if (now - (keyRequestSentAt.get(gid) ?? 0) < KEY_REQUEST_COOLDOWN_MS) {continue;}
      const convo = conversations[gid];
      // Catch-22 fix (handoff §2.7-1) — with no conversation row (brand-new
      // member whose `create` never landed) fall back to the stashed
      // envelope's sender so the key-request can still reach a key holder.
      const participants = resolveKeyRequestTargets(
        convo?.participants,
        ownAddress.userId,
        gid === groupId ? fallbackPeer?.userId : undefined,
      );
      if (participants.length === 0) {continue;}
      keyRequestSentAt.set(gid, now);
      try { await sendKeyRequest(gid, participants, store.groups[gid]?.epoch); }
      catch (e) { console.warn('[group-key-request:runtime] resync failed for', gid.slice(0, 12), asErrorMessage(e)); }
    }
  };

  // Audit G-03 — a designated remaining admin rotates the group key AFTER a
  // peer voluntarily left, so the leaver (who keeps the old key) can't decrypt
  // post-leave messages. Mirrors removeGroupMember's rekey half, but the leaver
  // is already out of membership (the `leave` action removed them). The new key
  // is derived deterministically, so if more than one admin races this they
  // converge on the same key (no fork). Broadcast under the CURRENT key that
  // all remaining members still hold; the leaver isn't in the fan-out set.
  const rekeyAfterLeaveImpl = async (groupId: string, leaverId: string): Promise<void> => {
    const store = useMessengerStore.getState();
    const cur = store.groups[groupId];
    if (!cur?.masterKeyB64) {return;}
    // Re-check admin rights on the live state (may have changed since the signal).
    if (!(cur.members[ownAddress.userId] as {admin?: boolean} | undefined)?.admin) {return;}
    if (cur.members[leaverId]) {return;} // leaver still present — the leave hasn't applied; bail
    const {deriveRekeyMasterKey} = require('@bravo/messenger-core') as typeof import('@bravo/messenger-core');
    const newMasterKeyB64 = deriveRekeyMasterKey({
      prevMasterKeyB64: cur.masterKeyB64,
      removedMemberIds: [leaverId],
      postEpoch:        cur.epoch + 1,
    });
    const rekeyAction = {type: 'rekey' as const, newMasterKeyB64, atEpoch: cur.epoch};
    const cert = await certCache.get();
    const ensureSessionFn = async (peer: SessionAddress): Promise<void> => {
      if (!(await own.hasSession(peer))) {await ensureOutgoingSession(own, keys, peer, ownStore);}
    };
    const deliverFn = async (peer: SessionAddress, ct: Ciphertext, clientMsgId: string): Promise<void> => {
      const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS);
      const outerSealed = await wrapOuter({recipientIdentityKeyB64: recipientIdKeyB64, sender: ownAddress, ciphertext: ct, cert});
      try { transport.send({event: 'envelope.send', data: {to: peer, outerSealed, clientMsgId, urgent: false}}); }
      catch { await relay.send({recipient: peer, outerSealed, clientMsgId, urgent: false}); }
    };
    try {
      await broadcastToGroup({
        group: cur, self: ownAddress, cert, body: '', admin: rekeyAction,
        session: own, ensureSession: ensureSessionFn, deliver: deliverFn,
      });
    } catch (e) {
      console.warn('[group-leave-rekey:runtime] rekey broadcast failed:', asErrorMessage(e));
    }
    // Rotate locally regardless (fail-closed): our own future sends use the new
    // key; a member who missed the broadcast self-heals via key-request.
    const after = applyAdminAction(cur, rekeyAction, ownAddress.userId);
    if (after !== cur) {
      store.setGroupState(after);
      if (cur.masterKeyB64 !== after.masterKeyB64) {disposeGroupKey(cur.masterKeyB64);}
      console.log('[group-leave-rekey:runtime] rotated key after leave of', leaverId.slice(0, 8), 'group', groupId.slice(0, 12));
    }
  };

  // Register the receive-path signal handler (one runtime per process).
  setGroupKeySignalHandler((sig) => {
    if (sig.kind === 'reshare') {
      const state = useMessengerStore.getState().groups[sig.groupId];
      // Audit G-05 — the owner reshares (signs fresh); OR any member who holds
      // the key AND a persisted owner signature relays it (owner-offline
      // recovery). reshareGroupKeyState enforces both gates + the receiver
      // verifies against the owner's identity, so this can't forge a key.
      const canReshare = !!state?.masterKeyB64 &&
        (state.owner === ownAddress.userId ||
          (!!state.creatorSigB64 && !!state.members[ownAddress.userId]));
      if (state && canReshare) {
        void reshareGroupKeyState(state, [sig.toUserId]);
      }
    } else if (sig.kind === 'request') {
      void requestGroupKeyResyncImpl(sig.groupId, sig.fromPeer);
    } else if (sig.kind === 'leave-rekey') {
      void rekeyAfterLeaveImpl(sig.groupId, sig.leaverId);
    }
  });

  // Signal resend protocol (flag-gated) — re-transmit recent still-undelivered
  // 1:1 TEXT messages to a peer who just told us (via rehandshake) they rebuilt
  // their session. Re-uses the SAME clientMsgId so the receiver dedups; bounded
  // window (10 min) + cap (10) + per-peer cooldown (60s) so it can't storm.
  const RESEND_COOLDOWN_MS = 60_000;
  const resendAtByPeer = new Map<string, number>();
  setResendSignalHandler((peer) => {
    void (async () => {
      try {
        if (!sqlMessages || !peer.userId) {return;}
        const now = Date.now();
        pruneCooldownMap(resendAtByPeer, 10 * 60 * 1000, now);
        if (now - (resendAtByPeer.get(peer.userId) ?? 0) < RESEND_COOLDOWN_MS) {return;}
        resendAtByPeer.set(peer.userId, now);

        const {resolveDirectConversationIdFromState} =
          require('../store/messengerStore') as typeof import('../store/messengerStore');
        const convoId = resolveDirectConversationIdFromState(useMessengerStore.getState(), peer.userId);
        const sinceIso = new Date(now - 10 * 60_000).toISOString();
        const rows = await sqlMessages.recentUndeliveredSelfText(convoId, sinceIso, 10);
        if (rows.length === 0) {return;}

        const cert = await certCache.get();
        await ensureOutgoingSession(own, keys, peer, ownStore);
        let resent = 0;
        for (const m of rows) {
          try {
            const sealed = sealPayload(cert, m.content, {
              clientMsgId:  m.id,
              expiresAtSec: m.expires_at ? Math.floor(m.expires_at / 1000) : undefined,
              replyTo:      m.reply_to_msg_id
                ? {msgId: m.reply_to_msg_id, preview: m.reply_to_preview ?? ''}
                : undefined,
              aad: {
                to:             peer,
                ts:             Date.now(),
                sender:         ownAddress,
                conversationId: directConvoAadId(ownAddress.userId, peer.userId),
              },
            });
            const ct = await own.encrypt(peer, sealed);
            const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(
              ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS,
            );
            const outerSealed = await wrapOuter({
              recipientIdentityKeyB64: recipientIdKeyB64,
              sender:                  ownAddress,
              ciphertext:              ct,
              cert,
            });
            // Same clientMsgId → the receiver's store dedups (no duplicate
            // bubble); the relay dedups a genuine re-send under it too.
            try { transport.send({event: 'envelope.send', data: {to: peer, outerSealed, clientMsgId: m.id, urgent: false}}); }
            catch { await relay.send({recipient: peer, outerSealed, clientMsgId: m.id, urgent: false}); }
            resent += 1;
          } catch (e) {
            console.warn('[resend] retransmit failed id=' + m.id.slice(0, 8), asErrorMessage(e));
          }
        }
        console.log('[resend] re-transmitted ' + resent + '/' + rows.length + ' to ' + peer.userId.slice(0, 8));
      } catch (e) {
        console.warn('[resend] handler failed', asErrorMessage(e));
      }
    })();
  });

  // Named so media helpers (sendMedia) can call back into sendText
  // without re-implementing the send/fan-out/grant pipeline.
  const runtimeApi: MessengerRuntime = {
    mode: 'production',
    own,
    // Self-heal — let screens (group ChatScreen / DepartmentChatScreen) and
    // the WS reconnect path proactively ask the owner to re-share the key
    // for any group we belong to but have no master key for.
    requestGroupKeyResync: requestGroupKeyResyncImpl,
    sendText: async (conversationId, text, peerOrOpts) => {
      const opts: SendTextOptions = peerOrOpts && 'userId' in peerOrOpts
        ? {peer: peerOrOpts}
        : peerOrOpts ?? {};
      // Why: ChatScreen may pass either the synthetic `direct:<peer>`
      // (NewChat / push tap / incoming call entry points) OR the
      // server-UUID (Home list tap / /conversations/mine sync). The
      // inbound path canonicalises to server-UUID-when-available; do
      // the same here so outgoing bubbles land in the same slot the
      // ChatScreen subscribes to (when both rows exist). Skip groups
      // — those always carry a server-UUID conversationId already.
      if (conversationId.startsWith('direct:')) {
        const {resolveDirectConversationIdFromState: resolve} =
          require('../store/messengerStore') as typeof import('../store/messengerStore');
        const peerUid = conversationId.slice('direct:'.length);
        const canonical = resolve(useMessengerStore.getState(), peerUid);
        if (canonical !== conversationId) {
          console.log('[send.text.routing] canonicalised ' + conversationId.slice(0, 16) + ' -> ' + canonical.slice(0, 16));
          conversationId = canonical;
        }
      }
      const expiresAtSec = opts.ttlSeconds
        ? Math.floor(Date.now() / 1000) + opts.ttlSeconds
        : undefined;
      // Audit P1-1 — the sender-cert fetch (incl. its 30s negative cache on
      // reject) is deliberately NOT hoisted here. It used to run BEFORE both
      // optimistic appends, so an offline cert-fetch reject destroyed the
      // typed text before any bubble/outbox row existed. Each path below now
      // appends its bubble FIRST, then fetches the cert inside a guard that
      // flips the bubble to `failed` on reject (retry chip re-runs the send).
      const replyMeta = opts.replyTo
        // Why: a reply to an empty / media-only / disappeared message can land
        // here with `preview` undefined. Previously `.slice()` on undefined
        // crashed the send + surfaced the "Cannot read property 'slice' of
        // undefined" red banner on the chat surface. Coerce to '' so the
        // worst case is an empty preview, not a thrown frame.
        ? {msgId: opts.replyTo.messageId, preview: (opts.replyTo.preview ?? '').slice(0, 200)}
        : undefined;

      // Group fan-out: if the conversation is a multi-party group/ops
      // channel, encrypt + ship one envelope per other-member instead
      // of sending to a single peer. Stamping `sealed.group` makes the
      // receiver route the message into the mission group thread; without
      // it the recipient's runtime falls back to a 1:1 conversation
      // keyed on the sender, which is invisible to the mission dock.
      //
      // Detection sources (in order): explicit conversation type from
      // the dispatched mission record, presence of a local GroupState
      // (we received an admin-create at some point), or the legacy
      // `participants` list with > 1 member.
      const convo = useMessengerStore.getState().conversations[conversationId];
      const groupState = useMessengerStore.getState().groups[conversationId];
      // A direct conversation now stores both participants ([self, peer]),
      // so the legacy `participants.length > 1` fallback would mis-route
      // every 1:1 send into the group fan-out. Trust the explicit `type`
      // when set; the length-based fallback is only for legacy untyped rows.
      const isGroup =
        opts.isGroup === true ||
        convo?.type === 'group' ||
        convo?.type === 'ops_channel' ||
        !!groupState ||
        (convo?.type !== 'direct' && (convo?.participants?.length ?? 0) > 1);

      // TOFU send-gate (opt-in via EXPO_PUBLIC_STRICT_IDENTITY_SEND_GATE). When
      // enabled, refuse to send to a 1:1 peer whose identity changed until the
      // user acknowledges it (WhatsApp "safety number changed — tap to accept").
      // Placed BEFORE the local bubble/outbox is created so a blocked send never
      // orphans a stuck 'sending' row. Default OFF ⇒ no behavior change; groups
      // are not gated here (per-member TOFU is out of scope for this gate).
      if (!isGroup && isIdentitySendGateEnabled()) {
        const gatePeerId =
          opts.peer?.userId ??
          (conversationId.startsWith('direct:') ? conversationId.slice('direct:'.length) : convo?.peer?.userId);
        if (gatePeerId && hasPendingIdentityAck(gatePeerId)) {
          try {
            useMessengerStore.getState().setError('This contact’s security code changed. Review and accept it before sending.');
          } catch { /* ignore */ }
          return;
        }
      }

      // P2-12 — reuse the bubble sendMedia already appended (existingMsgId) so
      // status/outbox/reactions all key off the same id; otherwise mint a new one.
      const msgId = opts.existingMsgId ?? makeId();
      // BS-REACT-AUTHOR — the wire `clientMsgId` MUST equal the local bubble
      // `msgId` so reactions/replies others place (keyed by clientMsgId) land
      // on the AUTHOR's own message too. The group path previously minted a
      // separate clientMsgId, so a group author never saw reactions on their
      // own messages and reply-jump missed. The 1:1 path already does this.
      const clientMsgId = msgId;
      const sentAt = new Date().toISOString();

      if (isGroup) {
        // SERVER IS AUTHORITATIVE for membership. We previously unioned
        // local GroupState.members with the server-fed conversation
        // participants — that let stale dev-contact entries (Alice/Bob
        // from earlier test runs) leak into the fan-out, causing every
        // mission-group send to also encrypt to a non-member. Only the
        // /conversations/mine response defines who is in the room.
        const convoMemberIds = convo?.participants ?? [];
        const participants = convoMemberIds.filter(uid => uid && uid !== ownAddress.userId);
        if (participants.length === 0) {
          throw new Error('group has no other participants — conversation may not be synced from /conversations/mine yet');
        }
        // Round 5 / Security S5 — cap recipient count per send. Without
        // this, a malicious admin could craft a 10k-member group and
        // any local send would fire 10k libsignal encrypt + HTTP
        // submissions in parallel, exhausting the pending LRU and
        // back-pressuring the WS / OPK pool. The cap is generous
        // (250) — well above the realistic group-size product spec
        // (Phase-1 informal cap is ~50) but low enough to keep the
        // worst-case fan-out bounded. Sends to larger groups are
        // refused outright with a clear error so the UI can show "too
        // large to send" instead of silently freezing the chat for
        // 30+ seconds.
        const MAX_GROUP_FANOUT = 250;
        if (participants.length > MAX_GROUP_FANOUT) {
          throw new Error(`group too large to send (${participants.length} > ${MAX_GROUP_FANOUT} recipients)`);
        }

        // P1-1/P2-12 — append the optimistic bubble BEFORE any network/crypto
        // await (cert fetch, group-key encrypt) so a failure leaves a durable
        // `failed` bubble the retry chip can act on instead of losing the text.
        // `peer` points at any one participant for legacy selectors; routing in
        // the group path is by clientMsgId + group id, not peer. When sendMedia
        // hands an `existingMsgId` the bubble was already appended before its
        // upload, so we skip the append here (no duplicate).
        const firstPeer: SessionAddress = {userId: participants[0], deviceId: 1};
        if (!opts.existingMsgId) {
          const msg: LocalMessage = {
            id: msgId,
            conversation_id: conversationId,
            sender_id: 'self',
            type: attachmentMessageType(opts.attachment),
            content: text,
            media_mime: opts.attachment?.mimeType,
            media_object_key: opts.attachment?.objectKey,
            // Round 8 — preserve the per-file AES key + IV on the local
            // row so backup mirroring (and on-device re-render) can
            // round-trip the attachment. Without this every attachment
            // becomes unrecoverable after a restore.
            media_key: opts.attachment?.keyB64,
            media_iv:  opts.attachment?.ivB64,
            media_meta: attachmentMediaMeta(opts.attachment),
            status: 'sending',
            is_encrypted: true,
            created_at: sentAt,
            peer: firstPeer,
            expires_at: expiresAtSec ? expiresAtSec * 1000 : undefined,
            reply_to_msg_id:  replyMeta?.msgId,
            reply_to_preview: replyMeta?.preview,
          };
          useMessengerStore.getState().appendMessage(conversationId, msg);
        }

        // P2-4 — capture the master key + group-encrypt the body UNDER the
        // per-group admin lock. Without it, an old-key text racing a same-device
        // rekey encrypts under a key the rotated receivers have already dropped
        // → the message is permanently lost (`epoch_stale`/`no_key`). The lock
        // serialises this encrypt step with the two-step rekey plan so we always
        // read a CONSISTENT (masterKey) — never a torn intermediate.
        // The sender-cert fetch (P1-1) rides inside the same guarded block so a
        // cert-fetch reject flips the appended bubble to `failed`, not lost text.
        // Round 5 / Security S1 — the shared `sealedBody` (master-key-wrapped
        // inner envelope) is sealed PER-RECIPIENT inside sendOne (each peer's
        // `aad.to` binds their address); only the outer wrap repeats per peer.
        let cert: Awaited<ReturnType<typeof certCache.get>>;
        let sealedBody: string;
        let sealedTs: number;
        try {
          const prep = await runWithGroupAdminLock(conversationId, async () => {
            // Re-read the master key INSIDE the lock so a rekey that just
            // committed is reflected (fresh key, not the pre-lock snapshot).
            const masterKey = useMessengerStore.getState().groups[conversationId]?.masterKeyB64;
            const innerEnvelope = JSON.stringify({
              groupId:     conversationId,
              kind:        'text',
              clientMsgId,
              body:        text,
            });
            const sb = masterKey
              ? JSON.stringify(await groupEncrypt(masterKey, innerEnvelope))
              : innerEnvelope;
            const c = await certCache.get();
            return {cert: c, sealedBody: sb, sealedTs: Date.now()};
          });
          cert = prep.cert;
          sealedBody = prep.sealedBody;
          sealedTs = prep.sealedTs;
        } catch (e) {
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
          throw e;
        }

        // Fix #10: parallelise fan-out. Sequential `for…of await` made
        // a 20-member group take 20× one-RTT (≈8s on poor networks)
        // before the user saw 'sent'. allSettled lets every per-peer
        // send race in parallel; we tally fulfilled vs rejected after.
        // Each per-peer task is a self-contained promise so a single
        // peer's transient failure doesn't block the rest.
        // Fix #11: recipientIdentityKeyB64Cached avoids popping a
        // peer's OPK on every send. Pool exhaustion was draining
        // 50 keys in a single chat session.
        // Audit P0-N4: persist one outbox row per recipient BEFORE the
        // relay.send. A Doze kill mid-fanout used to silently lose every
        // un-shipped peer's envelope; drainOutbox now replays each row
        // on the next reconnect.
        const sendOne = async (userId: string): Promise<{
          status: 'ok'; userId: string; retractToken?: string; envelopeId?: string;
        }> => {
          const peer: SessionAddress = {userId, deviceId: 1};
          // A4 RC3-group-fanout-outbox-gap — if session establishment or the
          // seal/encrypt below throws (peer unprovisioned, OPK pool exhausted,
          // keys-service blip) we used to drop this member SILENTLY: the durable
          // enqueue happened AFTER encrypt, so a throw left no row to replay.
          // Wrap the pre-ship crypto and, on failure, persist a DEFERRED outbox
          // row carrying the plaintext send-intent so the next drain
          // re-establishes the session, re-seals (with a FRESH timestamp) and
          // ships — instead of permanently losing this recipient.
          let outerSealed: string;
          try {
          await ensureOutgoingSession(own, keys, peer, ownStore);
          // Round 5 / Security S1 — bind THIS recipient + timestamp
          // into the sealed envelope. Replay against another recipient
          // or stale session record is now detected at unseal time.
          const sealed = sealPayload(cert, sealedBody, {
            expiresAtSec,
            clientMsgId: msgId,
            // GROUP MEDIA FIX — carry the attachment (objectKey + per-file
            // AES key + IV) in the sealed-sender payload, exactly like the
            // 1:1 path. Without this a group image/video/doc shipped a
            // text-only envelope, so recipients saw a caption with no media
            // (the per-file key never reached them). The attachment rides
            // inside the pairwise Signal + sealed-sender envelope (E2E; the
            // relay can't read it), matching the documented "key shipped
            // in-band inside the encrypted message envelope" model.
            attachment:  opts.attachment,
            // Audit G-08 — stamp our current membership transcript hash so
            // recipients can detect a fork/equivocation (divergent admin
            // sequence) vs their own local transcript.
            group: {groupId: conversationId, kind: 'text', clientMsgId, senderTranscriptHash: useMessengerStore.getState().groups[conversationId]?.transcriptHash},
            // Audit P0-N2 — extend AAD with sender / conversation / group
            // so a captured group ciphertext can't be replayed into a
            // different thread or re-asserted under a stale group state.
            aad: {
              to:             peer,
              ts:             sealedTs,
              sender:         ownAddress,
              conversationId,
              groupId:        conversationId,
            },
          });
          const ct = await own.encrypt(peer, sealed);
          const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS);
          outerSealed = await wrapOuter({
            recipientIdentityKeyB64: recipientIdKeyB64,
            sender:                  ownAddress,
            ciphertext:              ct,
            // Audit P0-1 — bind the sender cert into the outer ECIES AAD
            // (Sealed Sender v2 / v3). Receiver verifies the cert
            // BEFORE calling own.decrypt, so a forged outer envelope
            // can no longer coerce the legacy DecryptError → closeSession
            // ratchet-wipe path.
            cert,
          });
          } catch (cryptoErr) {
            // A4 — session/seal/encrypt failed for THIS peer. Persist a durable
            // DEFERRED row so the drain re-seals + ships. The sealedBody (group
            // master-key-wrapped inner envelope) is reused; only the per-peer
            // outer sealed-sender wrap + AAD timestamp are re-minted at drain.
            if (sqlOutbox) {
              try {
                await sqlOutbox.enqueue({
                  clientMsgId,
                  conversationId,
                  messageId:    msgId,
                  peerUserId:   peer.userId,
                  peerDeviceId: peer.deviceId,
                  payload:      JSON.stringify({
                    deferred:   true,
                    sealedBody,
                    expiresAtSec,
                    attachment: opts.attachment,
                    groupId:    conversationId,
                    kind:       'text',
                    clientMsgId,
                  }),
                });
              } catch (enqErr) {
                console.warn('[messenger.outbox] group deferred enqueue failed:', asErrorMessage(enqErr));
              }
            }
            // Not delivered now; the drain owns the retry. Re-throw so the
            // allSettled tally counts this peer as not-delivered (the bubble
            // stays out of a false 'sent' when nobody received it live).
            throw cryptoErr;
          }
          // Audit P0-N4: enqueue per-peer outbox row before shipping so
          // a crash between here and the relay.send still leaves a
          // recoverable row. Composite PK (clientMsgId, peerUserId,
          // peerDeviceId) means all participants coexist in the table.
          if (sqlOutbox) {
            try {
              await sqlOutbox.enqueue({
                clientMsgId,
                conversationId,
                messageId:    msgId,
                peerUserId:   peer.userId,
                peerDeviceId: peer.deviceId,
                payload:      JSON.stringify({outerSealed, expiresAtSec}),
              });
            } catch (e) {
              console.warn('[messenger.outbox] group enqueue failed:', asErrorMessage(e));
            }
          }
          // Group fan-out always uses HTTP. The WS path here used to
          // increment `delivered` on a pure transport.send() (no ack)
          // — half-dead sockets that buffered the frame but never
          // shipped it would fool us into flipping to 'sent' when
          // the peer never received anything. HTTP returns a real
          // 200 + retractToken, so we know the relay accepted it.
          try {
            const r = await relay.send({
              recipient:    peer,
              outerSealed,
              clientMsgId,
              expiresAtSec,
            });
            // Delivered to relay — drop the outbox row so it isn't
            // replayed by the next reconnect drain.
            if (sqlOutbox) {
              sqlOutbox.markDelivered(clientMsgId, peer.userId, peer.deviceId).catch(e =>
                console.warn('[messenger.outbox] group markDelivered failed:', asErrorMessage(e)));
            }
            return {status: 'ok', userId, retractToken: r.retractToken, envelopeId: r.envelopeId};
          } catch (e) {
            // Transient failure — leave the row in the outbox; the next
            // reconnect drain will retry with backoff. recordAttempt
            // bumps the per-row counter so MAX_ATTEMPTS still trips.
            if (sqlOutbox) {
              sqlOutbox.recordAttempt(clientMsgId, peer.userId, peer.deviceId).catch(err =>
                console.warn('[messenger.outbox] group recordAttempt failed:', asErrorMessage(err)));
            }
            throw e;
          }
        };
        // Audit P0-V5 / row #3 (M2) — register the attachment grant
        // set BEFORE fanout so a recipient who receives the sealed
        // envelope and immediately tries to download finds the grant
        // already populated. Awaiting AFTER fanout cannot close the
        // race — each peer has already raced their own download against
        // the SADD. One RTT to messenger-service before parallel
        // per-peer encrypt + WS submits. Errors are soft: message goes
        // through either way; only attachment download would 403 under
        // strict-mode if SADD failed. H5 note: passing FULL participants
        // (not just delivered) is intentional — failed peers can't
        // decrypt the envelope so a grant for them is harmless;
        // filtering would require a 2nd SADD post-fanout for no
        // security benefit.
        if (opts.attachment?.objectKey) {
          try {
            await mediaClient.registerGrants(opts.attachment.objectKey, participants);
          } catch (e) {
            console.warn('[messenger.media] registerGrants (group, pre-fanout) failed:', asErrorMessage(e));
          }
        }
        const results = await Promise.allSettled(participants.map(sendOne));
        let delivered = 0;
        const failures: string[] = [];
        let firstRetractToken: string | undefined;
        let firstEnvelopeId: string | undefined;
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.status === 'fulfilled') {
            delivered += 1;
            if (!firstRetractToken && r.value.retractToken) {
              firstRetractToken = r.value.retractToken;
            }
            // Audit MSG-03 — capture an envelopeId so the delivered/read tick
            // pipeline (applyEnvelopeDelivered + the read-receipt handler,
            // both keyed on msg.envelope_id) can fire for group messages. The
            // HTTP send path previously dropped envelopeId entirely, so group
            // ticks were cosmetically dead even though receipts arrive. First
            // recipient's id is enough for the tick to advance (readReceipt
            // matches by group membership); full per-member info is a parity
            // follow-up.
            if (!firstEnvelopeId && r.value.envelopeId) {
              firstEnvelopeId = r.value.envelopeId;
            }
          } else {
            failures.push(`${participants[i]}: ${asErrorMessage(r.reason)}`);
          }
        }
        if (firstRetractToken) {
          useMessengerStore.getState().updateMessageRetractToken(conversationId, msgId, firstRetractToken);
        }
        if (firstEnvelopeId) {
          useMessengerStore.getState().updateMessageEnvelopeId(conversationId, msgId, firstEnvelopeId);
        }

        if (delivered === 0) {
          // Why: a dept-channel admin posting where every member is offline
          // or unprovisioned (no published prekeys → ensureOutgoingSession
          // can't open a session, OR the relay was unreachable this instant)
          // must NOT lose the post. The bubble is already in the store and
          // mirrored to SQLCipher by the write-through subscriber, and every
          // peer we got far enough to encrypt for has a durable outbox row
          // (enqueued before relay.send) that the next reconnect drain
          // re-ships. Mirror the 1:1 offline-peer behaviour — keep the
          // message queued, don't hard-throw on "zero reachable right now".
          // The sealed-sender fan-out, sender-cert verification and
          // master-key wrap above are unchanged. (A group that was never
          // synced already threw earlier with "no other participants", so
          // that genuine "unknown/empty group" case still surfaces.)
          if (failures.length > 0) {
            console.warn('[group-send:runtime] no peer reachable this send; message queued for retry');
          }
          // Leave the bubble in its durable 'sending' state (re-assert so
          // the write-through subscriber re-persists the queued row).
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'sending');
          return;
        }
        useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'sent');
        return;
      }

      // ── 1:1 path ───────────────────────────────────────────────────
      const target = opts.peer ?? {userId: '', deviceId: 1};
      if (!target.userId) {throw new Error('production mode requires explicit peer address');}

      // M-15 — build + append the optimistic bubble BEFORE any of the crypto
      // awaits below. A first-contact X3DH failure (ensureOutgoingSession
      // fetching a prekey bundle) or a seal/wrap throw used to propagate
      // BEFORE the bubble existed, so ChatScreen's catch only flashed an
      // error banner and the user's typed text was gone with no failed
      // bubble and no retry chip. The bubble/outbox `msg` does not depend on
      // the ciphertext, so it's safe to materialise it up front and flip it
      // to 'failed' if the pipeline throws.
      // P2-12 — sendMedia already appended this bubble before its upload and
      // hands its id via `existingMsgId`; skip the append so there's no dupe.
      if (!opts.existingMsgId) {
      const msg: LocalMessage = {
        id: msgId,
        conversation_id: conversationId,
        sender_id: 'self',
        // BS-SELF-MEDIA-TYPE — derive image/video/file/audio from the mime
        // (was hardcoded 'file'), so the SENDER's own 1:1 image shows a
        // thumbnail and their own voice note shows the audio player —
        // matching the recipient + the group-send path.
        type: attachmentMessageType(opts.attachment),
        content: text,
        media_mime: opts.attachment?.mimeType,
        media_object_key: opts.attachment?.objectKey,
        // Round 8 — see the group-send branch above. Without this the
        // 1:1 attachment rendering pipeline can't decrypt R2 ciphertext
        // after a backup-restore.
        media_key: opts.attachment?.keyB64,
        media_iv:  opts.attachment?.ivB64,
        media_meta: attachmentMediaMeta(opts.attachment),
        status: 'sending',
        is_encrypted: true,
        created_at: sentAt,
        peer: target,
        expires_at: expiresAtSec ? expiresAtSec * 1000 : undefined,
        reply_to_msg_id:  replyMeta?.msgId,
        reply_to_preview: replyMeta?.preview,
      };
      useMessengerStore.getState().appendMessage(conversationId, msg);
      }

      // Audit MSG-07 / M-15: the bubble is already on screen; a throw in the
      // crypto pipeline below (no session / prekey fetch, identity fetch
      // failure, seal or wrap error) flips it to 'failed' (retry chip re-runs
      // the whole path) instead of stranding it in 'sending' or losing the text.
      let outerSealed: Awaited<ReturnType<typeof wrapOuter>>;
      let cert: Awaited<ReturnType<typeof certCache.get>>;
      try {
        // P1-1 — fetch the sender cert INSIDE the try so an offline reject (or
        // its 30s negative cache) flips the already-appended bubble to `failed`
        // instead of throwing before any bubble/outbox row exists.
        cert = await certCache.get();
        await ensureOutgoingSession(own, keys, target, ownStore);
        // Round 5 / Security S1 — bind recipient + timestamp into the
        // sealed envelope so the receiver can detect replays against a
        // different recipient or stale session record.
        const sealed = sealPayload(cert, text, {
          attachment:   opts.attachment,
          expiresAtSec,
          clientMsgId:  msgId,
          replyTo:      replyMeta,
          // Audit P0-N2 — extend AAD with sender + conversation so a 1:1
          // ciphertext can't be replayed into a group thread (recipient's
          // group state would reject mismatched conversationId).
          //
          // Audit P0-N2-follow-up — the AAD conversationId MUST be
          // symmetric across sender and receiver: Alice was stamping
          // `direct:bob` (her local UI key) while Bob computed
          // `direct:alice` (his local UI key), so verifySealedAad
          // rejected every 1:1 message with `conversation_mismatch`
          // and the sender saw "sent" while the receiver saw nothing.
          // `directConvoAadId(self, peer)` is order-independent so both
          // sides compute the same string.
          aad:          {
            to:             target,
            ts:             Date.now(),
            sender:         ownAddress,
            conversationId: directConvoAadId(ownAddress.userId, target.userId),
          },
        });
        const ct = await own.encrypt(target, sealed);
        const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, target, peerIdentityCache, PEER_IDENTITY_TTL_MS);
        outerSealed = await wrapOuter({
          recipientIdentityKeyB64: recipientIdKeyB64,
          sender:                  ownAddress,
          ciphertext:              ct,
          cert, // P0-1: cert bound into outer AAD
        });
      } catch (e) {
        useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
        throw e;
      }
      // Audit P0-V5 / row #3 (M2) — register the 1:1 attachment grant
      // server-side BEFORE the WS submit so the recipient's download
      // attempt (which can race after their sealed-envelope receive)
      // finds the grant set already populated. Fire-and-forget
      // previously raced the recipient's fetch in strict mode. The
      // server adds the sender to the grant set automatically so we
      // only need to list the peer here. Soft fail: message still
      // goes out either way; only attachment download would 403
      // under strict mode if SADD failed.
      if (opts.attachment?.objectKey) {
        try {
          await mediaClient.registerGrants(opts.attachment.objectKey, [target.userId]);
        } catch (e) {
          console.warn('[messenger.media] registerGrants (1:1) failed:', asErrorMessage(e));
        }
      }
      // Durable outbox — persist the outgoing envelope to SQLCipher
      // BEFORE handing it to the WS transport. If the app dies between
      // here and the server's `envelope.accepted`, the row survives
      // and the next-launch / next-connect drain re-ships it. Closes
      // the "WhatsApp keeps it, we lose it" message-loss-on-Doze gap.
      // Best-effort: if the DB write fails (full disk, file lock), we
      // still attempt the WS send — degrades to the pre-outbox
      // behaviour rather than blocking the user.
      if (sqlOutbox) {
        try {
          await sqlOutbox.enqueue({
            clientMsgId,
            conversationId,
            messageId:    msgId,
            peerUserId:   target.userId,
            peerDeviceId: target.deviceId,
            payload:      JSON.stringify({outerSealed, expiresAtSec}),
          });
        } catch (e) {
          console.warn('[messenger.outbox] enqueue failed:', asErrorMessage(e));
        }
      }

      // Don't flip to 'sent' yet — we haven't actually shipped it to
      // the relay. The WS send below is fire-and-forget (no ack here);
      // the real 'sent' transition happens on `envelope.accepted` from
      // the server (handleAccepted). The HTTP fallback IS sync, so we
      // can flip directly there. WhatsApp single-tick semantics:
      // "delivered to server", not "encrypted locally."
      // HTTP fallback closure — used when WS throws OR when WS send
      // succeeds but the server never ACKs within the watchdog.
      const httpFallback = async (): Promise<void> => {
        try {
          const r = await relay.send({
            recipient:    target,
            outerSealed,
            clientMsgId,
            expiresAtSec,
          });
          if (r.retractToken) {
            useMessengerStore.getState().updateMessageRetractToken(conversationId, msgId, r.retractToken);
          }
          // Audit MSG-03 — record the envelopeId so a 1:1 message sent via the
          // HTTP fallback still advances to delivered/read (the WS-accepted
          // path sets it, but the HTTP leg previously dropped it).
          if (r.envelopeId) {
            useMessengerStore.getState().updateMessageEnvelopeId(conversationId, msgId, r.envelopeId);
          }
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'sent');
          // Resolve the pending so a late envelope.accepted (if any
          // arrives via the still-open WS) doesn't double-flip — and
          // critically, clear the ack-watchdog timer so it doesn't
          // fire AGAIN with a duplicate HTTP retry (Fix #3).
          clearPending(clientMsgId);
          // Durable outbox — relay confirmed, drop the row so it isn't
          // replayed on the next connect. Audit P0-N4: pass the peer
          // tuple since the PK is now composite.
          if (sqlOutbox) {
            sqlOutbox.markDelivered(clientMsgId, target.userId, target.deviceId).catch(e =>
              console.warn('[messenger.outbox] markDelivered failed:', asErrorMessage(e)));
          }
        } catch (e) {
          useMessengerStore.getState().updateMessageStatus(conversationId, msgId, 'failed');
          // Pop on terminal failure too so the LRU doesn't accumulate
          // dead entries (Fix #8).
          clearPending(clientMsgId);
          // Don't delete the outbox row — the next connect-drain will
          // retry with exponential backoff (recordAttempt).
          if (sqlOutbox) {
            sqlOutbox.recordAttempt(clientMsgId, target.userId, target.deviceId).catch(err =>
              console.warn('[messenger.outbox] recordAttempt failed:', asErrorMessage(err)));
          }
          throw e;
        }
      };

      try {
        transport.send({
          event: 'envelope.send',
          data: {
            to:           target,
            outerSealed,
            clientMsgId,
            expiresAtSec,
          },
        });
        // WS send didn't throw — but socket.io can buffer to a
        // half-dead fd (Doze just froze it, internal heartbeat
        // hasn't expired yet). Set a watchdog: if the server doesn't
        // ack via envelope.accepted within 5s, force-reconnect the
        // WS AND retry over HTTP. Resolves the user-visible "single
        // tick but Sirajul never got it" pattern observed when sending
        // right after Doze unfreeze.
        // Fix #3: STORE the timer on the pending entry. handleAccepted
        // and httpFallback success now BOTH call clearPending which
        // clears the watchdog. Without that, a fast ack could leave
        // the watchdog armed; 5s later it'd fire a duplicate HTTP
        // retry and the server would log a duplicate clientMsgId.
        const ackTimer = setTimeout(() => {
          const entry = pendingByClientMsgId.get(clientMsgId);
          if (!entry) {return;}                                    // already cleared
          const cur = useMessengerStore.getState().messages[conversationId]?.find(m => m.id === msgId);
          if (cur?.status === 'sent') { clearPending(clientMsgId); return; }
          console.warn('[bravo.send] WS ack timeout — forcing reconnect + HTTP retry, clientMsgId=', clientMsgId);
          try {
            // P1-BR-4 (B-58) — don't tear down the socket mid-call: the
            // gateway disconnect-bye would drop the peer's call. The HTTP
            // fallback below still delivers the message; a genuinely dead
            // socket is caught by the heartbeat / AppState-resume probe.
            if (!hasLiveCall()) {
              transport.forceReconnect().catch(() => { /* state machine surfaces */ });
            }
          } catch { /* ignore */ }
          void httpFallback().catch(e =>
            console.warn('[bravo.send] HTTP retry also failed:', asErrorMessage(e)));
        }, 5000);
        trackPending(clientMsgId, {conversationId, messageId: msgId, peer: target, ackTimer});
      } catch {
        // No timer to track in this path — fall straight to HTTP. We
        // still record the pending entry so handleAccepted (if a late
        // WS ack lands once the socket reopens) can resolve it.
        trackPending(clientMsgId, {conversationId, messageId: msgId, peer: target});
        await httpFallback();
      }

      // CRIT-7 multi-device fan-out (flag-gated, EXPO_PUBLIC_MULTI_DEVICE, off
      // by default). The send above reaches the peer's device 1 (today's exact
      // behavior). When enabled, ALSO deliver to the peer's OTHER devices so a
      // linked/second device isn't silently skipped. Fully additive + best-
      // effort: it runs AFTER the primary send, never blocks it, never touches
      // the local bubble/outbox, and a per-device failure is isolated. Same
      // clientMsgId ⇒ each device dedups; the primary device's own dedup is
      // unaffected. Default off ⇒ this block is skipped and the path is
      // byte-identical.
      if (isMultiDeviceEnabled() && keys) {
        void (async () => {
          try {
            const devices = await keys.fetchDevices(target.userId);
            for (const d of devices) {
              const dev = d.address;
              if (dev.deviceId === target.deviceId) {continue;} // primary already handled
              try {
                if (!(await own.hasSession(dev))) {await own.initOutgoingSession(d);}
                const sealedN = sealPayload(cert, text, {
                  attachment:   opts.attachment,
                  expiresAtSec,
                  clientMsgId:  msgId,
                  replyTo:      replyMeta,
                  aad: {
                    to:             dev,
                    ts:             Date.now(),
                    sender:         ownAddress,
                    conversationId: directConvoAadId(ownAddress.userId, target.userId),
                  },
                });
                const ctN = await own.encrypt(dev, sealedN);
                const outerSealedN = await wrapOuter({
                  recipientIdentityKeyB64: d.identityKey,
                  sender:                  ownAddress,
                  ciphertext:              ctN,
                  cert,
                });
                try {
                  transport.send({event: 'envelope.send', data: {to: dev, outerSealed: outerSealedN, clientMsgId: msgId, expiresAtSec}});
                } catch {
                  await relay.send({recipient: dev, outerSealed: outerSealedN, clientMsgId: msgId, expiresAtSec});
                }
              } catch (e) {
                console.warn('[multi-device] fan-out to device ' + dev.deviceId + ' failed:', asErrorMessage(e));
              }
            }
          } catch (e) {
            console.warn('[multi-device] fetchDevices failed:', asErrorMessage(e));
          }
        })();
      }
    },
    sendMedia: async (conversationId, media, mediaOpts) => {
      // Resolve the canonical conversation id the same way sendText does
      // so the local bubble lands in the slot ChatScreen subscribes to.
      let convId = conversationId;
      if (convId.startsWith('direct:')) {
        const {resolveDirectConversationIdFromState: resolve} =
          require('../store/messengerStore') as typeof import('../store/messengerStore');
        const peerUid = convId.slice('direct:'.length);
        convId = resolve(useMessengerStore.getState(), peerUid);
      }

      // P2-12 — append an optimistic `sending` bubble BEFORE the upload so a
      // slow or failed upload leaves a durable on-screen row (visible + retryable)
      // instead of only a spinner + one-shot Alert. sendText later runs
      // crypto/outbox/fan-out against THIS bubble (via existingMsgId) rather than
      // minting a duplicate. `peer` is legacy for the group path (routing is by
      // clientMsgId + group id); a placeholder is fine when unknown.
      const msgId = makeId();
      const expiresAtMs = mediaOpts?.ttlSeconds ? Date.now() + mediaOpts.ttlSeconds * 1000 : undefined;
      useMessengerStore.getState().appendMessage(convId, {
        id: msgId,
        conversation_id: convId,
        sender_id: 'self',
        type: media.kind,
        content: mediaOpts?.caption ?? '',
        media_mime: media.mimeType,
        media_meta: media.meta ? {...media.meta} : undefined,
        status: 'sending',
        is_encrypted: true,
        created_at: new Date().toISOString(),
        peer: mediaOpts?.peer ?? {userId: '', deviceId: 1},
        expires_at: expiresAtMs,
      });

      // 1. Encrypt + upload the ciphertext. The returned key/iv NEVER
      //    leave this device except inside the sealed envelope below.
      //    MX-09 — the bubble's determinate ring rides the transient
      //    per-message progress registry; ALWAYS cleared when the upload
      //    leaves flight (finally) so a failed row can't wear a stale ring.
      const {setUploadProgress} = require('../media/uploadProgress') as typeof import('../media/uploadProgress');
      let upload: Awaited<ReturnType<MediaClient['uploadEncrypted']>>;
      setUploadProgress(msgId, 0);
      try {
        upload = await getUploadMediaClient().uploadEncrypted(
          media.bytes, media.mimeType, f => setUploadProgress(msgId, f),
        );
      } catch (e) {
        // P2-12 — durable failed bubble on upload failure. NOTE the retry gap:
        // the plaintext bytes aren't persisted, so the retry chip can't re-upload
        // a failed-UPLOAD row (only a failed-SEND row whose object already exists).
        setUploadProgress(msgId, null);
        useMessengerStore.getState().updateMessageStatus(convId, msgId, 'failed');
        throw e;
      }
      // Why: the success-path clear happens AFTER patchMessageMedia below —
      // the uploading bubble is classified as media via the live progress
      // value, so clearing before the object key lands would flash it
      // through the text branch for a frame.

      // 2. Build the in-band attachment metadata (per-file key/iv + object key).
      const attachment = {
        objectKey: upload.objectKey,
        keyB64:    upload.keyB64,
        ivB64:     upload.ivB64,
        mimeType:  media.mimeType,
        size:      upload.size,
        // `kind` lets the receiver pick image/audio/video rendering even
        // though the wire `type` collapses to 'file'.
        kind:      media.kind,
        // Media-parity (2026-07-03) — optional display hints (filename,
        // dimensions, duration, tiny thumbnail). In-band like key/iv.
        ...(media.meta?.name       !== undefined ? {name:       media.meta.name} : {}),
        ...(media.meta?.width      !== undefined ? {width:      media.meta.width} : {}),
        ...(media.meta?.height     !== undefined ? {height:     media.meta.height} : {}),
        ...(media.meta?.durationMs !== undefined ? {durationMs: media.meta.durationMs} : {}),
        ...(media.meta?.thumbB64   !== undefined ? {thumbB64:   media.meta.thumbB64} : {}),
      } as import('../crypto').SealedAttachment;

      // 3. Stamp the object key + per-file key/iv onto the bubble so the row
      //    mirrored to SQLCipher can be re-rendered/forwarded post-restore.
      useMessengerStore.getState().patchMessageMedia(convId, msgId, {
        type:             attachmentMessageType(attachment),
        media_mime:       attachment.mimeType,
        media_object_key: attachment.objectKey,
        media_key:        attachment.keyB64,
        media_iv:         attachment.ivB64,
        media_meta:       attachmentMediaMeta(attachment),
      });
      setUploadProgress(msgId, null);

      // 4. Ship via the normal send path (crypto + durable outbox + per-recipient
      //    fan-out + grant registration). existingMsgId reuses the bubble above.
      try {
        await runtimeApi.sendText(convId, mediaOpts?.caption ?? '', {
          peer:          mediaOpts?.peer,
          isGroup:       mediaOpts?.isGroup,
          ttlSeconds:    mediaOpts?.ttlSeconds,
          attachment,
          existingMsgId: msgId,
        });
      } catch (e) {
        // The R2 object is uploaded and referenced by this (now `failed`) bubble,
        // so the retry chip re-ships it — we must NOT delete it. (An orphaned
        // object is only possible if the store patch above threw; the media client
        // exposes no delete API and an ungranted R2 object is undownloadable and
        // ages out via the bucket lifecycle — reported as a known gap.)
        useMessengerStore.getState().updateMessageStatus(convId, msgId, 'failed');
        throw e;
      }

      // Media-parity G6 (2026-07-03) — seed the sender's own decrypted temp file
      // keyed by the bubble id so rendering our own photo costs zero network and
      // zero decrypts (previously the sender re-downloaded its own R2 upload).
      try {
        const {writeTempBytes} = require('../media/mediaFiles') as typeof import('../media/mediaFiles');
        const {seedResolvedAttachmentUri} = require('../media/useAttachmentUri') as typeof import('../media/useAttachmentUri');
        const tempUri = await writeTempBytes(media.bytes, media.mimeType, msgId);
        seedResolvedAttachmentUri(msgId, tempUri);
      } catch { /* best-effort — the download path still works */ }
    },
    downloadMedia: async ({objectKey, keyB64, ivB64}) => {
      return getUploadMediaClient().downloadEncrypted({objectKey, keyB64, ivB64});
    },

    // ── Incident-evidence reuse seam (Dept Chat v2 · Step 10) ───────────────
    // Thin, additive exposure of the EXISTING media + sealed-sender primitives so
    // the Departmental incident flow can encrypt-upload a photo and seal its
    // per-file key to each manager (and the submitter) WITHOUT a chat message and
    // WITHOUT duplicating the crypto. None of the existing send/receive paths are
    // changed; these just wrap what sendMedia / the outer-ECIES wrap already do.
    uploadEvidence: async (bytes, mimeType) => {
      const up = await getUploadMediaClient().uploadEncrypted(bytes, mimeType);
      return {objectKey: up.objectKey, keyB64: up.keyB64, ivB64: up.ivB64, size: up.size};
    },
    grantMediaAccess: async (objectKey, recipientUserIds) => {
      await mediaClient.registerGrants(objectKey, recipientUserIds);
    },
    sealOuterTo: async (recipientUserId, recipientDeviceId, body) => {
      const peer: SessionAddress = {userId: recipientUserId, deviceId: recipientDeviceId};
      const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(
        ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS,
      );
      const cert = await certCache.get();
      // Reuse the exact outer-ECIES wrap chat uses; the inner `ciphertext` carries
      // our small JSON ({keyB64, ivB64, mime}) instead of a Signal-session body.
      // `type` is an opaque tag here (no inner session decrypt happens).
      return wrapOuter({
        recipientIdentityKeyB64: recipientIdKeyB64,
        sender:                  ownAddress,
        ciphertext:              {type: 1, body} as Ciphertext,
        cert,
      });
    },
    openOuterAsSelf: async (outerSealedB64) => {
      const idk = await ownStore.getIdentityKeyPair();
      const u = await unwrapOuter({
        ownIdentityPrivKey: idk.privKey,
        ownIdentityPubKey:  idk.pubKey,
        outerSealedB64,
      });
      // v3 binds the sender cert into the GCM AAD — authenticate it before
      // trusting the unsealed payload (mirrors the receive path at line ~3539).
      if (u.senderCert) {
        await verifySenderCert({cert: u.senderCert, authorityPubKeyB64: config.authorityPubKeyB64});
      }
      return u.ciphertext.body;
    },
    processIncoming: async (_conversationId, peer, ct) => {
      // Conversation routing now derives from sealed.group.groupId
      // inside handleIncoming; the legacy parameter is ignored to
      // preserve the runtime interface.
      await handleIncoming(own, ownStore, peer, ct, config);
    },

    // ─── Presence + typing passthroughs ─────────────────────────────
    //
    // All four of these are best-effort: if the socket isn't open they
    // silently drop. Presence snapshots + typing auto-stop on the
    // server side mean a dropped frame will self-correct within seconds.

    subscribePresence: (userIds: string[]) => {
      // Round 7 / presence audit fix #1 — record the subscription
      // intent so we can replay it on reconnect. The wire emit is
      // idempotent server-side so duplicates from this set + a fresh
      // call are harmless.
      // Audit MSG-16 — increment the refcount per peer.
      for (const id of userIds) { presenceSubscriptions.set(id, (presenceSubscriptions.get(id) ?? 0) + 1); }
      try { transport.subscribePresence(userIds); } catch { /* socket not open */ }
    },

    unsubscribePresence: (userIds: string[]) => {
      // Audit MSG-16 — decrement the refcount; only RELEASE (wire-unsubscribe +
      // clearPresence) the peers whose count reached zero, so a Chat closing
      // doesn't blind Home's still-visible row for the same peer.
      const released: string[] = [];
      for (const id of userIds) {
        const next = (presenceSubscriptions.get(id) ?? 0) - 1;
        if (next <= 0) { presenceSubscriptions.delete(id); released.push(id); }
        else { presenceSubscriptions.set(id, next); }
      }
      if (released.length === 0) {return;}
      try { transport.unsubscribePresence(released); } catch { /* socket not open */ }
      // Round 8 / false-active audit fix #1 — purge the store entries
      // we just stopped tracking. Flip to `offline` rather than delete so
      // consumers reading `presence[uid].state` never handle `undefined`.
      try {
        useMessengerStore.getState().clearPresence(released);
      } catch { /* store may be mid-swap during owner switch */ }
    },

    setActivity: (state: 'active' | 'away') => {
      // Round 7 / presence audit fix #2 — remember the latest activity
      // so reconnect handlers can re-assert it without the caller
      // having to track their own state.
      lastActivity = state;
      try { transport.setActivity(state); } catch { /* socket not open */ }
    },

    sendTyping: (peer, state) => {
      try {
        transport.send({event: 'typing', data: {to: peer, state}});
      } catch { /* socket not open */ }
    },

    sendReaction: async (peer, conversationId, targetMsgId, emoji, remove = false) => {
      if (!peer.userId) {return;}
      const cert = await certCache.get();

      // BS-RX1 — fan a reaction out to EVERY group member, not just one.
      // Previously this sealed a single envelope to `peer`, so in a group
      // chat only one member ever saw the reaction and reaction chips
      // diverged per device. Mirror sendText's group detection +
      // server-authoritative participant list. For a direct chat the
      // recipient set is just [peer].
      const {reactionRecipients, isGroupConversation} =
        require('./messagingLogic') as typeof import('./messagingLogic');
      const reactionState = useMessengerStore.getState();
      const recipients = reactionRecipients(
        reactionState, conversationId, ownAddress.userId, peer,
      );
      // Audit MSG-02 (2026-07-02): a reaction in a GROUP must carry the group
      // id so the recipient folds it onto the message under the GROUP
      // conversation. Without this the envelope had no `group` hint, so the
      // receiver routed it to the REACTOR's 1:1 slot and applyReaction never
      // found the target (it lives under the groupId slot) — reactions were
      // invisible to everyone but the reactor.
      const reactionIsGroup = isGroupConversation(reactionState, conversationId);

      // Seal + encrypt + send ONE envelope per recipient. aad.to binds
      // the specific recipient per-envelope (Security S1), so this is
      // done inside the loop, not hoisted.
      const sendOneReaction = async (to: SessionAddress): Promise<void> => {
        if (!to.userId) {return;}
        await ensureOutgoingSession(own, keys, to, ownStore);
        // Reactions ride an empty-body sealed envelope whose only payload
        // is the reaction directive. Peer's handleIncoming detects the
        // `reaction` field and folds it onto the target message rather
        // than appending a new bubble.
        const clientMsgId = makeId();
        const sealed = sealPayload(cert, '', {
          reaction: {targetMsgId, emoji, remove},
          // MSG-02 — stamp the group so the receiver routes applyReaction to
          // the group conversation, not the reactor's direct slot.
          ...(reactionIsGroup ? {group: {groupId: conversationId, kind: 'text' as const, clientMsgId}} : {}),
          aad: {to, ts: Date.now()},
        });
        const ct = await own.encrypt(to, sealed);
        const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, to, peerIdentityCache, PEER_IDENTITY_TTL_MS);
        const outerSealed = await wrapOuter({
          recipientIdentityKeyB64: recipientIdKeyB64,
          sender:                  ownAddress,
          ciphertext:              ct,
          cert, // P0-1: cert bound into outer AAD
        });
        // Audit MSG-08 (2026-07-02): persist a durable outbox row so a
        // reaction sent while the socket is DOWN isn't lost (previously the
        // WS-throw fell to a swallowed relay.send with no retry — peers never
        // got it). messageId = clientMsgId (no bubble), so the drain's status
        // updates are harmless no-ops; reactions are idempotent on replay.
        if (sqlOutbox) {
          try {
            await sqlOutbox.enqueue({
              clientMsgId,
              conversationId,
              messageId:    clientMsgId,
              peerUserId:   to.userId,
              peerDeviceId: to.deviceId,
              payload:      JSON.stringify({outerSealed}),
            });
          } catch { /* enqueue best-effort */ }
        }
        let reactionDelivered = false;
        try {
          transport.send({
            event: 'envelope.send',
            data: {
              to:           to,
              outerSealed,
              clientMsgId,
              // P2-11 — reactions render nothing on the recipient; suppress the
              // killed-app FCM wake so a blocked/muted or dozing device isn't
              // rung by a phantom banner for a non-displayable envelope.
              urgent:       false,
            },
          });
          // P2-11 — do NOT markDelivered on the fire-and-forget WS send: that
          // dropped the durable outbox row before ANY ack, so a half-dead
          // socket (frame buffered, never shipped) silently lost the reaction.
          // Mirror the text path — register a pending entry so handleAccepted
          // deletes the row on the REAL `envelope.accepted`; if the ack never
          // comes, the outbox row survives and the reconnect drain replays it.
          trackPending(clientMsgId, {conversationId, messageId: clientMsgId, peer: to});
        } catch {
          try {
            await relay.send({
              recipient:    to,
              outerSealed,
              clientMsgId,
              urgent:       false,
            });
            reactionDelivered = true;   // HTTP 200 is a real ack
          } catch { /* socket down + HTTP failed — leave the row for drainOutbox */ }
        }
        // Clear the durable row only on a REAL ack (HTTP success here; the WS
        // path defers to handleAccepted). On failure the row stays and the
        // next reconnect drain replays it.
        if (reactionDelivered && sqlOutbox) {
          sqlOutbox.markDelivered(clientMsgId, to.userId, to.deviceId).catch(() => { /* best-effort */ });
        }
      };

      // Best-effort fan-out — one bad recipient (no session, OPK
      // exhausted) must not drop the reaction for everyone else.
      await Promise.allSettled(recipients.map(sendOneReaction));

      // Local echo — reflect the reaction on our side immediately so
      // UI doesn't have to wait for the server round-trip.
      const store = useMessengerStore.getState();
      const list  = store.messages[conversationId];
      const msg   = list?.find(m => m.id === targetMsgId);
      if (msg) {
        const next: Record<string, string> = {...(msg.reactions ?? {})};
        if (remove) {delete next.self;}
        else        {next.self = emoji;}
        store.updateMessageReactions(conversationId, msg.id, next);
      }
    },

    // Audit MSG-05 — drop the durable outbox rows for a message before a
    // tap-to-retry re-sends it under a fresh clientMsgId, so the original
    // envelope isn't ALSO shipped by the next reconnect drain (double delivery).
    discardOutboxForMessage: async (clientMsgId: string) => {
      if (!sqlOutbox) {return;}
      try { await sqlOutbox.deleteByClientMsgId(clientMsgId); }
      catch (e) { console.warn('[messenger.outbox] discardOutboxForMessage failed:', asErrorMessage(e)); }
    },

    // Audit P2-10 — drop EVERY outbox row for a conversation on "Clear chat"
    // so a still-queued (pending/failed) row isn't re-shipped by the next
    // reconnect drain after the user cleared the thread.
    discardOutboxForConversation: async (conversationId: string) => {
      if (!sqlOutbox) {return;}
      try { await sqlOutbox.deleteByConversation(conversationId); }
      catch (e) { console.warn('[messenger.outbox] discardOutboxForConversation failed:', asErrorMessage(e)); }
    },

    resetSessionWith: async (peer: SessionAddress) => {
      try { await own.closeSession(peer); } catch { /* best effort */ }
      const {bundle} = await keys.fetchPeerBundleWithPoolSize(peer.userId);
      await own.initOutgoingSession({
        ...bundle,
        address: {userId: peer.userId, deviceId: peer.deviceId},
      });
      // Reset the cooldown so a subsequent legitimate failure can
      // immediately attempt another rebuild instead of being silenced
      // by the rate limit.
      clearRebuildAttempt(peer);
    },

    getSafetyNumber: async (peer: SessionAddress) => {
      // Prefer the server-side bundle (source of truth post-rotation)
      // and fall back to the locally-cached identity key on transient
      // network failure. Either way, the returned code is over the
      // identity keys themselves — not the conversationId.
      const peerKeyB64 = await recipientIdentityKeyB64(ownStore, keys, peer);
      const ownIdentityPair = await ownStore.getIdentityKeyPair();
      return computeSafetyNumber(ownIdentityPair.pubKey, fromBase64(peerKeyB64));
    },

    // Audit P0-I3 / P0-S6 / P0-1 — verification surface. Delegates to
    // the SqlCipher store; methods are no-ops when the store doesn't
    // expose them (e.g. an in-memory store under a test runtime).
    getPeerVerification: async (peer: SessionAddress) => {
      const sql = ownStore as unknown as {
        getPeerVerification?: (addr: string) => Promise<{verifiedAtMs: number; safetyNumberSha256: string} | null>;
      };
      if (!sql.getPeerVerification) {return null;}
      return await sql.getPeerVerification(`${peer.userId}.${peer.deviceId}`);
    },
    markPeerVerified: async (peer: SessionAddress, safetyNumber: string) => {
      const sql = ownStore as unknown as {
        markPeerVerified?: (addr: string, hashHex: string, ts?: number) => Promise<boolean>;
      };
      if (!sql.markPeerVerified) {return false;}
      // SHA-256 the user-confirmed string before persisting. The store
      // enforces 64-char lowercase hex; producing it here keeps the
      // raw safety number out of the trust row (the row only needs to
      // prove the user confirmed THIS specific number, not store it).
      const enc = new TextEncoder().encode(safetyNumber);
      const ab  = enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) as ArrayBuffer;
      const digest = await crypto.subtle.digest('SHA-256', ab);
      const hex = Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      const ok = await sql.markPeerVerified(`${peer.userId}.${peer.deviceId}`, hex);
      // TOFU send-gate — verifying the safety number implies accepting the
      // (possibly changed) identity, so clear any pending acknowledgement.
      if (ok) { void acknowledgePeerIdentity(peer.userId); }
      return ok;
    },
    clearPeerVerification: async (peer: SessionAddress) => {
      const sql = ownStore as unknown as {
        clearPeerVerification?: (addr: string) => Promise<void>;
      };
      if (!sql.clearPeerVerification) {return;}
      await sql.clearPeerVerification(`${peer.userId}.${peer.deviceId}`);
    },
    /**
     * TOFU send-gate — acknowledge a peer's identity change WITHOUT full
     * safety-number verification (the lighter "accept" action). Clears the
     * pending gate so sends to this peer resume. No-op when the gate is off.
     */
    acknowledgePeerIdentityChange: async (userId: string) => {
      await acknowledgePeerIdentity(userId);
    },
    listIdentityRotations: async (peer: SessionAddress, limit = 50) => {
      const sql = ownStore as unknown as {
        listIdentityRotations?: (addr: string, limit?: number) => Promise<Array<{
          oldKeySha256: string; newKeySha256: string; observedAtMs: number;
        }>>;
      };
      if (!sql.listIdentityRotations) {return [];}
      return await sql.listIdentityRotations(`${peer.userId}.${peer.deviceId}`, limit);
    },

    broadcastGroupCallPresence: async (recipients, presence) => {
      if (!recipients.length) {return;}
      let cert: string;
      try { cert = await certCache.get(); } catch { return; }
      // Round 5 / Security S1 — `sealed` is now per-recipient so the aad
      // can bind the right address. The shared groupCallPresence body
      // is the same; only the outer wrap differs per peer.
      const presenceTs = Date.now();
      // One sealed envelope per recipient, sent through their pairwise
      // Signal session. Failures are logged per-recipient — the rest of
      // the fan-out continues.
      await Promise.all(recipients.map(async userId => {
        if (!userId || userId === ownAddress.userId) {return;}
        const peer: SessionAddress = {userId, deviceId: 1};
        try {
          await ensureOutgoingSession(own, keys, peer, ownStore);
          const sealed = sealPayload(cert, '', {
            groupCallPresence: presence,
            aad: {to: peer, ts: presenceTs},
          });
          const ct = await own.encrypt(peer, sealed);
          const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS);
          const outerSealed = await wrapOuter({
            recipientIdentityKeyB64: recipientIdKeyB64,
            sender:                  ownAddress,
            ciphertext:              ct,
            cert, // P0-1: cert bound into outer AAD
          });
          try {
            transport.send({
              event: 'envelope.send',
              data: {to: peer, outerSealed, clientMsgId: makeId(), urgent: false},
            });
          } catch {
            await relay.send({recipient: peer, outerSealed, clientMsgId: makeId(), urgent: false});
          }
        } catch (e) {
          console.warn('[messenger] presence broadcast failed', userId, (e as Error).message);
        }
      }));
    },

    createGroupChat: async ({name, members, allowZeroDelivered}) => {
      console.log('[group-create:runtime] start name=', JSON.stringify(name), 'inputMembers=', members);
      const others = Array.from(new Set(members.filter(uid => uid && uid !== ownAddress.userId)));
      console.log('[group-create:runtime] dedup+self-strip otherMembers=', others);
      if (others.length === 0) {
        console.warn('[group-create:runtime] no other members — aborting');
        throw new Error('group needs at least one other member');
      }
      // 1. Build a fresh GroupState (new groupId + master key).
      const state = makeNewGroup({
        name,
        owner:         ownAddress.userId,
        ownerDeviceId: signalDeviceId,
        members:       others.map(userId => ({userId, deviceId: 1})),
      });
      const conversationId = state.groupId;
      console.log('[group-create:runtime] state built groupId=', state.groupId, 'masterKeyLen=', state.masterKeyB64.length);
      const store = useMessengerStore.getState();

      // 2. Local state — group + conversation row, set BEFORE the
      // network broadcast so the sender's UI shows the chat instantly
      // even if delivery to peers is slow / partial.
      store.setGroupState(state);
      store.upsertConversation({
        id:            conversationId,
        type:          'group',
        name,
        participants:  [ownAddress.userId, ...others],
        unread_count:  0,
        is_muted:      false,
        created_at:    new Date().toISOString(),
        // `peer` is a carry-over from the direct-chat shape — for groups
        // we use the first member as the placeholder address. The real
        // routing is per-member fan-out via broadcastToGroup.
        peer:          {userId: others[0], deviceId: 1},
        session_state: 'fresh',
      });

      // 3. Fan out the admin `create` envelope to every other member
      // via their pairwise Signal session. Receivers' handleIncoming
      // sees `inner.kind === 'admin' + adminAction.type === 'create'`
      // and calls setGroupState + upsertConversation, so the group
      // appears in their inbox. The master key travels in the GroupState
      // payload (admin create is the ONE envelope sent without a
      // master-key wrap, since recipients don't have it yet).
      console.log('[group-create:runtime] local state set, starting fan-out to', others.length, 'member(s)');
      const cert = await certCache.get();
      const sessionLike = own; // SessionManager
      // Round 5 / Security S4 — sign the create envelope with the
      // creator's identity priv key. Receivers verify against the
      // sender cert's senderIdentityKey to detect a cert-leak +
      // member-substitution attack. Identity-key sign is async (curve25519
      // wrapper); cache the result so the per-recipient deliver loop
      // doesn't re-sign N times for the same envelope.
      const creatorIdentity = await ownStore.getIdentityKeyPair();
      const creatorSignature = await signGroupCreate(creatorIdentity.privKey, state);
      let delivered = 0;
      const failures: string[] = [];
      try {
        const r = await broadcastToGroup({
          group:   state,
          self:    ownAddress,
          cert,
          body:    '', // admin envelopes carry zero body
          admin:   {type: 'create', state, creatorSignature},
          session: sessionLike,
          // Pre-encrypt hook: ensure the per-peer Signal session exists
          // before broadcastToGroup tries to encrypt. Critical for the
          // restore + clear-data path where the local store has the
          // identity but no session records yet — libsignal's
          // encrypt() throws "No record for U.D" without one.
          ensureSession: async (peer) => {
            const had = await own.hasSession(peer);
            console.log(`[group-create:runtime] hasSession(${peer.userId}/${peer.deviceId})=${had}`);
            if (!had) {
              await ensureOutgoingSession(own, keys, peer, ownStore);
              console.log('[group-create:runtime] X3DH session built for', peer.userId);
            }
          },
          deliver: async (peer, ct, clientMsgId) => {
            console.log('[group-create:runtime] deliver →', peer.userId, '/', peer.deviceId);
            try {
              const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS);
              const outerSealed = await wrapOuter({
                recipientIdentityKeyB64: recipientIdKeyB64,
                sender:                  ownAddress,
                ciphertext:              ct,
                cert, // P0-1: cert bound into outer AAD
              });
              try {
                transport.send({
                  event: 'envelope.send',
                  data:  {to: peer, outerSealed, clientMsgId, urgent: false},
                });
                console.log('[group-create:runtime] sent via WS to', peer.userId);
              } catch {
                await relay.send({recipient: peer, outerSealed, clientMsgId, urgent: false});
                console.log('[group-create:runtime] sent via HTTP relay to', peer.userId);
              }
              delivered += 1;
            } catch (e) {
              const msg = asErrorMessage(e);
              failures.push(`${peer.userId}: ${msg}`);
              console.warn('[group-create:runtime] deliver FAILED to', peer.userId, '—', msg);
            }
          },
        });
        // r.recipients is the count broadcastToGroup ENQUEUED — actual
        // success comes from the delivered counter inside our deliver.
        void r;
      } catch (e) {
        failures.push(asErrorMessage(e));
      }
      console.log('[group-create:runtime] fan-out done delivered=', delivered, 'failures=', failures.length);
      if (delivered === 0) {
        // The local conversation/group state IS kept above — the user can re-share later.
        // D1-d — for dept-channel provisioning (allowZeroDelivered), a 0-delivered fan-out is
        // NOT a failure: the group is valid and must be registered with a STABLE id so it isn't
        // re-forked on every open. Members (who simply had no Signal keys yet) are keyed in later
        // via add-intents / self-heal. Other callers (1:1 group create) still throw as before.
        if (allowZeroDelivered) {
          console.warn('[group-create:runtime] 0 delivered — keeping group (allowZeroDelivered) conversationId=', conversationId);
          return {conversationId, groupId: state.groupId};
        }
        console.warn('[group-create:runtime] no recipients reached, throwing');
        throw new Error(`group create: no member could be reached (${failures.join('; ')})`);
      }
      console.log('[group-create:runtime] OK conversationId=', conversationId, 'groupId=', state.groupId);
      return {conversationId, groupId: state.groupId};
    },

    /**
     * MISSION-GROUP (batch area 5) — bootstrap the E2EE state for a group
     * whose id was ASSIGNED server-side (the mission Ops Room conversation
     * UUID), as opposed to createGroupChat's salt-derived id.
     *
     * Idempotent: if local GroupState already exists for `groupId` this is a
     * NO-OP — re-bootstrapping would mint a second master key and fork the
     * group (the multi-admin key-divergence the audits flagged). The agency
     * device (which owns the room) calls this from the dispatch-room-intent
     * drain BEFORE applying the queued CPO add-intents, so addGroupMember
     * finds a local group to rekey the CPO into instead of throwing
     * "unknown group" (which is why the add-intents sat `pending` forever).
     *
     * Mirrors createGroupChat's signed `create` fan-out, with two deltas:
     *   - the id is taken as given (makeAssignedGroup, no salt derivation);
     *   - zero/partial delivery does NOT throw — the local state must persist
     *     so the CPO adds proceed even if the initial member (client) is
     *     momentarily offline (they get the create on their next sync).
     */
    ensureAssignedGroup: async ({groupId, name, members}) => {
      return runWithGroupAdminLock(groupId, async () => {
        const store = useMessengerStore.getState();
        if (store.groups[groupId]?.masterKeyB64) {
          // Already bootstrapped on this device with a real key — never re-key.
          return {groupId, alreadyExisted: true};
        }
        // Audit G-06 (2026-07-02): before MINTING a fresh key for an
        // externally-assigned id (the mission Ops Room), try to RECOVER the
        // existing key. On a wiped/reinstalled owner device the local-existence
        // check above is empty, so the old code minted a NEW key over the SAME
        // conversationId — forking the room (members keyed under the original
        // key drop the new epoch-0 create via the G1 guard). Fire a key-request
        // to the members and wait briefly; if a reshare lands we adopt the
        // ORIGINAL key instead of forking. Best-effort: if nobody can reshare
        // (all offline, or the reshare is owner-gated and no other owner-device
        // is online — see G-05) we fall through to minting, which is the prior
        // behaviour. NOTE: full recovery for a reinstalled SOLE owner needs
        // either any-admin reshare (G-05) or owner-key backup-restore.
        const others0 = Array.from(new Set(members.filter(uid => uid && uid !== ownAddress.userId)));
        if (others0.length > 0) {
          try {
            await sendKeyRequest(groupId, others0, store.groups[groupId]?.epoch);
            const deadline = Date.now() + 2500;
            while (Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 250));
              if (useMessengerStore.getState().groups[groupId]?.masterKeyB64) {
                console.log('[group-assign] G-06 recovered existing key for', groupId.slice(0, 12), '— not minting a fork');
                return {groupId, alreadyExisted: true};
              }
            }
          } catch (e) {
            console.warn('[group-assign] G-06 key-request pre-mint failed:', asErrorMessage(e));
          }
        }
        const others = others0;
        // 1. Build E2EE state with the externally-assigned id + fresh key.
        const state = makeAssignedGroup({
          groupId,
          name,
          owner:         ownAddress.userId,
          ownerDeviceId: signalDeviceId,
          members:       others.map(userId => ({userId, deviceId: 1})),
        });
        // 2. Local state first so the agency UI + the drain see it instantly
        //    even if the fan-out is slow/partial.
        store.setGroupState(state);
        store.upsertConversation({
          id:            groupId,
          type:          'group',
          name,
          participants:  [ownAddress.userId, ...others],
          unread_count:  0,
          is_muted:      false,
          created_at:    new Date().toISOString(),
          peer:          others[0] ? {userId: others[0], deviceId: 1} : {userId: ownAddress.userId, deviceId: signalDeviceId},
          session_state: 'fresh',
        });
        // 3. Fan out the signed admin `create` (carrying the master key) to
        //    the initial members over their pairwise Signal sessions —
        //    identical to createGroupChat. Tolerates zero/partial delivery.
        if (others.length > 0) {
          const cert = await certCache.get();
          const sessionLike = own;
          const creatorIdentity = await ownStore.getIdentityKeyPair();
          const creatorSignature = await signGroupCreate(creatorIdentity.privKey, state);
          let delivered = 0;
          const failures: string[] = [];
          try {
            await broadcastToGroup({
              group:   state,
              self:    ownAddress,
              cert,
              body:    '',
              admin:   {type: 'create', state, creatorSignature},
              session: sessionLike,
              ensureSession: async (peer) => {
                const had = await own.hasSession(peer);
                if (!had) {await ensureOutgoingSession(own, keys, peer, ownStore);}
              },
              deliver: async (peer, ct, clientMsgId) => {
                try {
                  const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS);
                  const outerSealed = await wrapOuter({
                    recipientIdentityKeyB64: recipientIdKeyB64,
                    sender:                  ownAddress,
                    ciphertext:              ct,
                    cert,
                  });
                  try {
                    transport.send({event: 'envelope.send', data: {to: peer, outerSealed, clientMsgId, urgent: false}});
                  } catch {
                    await relay.send({recipient: peer, outerSealed, clientMsgId, urgent: false});
                  }
                  delivered += 1;
                } catch (e) {
                  failures.push(`${peer.userId}: ${asErrorMessage(e)}`);
                }
              },
            });
          } catch (e) {
            failures.push(asErrorMessage(e));
          }
          if (delivered === 0 && failures.length > 0) {
            console.warn('[ops-room:bootstrap] create fan-out reached no members (kept local state):', failures.join('; '));
          }
        }
        return {groupId, alreadyExisted: false};
      });
    },

    /**
     * Round 5 / Security S2 — remove a member AND rotate the master
     * key in the same operation. Two-step protocol on the wire:
     *
     *   1. Broadcast `admin: remove` at the current epoch. Recipients
     *      drop the user from their members map and bump epoch E→E+1.
     *      The removed member receives this same envelope and learns
     *      they were ousted (UI can then disable the chat).
     *   2. Broadcast `admin: rekey` at the post-remove epoch (E+1) with
     *      a fresh 32-byte master key. The inner body is master-key-
     *      wrapped under the OLD key so the removed member CAN decrypt
     *      it — they need to learn that the key changed so they don't
     *      keep trying to use the old one — but they do NOT learn the
     *      new key (the rekey body carries the new key in PLAINTEXT
     *      under the OLD master key, so the receiver applies it
     *      locally to bump their state to the new key). After this
     *      epoch every group message body is master-key-wrapped under
     *      the NEW key, which the removed member never sees, so they
     *      can no longer decrypt subsequent messages even passively.
     *
     * Order matters — step 2 fires only AFTER step 1's fan-out
     * resolves so remaining members have already advanced to E+1
     * locally and their parseGroupMessage masterKey lookup matches.
     */
    removeGroupMember: async ({groupId, removedUserId}) => {
      // Audit P1-G2 — serialise multi-step admin under a per-group lock.
      return runWithGroupAdminLock(groupId, async () => {
      const store = useMessengerStore.getState();
      const cur = store.groups[groupId];
      if (!cur) {throw new Error(`removeGroupMember: unknown group ${groupId}`);}
      // Authorisation: caller must be admin. We're "self" — same gate
      // that applyAdminAction enforces on the receiving side, mirrored
      // locally so a non-admin caller fails fast with a clear error
      // instead of a silent "no peer applied my action".
      const meAsMember = cur.members[ownAddress.userId];
      if (!meAsMember?.admin) {throw new Error('only admins can remove members');}
      if (removedUserId === ownAddress.userId) {
        throw new Error('cannot remove self via removeGroupMember');
      }
      if (!cur.members[removedUserId]) {
        throw new Error(`${removedUserId} is not a member of ${groupId}`);
      }

      const {planRemoveAndRekey} = require('@bravo/messenger-core') as
        typeof import('@bravo/messenger-core');
      const plan = planRemoveAndRekey(cur, removedUserId);

      const cert = await certCache.get();
      const sessionLike = own;

      // Step 1: broadcast `remove` to ALL current members (incl. the
      // user being removed — they need to know they're out). The
      // existing master key is what's wrapping this admin body.
      let removeDelivered = 0;
      const removeFailures: string[] = [];
      const ensureSessionFn = async (peer: SessionAddress): Promise<void> => {
        const had = await own.hasSession(peer);
        if (!had) {await ensureOutgoingSession(own, keys, peer, ownStore);}
      };
      const deliverFn = async (peer: SessionAddress, ct: Ciphertext, clientMsgId: string): Promise<void> => {
        try {
          const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(
            ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS,
          );
          const outerSealed = await wrapOuter({
            recipientIdentityKeyB64: recipientIdKeyB64,
            sender:                  ownAddress,
            ciphertext:              ct,
            cert, // P0-1: cert bound into outer AAD
          });
          try {
            transport.send({
              event: 'envelope.send',
              data:  {to: peer, outerSealed, clientMsgId, urgent: false},
            });
          } catch {
            await relay.send({recipient: peer, outerSealed, clientMsgId, urgent: false});
          }
        } catch (e) {
          throw new Error(asErrorMessage(e));
        }
      };
      try {
        await broadcastToGroup({
          group:         cur,
          self:          ownAddress,
          cert,
          body:          '',
          admin:         plan.remove,
          session:       sessionLike,
          ensureSession: ensureSessionFn,
          deliver: async (peer, ct, clientMsgId) => {
            try { await deliverFn(peer, ct, clientMsgId); removeDelivered += 1; }
            catch (e) { removeFailures.push(`${peer.userId}: ${asErrorMessage(e)}`); }
          },
        });
      } catch (e) {
        removeFailures.push(asErrorMessage(e));
      }
      if (removeDelivered === 0) {
        throw new Error(`remove member: no peer reached (${removeFailures.join('; ')})`);
      }

      // Apply step 1 to OUR local state so the rekey we ship next
      // wraps under the post-remove member set (the removed user is
      // already gone from `cur.members`).
      const stateAfterRemove = applyAdminAction(cur, plan.remove, ownAddress.userId);
      store.setGroupState(stateAfterRemove);

      // Step 2: broadcast `rekey` to the POST-remove member set. The
      // body is encrypted under the OLD master key (which the now-
      // removed user holds — but they no longer get a copy because we
      // fan out using the post-remove member list). The new key inside
      // the body becomes the active master key for everyone who
      // applies this admin action.
      // B-10 — fan out the rekey BEFORE we rotate locally so the host's
      // next message under the new epoch can't outrun the new-epoch key
      // on the remaining members. Wrapped in a retryable closure; the
      // envelope is wrapped under the OLD key (still active here).
      const rekeyFailures: string[] = [];
      const fanOutRekey = async (): Promise<number> => {
        let delivered = 0;
        try {
          await broadcastToGroup({
            group:         stateAfterRemove,
            self:          ownAddress,
            cert,
            body:          '',
            admin:         plan.rekey,
            session:       sessionLike,
            ensureSession: ensureSessionFn,
            deliver: async (peer, ct, clientMsgId) => {
              try { await deliverFn(peer, ct, clientMsgId); delivered += 1; }
              catch (e) { rekeyFailures.push(`${peer.userId}: ${asErrorMessage(e)}`); }
            },
          });
        } catch (e) {
          rekeyFailures.push(asErrorMessage(e));
        }
        return delivered;
      };
      let rekeyDelivered = await fanOutRekey();
      // B-10 — 0-peer redistribution: do NOT silently proceed. Retry once
      // before the new epoch takes effect, then surface if still 0.
      if (rekeyDelivered === 0) {
        rekeyDelivered = await fanOutRekey();
      }
      if (rekeyDelivered === 0) {
        store.setError('Group key update reached no members — they may miss new messages until they refetch');
        console.warn('[group-rekey:runtime] rekey fan-out delivered to 0 peers after retry; remaining members must refetch state');
      }
      // Even if rekey fan-out failed, locally rotate to the new key so
      // OUR future sends are encrypted under the new key. Any remaining
      // member who didn't receive the rekey envelope will fail to
      // decrypt our next group message and surface a "couldn't decrypt
      // one message" — at which point a manual rejoin / re-send
      // recovers them. This is a deliberate fail-CLOSED choice:
      // continuing to use the OLD key would let the removed member
      // keep reading; better to risk a missed message than a privacy
      // leak.
      const stateAfterRekey = applyAdminAction(stateAfterRemove, plan.rekey, ownAddress.userId);
      store.setGroupState(stateAfterRekey);

      // Audit P0-G2 — drop the OLD master key from the in-process key
      // cache the moment the new key takes effect locally. Without this,
      // the previous CryptoKey sits in keyCache for the entire process
      // lifetime, widening any pre-rekey replay window. Compare base64
      // strings — the key changes from `cur.masterKeyB64` to
      // `stateAfterRekey.masterKeyB64`; dispose only if they actually
      // differ (defensive — if the planner ever emits a no-op rekey,
      // don't evict a still-live key).
      if (cur.masterKeyB64 !== stateAfterRekey.masterKeyB64) {
        disposeGroupKey(cur.masterKeyB64);
      }

      return {newEpoch: stateAfterRekey.epoch};
      }); // runWithGroupAdminLock
    },

    // Audit P1-G4 — voluntary leave + rekey. Mirrors removeGroupMember but the
    // sender removes THEMSELVES (planLeaveAndRekey) and then EXITS the group
    // locally instead of adopting the new key. Best-effort fan-out; the local
    // exit always completes so a user is never stuck in a group they left.
    leaveGroup: async ({groupId}) => {
      return runWithGroupAdminLock(groupId, async () => {
      const store = useMessengerStore.getState();
      const cur = store.groups[groupId];
      if (!cur) {
        // Unknown group — nothing to broadcast; ensure we're out locally.
        store.removeGroupState(groupId);
        return {left: true};
      }
      const others = Object.keys(cur.members).filter(u => u && u !== ownAddress.userId);
      if (!cur.members[ownAddress.userId] || others.length === 0) {
        // Not a member, or the only member — no one to notify / rekey. Drop
        // locally (removeGroupState evicts the key from the cache too).
        store.removeGroupState(groupId);
        return {left: true};
      }

      const {planLeaveAndRekey} = require('@bravo/messenger-core') as
        typeof import('@bravo/messenger-core');
      // Broadcast ONLY the `leave` — NOT the chained rekey. The leaver cannot
      // authorize the post-leave rekey: once the `leave` removes them, the
      // remaining members reject any further admin action signed by a non-member
      // (the rekey would be a silent no-op). True forward-secrecy-on-leave
      // therefore needs a REMAINING admin to rekey after the leave (a separate
      // follow-up); this is the documented best-effort-cooperative-leaver model
      // — the leaver retains the OLD key but voluntarily exits and their client
      // honours it. Membership IS updated for everyone, which is the user-
      // visible behaviour ("X left the group").
      const plan = planLeaveAndRekey(cur, ownAddress.userId);

      const cert = await certCache.get();
      const sessionLike = own;
      const ensureSessionFn = async (peer: SessionAddress): Promise<void> => {
        const had = await own.hasSession(peer);
        if (!had) {await ensureOutgoingSession(own, keys, peer, ownStore);}
      };
      const deliverFn = async (peer: SessionAddress, ct: Ciphertext, clientMsgId: string): Promise<void> => {
        const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(
          ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS,
        );
        const outerSealed = await wrapOuter({
          recipientIdentityKeyB64: recipientIdKeyB64,
          sender:                  ownAddress,
          ciphertext:              ct,
          cert,
        });
        try {
          transport.send({event: 'envelope.send', data: {to: peer, outerSealed, clientMsgId, urgent: false}});
        } catch {
          await relay.send({recipient: peer, outerSealed, clientMsgId, urgent: false});
        }
      };

      // Tell the CURRENT members we're leaving (they remove us + advance to
      // E+1). Wrapped under the CURRENT master key (all hold it). Best-effort.
      try {
        await broadcastToGroup({
          group: cur, self: ownAddress, cert, body: '', admin: plan.leave,
          session: sessionLike, ensureSession: ensureSessionFn,
          deliver: async (peer, ct, clientMsgId) => {
            try { await deliverFn(peer, ct, clientMsgId); } catch { /* best-effort — we leave regardless */ }
          },
        });
      } catch (e) {
        console.warn('[group-leave:runtime] leave broadcast failed:', asErrorMessage(e));
      }

      // We're OUT — drop the group entirely. removeGroupState evicts the old
      // key from the cache so nothing local can decrypt with it after exit.
      store.removeGroupState(groupId);
      return {left: true};
      }); // runWithGroupAdminLock
    },

    /**
     * Audit P0-G3 — atomic "add member + rekey" runtime wrapper.
     *
     * Mirrors removeGroupMember exactly: two-step plan, fan-out, local
     * state advance, key dispose. The ONLY sanctioned client-side path
     * to add a member; do not let UI invoke a bare `add` action.
     *
     * Why forward-secrecy matters here:
     *   - A naïve `add` admits the new member at the CURRENT epoch
     *     with the CURRENT master key. From that moment they can
     *     decrypt every queued envelope on the relay (up to 30-day
     *     dwell) AND every sealed-archive row written under the
     *     current key (up to 90-day TTL).
     *   - The chained rekey rotates the key the instant the new
     *     member is in the membership set. After this returns, the
     *     new member can decrypt messages sent under the new key but
     *     not anything from the prior epoch.
     */
    addGroupMember: async ({groupId, newMember}) => {
      // Audit P1-G2 — serialise multi-step admin under the per-group lock.
      return runWithGroupAdminLock(groupId, async () => {
      const store = useMessengerStore.getState();
      const cur = store.groups[groupId];
      if (!cur) {throw new Error(`addGroupMember: unknown group ${groupId}`);}
      const meAsMember = cur.members[ownAddress.userId];
      if (!meAsMember?.admin) {throw new Error('only admins can add members');}
      if (newMember.userId === ownAddress.userId) {
        throw new Error('cannot add self via addGroupMember');
      }
      if (cur.members[newMember.userId]) {
        throw new Error(`${newMember.userId} is already a member of ${groupId}`);
      }
      // group-grown-past-send-cap-bricks-sends — enforce the fan-out cap at ADD
      // time, not only on send. The send path refuses a group larger than
      // MAX_GROUP_FANOUT (250) with 'group too large to send'; without this gate
      // the 251st add succeeded and then BRICKED the chat (no message could be
      // sent). Reject the add instead so the group can never enter that state.
      // Must stay in lockstep with MAX_GROUP_FANOUT in the send path below.
      if (Object.keys(cur.members).length >= 250) {
        throw new Error('group is at the maximum size (250 members)');
      }

      const {planAddAndRekey} = require('@bravo/messenger-core') as
        typeof import('@bravo/messenger-core');
      const plan = planAddAndRekey(cur, newMember);

      const cert = await certCache.get();
      const sessionLike = own;

      const ensureSessionFn = async (peer: SessionAddress): Promise<void> => {
        const had = await own.hasSession(peer);
        if (!had) {await ensureOutgoingSession(own, keys, peer, ownStore);}
      };
      const deliverFn = async (peer: SessionAddress, ct: Ciphertext, clientMsgId: string): Promise<void> => {
        try {
          const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(
            ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS,
          );
          const outerSealed = await wrapOuter({
            recipientIdentityKeyB64: recipientIdKeyB64,
            sender:                  ownAddress,
            ciphertext:              ct,
            cert, // P0-1: cert bound into outer AAD
          });
          try {
            transport.send({
              event: 'envelope.send',
              data:  {to: peer, outerSealed, clientMsgId, urgent: false},
            });
          } catch {
            await relay.send({recipient: peer, outerSealed, clientMsgId, urgent: false});
          }
        } catch (e) {
          throw new Error(asErrorMessage(e));
        }
      };

      // Step 1: broadcast `add` to the POST-add member set (existing
      // members + new member). The new member needs the add envelope
      // to learn they're in the group AND to apply the membership
      // update locally; existing members need it to advance their
      // local membership set so the subsequent rekey at epoch E+1
      // matches their `applyAdminAction` gate.
      //
      // The body is empty (admin envelopes carry the action, not a
      // text payload) and is master-key-wrapped under the CURRENT
      // key — which all post-add members hold (the new member just
      // received it via X3DH+session-establishment that the caller
      // is responsible for completing before invoking us).
      const stateForAddBroadcast: GroupState = {
        ...cur,
        members: {
          ...cur.members,
          [newMember.userId]: {
            deviceId: newMember.deviceId,
            admin:    false,
            joinedAt: Date.now(),
          },
        },
      };
      let addDelivered = 0;
      const addFailures: string[] = [];
      try {
        await broadcastToGroup({
          group:         stateForAddBroadcast,
          self:          ownAddress,
          cert,
          body:          '',
          admin:         plan.add,
          session:       sessionLike,
          ensureSession: ensureSessionFn,
          deliver: async (peer, ct, clientMsgId) => {
            try { await deliverFn(peer, ct, clientMsgId); addDelivered += 1; }
            catch (e) { addFailures.push(`${peer.userId}: ${asErrorMessage(e)}`); }
          },
        });
      } catch (e) {
        addFailures.push(asErrorMessage(e));
      }
      if (addDelivered === 0) {
        throw new Error(`add member: no peer reached (${addFailures.join('; ')})`);
      }

      // Apply step 1 to OUR local state so the rekey we ship next
      // matches the same epoch.
      const stateAfterAdd = applyAdminAction(cur, plan.add, ownAddress.userId);
      store.setGroupState(stateAfterAdd);

      // Step 2: broadcast `rekey` to the SAME post-add member set,
      // encrypted under the OLD master key (still active locally at
      // this point). All recipients hold the OLD key so they all
      // decrypt — they then rotate forward to the new key.
      // B-10 — fan out the rekey BEFORE we rotate locally so the host's
      // next message under the new epoch can't outrun the new-epoch key.
      // The envelope is wrapped under the OLD key (still active here);
      // recipients hold the OLD key, decrypt the rekey, then rotate
      // forward. Wrap in a retryable closure so a 0-peer fan-out can be
      // re-attempted before the new epoch goes live — same sealed fan-out,
      // no new wire format.
      const rekeyFailures: string[] = [];
      const fanOutRekey = async (): Promise<number> => {
        let delivered = 0;
        try {
          await broadcastToGroup({
            group:         stateAfterAdd,
            self:          ownAddress,
            cert,
            body:          '',
            admin:         plan.rekey,
            session:       sessionLike,
            ensureSession: ensureSessionFn,
            deliver: async (peer, ct, clientMsgId) => {
              try { await deliverFn(peer, ct, clientMsgId); delivered += 1; }
              catch (e) { rekeyFailures.push(`${peer.userId}: ${asErrorMessage(e)}`); }
            },
          });
        } catch (e) {
          rekeyFailures.push(asErrorMessage(e));
        }
        return delivered;
      };
      let rekeyDelivered = await fanOutRekey();
      // B-10 — 0-peer redistribution: do NOT silently proceed. Retry the
      // rekey fan-out once before the new epoch takes effect, then surface
      // if it still reached nobody.
      if (rekeyDelivered === 0) {
        rekeyDelivered = await fanOutRekey();
      }
      if (rekeyDelivered === 0) {
        store.setError('Group key update reached no members — they may miss new messages until they refetch');
        console.warn('[group-add-rekey:runtime] rekey fan-out delivered to 0 peers after retry; members must refetch state');
      }

      // Locally rotate to the new key regardless of fan-out — same
      // fail-CLOSED reasoning as removeAndRekey. If rekey fan-out
      // failed, peers will surface a decrypt error on our next
      // message and we recover via session-rebuild; preferable to
      // keeping the old key live and admitting the new member
      // (already in our state) to decrypt under it.
      const stateAfterRekey = applyAdminAction(stateAfterAdd, plan.rekey, ownAddress.userId);
      store.setGroupState(stateAfterRekey);

      // Audit P0-G2 — dispose the old key from the in-process cache.
      if (cur.masterKeyB64 !== stateAfterRekey.masterKeyB64) {
        disposeGroupKey(cur.masterKeyB64);
      }

      // RC1 FIX (the #1 structural break) — the `add` + `rekey` envelopes
      // above are BOTH master-key-wrapped, but the NEW member held no
      // prior key, so it can decrypt NEITHER and would be permanently
      // keyless (the old `planAddAndRekey` "new member unwraps the rekey"
      // premise was false). Deliver the post-rekey state to the new member
      // as an UNWRAPPED, signed `admin: create` over their pairwise
      // session — the one carrier a keyless member can read — so they
      // actually receive the CURRENT key. Forward-secrecy holds: the state
      // we ship is post-rekey (the NEW key only), so the new member still
      // cannot decrypt anything from before they joined. Owner-gated +
      // roster-gated inside reshareGroupKeyState (we are the owner here iff
      // we minted this group; for an assigned/ops group the owning device
      // is the one running addGroupMember). Best-effort: a failure here
      // self-heals via the member's key-request on next focus/reconnect.
      try {
        const keyed = await reshareGroupKeyState(stateAfterRekey, [newMember.userId]);
        if (keyed === 0) {
          console.warn('[group-add-rekey:runtime] new member did not receive the key inline; will self-heal via key-request');
        }
      } catch (e) {
        console.warn('[group-add-rekey:runtime] new-member key delivery failed', asErrorMessage(e));
      }
      // Media-parity M4 (2026-07-03) — download grants are a send-time
      // snapshot of the member set, so a member added later 403'd on
      // every pre-join attachment even though drain-on-add shows them
      // the bubbles. registerGrants is additive + owner-checked server-
      // side, so re-granting is safe — but only for objects WE uploaded
      // (a grant call on a peer's object would 403 not_object_owner).
      // Recent-100 cap bounds the burst; fire-and-forget per object.
      try {
        const rows = useMessengerStore.getState().messages[groupId] ?? [];
        const ownMedia = rows.filter(m => m.sender_id === 'self' && m.media_object_key).slice(-100);
        for (const m of ownMedia) {
          void mediaClient.registerGrants(m.media_object_key!, [newMember.userId])
            .catch(e => console.warn('[group-add:runtime] media re-grant failed:', asErrorMessage(e)));
        }
        if (ownMedia.length > 0) {
          console.log(`[group-add:runtime] re-granting ${ownMedia.length} media object(s) to new member ${newMember.userId.slice(0, 8)}`);
        }
      } catch { /* best-effort — pre-join media stays sender-resendable */ }

      return {newEpoch: stateAfterRekey.epoch};
      }); // runWithGroupAdminLock
    },

    // BS-CALL-ADHOC — establish a group master key for an ad-hoc/escalated
    // multi-party call. Reuses the EXACT proven sealed fan-out that
    // createGroupChat uses (makeNewGroup + broadcastToGroup admin/create);
    // no new crypto primitive. Fail-closed: throws if no key can be
    // established so the caller refuses the call rather than going plaintext.
    ensureCallGroupKey: async ({conversationId, recipientUserIds}) => {
      const store = useMessengerStore.getState();
      const others = Array.from(new Set(
        recipientUserIds.filter(uid => uid && uid !== ownAddress.userId),
      ));
      if (others.length === 0) {
        throw new Error('ensureCallGroupKey: no other participants — cannot key an ad-hoc call');
      }

      // BS-CALL-KEY-RESYNC: if the host already has a key, re-broadcast it
      // to all current call recipients. This ensures reinstalled devices
      // (Techno self-minted a wrong K2) and devices that missed the original
      // fan-out (emulator had no key) always receive the correct key at call
      // time. We never mint a new key here — only distribute the existing one.
      //
      // GUARD (BS-CALL-OWNER): only re-broadcast a state THIS device owns.
      // `setGroupState` is a full overwrite, so after a prior call where the
      // OTHER party was host, `groups[conversationId]` can hold owner=peer.
      // Re-broadcasting that ships an admin/create with owner=peer from us;
      // the recipient's owner===sender check (the forgery guard) then DROPs
      // it and the key never lands. When we don't own the existing state,
      // fall through to mint a fresh group with owner=self instead.
      const existing = store.groups[conversationId];
      if (existing?.masterKeyB64 && existing.owner === ownAddress.userId) {
        const cert = await certCache.get();
        const creatorIdentity = await ownStore.getIdentityKeyPair();
        const creatorSignature = await signGroupCreate(creatorIdentity.privKey, existing);
        let redelivered = 0;
        try {
          await broadcastToGroup({
            group:   existing,
            self:    ownAddress,
            cert,
            body:    '',
            admin:   {type: 'create', state: existing, creatorSignature},
            session: own,
            ensureSession: async (peer) => {
              const had = await own.hasSession(peer);
              if (!had) { await ensureOutgoingSession(own, keys, peer, ownStore); }
            },
            deliver: async (peer, ct, clientMsgId) => {
              try {
                const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS);
                const outerSealed = await wrapOuter({recipientIdentityKeyB64: recipientIdKeyB64, sender: ownAddress, ciphertext: ct, cert});
                try { transport.send({event: 'envelope.send', data: {to: peer, outerSealed, clientMsgId, urgent: false}}); }
                catch { await relay.send({recipient: peer, outerSealed, clientMsgId, urgent: false}); }
                redelivered += 1;
              } catch (e) {
                console.warn('[call-adhoc-key:runtime] resync delivery failed', peer.userId, asErrorMessage(e));
              }
            },
          });
        } catch (e) {
          console.warn('[call-adhoc-key:runtime] resync broadcast failed', asErrorMessage(e));
        }
        console.log('[call-adhoc-key:runtime] key resynced delivered=', redelivered, 'keyConvo=', conversationId.slice(0, 12));
        return {keyConversationId: conversationId};
      }

      // GUARD (BS-CALL-REALGROUP-MINT / B-15): owner-poison protection.
      // The resync gate above failed, so we don't own the existing state.
      // If conversationId names a REAL named-server group (a stored
      // group/ops_channel row, OR a groups[] entry owned by someone else),
      // we MUST NOT fall through to the mint path: makeNewGroup +
      // setGroupState is a FULL OVERWRITE that would replace the real
      // group's state (owner, name, epoch, master key) with owner=self,
      // name='Call', epoch=0 and a fresh key, then fan that key out —
      // hijacking the real group. The real group's master key is only ever
      // distributed by its real owner via the normal group-create/rekey
      // path. So: reuse the stored real key as-is (no rotation, no
      // overwrite, no fan-out), or fail closed if we lack it.
      const convType = useMessengerStore.getState().conversations[conversationId]?.type;
      const isReal =
        !conversationId.startsWith('direct:') &&
        (convType === 'group' ||
          convType === 'ops_channel' ||
          !!(existing?.masterKeyB64 && existing.owner && existing.owner !== ownAddress.userId));
      if (isReal) {
        if (existing?.masterKeyB64) {
          // Reuse the real owner's distributed key verbatim. No mint, no
          // overwrite, no key fan-out — SFrame derives from the stored key.
          console.log('[call-adhoc-key:runtime] reusing real-group key (non-owner host) keyConvo=', conversationId.slice(0, 12));
          return {keyConversationId: conversationId};
        }
        // We lack the real group's key. Fail closed — never mint over a
        // group owned by another user. The caller (useGroupCall) treats a
        // throw as fail-closed and tears the call down.
        throw new Error('ensureCallGroupKey: missing real-group master key — refusing to mint over a group owned by another user');
      }

      // 1. Mint a fresh group (own master key) for the call participants.
      const state = makeNewGroup({
        name:          'Call',
        owner:         ownAddress.userId,
        ownerDeviceId: signalDeviceId,
        members:       others.map(userId => ({userId, deviceId: 1})),
      });
      const keyConversationId = state.groupId;

      // 2. Store locally BEFORE fan-out (host can derive keys immediately).
      //    File the ad-hoc key under its OWN minted id and under
      //    `direct:<owner>` (= direct:<host>), which is the SAME slot the
      //    receive-side aliases it to (group-create:recv name==='Call'
      //    branch). Host and receivers therefore resolve the identical
      //    slot for this call.
      //
      //    B-10 (do NOT poison the real group): we deliberately do NOT
      //    alias the ad-hoc key over the original `conversationId`. For a
      //    REAL named group whose admin is NOT the caller, that alias used
      //    to OVERWRITE `groups[conversationId].masterKeyB64` AND `owner`
      //    with this throwaway call key — corrupting the persistent group's
      //    master key on the host device (and making every receiver, who
      //    keys real-group calls off `conversationId`, decrypt with the
      //    wrong key → 0 video frames). The call still works because the
      //    cryptor keys off the returned `keyConversationId`, not the real
      //    convo id; the real group's key is left untouched.
      store.setGroupState(state);
      try { useMessengerStore.getState().setGroupState({...state, groupId: `direct:${ownAddress.userId}`}); } catch { /* alias best-effort */ }

      // 3. Distribute via the same sealed Signal fan-out as createGroupChat.
      const cert = await certCache.get();
      const creatorIdentity = await ownStore.getIdentityKeyPair();
      const creatorSignature = await signGroupCreate(creatorIdentity.privKey, state);
      let delivered = 0;
      const failures: string[] = [];
      try {
        await broadcastToGroup({
          group:   state,
          self:    ownAddress,
          cert,
          body:    '',
          admin:   {type: 'create', state, creatorSignature},
          session: own,
          ensureSession: async (peer) => {
            const had = await own.hasSession(peer);
            if (!had) { await ensureOutgoingSession(own, keys, peer, ownStore); }
          },
          deliver: async (peer, ct, clientMsgId) => {
            try {
              const recipientIdKeyB64 = await recipientIdentityKeyB64Cached(ownStore, keys, peer, peerIdentityCache, PEER_IDENTITY_TTL_MS);
              const outerSealed = await wrapOuter({recipientIdentityKeyB64: recipientIdKeyB64, sender: ownAddress, ciphertext: ct, cert});
              try { transport.send({event: 'envelope.send', data: {to: peer, outerSealed, clientMsgId, urgent: false}}); }
              catch { await relay.send({recipient: peer, outerSealed, clientMsgId, urgent: false}); }
              delivered += 1;
            } catch (e) {
              failures.push(`${peer.userId}: ${asErrorMessage(e)}`);
            }
          },
        });
      } catch (e) {
        failures.push(asErrorMessage(e));
      }
      console.log('[call-adhoc-key:runtime] key distributed delivered=', delivered, 'failures=', failures.length, 'keyConvo=', keyConversationId);
      if (delivered === 0) {
        // Nobody got the key → they can't decrypt our media. Fail closed:
        // tear down the just-created local state and refuse.
        try { store.removeGroupState(keyConversationId); store.removeGroupState(conversationId); } catch { /* ignore */ }
        throw new Error(`ensureCallGroupKey: key reached no participants (${failures.join('; ')})`);
      }
      return {keyConversationId};
    },

    markRead: (conversationId: string) => {
      // Collect inbound envelopes that haven't been receipted yet.
      // We group by peer because the WS frame is per-peer; in a 1:1
      // chat there's only one group, but a mission group has many.
      const store = useMessengerStore.getState();
      // B-18 — a 1:1 thread's messages can be split across the synthetic
      // `direct:<peer>` slot and a server-UUID row. ChatScreen merges both
      // for display, so mark-read must cover every slot for the peer or the
      // unread badge sticks on whichever slot the user didn't open.
      const slotIds = directConversationSlots(store, conversationId);
      // Audit P1-T3 — honour the user's "Send read receipts" privacy
      // setting. When off, we still flip the LOCAL bubble status so
      // the user's own UI advances past unread, but we MUST NOT
      // emit the WS frame that would tell the sender about it.
      const emitToSender = getReadReceiptsEnabledCached();
      const byPeer = new Map<string, {peer: SessionAddress; envelopeIds: string[]}>();
      for (const slotId of slotIds) {
        const list = store.messages[slotId] ?? [];
        // M-14 — flip the whole slot in ONE store commit; per-message flips
        // each ran the O(all-messages) write-through diff + one SQL txn.
        const flipIds: string[] = [];
        for (const msg of list) {
          if (msg.sender_id === 'self') {continue;}          // we don't receipt our own messages
          if (msg.status === 'read') {continue;}             // already receipted
          if (!msg.envelope_id) {continue;}                  // no id to reference
          const key = `${msg.peer.userId}.${msg.peer.deviceId}`;
          const slot = byPeer.get(key) ?? {peer: msg.peer, envelopeIds: []};
          slot.envelopeIds.push(msg.envelope_id);
          byPeer.set(key, slot);
          flipIds.push(msg.id);
        }
        if (flipIds.length > 0) {
          store.updateMessageStatusBulk(slotId, flipIds, 'read');
        }
      }
      if (!emitToSender) {return;}
      // Audit MSG-06 — if the socket is down, queue the receipt for the
      // reconnect flush instead of dropping it (the local bubble is already
      // 'read', so it will never be re-collected by a future markRead).
      // Audit P2-7 — also queue when the live emit THROWS (half-open
      // socket), and mirror the queue to AsyncStorage so an app kill while
      // offline doesn't permanently lose the receipts.
      const connected = transport.state === 'connected';
      let queuedAny = false;
      for (const {peer, envelopeIds} of byPeer.values()) {
        let sent = false;
        if (connected) {
          try {
            transport.sendReadReceipt(peer, envelopeIds);
            sent = true;
          } catch { /* half-open socket — queue below */ }
        }
        if (!sent) {
          const key = `${peer.userId}.${peer.deviceId}`;
          const slot = pendingReadReceipts.get(key) ?? {peer, envelopeIds: new Set<string>()};
          for (const id of envelopeIds) { slot.envelopeIds.add(id); }
          pendingReadReceipts.set(key, slot);
          queuedAny = true;
        }
      }
      if (queuedAny) {void persistPendingReadReceipts();}
    },

    pullEnvelopes: async () => {
      // Force-pull the relay queue. ChatScreen calls this on mount and
      // on AppState=active so messages that piled up while the app was
      // frozen show up before the user sees a stale "no messages" view.
      // Fix #4: route through coalescedDrain so a parallel pull from
      // WS-reconnect / AppState-active doesn't fire a third concurrent
      // pull — the inflight Promise is shared.
      try {
        await coalescedDrain();
      } catch (e) {
        // Don't surface as a banner — drain failures are usually
        // transient (brief WS outage). Next AppState active or WS
        // reconnect will retry. Same reasoning as the silent unwrap-
        // fail handling in handleEnvelopeFrame.
        console.warn('[bravo.pullEnvelopes] drain failed:', asErrorMessage(e));
      }
    },

    loadLinkMessages: async (limit = 60, offset = 0) => {
      // Same guards as loadOlderMessages: no SQL store in loopback/failed
      // boot, and never read through a stale post-logout DB handle.
      if (!sqlMessages) {return [];}
      if (!isOurEpoch()) {return [];}
      try {
        return await sqlMessages.loadLinkMessages(limit, offset);
      } catch (e) {
        console.warn('[bravo.links] load failed:', asErrorMessage(e));
        return [];
      }
    },

    loadOlderMessages: async (conversationId: string, limit = 50) => {
      // Round 6 / perf — page older messages from SQLCipher into the
      // store. Boot loads `MAX_HYDRATE_PER_CONVO=200` most-recent rows
      // per chat; this method pulls the next page on scroll-back.
      //
      // No SQL store ⇒ caller is in loopback or the SQLCipher init
      // failed at boot. Either way there's nothing older to load.
      if (!sqlMessages) {return {loaded: 0, exhausted: true};}

      // Round 6 / race fix — bail when our owner epoch is stale. The
      // SQLCipher handle is bound to the previous user's DB; reading
      // through it after logout is at best garbage data on the new
      // user's UI, at worst a "store closed" throw.
      if (!isOurEpoch()) {return {loaded: 0, exhausted: true};}

      const store = useMessengerStore.getState();
      const list = store.messages[conversationId] ?? [];
      // Cursor: the OLDEST row currently in memory. If the conversation
      // has no in-memory rows there's nothing to anchor against — fall
      // back to "no more" rather than dump the whole table.
      if (list.length === 0) {return {loaded: 0, exhausted: true};}
      const oldest = list[0];
      const before = oldest.created_at;
      const beforeId = oldest.id;

      let older: LocalMessage[] = [];
      try {
        older = await sqlMessages.loadOlder(conversationId, before, beforeId, limit);
      } catch (e) {
        console.warn('[bravo.loadOlder] sql failed', conversationId, asErrorMessage(e));
        return {loaded: 0, exhausted: false};
      }

      // Re-check after the await — the user could have signed out
      // mid-read. Don't prepend onto the next user's store.
      if (!isOurEpoch()) {return {loaded: 0, exhausted: true};}

      if (older.length === 0) {return {loaded: 0, exhausted: true};}
      useMessengerStore.getState().prependOlderMessages(conversationId, older);
      // Exhausted iff we got fewer rows than requested (the SQL query
      // is `LIMIT limit`; a partial page means we hit the floor).
      return {loaded: older.length, exhausted: older.length < limit};
    },

    // Audit S7 — caller-identity binding for outgoing `call.offer`. The
    // CallController calls this AFTER createOffer succeeds but BEFORE
    // shipping the offer, so the cert + signature bind the exact frame
    // that goes on the wire. The cert is reused from the same cache the
    // text-send path uses; the signing key is the local Signal identity
    // priv key the cert attests.
    signCallOfferAuth: async ({callId, to, kind}): Promise<CallOfferAuth> => {
      const cert = await certCache.get();
      const ident = await ownStore.getIdentityKeyPair();
      return coreSignCallOfferAuth({
        cert,
        identityPrivKey: ident.privKey,
        callId,
        from: ownAddress,
        to,
        kind,
      });
    },

    // Audit P1-N7 — revoke our currently-cached sender cert on rotation.
    // Best-effort: if the auth-service endpoint isn't deployed yet the
    // call returns `backendMissing: true` and the local cache is still
    // invalidated so subsequent sends mint a fresh cert under the new
    // identity. Never throws — the rotation flow must proceed regardless.
    revokeOwnSenderCert: async (): Promise<{revoked: boolean; backendMissing: boolean}> => {
      try {
        return await certCache.revokeCurrentAndInvalidate();
      } catch {
        return {revoked: false, backendMissing: false};
      }
    },
  };
  return runtimeApi;
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * Map a sealed attachment to the local-row `type` that drives the
 * ChatScreen bubble renderer. Prefers the explicit `kind` hint; falls
 * back to sniffing the declared mime so older senders (no `kind`) still
 * render images/audio/video instead of a generic file bubble.
 */
function attachmentMessageType(
  attachment?: {mimeType?: string; kind?: string} | null,
): 'text' | 'image' | 'audio' | 'video' | 'file' {
  if (!attachment) {return 'text';}
  const k = attachment.kind;
  if (k === 'image' || k === 'audio' || k === 'video') {return k;}
  const mime = (attachment.mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) {return 'image';}
  if (mime.startsWith('audio/')) {return 'audio';}
  if (mime.startsWith('video/')) {return 'video';}
  return 'file';
}

/**
 * Media-parity (2026-07-03) — map the sealed attachment's optional
 * display metadata onto the LocalMessage row (persisted as
 * media_meta_json, schema v13) so bubbles render instant previews with
 * the right aspect ratio, real filenames, and durations. Returns
 * undefined when the sender shipped none, so pre-metadata envelopes
 * cost nothing.
 */
function attachmentMediaMeta(att?: {
  name?:       string;
  width?:      number;
  height?:     number;
  durationMs?: number;
  thumbB64?:   string;
  size?:       number;
} | null): LocalMessage['media_meta'] {
  if (!att) {return undefined;}
  const {name, width, height, durationMs, thumbB64, size} = att;
  if (name === undefined && width === undefined && height === undefined &&
      durationMs === undefined && thumbB64 === undefined && !size) {
    return undefined;
  }
  return {
    ...(name       !== undefined ? {name} : {}),
    ...(width      !== undefined ? {width} : {}),
    ...(height     !== undefined ? {height} : {}),
    ...(durationMs !== undefined ? {durationMs} : {}),
    ...(thumbB64   !== undefined ? {thumbB64} : {}),
    ...(size ? {sizeBytes: size} : {}),
  };
}

async function publishOwnBundle(
  store: CryptoStore,
  keys: KeysHttpClient,
  ownAddress: SessionAddress,
): Promise<{identityRotated?: boolean; previousIdentityKey?: string}> {
  // Audit P0-I1 — the published SPK keyId is the latest stored, NOT a
  // hardcoded `1`. After a rotation `currentSignedPreKeyId` returns the
  // freshly-minted SPK so the upload carries the rotated key. Pre-
  // rotation installs continue to return 1 (the keyId installIdentity
  // wrote), so the upload shape is unchanged for unrotated users.
  const spkKeyId = await currentSignedPreKeyId(store);
  const bundle = await buildOwnPreKeyBundle(store, ownAddress, spkKeyId);
  // Gather the OPK pool we stored locally in installIdentity (keyIds 1..N).
  const opks: {keyId: number; publicKey: string}[] = [];
  for (let i = 1; i <= 50; i++) {
    const pk = await store.loadPreKey(i);
    if (pk) {opks.push({keyId: i, publicKey: toBase64(pk.pubKey)});}
  }
  const res = await keys.uploadBundle({
    registrationId:  bundle.registrationId,
    identityKey:     bundle.identityKey,
    signedPreKey:    bundle.signedPreKey,
    oneTimePreKeys:  opks,
  });
  // BE-2.1: if even after the upload the server says we're low,
  // replenish in background. Covers the edge case where we reinstall
  // and the server already handed out most of our pre-upload keys.
  if (res.poolSize !== null && res.poolSize !== undefined && res.poolSize < 10) {
    void maybeReplenishOwnOpks(store, keys).catch(() => { /* best-effort */ });
  }
  // Handoff §4.5-2 — thread the server-detected rotation out so the boot
  // call site can purge the relay's dead queue (envelopes wrapped to the
  // superseded identity can never decrypt — the priv key died with the
  // old install). Server-driven on purpose: a restore-from-backup
  // republish presents the restored OLD identity ⇒ identityRotated=false
  // ⇒ no purge (those envelopes ARE decryptable).
  return {identityRotated: res.identityRotated, previousIdentityKey: res.previousIdentityKey};
}

async function ensureOutgoingSession(
  own: SessionManager,
  keys: KeysHttpClient,
  peer: SessionAddress,
  ownStore?: CryptoStore,
): Promise<void> {
  if (await own.hasSession(peer)) {return;}
  const {bundle, poolSize} = await keys.fetchPeerBundleWithPoolSize(peer.userId);
  await own.initOutgoingSession({
    ...bundle,
    address: {userId: peer.userId, deviceId: peer.deviceId},
  });
  maybeReplenish(ownStore, keys, poolSize);
}

/**
 * B-46 — send-side mirror of `refreshPeerIdentityIfRotated`: the peer's
 * identity changed (their device destroyed our envelope), so the local
 * trusted identity AND the Double-Ratchet session negotiated under it
 * are both dead. Fetch the authority-signed current bundle, overwrite
 * trust, drop the stale session, and run a fresh X3DH. Same trust model
 * as every first-contact send — keys-service is authoritative and the
 * bundle binding is authority-verified inside the client.
 */
async function forceRefreshOutgoingSession(
  own: SessionManager,
  keys: KeysHttpClient,
  peer: SessionAddress,
  ownStore: CryptoStore,
): Promise<void> {
  const {bundle, poolSize} = await keys.fetchPeerBundleWithPoolSize(peer.userId);
  const addrKey = `${peer.userId}.${peer.deviceId}`;
  await ownStore.saveIdentity(addrKey, fromBase64(bundle.identityKey));
  // BS-IDKEY (send side) — archive the stale session so libsignal
  // rebuilds from the fresh prekey bundle instead of encrypting into
  // the dead ratchet. Best-effort: no session row is a no-op.
  try { await ownStore.removeSession(addrKey); } catch { /* no session row — fine */ }
  await own.initOutgoingSession({
    ...bundle,
    address: {userId: peer.userId, deviceId: peer.deviceId},
  });
  maybeReplenish(ownStore, keys, poolSize);
}

function maybeReplenish(
  ownStore: CryptoStore | undefined,
  keys: KeysHttpClient,
  poolSize: number | null | undefined,
): void {
  // BE-2.1: if the server says OUR peer's pool is low, we don't
  // replenish for them — but the same header is also set on OUR bundle
  // uploads. The caller triggers a self-refill via maybeReplenishOwnOpks
  // on upload response. This branch is reserved for future reciprocal
  // refill logic; keep the wire-up so `poolSize` is not lost.
  if (ownStore && poolSize !== null && poolSize !== undefined && poolSize < 10) {
    void maybeReplenishOwnOpks(ownStore, keys).catch(() => { /* best-effort */ });
  }
}

/**
 * Recover the recipient's identity public key (base64) for the outer
 * ECIES wrap. The Signal session-init path stores the peer identity
 * in our trusted-identities table under `${userId}.${deviceId}`. If
 * for some reason it's missing (e.g. legacy session imported without
 * a fresh handshake), fall back to refetching the bundle so the wrap
 * never proceeds against an unknown key.
 */
async function recipientIdentityKeyB64(
  ownStore: CryptoStore,
  keys: KeysHttpClient,
  peer: SessionAddress,
): Promise<string> {
  // Always fetch from auth-service — the previous version returned the
  // libsignal-cached identity if present, which never refreshed when the
  // peer rotated keys (clear-data + reinstall). Outer ECIES wraps with
  // a stale identity → recipient can't decrypt with their new private
  // key → "envelope unwrap failed: outer sealed authentication failed".
  // The libsignal cache only updates on receiving a PreKeyWhisperMessage
  // from the peer, which is a chicken-and-egg loop after rotation.
  //
  // Strategy: trust the server as the source of truth (it stores the
  // most recent uploaded identity). On a successful fetch, fall through
  // to update libsignal's cache too so subsequent decrypts trust the
  // same key without an extra round-trip. Falls back to the cache only
  // if the network request fails — better stale than no message at all.
  try {
    const {bundle} = await keys.fetchPeerBundleWithPoolSize(peer.userId);
    return bundle.identityKey;
  } catch {
    const cached = await ownStore.loadIdentityKey(`${peer.userId}.${peer.deviceId}`);
    if (cached) {return toBase64(cached);}
    throw new Error('peer identity unavailable: server unreachable and no local cache');
  }
}

/**
 * Fix #11: cached version of `recipientIdentityKeyB64`. Every call to
 * the bare version pops one of the peer's one-time pre-keys (the
 * server's GET /auth/keys/:userId is destructive on OPK pool by
 * design — that's how X3DH works). Sending 50 messages to a peer
 * exhausted all 50 pre-uploaded OPKs in one chat session, after
 * which any new sender's X3DH stalled until that peer came back
 * online to refill.
 *
 * Identity keys rotate only on reinstall, which we already detect
 * via DecryptError → caller invalidates this cache there. 8 minutes
 * is a comfortable balance: short enough that a fresh reinstall self-
 * heals on the next inbound, long enough to coalesce a typical chat
 * session into one fetch.
 */
async function recipientIdentityKeyB64Cached(
  ownStore: CryptoStore,
  keys: KeysHttpClient,
  peer: SessionAddress,
  cache: Map<string, {idKey: string; fetchedAt: number}>,
  ttlMs: number,
): Promise<string> {
  const key = `${peer.userId}.${peer.deviceId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < ttlMs) {
    return hit.idKey;
  }
  const idKey = await recipientIdentityKeyB64(ownStore, keys, peer);
  cache.set(key, {idKey, fetchedAt: Date.now()});
  return idKey;
}

/**
 * BE-2.1: top up our own one-time pre-key pool when the server
 * reports it's running low. Idempotent — server ignores duplicate
 * keyIds. Runs in background; caller never awaits.
 */
async function maybeReplenishOwnOpks(
  store: CryptoStore,
  keys: KeysHttpClient,
): Promise<void> {
  const REFILL_COUNT = 50;
  // A6 opk-refill-overwrites-live-prekeys — fill from ABOVE the highest
  // occupied keyId, never the first gap. OPKs are POPPED on use, leaving holes
  // in the low range while higher keyIds stay live; the old "first empty slot"
  // probe stopped at the first hole and then filled 50 contiguous ids straight
  // over those still-live higher keyIds, overwriting their private halves while
  // the server kept serving the old publics — so a cold-contact sender who had
  // popped one of them got a PreKeyWhisperMessage that failed X3DH (Bad MAC),
  // losing that contact's first message. The store exposes only loadPreKey, so
  // scan upward tracking the highest id that still exists; stop once we've seen
  // REFILL_COUNT consecutive empties — that confirmed-empty run IS where we
  // fill, so the fill range can never overlap an occupied (live) slot.
  let maxId = 0;
  let consecutiveEmpty = 0;
  let probe = 1;
  while (consecutiveEmpty < REFILL_COUNT) {
    if (await store.loadPreKey(probe)) {
      maxId = probe;
      consecutiveEmpty = 0;
    } else {
      consecutiveEmpty += 1;
    }
    probe += 1;
    if (probe > 1_000_000) {return;} // Defensive — runaway scan.
  }
  const nextId = maxId + 1;
  const fresh: {keyId: number; publicKey: string}[] = [];
  for (let i = 0; i < REFILL_COUNT; i++) {
    const pk = await KeyHelper.generatePreKey(nextId + i);
    await store.storePreKey(pk.keyId, pk.keyPair);
    fresh.push({keyId: pk.keyId, publicKey: toBase64(pk.keyPair.pubKey)});
  }
  const identity  = await store.getIdentityKeyPair();
  const regId     = await store.getLocalRegistrationId();
  // Audit P0-I1 — load the CURRENT signed pre-key, not a hardcoded `1`.
  // After a rotation the stored SPK lives under a higher keyId; the
  // legacy load would silently miss it and fail with "no signature."
  const spkKeyId  = await currentSignedPreKeyId(store);
  const signedSpk = await store.loadSignedPreKey(spkKeyId);
  if (!signedSpk?.signature) {return;}
  await keys.uploadBundle({
    registrationId: regId,
    identityKey:    toBase64(identity.pubKey),
    signedPreKey: {
      keyId:     spkKeyId,
      publicKey: toBase64(signedSpk.pubKey),
      signature: toBase64(signedSpk.signature),
    },
    oneTimePreKeys: fresh,
  });

  // Round 8 — re-mirror the identity backup so the freshly-generated
  // OPK private halves reach the user's encrypted backup. Previously
  // the identity bundle was uploaded ONCE at setup; every subsequent
  // OPK refill (every ~50 sent messages) widened the gap between
  // server-side OPK pool and the privates the user could recover from
  // backup. Result: peers using a post-setup OPK could not be
  // decrypted after restore.
  //
  // Best-effort: if the mirror isn't unlocked, skip silently — the
  // next setupBackup / restoreBackup will overwrite with a current
  // snapshot. Wrapped in a try so a failed re-mirror cannot propagate
  // back into the keys.uploadBundle path.
  try {
    const {refreshIdentityBackup} = require('../backup/identityBackup') as
      typeof import('../backup/identityBackup');
    await refreshIdentityBackup(store);
  } catch (e) {
    // Mirror not loaded, key not unlocked, or network blip — none of
    // these are fatal. The next refresh attempt will succeed.
    console.warn('[bravo.opk] identity-backup refresh skipped:', (e as Error).message);
  }
}

interface FrameDeps {
  own:                    SessionManager;
  ownStore:               CryptoStore;
  pendingByClientMsgId:   Map<string, {
    conversationId: string;
    messageId:      string;
    ackTimer?:      ReturnType<typeof setTimeout>;
    // Bug-hunt #2 — `handleAccepted` reads `entry.peer.userId` to
    // route the durable-outbox `markDelivered` call to the right
    // composite-key row. The runtime-side construction site (line
    // ~377) already populates this, but the type declaration was
    // missing the field, so any future construction site would
    // compile cleanly and NPE at runtime. Pinning here.
    peer:           SessionAddress;
  }>;
  config:                 ProductionConfig;
  relay:                  RelayHttpClient;
  keys:                   KeysHttpClient;
  /** Per-runtime peer identity-key cache — see Fix #11. */
  peerIdentityCache?:     Map<string, {idKey: string; fetchedAt: number}>;
  /** Send a 'control: rehandshake' nudge — see sendRehandshakeNudge. */
  rehandshakeNudge:       (peer: SessionAddress) => Promise<void>;
  /**
   * B-46 — sender-side auto-resend when the recipient destroyed our
   * envelope (`envelope.undeliverable`). Optional: the archive-replay
   * dispatcher and loopback runtime don't wire it.
   */
  resendUndeliverable?:   (envelopeId: string) => void;
  /**
   * Pong observer — the AppState gating in Fix #7 needs the most
   * recent pong wall-clock to decide whether the socket is healthy
   * enough to skip the force-reconnect on resume.
   */
  onPong?:                (ts: number) => void;
  /**
   * Durable outbox — handleAccepted deletes the row when the relay
   * confirms acceptance. Optional because the loopback runtime (tests)
   * has no SQLCipher DB.
   */
  outbox?:                SqlOutboxStore | null;
  /**
   * Audit P0-N14 — atomic ratchet+plaintext receive.
   * Sharing the SQLCipher handle lets handleIncoming wrap libsignal's
   * session UPSERT and our plaintext UPSERT in a single BEGIN/COMMIT.
   * Both null on the loopback runtime (in-memory store, no SQLite).
   */
  txnDb?:                 TxnDbHandle | null;
  sqlMessages?:           SqlMessageStore | null;
  /**
   * Audit P0-N6 — persistent receive-side envelope-id dedup. Lives in
   * the same SQLCipher DB as sessions/messages so the markSeen INSERT
   * runs INSIDE the receive transaction. Null on the loopback runtime.
   */
  seenEnvelopes?:         SeenEnvelopeStore | null;
  /**
   * Audit 1:1 P1-1 — sender-cert revocation cache. When fresh, the set
   * is passed to `verifySenderCert` so a revoked jti hard-rejects.
   * When stale (poll has failed for > REVOCATION_FRESHNESS_MS) the
   * receive proceeds without consulting the set — better to accept a
   * possibly-revoked cert than to let an attacker disable revocation
   * enforcement by DoS'ing the revocation-list endpoint. Optional
   * because the loopback runtime + tests don't poll auth-service.
   */
  revokedJtiCache?:       RevokedJtiCache | null;
  /**
   * Bug-hunt #3 — durable stash for group envelopes that arrived
   * before we held the master key for their group (admin create or
   * rekey still in flight). The stash row writes INSIDE the receive
   * txn so the stash, the seen_envelopes row, and the relay ack
   * commit atomically. Null on the loopback runtime.
   */
  pendingGroupEnvelopes?: PendingGroupEnvelopeStore | null;
  /**
   * Bug-hunt #5 follow-through — durable stash for admin actions
   * that arrived out-of-epoch order. Drained on every admin commit
   * that advances local state.
   */
  pendingAdminActions?:   PendingAdminActionStore | null;
}

async function handleServerFrame(frame: ServerFrame, deps: FrameDeps): Promise<void> {
  // Call signalling: route call.offer / call.answer / call.ice /
  // call.hangup to the dispatcher first. If a registered signalling
  // claims the frame we're done; otherwise fall through to the
  // envelope/typing branches below so non-call frames still flow.

  const {dispatchCallFrame} = require('../webrtc/callDispatcher') as typeof import('../webrtc/callDispatcher');
  // Single source of truth for "which frames belong to the call
  // dispatcher" — see callFrameRouter.ts. Adding a new call.* event
  // requires updating that file AND adding a `case` in callDispatcher.
  if (isCallFrame((frame as {event: string}).event)) {
    dispatchCallFrame(frame);
    return;
  }
  // SFU group-call frames — sfu.new-producer / sfu.participant.* —
  // are not in the typed ServerFrame union (they're per-room and
  // dynamic). Route them through sfuDispatcher so the active
  // useGroupCall hook for this room receives them.

  const {dispatchSfuFrame, recordSfuObservedTag, SFU_FRAME_EVENTS} = require('../webrtc/sfuDispatcher') as typeof import('../webrtc/sfuDispatcher');
  if (SFU_FRAME_EVENTS.has((frame as {event: string}).event)) {
    // Audit P0-C3 — feed the per-room observed-tag set from the
    // authoritative SFU broadcasts BEFORE dispatching to the hook.
    // recordGroupCallIdentity rejects any sealed groupCallPresence
    // envelope whose participantTag the SFU has not announced for this
    // room, so a removed/non-member peer can no longer relabel a
    // legitimate member's tile. Runs here because the runtime sees every
    // SFU frame regardless of which useGroupCall handler (full or the
    // reduced restore-path one) is mounted.
    recordSfuObservedTag(frame as never);
    dispatchSfuFrame(frame as never);
    return;
  }
  // Group-call RING frames are global (recipient hasn't joined any room
  // yet, so sfuDispatcher's roomId routing wouldn't fire). Routed here
  // to the global ring handler installed by the navigation root.
  // sfu.muted / sfu.kicked are NOT global — they target a specific
  // already-joined room, so they fall through SFU_FRAME_EVENTS above.

  const {dispatchGroupRingFrame, GROUP_RING_FRAME_EVENTS} =
    require('../webrtc/groupCallRingDispatcher') as typeof import('../webrtc/groupCallRingDispatcher');
  if (GROUP_RING_FRAME_EVENTS.has((frame as {event: string}).event)) {
    dispatchGroupRingFrame(frame as never);
    return;
  }
  // Finding #8(a) / P2-BR-9 — a group call we were offline for. The server
  // now fans `sfu.ring.missed` on reconnect (analogue to the 1:1
  // `call.missed`); record a "Missed group call" bubble so the Calls log +
  // chat thread show it (WhatsApp parity). Stable id keyed by roomId keeps
  // appendMessage's dedup idempotent across a reconnect replay of the same
  // missed marker.
  if ((frame as {event: string}).event === 'sfu.ring.missed') {
    const d = (frame as {data?: {
      roomId?: string; conversationId?: string;
      callType?: 'voice' | 'video'; from?: {userId?: string; deviceId?: number}; at?: number;
    }}).data;
    if (d?.roomId && d.conversationId) {
      try {
        const {appendMissedGroupCallBubble} = require('../webrtc/useGroupCall') as typeof import('../webrtc/useGroupCall');
        appendMissedGroupCallBubble({
          conversationId: d.conversationId,
          callType:       d.callType === 'video' ? 'video' : 'voice',
          stableId:       `missed-group-${d.roomId}`,
          at:             d.at,
        });
      } catch { /* store / hook module unavailable (tests / early boot) */ }
    }
    return;
  }
  switch (frame.event) {
    case 'pong': {
      // Compute WebSocket round-trip from the timestamp we stamped on
      // the corresponding ping. Publishes into the rttRegistry so the
      // network-latency chip + any other subscribers can paint.
      const ts = frame.data?.ts;
      if (typeof ts === 'number') {

        const {publishRtt} = require('./rttRegistry') as typeof import('./rttRegistry');
        publishRtt(Math.max(0, Date.now() - ts));
      }
      // Fix #7: feed the AppState-resume gating with the most recent
      // pong wall-clock so foreground transitions can skip force-
      // reconnect when the socket is genuinely live.
      deps.onPong?.(Date.now());
      return;
    }
    case 'envelope.accepted':
      return handleAccepted(frame, deps);
    case 'envelope.deliver':
      return handleDeliver(frame, deps);
    case 'envelope.delivered':
      applyEnvelopeDelivered(frame.data.envelopeId);
      return;
    case 'envelope.undeliverable':
      // Handoff §3.6(c) — the recipient acked with disposition
      // 'discarded' (decrypt failure destroyed the message). Flip the
      // bubble to `undelivered` instead of lying with ✓✓.
      applyEnvelopeUndeliverable(frame.data.envelopeId);
      // B-46 — we still hold the plaintext; try ONE automatic re-send
      // against the recipient's CURRENT identity (fresh bundle + X3DH).
      // Recovers messages destroyed by recipient identity churn
      // (reinstall / cleared data / failed restore) without user action.
      deps.resendUndeliverable?.(frame.data.envelopeId);
      return;
    case 'read-receipt': {
      // Peer reports they've read a set of our envelopes. Flip the
      // matching local messages to `read` so the chat shows the
      // double-tick. Match by envelope_id (set on outbound msg via
      // envelope.accepted's response). Best-effort — if we don't
      // recognise an id, the user already cleared that thread.
      //
      // Audit P0-E1 — ownership guard. Two cross-checks before flipping:
      //  (1) `msg.sender_id === 'self'` so a peer can't mark THEIR OWN
      //      message read on our behalf (would otherwise let Eve flip
      //      a message Bob sent us to "read" by guessing the envelope id).
      //  (2) `msg.peer.userId === frame.data.from.userId` so a peer can
      //      only receipt envelopes that travelled through THIS thread —
      //      Eve cannot guess a Bob↔Alice envelope id and confirm its
      //      existence on Alice's device by spoofing a read-receipt
      //      from her own thread.
      // The gateway stamps `from` from the authenticated socket context,
      // so the chain is authenticated end-to-end.
      const store = useMessengerStore.getState();
      const ids = new Set(frame.data.envelopeIds);
      const receipterUid = frame.data.from?.userId;
      if (!receipterUid) {return;}
      // BS-RR1 — ownership guard: the receipter must belong to the thread
      // the message lives in. For a direct chat that's the stored peer;
      // for a group, validate against the participant list (every outbound
      // group row stores peer = participants[0], so the old single-peer
      // match only ever accepted the first member's receipt). See
      // readReceiptAccepted for the full rationale.
      const {readReceiptAccepted} =
        require('./messagingLogic') as typeof import('./messagingLogic');
      for (const [conversationId, list] of Object.entries(store.messages)) {
        // M-14 — batch all flips for this conversation into one commit.
        const flipIds: string[] = [];
        for (const msg of list) {
          if (!msg.envelope_id || !ids.has(msg.envelope_id)) {continue;}
          if (msg.status === 'read') {continue;}
          if (msg.sender_id !== 'self') {continue;}
          if (!readReceiptAccepted({
            state:             store,
            conversationId,
            receipterUid,
            messagePeerUserId: msg.peer?.userId,
          })) {continue;}
          flipIds.push(msg.id);
        }
        if (flipIds.length > 0) {
          store.updateMessageStatusBulk(conversationId, flipIds, 'read');
        }
      }
      return;
    }
    case 'typing': {
      // Server forwards typing frames per signal-device; we treat "any
      // device of the peer is typing" as "the conversation is typing".
      // Typing frames carry only `from` (peer address) — no conversation
      // id — so for 1:1 we map to `direct:<peerUserId>` and for groups
      // we set the typing flag on every group whose participants include
      // this sender. Without the fan-out the mission-group ChatScreen
      // would never light up because its conversation id is the group
      // UUID, not the synthetic `direct:` key.
      const store = useMessengerStore.getState();
      const senderUid = frame.data.from.userId;
      const isTyping  = frame.data.state === 'start';
      const syntheticId = convoIdFor(frame.data.from);
      // BS-TY1 — also resolve the CANONICAL direct conversation id. Once
      // /conversations/mine sync mints a server-UUID row for a 1:1, the
      // open ChatScreen is keyed by that UUID — but typing frames carry
      // only `from`, so without resolving to the canonical id the
      // indicator was set on `direct:<peer>` and the UUID-keyed screen
      // never lit up. The message receive path already routes through
      // this resolver; the typing path must too.
      const {resolveDirectConversationIdFromState: resolveDirect} =
        require('../store/messengerStore') as typeof import('../store/messengerStore');
      const canonicalId = resolveDirect(store, senderUid);

      // Collect every conversation id this typing frame affects: the
      // synthetic direct key, the canonical direct id, and any group the
      // sender is a participant of (server-authoritative list).
      const {typingAffectedConversationIds} =
        require('./messagingLogic') as typeof import('./messagingLogic');
      const affected = typingAffectedConversationIds(store, senderUid, syntheticId, canonicalId);
      for (const convId of affected) {
        store.setTyping(convId, isTyping);
        // BS-TY2 — arm a watchdog on `start`, clear it on `stop`, so a
        // dropped `stop` frame can't strand the bubble "typing…" forever.
        if (isTyping) {
          typingWatchdog.arm(convId, () => {
            try { useMessengerStore.getState().setTyping(convId, false); } catch { /* store gone */ }
          });
        } else {
          typingWatchdog.clear(convId);
        }
      }
      return;
    }
    case 'presence': {
      // Presence frames arrive both as unsolicited broadcasts (state
      // changes from watched users) and as snapshot emits right after
      // presence.subscribe. Either way we mirror the FULL state into
      // the store so the UI can distinguish `active` (green +
      // "Active now") vs `online` (green) vs `away` (amber). Round 7
      // presence audit fix #7 — previously we collapsed to a boolean
      // and `away` peers showed up as Online.
      useMessengerStore.getState().setPresence(
        frame.data.userId,
        frame.data.state,
        frame.data.lastSeenMs,
      );
      return;
    }
    case 'error': {
      // 'superseded' is benign — fired when a newer socket from the same
      // user/device replaces this one (common during remounts/reconnects).
      // Don't surface it to the UI; the new socket continues to work fine.
      if (frame.data.code === 'superseded') {return;}
      const code = frame.data.code;
      const msg  = `${code}: ${frame.data.message}`;
      useMessengerStore.getState().setError(msg);
      // Call-related errors (peer_offline / busy / declined) are
      // transient — the gateway already queues offline-callee offers
      // and fires a VoIP push, so the call WILL ring once the callee
      // comes back online. Showing a sticky red banner in the chat is
      // misleading. Auto-clear after a few seconds so it acts like a
      // brief toast notice, not a persistent error. Don't clobber a
      // newer error that may have arrived in the meantime — match on
      // the exact prefix.
      if (code === 'peer_offline' || code === 'busy' || code === 'declined') {
        setTimeout(() => {
          const store = useMessengerStore.getState();
          if (store.error?.startsWith(code + ':')) {
            store.setError(null);
          }
        }, 3500);
      }
      return;
    }
  }
}

/**
 * Audit MEDIUM-2 (2026-07-02): per-group set of master keys that a same-epoch
 * owner-signed HEAL (G-04) has already SUPERSEDED. Enables a rollback guard:
 * because the G-04 heal accepts any owner-signed same-epoch create with a
 * different key, a malicious member could relay (via G-05) an OLDER captured
 * owner-create to roll a peer back to a key that was already replaced — there
 * is no ordering tiebreaker in the signed create bytes. A key here has been
 * provably retired at its epoch; re-installing it is always a downgrade, so we
 * refuse. Memory-only (per session): the precondition is a same-identity
 * same-epoch fork, and after a restart the group re-converges via self-heal,
 * so a persistent store is not warranted. Bounded per group.
 */
const supersededGroupKeys = new Map<string, Set<string>>();
const SUPERSEDED_KEYS_CAP = 32;
function markGroupKeySuperseded(groupId: string, keyB64: string): void {
  let s = supersededGroupKeys.get(groupId);
  if (!s) { s = new Set(); supersededGroupKeys.set(groupId, s); }
  s.add(keyB64);
  // Bound: drop the oldest insertion if we exceed the cap.
  if (s.size > SUPERSEDED_KEYS_CAP) {
    const first = s.values().next().value;
    if (first !== undefined) { s.delete(first); }
  }
}
function isGroupKeySuperseded(groupId: string, keyB64: string): boolean {
  return supersededGroupKeys.get(groupId)?.has(keyB64) === true;
}

function handleAccepted(frame: ServerEnvelopeAccepted, deps: FrameDeps): void {
  const entry = deps.pendingByClientMsgId.get(frame.data.clientMsgId);
  if (!entry) {return;}
  // Fix #3: cancel the WS-ack watchdog so it doesn't fire AFTER the
  // server accepted — without this clear, a 5s-late watchdog ran
  // forceReconnect + httpFallback against an envelope that was
  // already 'sent', triggering a duplicate POST /envelopes.
  if (entry.ackTimer) { clearTimeout(entry.ackTimer); }
  const store = useMessengerStore.getState();
  store.updateMessageStatus(entry.conversationId, entry.messageId, 'sent');
  store.updateMessageEnvelopeId(entry.conversationId, entry.messageId, frame.data.envelopeId);
  if (frame.data.retractToken) {
    store.updateMessageRetractToken(entry.conversationId, entry.messageId, frame.data.retractToken);
  }
  deps.pendingByClientMsgId.delete(frame.data.clientMsgId);
  // Durable outbox — relay confirmed via WS; drop the row so the next
  // connect-drain doesn't replay it. Audit P0-N4: composite key resolves
  // to a single 1:1 row (the WS path never carries group sends).
  if (deps.outbox) {
    deps.outbox.markDelivered(frame.data.clientMsgId, entry.peer.userId, entry.peer.deviceId).catch(e =>
      console.warn('[messenger.outbox] markDelivered (WS path) failed:', asErrorMessage(e)));
  }
}

// L16 Envelope-dedup-TOCTOU — envelopes currently being decrypted. wasSeen()
// only reflects markSeen, which commits at the END of the receive txn, so two
// concurrent deliveries of the SAME envelope (relay re-push on reconnect racing
// a drainRelay catch-up, or two rapid reconnects) both pass the wasSeen gate
// and feed the SAME ciphertext to libsignal — one wins the ratchet, the other
// throws bad-MAC and shows a spurious 'message failed to decrypt' banner. This
// in-flight set drops the concurrent duplicate; the persistent wasSeen() store
// still handles the SEQUENTIAL re-delivery case.
const inFlightEnvelopes = new Set<string>();
async function handleDeliver(frame: ServerEnvelopeDeliver, deps: FrameDeps): Promise<void> {
  const envId = frame.data.envelopeId;
  if (inFlightEnvelopes.has(envId)) {
    // A concurrent pass already owns this envelope; it will ack + render (or
    // leave it for the relay to re-push on failure). Dropping here avoids the
    // double-decrypt that burns the ratchet message-key twice.
    return;
  }
  inFlightEnvelopes.add(envId);
  try {
    await handleDeliverInner(frame, deps);
  } finally {
    inFlightEnvelopes.delete(envId);
  }
}
async function handleDeliverInner(frame: ServerEnvelopeDeliver, deps: FrameDeps): Promise<void> {
  // Audit P0-N6 — persistent receive-side dedup. The relay re-pushes
  // every pending envelope on every reconnect (flushPendingOnConnect),
  // and acks can be lost across socket drops or app crashes. Without
  // this gate, the SAME ciphertext would be fed to libsignal a second
  // time on the next connect; the ratchet has already burned the
  // message key, so the retry throws "bad MAC" and corrupts the
  // session. Check BEFORE unwrap/decrypt so we don't waste a cert/AAD
  // verify (and don't touch the ratchet at all).
  // Why: previously a throw from wasSeen() (SQLCipher not yet open on
  // fresh-install race, schema migration in progress, native bridge
  // intermittent failure) would propagate to the outer handleServerFrame
  // catch WITHOUT ever firing the ack. The relay would then re-deliver
  // the same envelope on every reconnect and the user's UI would never
  // render it (because handleIncoming also never ran). Wrap in try/catch
  // so a dedup-store hiccup degrades to "process the envelope normally"
  // — the worst case is a duplicate decrypt attempt, which downstream
  // libsignal already protects against via the message-key dedup.
  let alreadySeen = false;
  if (deps.seenEnvelopes) {
    try {
      alreadySeen = await deps.seenEnvelopes.wasSeen(frame.data.envelopeId);
    } catch (e) {
      crashLog(`[messenger] seenEnvelopes.wasSeen threw env=${(frame.data?.envelopeId ?? '?').slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
      // Continue — better to re-decrypt than to silently strand the envelope.
    }
  }
  if (alreadySeen) {
    // Re-ack so the relay drops the row from its pending list.
    // Audit P0-N9 — pass the freshly-delivered ackToken so the relay
    // accepts the dedup re-ack even after strict mode flips.
    // Disposition 'delivered': seen ⇒ a prior receive txn committed
    // (rendered or durably stashed) — the device genuinely has it.
    try { await deps.relay.ack(frame.data.envelopeId, frame.data.ackToken, 'delivered'); } catch { /* non-fatal */ }
    return;
  }
  // Sealed Sender v2: the sender's address travels INSIDE the outer
  // ECIES wrap, AES-GCM-bound to our own identity key. The relay no
  // longer carries any sender hint on the wire.
  let unwrapped;
  try {
    const ownIdentity = await deps.ownStore.getIdentityKeyPair();
    unwrapped = await unwrapOuter({
      ownIdentityPrivKey: ownIdentity.privKey,
      ownIdentityPubKey:  ownIdentity.pubKey,
      outerSealedB64:     frame.data.outerSealed,
    });
  } catch (e) {
    // ONE bad envelope must not flash a global red banner — that surfaces
    // every time the relay redelivers a stale undecryptable row (e.g.
    // envelopes from a peer's previous identity, or queued messages from
    // before a key rotation). Log + ACK so the relay stops redelivering;
    // the user already sees the messages they CAN decrypt.
    // Diagnostic breadcrumb — silent-failure visibility for the
    // "I sent a message, peer never saw it" report. The console.warn
    // below only lands in dev/debug; production phones strip it. Wire
    // through Crashlytics so we can correlate with the user reports.
    crashLog(`[messenger] unwrap-failed envId=${frame.data.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
    crashRecord(e instanceof Error ? e : new Error(String(e)), {
      area: 'messenger.unwrap', envelopeId: frame.data.envelopeId.slice(0, 8),
    });
    console.warn('[messenger] envelope unwrap failed (will ack to drop):', asErrorMessage(e));
    // Fix #5 — count toward the "missing-ratchet" telemetry so the
    // restore summary can show how many messages were unrecoverable.
    try {
      const {noteUndecryptable} = require('../backup/sessionRatchetRecovery') as
        typeof import('../backup/sessionRatchetRecovery');
      noteUndecryptable(`deliver-unwrap:${asErrorMessage(e).slice(0, 40)}`);
    } catch { /* fine */ }
    // B-46 — sealed sender means the sender is unknowable here, so no
    // per-conversation placeholder is possible. Count the destruction
    // so MessengerHome can surface "N messages couldn't be decrypted"
    // instead of pure silence.
    try { useMessengerStore.getState().noteUndecryptableDrop(frame.data.envelopeId); } catch { /* store mid-swap — fine */ }
    // 'discarded' — outer unwrap failed; the message is destroyed and the
    // sender is unknown (inside the broken wrap), so no placeholder.
    try { await deps.relay.ack(frame.data.envelopeId, frame.data.ackToken, 'discarded'); } catch { /* non-fatal */ }
    return;
  }

  // Audit P0-1 — pre-decrypt cert verify for v3 wraps. The outer GCM tag
  // has already proved the cert bytes in the wire match the cert the
  // sender used to derive the AAD; here we additionally verify the
  // authority signature, expiry, and (when available) identity-key
  // continuity. If verification fails we DROP the envelope WITHOUT
  // calling own.decrypt — the legacy DecryptError → closeSession path
  // can no longer be coerced by a forged outer envelope.
  //
  // For v2 wraps (no cert in AAD) we fall through to the legacy flow;
  // the cert is still verified inside doHandleIncoming AFTER own.decrypt
  // (existing behaviour). v2 still has the P0-1 attack surface that the
  // sessionWipeProtection band-aid mitigates; v3 closes it at the root.
  let trustedPeer = unwrapped.sender;
  if (unwrapped.wireVersion === 3 && unwrapped.senderCert) {
    try {
      // Audit P0-8 — resolve the expected identity from the local trust
      // row when present, or from the authority-signed peer bundle on
      // cold contact. P0-I2 guarantees the bundle's identityKey is
      // authority-attested, so we can use it as a continuity anchor
      // instead of letting a cold-contact cert verify run unchecked.
      // Returns undefined only when BOTH paths fail (transient outage);
      // in that case the cert is still verified for signature + expiry
      // + revocation but continuity is skipped — matches the prior
      // behaviour for availability under a keys-service blip.
      const expectedIdentityKey = await resolveExpectedSenderIdentity(
        unwrapped.sender, deps.ownStore, deps.keys, deps.peerIdentityCache,
      );
      const claims = await verifySenderCert({
        cert:                unwrapped.senderCert,
        authorityPubKeyB64:  deps.config.authorityPubKeyB64,
        expectedIdentityKey,
        // Audit 1:1 P1-1 — consult the revocation list cache when fresh.
        // A stale cache (poll has failed for > REVOCATION_FRESHNESS_MS)
        // is intentionally NOT passed: better to accept a possibly-
        // revoked cert than to let a deliberate revocation-list DoS
        // disable cert verification altogether. The cache fail-opens
        // by design; verify mirrors that posture here.
        revokedJtis: deps.revokedJtiCache?.isFresh() ? deps.revokedJtiCache.snapshot() : undefined,
      });
      // Trusted peer comes from authority-attested claims, NOT the
      // inner `sender` field which is forgeable on v3 too (it's kept
      // only for v2 receivers' back-compat decode path).
      trustedPeer = {
        userId:   claims.senderUserId,
        deviceId: claims.senderSignalDeviceId,
      };
    } catch (e) {
      // BS-CERT-MISMATCH fix: the original code did `throw e` here for
      // IdentityKeyMismatchError, intending to reach the
      // refresh-and-retry handler in the sequential try/catch below.
      // That never worked: a throw in one catch block is NOT caught by a
      // subsequent try/catch at the same level — it exits handleDeliver
      // entirely, so the refresh never ran and the envelope was never
      // ACKed, causing the relay to redeliver it forever and producing
      // the "[messenger.dispatchFrame] err=sender identity key mismatch"
      // loop the user sees. Fix: run the refresh inline here so it
      // actually executes, then ACK-drop so the drain can proceed.
      if (e instanceof IdentityKeyMismatchError && deps.keys) {
        const {refreshPeerIdentityIfRotated} = require('../crypto/peerIdentityRefresh') as
          typeof import('../crypto/peerIdentityRefresh');
        const outcome = await refreshPeerIdentityIfRotated(
          e.claims.senderUserId,
          e.claims.senderSignalDeviceId,
          e.claims.senderIdentityKey,
          deps.keys,
          deps.ownStore,
        );
        crashLog(`[messenger] ws-cert-pre-verify-rotation env=${frame.data.envelopeId.slice(0, 8)} outcome=${outcome.result} reason=${outcome.reason ?? '-'}`);
        // TOFU send-gate — record the unacknowledged identity change (harmless
        // when the gate flag is off; sendText only blocks on it when enabled).
        if (outcome.result === 'refreshed' && outcome.sessionReset) { void notePeerIdentityChanged(e.claims.senderUserId); }
        if (outcome.result === 'refreshed') {
          try {deps.peerIdentityCache?.delete(`${e.claims.senderUserId}.${e.claims.senderSignalDeviceId}`);} catch { /* ignore */ }
          if (outcome.sessionReset) {
            try { useMessengerStore.getState().setError('A contact’s security code changed — their messages will resume on a new secure session.'); } catch { /* ignore */ }
          }
          // Now that trust is refreshed, set trustedPeer from the
          // mismatch claims (authority-attested) and fall through to
          // handleIncoming for a single retry.
          trustedPeer = {userId: e.claims.senderUserId, deviceId: e.claims.senderSignalDeviceId};
        } else if (outcome.result === 'unavailable') {
          // Keys-service blip — leave on relay for a future drain by
          // returning without ACKing. leaveOnRelay is declared after this
          // block so we return directly instead.
          return;
        } else {
          // stale-cert / no-change — ACK-drop, cannot recover.
          crashLog(`[messenger] ws-cert-pre-verify-mismatch dropped env=${frame.data.envelopeId.slice(0, 8)} reason=${outcome.reason ?? '?'}`);
          try { await deps.relay.ack(frame.data.envelopeId, frame.data.ackToken, 'discarded'); } catch { /* non-fatal */ }
          return;
        }
        // If refreshed: trustedPeer is now set; fall through to handleIncoming.
      } else {
        crashLog(`[P0-1] v3 cert pre-verify failed envId=${frame.data.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
        try { await deps.relay.ack(frame.data.envelopeId, frame.data.ackToken, 'discarded'); } catch { /* non-fatal */ }
        return;
      }
    }
  }

  // Audit 1:1 P1-4 — wrap handleIncoming so any non-rotation throw
  // ACK-drops the envelope. Previously a thrown error escaped to the
  // outer onFrame .catch, the ACK never ran, and the relay redelivered
  // the same broken envelope on every subsequent pull/reconnect — a
  // permanent loop visible only as the global recovery banner cycling.
  //
  // Audit 1:1 P1-5 — also handle `IdentityKeyMismatchError` here (was
  // wired only into `drainRelay`): refetch the keys bundle, save the
  // current identity, retry once. On `unavailable` (keys-service blip)
  // we leave the envelope on the relay so a future drain can retry.
  let handledOk = false;
  let leaveOnRelay = false;
  try {
    await handleIncoming(
      deps.own, deps.ownStore, trustedPeer, unwrapped.ciphertext,
      deps.config, frame.data.envelopeId, deps.keys, deps.rehandshakeNudge,
      deps.peerIdentityCache,
      // Audit P0-N14 — when both are present, handleIncoming wraps the
      // decrypt + message-row UPSERT in a single SQLite transaction.
      deps.txnDb ?? null, deps.sqlMessages ?? null,
      // Audit P0-N6 — markSeen runs INSIDE the same transaction so a
      // mid-flight crash can't leave the dedup row committed without
      // its plaintext counterpart (or vice versa).
      deps.seenEnvelopes ?? null,
      // Bug-hunt #3 — pending-stash threading.
      deps.pendingGroupEnvelopes ?? null,
      deps.pendingAdminActions ?? null,
    );
    handledOk = true;
  } catch (e) {
    if (e instanceof LeaveOnRelayError) {
      // B-30 — first-message recovery asked to leave this envelope on the
      // relay for a bounded redelivery (the session rebuild was kicked off in
      // handleIncoming). Reuse the existing leaveOnRelay ack-skip below.
      leaveOnRelay = true;
    } else if (isTransientSqlError(e)) {
      // Audit P0-1(b) — transient LOCAL SQL failure (nested-txn collision,
      // SQLITE_BUSY/locked, disk I/O pressure). The receive txn rolled back
      // (no ratchet advance) and the relay still holds a deliverable copy,
      // so a local hiccup must NEVER ack-`discarded` (destroy) the message.
      // Skip the ack; the relay redelivers on the next drain/reconnect.
      crashLog(`[messenger] ws-handle transient-sql leave-on-relay env=${frame.data.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
      leaveOnRelay = true;
    } else if (e instanceof IdentityKeyMismatchError && deps.keys) {
      const {refreshPeerIdentityIfRotated} = require('../crypto/peerIdentityRefresh') as
        typeof import('../crypto/peerIdentityRefresh');
      const outcome = await refreshPeerIdentityIfRotated(
        e.claims.senderUserId,
        e.claims.senderSignalDeviceId,
        e.claims.senderIdentityKey,
        deps.keys,
        deps.ownStore,
      );
      crashLog(`[messenger] ws-identity-rotation env=${frame.data.envelopeId.slice(0, 8)} outcome=${outcome.result} reason=${outcome.reason ?? '-'}`);
      if (outcome.result === 'refreshed' && outcome.sessionReset) { void notePeerIdentityChanged(e.claims.senderUserId); }
      if (outcome.result === 'refreshed') {
        try {deps.peerIdentityCache?.delete(`${e.claims.senderUserId}.${e.claims.senderSignalDeviceId}`);} catch { /* ignore */ }
        // BS-IDKEY — surface the rotation (safety-number-changed model).
        if (outcome.sessionReset) {
          try {
            useMessengerStore.getState().setError(
              'A contact’s security code changed — their messages will resume on a new secure session.',
            );
          } catch { /* ignore */ }
        }
        try {
          await handleIncoming(
            deps.own, deps.ownStore, trustedPeer, unwrapped.ciphertext,
            deps.config, frame.data.envelopeId, deps.keys, deps.rehandshakeNudge,
            deps.peerIdentityCache,
            deps.txnDb ?? null, deps.sqlMessages ?? null,
            deps.seenEnvelopes ?? null,
            deps.pendingGroupEnvelopes ?? null,
            deps.pendingAdminActions ?? null,
          );
          handledOk = true;
        } catch (e2) {
          // BS-IDKEY — EXPECTED when sessionReset fired: this envelope was
          // sealed to the now-archived ratchet so it can't decrypt. Drop
          // it (ack below proceeds) — the session is reset, so subsequent
          // messages rebuild + deliver. A non-reset failure stays a soft
          // drop as before.
          if (outcome.sessionReset) {
            crashLog(`[messenger] ws rotation env=${frame.data.envelopeId.slice(0, 8)} dropped (sealed to archived ratchet) — session reset, future msgs ok`);
            // Destroyed (sealed to the archived ratchet) — honest disposition.
            noteDestroyedEnvelope({envelopeId: frame.data.envelopeId, reason: 'rotation-archived-ratchet'});
            handledOk = true;
          } else if (isTransientSqlError(e2)) {
            // Audit P0-1(b) — local storage hiccup on the retry too:
            // leave on relay, never destroy.
            crashLog(`[messenger] ws post-refresh transient-sql leave-on-relay env=${frame.data.envelopeId.slice(0, 8)}`);
            leaveOnRelay = true;
          } else {
            crashLog(`[messenger] ws post-refresh handle failed env=${frame.data.envelopeId.slice(0, 8)} err=${asErrorMessage(e2).slice(0, 120)}`);
          }
        }
      } else if (outcome.result === 'unavailable') {
        // keys-service blip — leave on relay for a future drain.
        leaveOnRelay = true;
      } else {
        // stale-cert / no-change — drop.
        crashLog(`[messenger] ws identity-mismatch dropped env=${frame.data.envelopeId.slice(0, 8)} reason=${outcome.reason ?? '?'}`);
      }
    } else {
      // Non-rotation failure (cert reject, AAD reject, bad MAC, etc.).
      // Drop the envelope so the relay stops redelivering. Same posture
      // as drainRelay's catch-all branch.
      crashLog(`[messenger] ws-handle-failed env=${frame.data.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
      // B-30 — telemetry parity with drainRelay's catch-all (the WS path was
      // blind to these drops on vc78). Count genuinely-unexpected throws that
      // reach the catch-all so they're diagnosable rather than silent.
      try {
        const {noteUndecryptable} = require('../backup/sessionRatchetRecovery') as
          typeof import('../backup/sessionRatchetRecovery');
        noteUndecryptable(`ws-handle:${asErrorMessage(e).slice(0, 40)}`);
      } catch { /* recovery module not loaded — fine */ }
    }
  }
  // ACK only after we've successfully decrypted + stored, OR after we
  // decided to ack-drop (cert/AAD reject etc.). Audit P1-4 — never
  // skip the ACK on a verify failure, only on `unavailable` rotation
  // where the next drain will reasonably retry.
  if (!leaveOnRelay) {
    // Handoff §3.6(c) — ack-for-delete vs delivered-signal. `handledOk`
    // false (unrecoverable throw) or a destroyed-note from the deep path
    // (AAD reject / tamper-final / recovery give-up) means the message
    // will NEVER render here: ack 'discarded' so the relay emits
    // `envelope.undeliverable` instead of the ✓✓ `envelope.delivered`.
    // Stash branches leave no note — the device durably holds those, so
    // 'delivered' stays honest.
    const destroyedInfo = takeDestroyedEnvelope(frame.data.envelopeId);
    const disposition = (!handledOk || destroyedInfo) ? 'discarded' as const : 'delivered' as const;
    try {
      await deps.relay.ack(frame.data.envelopeId, frame.data.ackToken, disposition);
      console.log('[messenger.deliver] ACK ok envId=' + frame.data.envelopeId.slice(0, 8) + ' handled=' + handledOk + ' disposition=' + disposition);
    } catch (e) {
      // Non-fatal — the envelope will redeliver on next pull. But log it
      // so a silent ack failure (token race, 401, 429, network) is
      // visible in JS console / Crashlytics rather than vanishing into
      // the void.
      console.warn('[messenger.deliver] ACK FAILED envId=' + frame.data.envelopeId.slice(0, 8) + ' err=' + asErrorMessage(e));
    }
  } else {
    // Why: previously `leaveOnRelay=true` meant we INTENTIONALLY skip
    // the ack so the next reconnect re-fetches the envelope after the
    // keys-service blip clears. But if that blip is permanent (peer
    // identity genuinely changed and the registry never updates), the
    // envelope re-delivers forever and the receiver burns CPU on every
    // reconnect. Cap with a log so we can spot the case in field reports.
    console.warn('[messenger.deliver] leaveOnRelay=true — envelope will redeliver envId=' + frame.data.envelopeId.slice(0, 8));
  }
  void handledOk; // referenced for diagnostic if ever wired to telemetry
}

/**
 * Bug-hunt #1.A — signals from `doHandleIncoming` to the outer
 * `handleIncoming` wrapper that something needs to happen AFTER the
 * receive txn commits/rolls back. Previously these actions ran inside
 * the BEGIN IMMEDIATE block, which:
 *   1. held the SQLite write lock across multi-second HTTP round trips
 *      (self-DoS on each forged envelope),
 *   2. committed partial libsignal-store writes under the same txn as
 *      the ratchet that just threw,
 *   3. made the recovery untestable in isolation from the txn wrapper.
 *
 * `decrypt-recovery` carries the DecryptError rebuild dance
 * (closeSession + bundle fetch + initOutgoingSession + nudge).
 *
 * `drain-group` (bug-hunt #3.B) carries the pending-queue drain
 * triggered by an admin `create`/`rekey` that committed a new
 * masterKeyB64. The drain processes pending rows in their own per-row
 * txns so a malformed row can't roll back the admin commit.
 */
interface DecryptRecoveryRequest {
  kind:               'decrypt-recovery';
  peer:               SessionAddress;
  reason:             'protected' | 'rebuild' | 'cooldown';
}

interface DrainGroupRequest {
  kind:               'drain-group';
  groupId:            string;
}

/**
 * Self-heal — emitted by the receive path so the factory (which holds the
 * send stack) can act AFTER the receive txn commits, mirroring the
 * drain-group deferral.
 *
 *   reshare-group-key — WE are the owner and a member sent us a signed
 *                       `key-request`; re-DELIVER the current key to them
 *                       (no epoch bump, roster-gated).
 *   request-group-key — we received a group message we CANNOT decrypt
 *                       (no_key / key-divergence) for a group we belong
 *                       to; ask the owner/admins to re-share the key.
 */
interface ReshareGroupKeyRequest {
  kind:               'reshare-group-key';
  groupId:            string;
  toUserId:           string;
}
interface RequestGroupKeyRequest {
  kind:               'request-group-key';
  groupId:            string;
  /**
   * Sender address of the envelope that triggered the request, when
   * known. A brand-new member may hold NO conversations[groupId] row
   * yet (the owner's `create` never landed), and the resync handler's
   * participants normally come from that row — the very row only the
   * missing `create` would have written (handoff §2.5 Seam C). The
   * fallback lets the key-request target the stashed envelope's sender
   * directly instead of silently no-oping.
   */
  fromPeer?:          SessionAddress;
}

/**
 * Signal resend protocol (flag-gated, EXPO_PUBLIC_RESEND_PROTOCOL, default off).
 * When WE receive a `rehandshake` control from a peer — which they send after
 * failing to decrypt something from us — that is a strong signal the peer lost
 * messages we sent. If the flag is on, re-transmit our recent still-undelivered
 * 1:1 messages to that peer over the now-healed session. Uses the EXISTING
 * rehandshake signal (no sealed-payload schema change) and re-sends with the
 * ORIGINAL clientMsgId so the receiver dedups (no duplicate bubble). Default off
 * ⇒ the receive path is byte-identical (the branch is skipped).
 */
interface ResendUndeliveredRequest {
  kind:               'resend-undelivered';
  peer:               SessionAddress;
}

type PostTxnRequest =
  | DecryptRecoveryRequest
  | DrainGroupRequest
  | ReshareGroupKeyRequest
  | RequestGroupKeyRequest
  | ResendUndeliveredRequest;

/** Is the resend protocol enabled? Default OFF. Read via globalThis to dodge the
 *  babel-preset-expo EXPO_PUBLIC static rewrite (keeps it readable in tests). */
function isResendProtocolEnabled(): boolean {
  const raw = (globalThis as {process?: {env?: Record<string, string | undefined>}})
    ?.process?.env?.EXPO_PUBLIC_RESEND_PROTOCOL;
  return raw === 'true';
}

/**
 * CRIT-7 multi-device fan-out. Default OFF. When enabled, a 1:1 send ALSO
 * delivers to the peer's devices beyond device 1 (a linked/second device is
 * otherwise silently skipped — the CRIT-7 data-loss gap). Additive to the
 * primary device-1 send; default off ⇒ send path byte-identical.
 */
function isMultiDeviceEnabled(): boolean {
  const raw = (globalThis as {process?: {env?: Record<string, string | undefined>}})
    ?.process?.env?.EXPO_PUBLIC_MULTI_DEVICE;
  return raw === 'true';
}

/**
 * Self-heal signal bus. The deep receive path (top-level functions that
 * only thread crypto-store params) emits group-key signals here; the
 * runtime factory — which owns the cert cache, transport, relay and
 * session manager needed to actually re-share / request a key — registers
 * the single handler at construction time. One runtime per app process, so
 * a module-level slot is sufficient; the loopback/test runtime never
 * registers one, so these signals are inert there.
 */
type GroupKeySignal =
  | {kind: 'reshare'; groupId: string; toUserId: string}
  | {kind: 'request'; groupId: string; fromPeer?: SessionAddress}
  // Audit G-03 — a designated remaining admin rekeys after a peer voluntarily
  // LEFT, so the leaver (who keeps the old key) can't read post-leave messages
  // (forward secrecy). `leaverId` is needed because the leaver is already gone
  // from local membership by the time this fires.
  | {kind: 'leave-rekey'; groupId: string; leaverId: string};
let groupKeySignalHandler: ((s: GroupKeySignal) => void) | null = null;
function setGroupKeySignalHandler(h: ((s: GroupKeySignal) => void) | null): void {
  groupKeySignalHandler = h;
}
function emitGroupKeySignal(s: GroupKeySignal): void {
  try { groupKeySignalHandler?.(s); } catch { /* never let self-heal dispatch break receive */ }
}

/**
 * Resend-protocol signal bus — same shape as the group-key bus. The receive
 * path emits a peer address; the factory (which owns transport/relay/cert/
 * session send stack) registers the handler that re-transmits undelivered 1:1
 * messages. Inert on the loopback/test runtime (no handler registered).
 */
let resendSignalHandler: ((peer: SessionAddress) => void) | null = null;
function setResendSignalHandler(h: ((peer: SessionAddress) => void) | null): void {
  resendSignalHandler = h;
}
function emitResendSignal(peer: SessionAddress): void {
  try { resendSignalHandler?.(peer); } catch { /* never let resend dispatch break receive */ }
}

async function handleIncoming(
  own: SessionManager,
  ownStore: CryptoStore,
  peer: SessionAddress,
  ct: Ciphertext,
  config: ProductionConfig,
  envelopeId?: string,
  keys?: KeysHttpClient,
  nudgeAfterRebuild?: (peer: SessionAddress) => void | Promise<void>,
  /**
   * Fix #11: when the peer rotates identity, libsignal throws
   * DecryptError on inbound. We then refetch + rebuild — but we
   * must also evict the stale entry from the per-runtime peer-
   * identity cache or our NEXT outbound to them would re-wrap
   * with the previous (rotated-out) identity.
   */
  peerIdentityCache?: Map<string, {idKey: string; fetchedAt: number}>,
  /**
   * Audit P0-N14 — atomic ratchet+plaintext receive.
   * When both are provided, the decrypt → checks → message-row UPSERT
   * sequence runs inside a single `BEGIN IMMEDIATE` / `COMMIT` on the
   * shared SQLCipher handle. A throw anywhere in the window ROLLBACKs
   * the ratchet advance so the redelivered ciphertext decrypts cleanly
   * on retry instead of failing forever with "bad MAC". Both null on
   * the loopback runtime (in-memory store, no SQLite).
   */
  txnDb?: TxnDbHandle | null,
  sqlMessages?: SqlMessageStore | null,
  /**
   * Audit P0-N6 — when present, markSeen(envelopeId) runs inside the
   * receive transaction so the dedup gate commits atomically with the
   * ratchet advance + plaintext UPSERT.
   */
  seenEnvelopes?: SeenEnvelopeStore | null,
  /**
   * Bug-hunt #3 — pending stash for group envelopes that arrived
   * before the local master key (admin create/rekey still in flight)
   * and admin actions that arrived out-of-epoch order. Both stash
   * writes happen INSIDE the receive txn; the drain happens OUTSIDE
   * via the `drain-group` post-txn request.
   */
  pendingGroupEnvelopes?: PendingGroupEnvelopeStore | null,
  pendingAdminActions?: PendingAdminActionStore | null,
): Promise<void> {
  // Audit P0-N14 — wrap the WHOLE receive path in a transaction when
  // we have a SQLCipher handle. Inside, every `appendMessage` is
  // mirrored by a synchronous `sqlMessages.upsert` BEFORE we exit the
  // function, so the COMMIT flushes both the libsignal session UPSERT
  // and our plaintext row in one atomic step.
  //
  // On the loopback path (no txnDb / no sqlMessages) we fall through
  // to the legacy non-transactional behaviour — fine for tests where
  // the in-memory store has no notion of crash recovery.
  //
  // Bug-hunt #1.A / #3.B — doHandleIncoming MAY return a `PostTxnRequest`
  // when the inner path needs work that must happen AFTER the receive
  // txn commits. We catch it here, exit the txn cleanly, then dispatch.
  let post: PostTxnRequest | void;
  if (txnDb && sqlMessages) {
    post = await runWithRatchetTxn(txnDb, () => doHandleIncoming(
      own, ownStore, peer, ct, config, envelopeId, keys, nudgeAfterRebuild,
      peerIdentityCache, sqlMessages, seenEnvelopes ?? null,
      pendingGroupEnvelopes ?? null, pendingAdminActions ?? null,
    ));
  } else {
    post = await doHandleIncoming(
      own, ownStore, peer, ct, config, envelopeId, keys, nudgeAfterRebuild,
      peerIdentityCache, null, null, null, null,
    );
  }
  if (!post) {return;}
  if (post.kind === 'decrypt-recovery') {
    await runDecryptRecovery(post, own, keys, nudgeAfterRebuild);
    // B-30 — the legacy path ACK-deleted the triggering envelope here even
    // though it was never delivered, so the first message on a (re)established
    // session was permanently lost. For the rebuild/cooldown reasons, leave it
    // on the relay (bounded) so a redelivery can decrypt once the session is
    // rebuilt; the WS/drain caller turns LeaveOnRelayError into a skip-ack.
    // The P0-1 'protected' reason and the loopback (no-envelopeId) path stay
    // ACK-drop, and a give-up (cap/age reached) is counted for diagnosability.
    const disposition = decideRecoveryDisposition(post.reason, envelopeId);
    if (disposition === 'leave-on-relay' && envelopeId) {
      throw new LeaveOnRelayError(envelopeId);
    }
    if (envelopeId) {
      try {
        const {noteUndecryptable} = require('../backup/sessionRatchetRecovery') as
          typeof import('../backup/sessionRatchetRecovery');
        noteUndecryptable(`first-msg-${post.reason}`);
      } catch { /* recovery module not loaded — fine */ }
      // Handoff §3.6 — recovery gave up (cap/age/protected): the envelope
      // is about to be ACK-dropped, i.e. destroyed. Honest disposition.
      noteDestroyedEnvelope({envelopeId, reason: `first-msg-${post.reason}`, peer});
    }
    return;
  }
  if (post.kind === 'drain-group' && pendingGroupEnvelopes && txnDb && sqlMessages) {
    // Bug-hunt #3.B — fire-and-forget drain. Each pending row is
    // processed in its own fresh receive txn so a malformed row can't
    // poison the rest. `void` rather than `await` so the WS handler
    // isn't blocked on potentially many rows; subsequent inbound for
    // this group will already see the drained rows persisted.
    void drainPendingGroup(
      post.groupId, config, txnDb, sqlMessages, seenEnvelopes ?? null,
      pendingGroupEnvelopes, pendingAdminActions ?? null,
    );
  }
  // Self-heal — hand the group-key signals to the factory's registered
  // handler (which owns the send stack). Fire-and-forget; the handler
  // itself rate-limits and roster-gates.
  if (post.kind === 'reshare-group-key') {
    emitGroupKeySignal({kind: 'reshare', groupId: post.groupId, toUserId: post.toUserId});
  }
  if (post.kind === 'request-group-key') {
    emitGroupKeySignal({kind: 'request', groupId: post.groupId, fromPeer: post.fromPeer});
  }
  if (post.kind === 'resend-undelivered') {
    emitResendSignal(post.peer);
  }
}

/**
 * Bug-hunt #1.A — runs after the receive txn has committed/rolled back.
 * Executes the legacy "wipe the session and rebuild from a fresh bundle"
 * dance with NO SQLite write lock held. Marks the rebuild cooldown only
 * after both the bundle fetch and `initOutgoingSession` succeed
 * (preserves the fix-#6 semantics).
 *
 * Bug-hunt #1.D — when `EXPO_PUBLIC_P01_PROOF_OF_LIFE=true`, before
 * destroying the session we fire a `rehandshake` control envelope to
 * the peer and wait briefly for any inbound activity. If the peer is
 * genuinely online and the session is healthy from their side, the
 * inbound clears the recovery banner via the normal success path and
 * we abort the wipe. This closes the residual P0-1 surface (cold-start
 * fresh contact, 24h+ silent peer) without changing the wire format.
 */
async function runDecryptRecovery(
  req: DecryptRecoveryRequest,
  own: SessionManager,
  keys?: KeysHttpClient,
  nudgeAfterRebuild?: (peer: SessionAddress) => void | Promise<void>,
): Promise<void> {
  if (req.reason !== 'rebuild') {return;}
  if (!keys) {return;}

  const PROOF_OF_LIFE_ENABLED =
    typeof process !== 'undefined' &&
    (process as {env?: {[k: string]: string | undefined}}).env?.EXPO_PUBLIC_P01_PROOF_OF_LIFE === 'true';
  // Bug-hunt #1.D — proof-of-life round-trip. Behind a feature flag so
  // the rollout can be staged; default off keeps the existing fast-path
  // behaviour. The wait is short (3s) so a non-responsive peer doesn't
  // delay legitimate rebuild — the rebuild branch still runs after the
  // wait elapses with no inbound seen.
  if (PROOF_OF_LIFE_ENABLED && nudgeAfterRebuild) {
    try {
      // Send the nudge using the CURRENT (about-to-be-destroyed) session.
      // If the session is genuinely live on the peer's side, they receive
      // the rehandshake and their normal response path lights up our
      // `rememberSuccessfulDecrypt`. Failure here (e.g. the session is
      // already burned on our side too) just falls through to rebuild.
      await Promise.resolve(nudgeAfterRebuild(req.peer)).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
    const beforeWait = Date.now();
    await new Promise<void>(resolve => setTimeout(resolve, 3000));
    // If the peer responded during the wait, `rememberSuccessfulDecrypt`
    // would have stamped a fresh timestamp. Consult the same window
    // check we'd consult in the next inbound's catch block — if the
    // session is now "recent", abort the wipe.
    if (hasRecentSuccessfulDecrypt(req.peer)) {
      crashLog(`[P0-1-PoL] proof-of-life cleared rebuild for peer=${req.peer.userId.slice(0, 8)}/${req.peer.deviceId} waitMs=${Date.now() - beforeWait}`);
      return;
    }
  }

  // Why: closeSession + initOutgoingSession write libsignal session rows
  // on the same op-sqlite connection that other envelopes' BEGIN
  // IMMEDIATE may currently hold. Without serialization, a concurrent
  // receive triggers "cannot start a transaction within a transaction"
  // and recovery fails forever for the peer. Queue both writes on the
  // same txnChain as runWithRatchetTxn so they wait for any open
  // transaction to commit. The bundle FETCH is HTTP — no DB lock — so
  // we do it OUTSIDE the chain to keep the chain free.
  let bundle: Awaited<ReturnType<typeof keys.fetchPeerBundleWithPoolSize>>['bundle'];
  try {
    await runOnTxnChain(() => own.closeSession(req.peer));
  } catch { /* best effort */ }
  try {
    bundle = (await keys.fetchPeerBundleWithPoolSize(req.peer.userId)).bundle;
    await runOnTxnChain(() => own.initOutgoingSession({
      ...bundle,
      address: {userId: req.peer.userId, deviceId: req.peer.deviceId},
    }));
    // Fix #6: stamp cooldown AFTER success only. A bundle-fetch failure
    // used to leave the peer locked in a 60s penalty box even though no
    // rebuild actually happened.
    markRebuildAttempt(req.peer);
    // Rehandshake nudge: send a tiny control envelope back so the
    // original sender's libsignal session-replaces on decrypt. Without
    // this, ops/sender stays stuck on the stale ratchet until they
    // happen to send again. Best-effort; failures don't block recovery.
    if (nudgeAfterRebuild) {void nudgeAfterRebuild(req.peer);}
  } catch (recoveryErr) {
    // Surface the swallowed failure — the manual reset is still the
    // safety net but at least we know which leg failed (bundle fetch,
    // init, or nudge). Cooldown intentionally NOT stamped: leave the
    // gate open for the next inbound.
    crashLog(`[messenger] recovery-failed peerPrefix=${req.peer.userId.slice(0, 8)} err=${(recoveryErr as Error).message.slice(0, 120)}`);
    crashRecord(recoveryErr instanceof Error ? recoveryErr : new Error(String(recoveryErr)), {
      area: 'messenger.identityRecovery', peerPrefix: req.peer.userId.slice(0, 8),
    });
    console.warn('[messenger] recovery failed', {
      peer: req.peer, error: (recoveryErr as Error).message,
    });
  }
}

/**
 * Bug-hunt #3.B — replay every pending envelope for a group whose
 * master key just landed. Each row is processed in its own fresh
 * receive txn so a single malformed row can't poison the rest.
 *
 * Per-row outcomes:
 *   - replay succeeds → row deleted.
 *   - replay throws (still no_key, tamper, parse error) → bump
 *     attempts; if at `PENDING_GROUP_MAX_ATTEMPTS`, drop the row.
 *
 * After draining the envelope queue, also runs the admin-action
 * drain (bug-hunt #3.D): a `create`/`rekey` that just committed
 * could be exactly the local-state advance some stashed admin
 * action was waiting for.
 */
async function drainPendingGroup(
  groupId: string,
  config: ProductionConfig,
  txnDb: TxnDbHandle,
  sqlMessages: SqlMessageStore,
  seenEnvelopes: SeenEnvelopeStore | null,
  pendingGroupEnvelopes: PendingGroupEnvelopeStore,
  pendingAdminActions: PendingAdminActionStore | null,
): Promise<void> {
  let rows;
  try {
    rows = await pendingGroupEnvelopes.listForGroup(groupId);
  } catch (e) {
    crashLog(`[group:drain] list failed groupId=${groupId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 80)}`);
    return;
  }
  if (rows.length > 0) {
    crashLog(`[group:drain] groupId=${groupId.slice(0, 8)} rows=${rows.length}`);
  }
  for (const row of rows) {
    try {
      const sealed = JSON.parse(row.sealedJson) as ReturnType<typeof unsealPayload>;
      await replayGroupSealedDecode(
        sealed,
        {userId: row.peerUserId, deviceId: row.peerDeviceId},
        row.envelopeId,
        config,
        txnDb,
        sqlMessages,
        seenEnvelopes,
      );
      await pendingGroupEnvelopes.delete(row.envelopeId);
    } catch (e) {
      crashLog(
        `[group:drain] replay failed groupId=${groupId.slice(0, 8)} ` +
        `env=${row.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 80)}`,
      );
      try {
        const attempts = await pendingGroupEnvelopes.bumpAttempts(row.envelopeId);
        if (attempts >= PENDING_GROUP_MAX_ATTEMPTS) {
          await pendingGroupEnvelopes.delete(row.envelopeId);
        }
      } catch { /* swallow */ }
    }
  }
  // Bug-hunt #3.D — try replaying any stashed admin actions for this
  // group too. We just advanced local state; one of the stale-epoch
  // actions may now apply.
  if (pendingAdminActions) {
    await drainPendingAdminActions(groupId, pendingAdminActions);
  }
}

/**
 * Bug-hunt #3.B — replay a stashed group sealed payload. We bypass
 * `own.decrypt` (the inner Signal ciphertext was already consumed
 * when the envelope first arrived — the per-message key has burned)
 * and re-run only the post-decrypt routing: parse the group payload
 * with the now-available master key, append the message row, and
 * mark the envelope-id seen.
 *
 * If the master key STILL doesn't decrypt the body (drain triggered
 * on the wrong group, or pending row references a yet-to-arrive
 * rekey), throw — the caller bumps attempts and eventually drops.
 */
async function replayGroupSealedDecode(
  sealed: ReturnType<typeof unsealPayload>,
  peer: SessionAddress,
  envelopeId: string,
  config: ProductionConfig,
  txnDb: TxnDbHandle,
  sqlMessages: SqlMessageStore,
  seenEnvelopes: SeenEnvelopeStore | null,
): Promise<void> {
  if (!sealed.group) {throw new Error('replay: not a group envelope');}
  const store = useMessengerStore.getState();
  const existing = store.groups[sealed.group.groupId];
  const masterKey = existing?.masterKeyB64;
  if (!masterKey) {
    throw new Error('replay: master key still missing post-drain');
  }
  const parseResult = await parseGroupMessage(sealed, masterKey);
  if (!parseResult.ok) {
    throw new Error(`replay: parse ${parseResult.reason}`);
  }
  const inner = parseResult.envelope;
  if (inner.kind === 'admin') {
    // Admin replay through `setGroupState` is delicate (epoch
    // ordering, signature checks). Stashed admin actions are
    // handled by `drainPendingAdminActions` separately; if an
    // admin envelope ended up in the GROUP-envelope queue it was
    // already routed wrong. Drop the row by completing cleanly.
    return;
  }
  // Audit P1-N4 — same gate as the live path: a stashed text envelope
  // from a peer who isn't a member at the current epoch is dropped.
  // Covers the race where a removed peer's old envelope was stashed
  // pending key arrival and then drains after the remove lands.
  if (existing && !isGroupMember(existing, peer.userId)) {
    return;
  }
  const conversationId = sealed.group.groupId;
  const groupMsg: LocalMessage = {
    id:               sealed.clientMsgId ?? makeId(),
    conversation_id:  conversationId,
    sender_id:        peer.userId,
    // GROUP MEDIA FIX — a media message that arrived before the key
    // (no_key) is stashed and drained here once the key lands; carry the
    // attachment so the drained row renders as media, not a bare caption.
    type:             attachmentMessageType(sealed.attachment),
    content:          inner.body,
    media_mime:       sealed.attachment?.mimeType,
    media_object_key: sealed.attachment?.objectKey,
    media_key:        sealed.attachment?.keyB64,
    media_iv:         sealed.attachment?.ivB64,
    media_meta:       attachmentMediaMeta(sealed.attachment),
    status:           'delivered',
    is_encrypted:     true,
    // L18 GROUP-DRAIN-RECEIVE-TIME-ORDERING — use the sender's SEAL timestamp
    // (aad.ts) as created_at, not the drain time. A stashed (no_key) envelope
    // drains long after it was sent; stamping "now" sorted it AFTER messages
    // actually sent later but decoded earlier. appendMessage splices an
    // out-of-order row into its chronological slot, so the right timestamp lands
    // it back in send-order. Fall back to now only if the ts is somehow absent.
    created_at:       (() => {
      const sentTs = (sealed.aad as {ts?: number} | undefined)?.ts;
      return typeof sentTs === 'number' ? new Date(sentTs).toISOString() : new Date().toISOString();
    })(),
    peer,
    envelope_id:      envelopeId,
    expires_at:       sealed.expiresAtSec ? sealed.expiresAtSec * 1000 : undefined,
    reply_to_msg_id:  sealed.replyTo?.msgId,
    reply_to_preview: sealed.replyTo?.preview,
  };
  await runWithRatchetTxn(txnDb, async () => {
    if (seenEnvelopes) {await seenEnvelopes.markSeen(envelopeId);}
    store.appendMessage(conversationId, groupMsg);
    await sqlMessages.upsert(groupMsg);
  });
  void config; // keep signature stable for future expansion
}

/**
 * Bug-hunt #3.D — replay every pending admin action for a group.
 * Re-runs `applyAdminAction`; if the action still no-ops (local
 * state still mismatched), bump attempts and drop after the cap.
 *
 * Runs OUTSIDE the receive txn — admin replay touches the Zustand
 * store, not SQLite, so there's no concurrency benefit to wrapping
 * it. Errors are swallowed per row so one bad action can't stop
 * the rest from replaying.
 */
async function drainPendingAdminActions(
  groupId: string,
  pendingAdminActions: PendingAdminActionStore,
): Promise<void> {
  let rows;
  try {
    rows = await pendingAdminActions.listForGroup(groupId);
  } catch (e) {
    crashLog(`[group:drain-admin] list failed groupId=${groupId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 80)}`);
    return;
  }
  if (rows.length > 0) {
    crashLog(`[group:drain-admin] groupId=${groupId.slice(0, 8)} rows=${rows.length}`);
  }
  // pending-admin-drain-unsorted-epoch — apply stashed admin actions in
  // ASCENDING epoch order so ONE drain pass can advance the group state
  // monotonically. Out-of-order arrival used to try a higher-epoch action
  // first (applyAdminAction no-ops on epoch mismatch), apply the lower one,
  // then leave the now-applicable higher one for the NEXT drain trigger.
  // Pure scheduling: the per-action epoch + signature checks inside
  // applyAdminAction are unchanged and still gate every apply, so the sort can
  // never apply something the reducer would reject. Rows with no atEpoch
  // (e.g. a stray create) sort last — no worse than today (they just retry).
  const epochOf = (r: {actionJson: string}): number => {
    try {
      const a = JSON.parse(r.actionJson) as {atEpoch?: number};
      return typeof a.atEpoch === 'number' ? a.atEpoch : Number.MAX_SAFE_INTEGER;
    } catch { return Number.MAX_SAFE_INTEGER; }
  };
  const sortedRows = [...rows].sort((a, b) => epochOf(a) - epochOf(b));
  const store = useMessengerStore.getState();
  for (const row of sortedRows) {
    try {
      const existing = store.groups[row.groupId];
      if (!existing) {
        await pendingAdminActions.delete(row.id);
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = JSON.parse(row.actionJson) as any;
      const next = applyAdminAction(existing, action, row.senderUserId);
      if (next === existing) {
        // Still doesn't apply — bump attempts, drop after cap.
        const attempts = await pendingAdminActions.bumpAttempts(row.id);
        if (attempts >= PENDING_ADMIN_MAX_ATTEMPTS) {
          await pendingAdminActions.delete(row.id);
        }
        continue;
      }
      store.setGroupState(next);
      if (existing.masterKeyB64 !== next.masterKeyB64) {
        disposeGroupKey(existing.masterKeyB64);
      }
      await pendingAdminActions.delete(row.id);
    } catch (e) {
      crashLog(`[group:drain-admin] apply failed id=${row.id} err=${asErrorMessage(e).slice(0, 80)}`);
      try {
        const attempts = await pendingAdminActions.bumpAttempts(row.id);
        if (attempts >= PENDING_ADMIN_MAX_ATTEMPTS) {
          await pendingAdminActions.delete(row.id);
        }
      } catch { /* swallow */ }
    }
  }
}

async function doHandleIncoming(
  own: SessionManager,
  ownStore: CryptoStore,
  peer: SessionAddress,
  ct: Ciphertext,
  config: ProductionConfig,
  envelopeId: string | undefined,
  keys: KeysHttpClient | undefined,
  nudgeAfterRebuild: ((peer: SessionAddress) => void | Promise<void>) | undefined,
  peerIdentityCache: Map<string, {idKey: string; fetchedAt: number}> | undefined,
  sqlMessages: SqlMessageStore | null,
  seenEnvelopes: SeenEnvelopeStore | null,
  pendingGroupEnvelopes: PendingGroupEnvelopeStore | null,
  pendingAdminActions: PendingAdminActionStore | null,
): Promise<void | PostTxnRequest> {
  console.log('[recv.enter] doHandleIncoming peer=' + peer.userId.slice(0, 8) + '/' + peer.deviceId + ' envId=' + (envelopeId ?? 'inline').slice(0, 8));
  // Bug-hunt #1.A — identity-rotation recovery is now SIGNALLED here
  // and EXECUTED by the outer `handleIncoming` AFTER the receive txn
  // commits. The old in-line dance (closeSession + bundle fetch +
  // initOutgoingSession) held the SQLite write lock across a network
  // round-trip, self-DoSing every concurrent receive. The function
  // returns a `DecryptRecoveryRequest` instead.
  let sealed: string;
  try {
    sealed = await own.decrypt(peer, ct);
  } catch (e) {
    // B-30 — recognize NoSessionError too (it was escaping to `throw e` below
    // → the catch-all ACK-dropped the first message on a fresh/lost session).
    // The classifier also name-matches the dual error-class copies.
    if (isRecoverableDecryptError(e)) {
      // Fix #11: invalidate the peer identity cache so the NEXT
      // outbound message re-fetches the (presumably rotated) key
      // instead of wrapping with the stale one we cached on a
      // prior success.
      peerIdentityCache?.delete(`${peer.userId}.${peer.deviceId}`);
      // Audit P0-1 — defence against forged-outer-envelope ratchet
      // wipe. See `sessionWipeProtection` for the full rationale.
      if (hasRecentSuccessfulDecrypt(peer)) {
        crashLog(`[P0-1] suppressed session-wipe on DecryptError — recent legitimate activity from peer=${peer.userId.slice(0, 8)}/${peer.deviceId} (likely forged outer envelope)`);
        useMessengerStore.getState().setRecoveryBanner(
          'A message failed to decrypt. If you keep seeing this, ask the sender to reinstall.',
        );
        return {kind: 'decrypt-recovery', peer, reason: 'protected'};
      }
      // Fix #16: soft `recoveryBanner` slot — identity rotation is a
      // known recoverable case; don't stomp on a fatal banner.
      useMessengerStore.getState().setRecoveryBanner(
        'Lost session with sender (likely reinstall) — your next message will rebuild it.',
      );
      // Hand recovery to the outer wrapper. It runs after the receive
      // txn commits (empty — no rows were written in this branch) so
      // closeSession + bundle fetch + initOutgoingSession execute with
      // NO SQLite write lock held.
      if (keys && shouldAttemptRebuild(peer)) {
        return {kind: 'decrypt-recovery', peer, reason: 'rebuild'};
      }
      return {kind: 'decrypt-recovery', peer, reason: 'cooldown'};
    }
    throw e;
  }
  // Decrypt succeeded — clear the soft recovery banner (set above on
  // a prior failed envelope). Don't touch `error`; that's reserved
  // for fatal/sticky banners and may belong to a different subsystem.
  if (useMessengerStore.getState().recoveryBanner) {
    useMessengerStore.getState().setRecoveryBanner(null);
  }
  // Audit P0-1 — mark this peer's session as live. A subsequent
  // DecryptError within PROTECTED_SESSION_WINDOW_MS will be treated
  // as a likely forged-outer-envelope attack and the wipe-and-rebuild
  // path will refuse to run.
  rememberSuccessfulDecrypt(peer);
  // B-30 — this envelope finally decrypted; free its leave-on-relay budget
  // slot so the bounded retry counter doesn't linger until LRU eviction.
  if (envelopeId) {clearFirstMsgRetryBudget(envelopeId);}
  // Audit P0-N6 — the ratchet has advanced; mark this envelope-id seen
  // so a redelivery doesn't feed the same ciphertext back through
  // libsignal (which would throw "bad MAC" because the per-message key
  // has burned). The INSERT runs inside the receive transaction so any
  // throw downstream (cert/AAD reject, malformed payload) ROLLBACKs
  // BOTH the markSeen and the ratchet advance together.
  if (seenEnvelopes && envelopeId) {
    await seenEnvelopes.markSeen(envelopeId);
  }
  // Audit 1:1 P1-8 — wrap unsealPayload so a version-rejection emits a
  // crashLog breadcrumb. The thrown CryptoError is rethrown so the txn
  // rolls back (matching the existing fail-closed behaviour), but now
  // operators get a counter they can correlate with rollout-pinning
  // problems instead of just "messages stopped appearing".
  let unwrapped;
  try {
    unwrapped = unsealPayload(sealed);
  } catch (e) {
    if (e instanceof Error && /unsupported sealed version/.test(e.message)) {
      crashLog(`[messenger] unseal-version-reject env=${envelopeId?.slice(0, 8) ?? 'inline'} msg=${e.message}`);
    }
    throw e;
  }
  // Audit P0-8 — prefer the local trust row, fall back to the
  // authority-signed peer bundle on cold contact (P0-I2 attests it).
  // When `keys` is undefined (loopback tests / harness paths) we
  // degrade gracefully to the legacy local-only resolution.
  const expectedSenderIdentity = keys
    ? await resolveExpectedSenderIdentity(peer, ownStore, keys, peerIdentityCache)
    : await (async () => {
        const local = await ownStore.loadIdentityKey(`${peer.userId}.${peer.deviceId}`);
        return local ? toBase64(local) : undefined;
      })();
  const claims = await verifySenderCert({
    cert:                unwrapped.cert,
    authorityPubKeyB64:  config.authorityPubKeyB64,
    expectedIdentityKey: expectedSenderIdentity,
  });
  if (claims.senderUserId !== peer.userId) {
    // Audit 1:1 P1-3 — must THROW so the receive txn rolls back the
    // ratchet advance. The original `return` exited cleanly inside the
    // BEGIN IMMEDIATE block, COMMITting the libsignal session UPSERT
    // even though we dropped the message. On the inevitable redelivery
    // libsignal then threw "bad MAC" against the now-burned message
    // key and the conversation got stuck. Throwing rolls the ratchet
    // back to its pre-decrypt state so the retry succeeds when (if
    // ever) a cert-matched envelope arrives.
    useMessengerStore.getState().setError('sender cert / hint mismatch');
    throw new Error('cert_peer_mismatch');
  }
  // Audit 1:1 P0-2 — deviceId pinning. The sender cert claims a specific
  // (userId, deviceId); the outer wrap names the same pair. Mismatch =
  // cross-device replay attempt; drop with rollback.
  if (claims.senderSignalDeviceId !== peer.deviceId) {
    useMessengerStore.getState().setError('sender cert / device-id mismatch');
    throw new Error('cert_device_mismatch');
  }
  // Round 5 / Security S1 — verify the AAD binding. We own the
  // receiver's identity so we can check `aad.to` matches. A mismatch
  // means the ciphertext was sealed for someone else and replayed to
  // us; a stale ts means the ciphertext sat unsent for >15 min and
  // should be treated as a replay attempt.
  //
  // Audit S10 — previously the call accepted any envelope WITHOUT an
  // AAD block (`{ok: true, aad: undefined}`), which silently disabled
  // the replay-protection feature. We now require an AAD by default,
  // with an env-var escape hatch (EXPO_PUBLIC_SEALED_AAD_LEGACY=true)
  // for the rare case that a server fleet still ships pre-S1 senders.
  // Audit P0-N2 — the extended AAD also binds sender + conversation +
  // group + epoch. We compute the receiver-side expected values here so
  // verifySealedAad can reject a cross-thread or cross-group replay.
  //
  // Audit P0-N2-follow-up — for 1:1 envelopes the AAD conversationId
  // is the SYMMETRIC id (`directConvoAadId(self, peer)`), NOT the
  // per-side UI key returned by `convoIdFor(peer)`. The UI key
  // continues to drive local thread routing below.
  const expectedConversationId = unwrapped.group?.groupId
    ?? directConvoAadId(config.ownUserId, peer.userId);
  const aadCheck = verifySealedAad({
    sealed:                 unwrapped,
    selfUserId:             config.ownUserId,
    selfDeviceId:           config.signalDeviceId ?? 1,
    requireAad:             !SEALED_AAD_LEGACY,
    expectedSender:         peer,
    expectedConversationId,
    expectedGroupId:        unwrapped.group?.groupId,
  });
  if (!aadCheck.ok) {
    // Drop the envelope. Surface a soft warning so the user can see
    // when sealed-sender binding catches something — security audits
    // need this signal.
    crashLog(`[messenger] aad-rejected reason=${aadCheck.reason} peerPrefix=${peer.userId.slice(0, 8)} env=${envelopeId?.slice(0, 8) ?? 'inline'}`);
    console.warn(`[messenger] sealed aad rejected reason=${aadCheck.reason} from peer=${peer.userId}`);
    console.log('[recv.branch] AAD_REJECT reason=' + aadCheck.reason);
    // BS-AADCLOCK / MSG-01 — the AAD carries a signed timestamp. After the
    // MSG-01 fix the STALE bound is the 30-day relay dwell (not ±15min), so
    // the two reasons now mean different things:
    //   `future` — timestamp is ahead of now beyond the ±15min clock-skew
    //     window. That IS a device-clock problem and is actionable.
    //   `stale`  — timestamp is older than the 30-day relay dwell, i.e. the
    //     relay could never have legitimately held it this long. That's an
    //     expired/replayed envelope, NOT a clock issue and NOT actionable —
    //     drop it silently like an already-expired message. (Legitimately
    //     delayed offline/backlog messages within 30 days now PASS, which is
    //     the whole point of MSG-01: they used to be silently destroyed.)
    const ts = (unwrapped.aad as {ts?: number} | undefined)?.ts;
    const deltaSec = typeof ts === 'number' ? Math.round((Date.now() - ts) / 1000) : null;
    if (aadCheck.reason === 'future') {
      crashLog(`[messenger] aad-clock-skew reason=future deltaSec=${deltaSec ?? '?'} peer=${peer.userId.slice(0, 8)} env=${envelopeId?.slice(0, 8) ?? 'inline'}`);
      useMessengerStore.getState().setError(
        'A message was dropped because a device clock looks wrong. Turn on automatic date & time on both phones, then resend.',
      );
    } else if (aadCheck.reason === 'stale') {
      // Silent — >30 days old (expired off the relay / replay). No user banner.
      crashLog(`[messenger] aad-stale deltaSec=${deltaSec ?? '?'} peer=${peer.userId.slice(0, 8)} env=${envelopeId?.slice(0, 8) ?? 'inline'}`);
    } else {
      useMessengerStore.getState().setError(`Dropped one envelope (sealed-sender ${aadCheck.reason})`);
    }
    // Handoff §3.6 — this clean return COMMITS the txn (ratchet advance
    // kept) and the caller acks, so the message is DESTROYED. Tell the
    // ack site the truth (disposition 'discarded' → sender sees
    // `undelivered`, not ✓✓) and leave a persistent gap marker in the
    // thread — except for `stale` (>30d replay/expired: not a live
    // conversation event, a placeholder would be noise).
    if (envelopeId) {
      noteDestroyedEnvelope({envelopeId, reason: `aad:${aadCheck.reason}`, peer});
      // Audit P2-9 — a blocked peer's failure must not resurrect the thread
      // via the placeholder row (the destroyed-note above stays: honest ack).
      if (aadCheck.reason !== 'stale' && !isPeerBlocked(peer.userId)) {
        const failedConvoId = unwrapped.group?.groupId
          ?? (require('../store/messengerStore') as typeof import('../store/messengerStore'))
            .resolveDirectConversationIdFromState(useMessengerStore.getState(), peer.userId);
        const placeholder = insertDecryptFailurePlaceholder({
          conversationId: failedConvoId, peer, envelopeId, reason: `aad:${aadCheck.reason}`,
        });
        if (placeholder && sqlMessages) {await sqlMessages.upsert(placeholder);}
      }
    }
    return;
  }
  // M7: if the payload is already expired by the time it arrives
  // (offline backlog catch-up), drop it without showing the user.
  if (unwrapped.expiresAtSec && unwrapped.expiresAtSec * 1000 <= Date.now()) {
    console.log('[recv.branch] EXPIRED expiresAtSec=' + unwrapped.expiresAtSec);
    return;
  }

  // Rehandshake nudge: receiver-issued control envelope. The very
  // act of decrypting it (a fresh PreKeyWhisperMessage) caused
  // libsignal to session-replace our broken ratchet record above.
  // Nothing else to do — drop without rendering.
  if (unwrapped.control === 'rehandshake') {
    console.log('[recv.branch] CONTROL_REHANDSHAKE');
    // Signal resend protocol (flag-gated) — the peer telling us they rebuilt
    // their session is a strong signal they couldn't decrypt messages we sent.
    // Defer a re-transmit of our recent undelivered 1:1 messages to after the
    // txn commits (the factory handler owns the send stack). Default off.
    if (isResendProtocolEnabled()) {
      return {kind: 'resend-undelivered', peer};
    }
    return;
  }

  // Group-call identity envelope — peer telling us "my opaque SFU
  // tag X belongs to display name Y". Feed the per-room identity
  // registry so the active GroupCallScreen labels tiles with real
  // names. Discard without rendering — never a chat bubble.
  if (unwrapped.groupCallPresence) {
    console.log('[recv.branch] GROUP_CALL_PRESENCE');

    const {recordGroupCallIdentity} = require('../webrtc/groupCallIdentityRegistry') as typeof import('../webrtc/groupCallIdentityRegistry');
    recordGroupCallIdentity(
      unwrapped.groupCallPresence.roomId,
      unwrapped.groupCallPresence.participantTag,
      unwrapped.groupCallPresence.displayName,
      peer.userId,
    );
    return;
  }

  // Route by sealed group.groupId when present (group broadcast), else
  // resolve the 1:1 conversation id. The sender chose the conversation;
  // trust the sealed payload, not the hint (which is only used for
  // routing decrypt).
  //
  // Why: MessengerHomeScreen syncs `/conversations/mine` and stores each
  // row under the server-issued UUID. ChatScreen then subscribes to
  // `s.messages[<server-UUID>]`. The legacy fallback `convoIdFor(peer)`
  // returns `direct:<peer.userId>` — a synthetic id that does NOT match
  // the server UUID. With the synthetic id, every inbound text landed
  // in a different `s.messages` slot than the one ChatScreen was
  // watching, so bubbles never appeared and the home list never
  // reordered. (Outgoing texts and call records were fine because their
  // call sites passed the server UUID explicitly.) Look up the existing
  // direct conversation by peer.userId first; only synthesise the
  // legacy key when no server row exists.
  // Why: ChatScreen's conversationId varies by entry point:
  //   - Home list tap → server-UUID from /conversations/mine
  //   - NewChat / push tap / incoming call → synthetic `direct:<peer>`
  // The typing handler at line ~2918 writes to BOTH the synthetic key
  // AND fans out to every conversation whose participants includes the
  // sender — that's why typing renders for chats opened either way.
  // appendMessage has no such fan-out: it writes to exactly one key.
  // If that key doesn't match what ChatScreen subscribes to, the bubble
  // is lost. Field evidence (Pixel v1.0.38): typing rendered but text
  // didn't, because the home-list tap had the user on the server-UUID
  // slot while inbound went to the synthetic. Resolve to the server-
  // UUID direct conversation when one exists; fall back to synthetic
  // only for cold contacts not yet synced via /conversations/mine.
  // See resolveDirectConversationIdFromState's docstring for why this
  // is centralised. The same resolver is used by sendText so inbound
  // and outbound agree on which slot ChatScreen subscribes to.
  let conversationId: string;
  if (unwrapped.group?.groupId) {
    conversationId = unwrapped.group.groupId;
  } else {
    const {resolveDirectConversationIdFromState: resolve} =
      require('../store/messengerStore') as typeof import('../store/messengerStore');
    conversationId = resolve(useMessengerStore.getState(), peer.userId);
    console.log('[recv.text.routing] peer=' + peer.userId.slice(0, 8) + ' convoId=' + conversationId.slice(0, 16) + ' isServerUuid=' + !conversationId.startsWith('direct:'));
  }

  // Audit MSG-02 (2026-07-02): a reaction carrying a group stamp is a
  // 1:1-PAIRWISE-encrypted CONTROL envelope (empty body) with a group ROUTING
  // hint — NOT a group-master-key-encrypted message. Handle it HERE, before
  // the group-parse path below (which would feed the empty body to
  // parseGroupMessage and drop it). Route applyReaction to the group
  // conversation so the author + every member see the reaction (previously it
  // landed in the reactor's 1:1 slot and was invisible to everyone else).
  if (unwrapped.reaction && unwrapped.group?.groupId) {
    // Audit P2-9 — apply the M-07 blocked-peer gate BEFORE the reaction
    // lands (blocked peers could previously patch reactions unimpeded).
    if (isPeerBlocked(peer.userId)) {
      console.log('[recv.reaction.blocked] peer=' + peer.userId.slice(0, 8));
      return;
    }
    applyReaction(
      unwrapped.group.groupId,
      peer.userId,
      unwrapped.reaction.targetMsgId,
      unwrapped.reaction.emoji,
      unwrapped.reaction.remove ?? false,
    );
    return;
  }

  // Group path — admin messages mutate group state, text messages
  // get unwrapped from the inner GroupMessageEnvelope (and decrypted
  // with the group master key when the body was wrapped by a master-
  // key-aware client). Legacy plaintext envelopes (server-created
  // mission groups before any admin create has been distributed) are
  // accepted as-is.
  if (unwrapped.group) {
    const store = useMessengerStore.getState();
    const existing = store.groups[unwrapped.group.groupId];
    const masterKey = existing?.masterKeyB64;
    const parseResult = await parseGroupMessage(unwrapped, masterKey);

    // Audit fix #27 — discriminated-union return. Distinguish:
    //   no_key  → admin create/rekey not yet processed. Bug-hunt #3:
    //             stash the ciphertext in the pending queue (durable
    //             SQLCipher row) and ack the relay. The next
    //             `applyAdminAction(create|rekey)` that commits a new
    //             masterKeyB64 for this group drains the row. Without
    //             the stash, the legacy fall-through wrote a
    //             ciphertext-JSON bubble and acked, losing the message
    //             when the create/rekey arrived seconds later.
    //   tamper  → groupDecrypt under our master key failed. The cert
    //             chain + sealed AAD were already verified upstream, so
    //             this is almost always KEY DIVERGENCE (a missed
    //             create/rekey fan-out or a stale epoch), NOT a forgery.
    //             MSG-01: do NOT silently drop-and-ack as final — that
    //             loses the message (the relay already ACKed on
    //             delivery). Stay fail-CLOSED (never render the
    //             ciphertext) but durably STASH the envelope on the SAME
    //             pending queue as no_key, so the next legitimate
    //             create/rekey that updates groups[groupId].masterKeyB64
    //             drains + re-decrypts it. Surface a recoverable
    //             "re-syncing" indicator. Recovery is the existing
    //             drain: the host's next create/rekey re-broadcasts the
    //             current key via the sealed fan-out. A genuine tamper
    //             keeps failing on replay and is dropped after
    //             PENDING_GROUP_MAX_ATTEMPTS — still fail-closed.
    //   malformed/not_group → fall through to legacy plaintext path
    //             (server-created mission groups before key
    //             distribution, ops/agent flow — these envelopes
    //             genuinely ship plaintext bodies)
    if (!parseResult.ok) {
      if (parseResult.reason === 'tamper' && pendingGroupEnvelopes && envelopeId) {
        // MSG-01 — recoverable key-divergence. Stash (same shape as the
        // no_key branch) instead of dropping; the create/rekey drain
        // re-decrypts once the correct master key lands.
        await pendingGroupEnvelopes.stash({
          envelopeId,
          groupId:      unwrapped.group.groupId,
          peerUserId:   peer.userId,
          peerDeviceId: peer.deviceId,
          sealed:       unwrapped,
          receivedAtMs: Date.now(),
        });
        crashLog(
          `[group:recv] tamper (key divergence) — stashed for groupId=${unwrapped.group.groupId.slice(0, 8)} ` +
          `env=${envelopeId.slice(0, 8)} (awaiting create/rekey resync)`,
        );
        useMessengerStore.getState().setError("Couldn't decrypt one message — re-syncing");
        // Handoff §2.7-2 — make the thread visible (syncing) even when the
        // owner's `create` never landed, and make the row-walking self-heal
        // triggers reachable for this group.
        upsertKeylessGroupPlaceholder(unwrapped.group.groupId, peer);
        // Self-heal — actively ask the owner to re-share the current key
        // (post-txn; rate-limited in the handler) instead of waiting
        // passively for an unrelated create/rekey that may never come.
        // `fromPeer` breaks the no-row catch-22 (§2.5 Seam C).
        return {kind: 'request-group-key', groupId: unwrapped.group.groupId, fromPeer: {userId: peer.userId, deviceId: peer.deviceId}};
      }
      if (parseResult.reason === 'tamper') {
        // MSG-01 — the inner group-message integrity check (HMAC over the
        // group master key) failed. The drop is INTENTIONAL and stays
        // (fail-closed, per the security contract) — we do NOT decrypt or
        // surface a possibly-forged body. But the OLD behaviour was a
        // silent drop: no notification, the sender looked unanswered, and
        // there was no diagnostic breadcrumb to correlate "X stopped
        // receiving from Y". We now (1) surface a clearer, actionable
        // message to the user and (2) emit a durable crashLog breadcrumb
        // tagging the peer + group so a desync (stale epoch / rolled key
        // after a reinstall) is traceable in release builds. We do NOT
        // auto-rekey here — forcing a group rekey on an integrity failure
        // is a key-distribution change that needs architecture sign-off
        // (and would be abusable as a rekey-amplification vector).
        console.warn('[group:recv] tamper detected — dropping envelope from', peer.userId);
        crashLog(
          `[group:recv] tamper DROP peer=${peer.userId.slice(0, 8)} ` +
          `group=${unwrapped.group.groupId.slice(0, 8)} ` +
          `env=${envelopeId?.slice(0, 8) ?? '-'}`,
        );
        useMessengerStore.getState().setError(
          'A group message failed its integrity check and was not shown. ' +
          'If this keeps happening, ask the sender to resend.',
        );
        // Handoff §3.6 — terminal drop (no stash): the message is
        // destroyed. Honest disposition for the sender + a persistent
        // gap marker in the group thread (content is generic — never
        // renders anything derived from the rejected ciphertext).
        if (envelopeId) {
          noteDestroyedEnvelope({envelopeId, reason: 'group-tamper', peer});
          // Audit P2-9 — no placeholder resurrection for blocked senders.
          if (!isPeerBlocked(peer.userId)) {
            const placeholder = insertDecryptFailurePlaceholder({
              conversationId: unwrapped.group.groupId, peer, envelopeId, reason: 'group-tamper',
            });
            if (placeholder && sqlMessages) {await sqlMessages.upsert(placeholder);}
          }
        }
        return;
      }
      if (parseResult.reason === 'no_key' && pendingGroupEnvelopes && envelopeId) {
        // Bug-hunt #3.A — durable stash. Runs INSIDE the receive txn so
        // the stash row, `seen_envelopes.markSeen` (already executed
        // above before the cert verify), and the relay ack commit
        // atomically. A crash between them would otherwise leave us
        // with a "seen" envelope-id but no row to drain — and the
        // relay's already going to redeliver, which the seen-gate
        // would then mistakenly drop.
        await pendingGroupEnvelopes.stash({
          envelopeId,
          groupId:      unwrapped.group.groupId,
          peerUserId:   peer.userId,
          peerDeviceId: peer.deviceId,
          sealed:       unwrapped,
          receivedAtMs: Date.now(),
        });
        crashLog(
          `[group:recv] no_key — stashed for groupId=${unwrapped.group.groupId.slice(0, 8)} ` +
          `env=${envelopeId.slice(0, 8)} (pending admin create/rekey)`,
        );
        // B-26(b) — the stash above is correct (fail-closed: we don't hold
        // the master key, so we never render the ciphertext), but the OLD
        // path returned SILENTLY. An established member who has lost the
        // group key then saw a blank thread with no explanation — the
        // message sits in the durable stash until an admin create/rekey
        // re-seeds the key (which, for a member who never persisted it,
        // needs an owner-side resync — a key-distribution change requiring
        // architecture sign-off; see B-26(a)). Surface the same visible
        // notice channel the tamper branch uses so the gap is explained,
        // not blank. The drain (replayGroupSealedDecode) fills the bubble in
        // once the key arrives.
        useMessengerStore.getState().setError(
          "Waiting for this group's encryption key — the message will appear once it syncs.",
        );
        // Handoff §2.7-2 — a brand-new member has no inbox row yet (its only
        // writer is the owner's `create`, which may be lost/in-flight). Show
        // the thread in a syncing state so the group isn't invisible AND the
        // row-walking self-heal triggers (WS-connect resync, ChatScreen-open
        // resync) become reachable.
        upsertKeylessGroupPlaceholder(unwrapped.group.groupId, peer);
        // Self-heal — actively request a re-share from the owner/admins
        // (post-txn; rate-limited). The owner re-DELIVERS the current key
        // over a fresh pairwise session and the stash drains.
        // `fromPeer` breaks the no-row catch-22 (§2.5 Seam C).
        return {kind: 'request-group-key', groupId: unwrapped.group.groupId, fromPeer: {userId: peer.userId, deviceId: peer.deviceId}};
      }
      // malformed / not_group / (no_key with no stash store on loopback
      // runtime) → legacy plaintext path. Older clients (ops console,
      // server-created mission groups before key distribution) ship
      // plaintext bodies here.
      //
      // B-25 — a sender lacking the group master key ships the inner
      // GroupMessageEnvelope as PLAINTEXT JSON (send path:
      // `sealedBody = masterKey ? groupEncrypt(...) : innerEnvelope`).
      // parseGroupMessage returns `malformed` for it (Audit P0-G2 rejects
      // unencrypted kind:text at the crypto layer), so it lands here with
      // `unwrapped.body` holding the whole inner-envelope JSON string.
      // Rendering it verbatim showed raw JSON in the bubble and leaked the
      // internal groupId/clientMsgId. unwrapPlaintextGroupInnerBody pulls the
      // inner `.body` for THIS group; a genuine bare-string plaintext body
      // (ops/mission) passes through unchanged. Presentation only — the
      // crypto gate already ran and is not weakened.
      //
      // Audit P1-4 (2026-07-09) — membership gate for the legacy/malformed
      // fall-through. The P1-N4 isGroupMember drop below only guards the
      // master-key-decrypted path; without this gate any authenticated
      // sender (incl. a member removed via remove+rekey) could seal a
      // plaintext/malformed group body and have it RENDER into the group
      // thread — auto-creating the group row on devices that never joined.
      // When we hold local GroupState, require current membership; when we
      // don't, require the EXISTING conversation row's participant list to
      // contain the sender. Never auto-create a group row from this branch.
      {
        const legacySenderAllowed = existing
          ? isGroupMember(existing, peer.userId)
          : ((store.conversations[conversationId]?.participants ?? []).includes(peer.userId));
        if (!legacySenderAllowed) {
          console.warn(`[group:recv] DROP legacy text — peer=${peer.userId.slice(0, 8)} not a member of groupId=${unwrapped.group.groupId.slice(0, 8)}`);
          crashLog(`[group:recv] P1-4 legacy nonmember DROP peer=${peer.userId.slice(0, 8)} group=${unwrapped.group.groupId.slice(0, 8)} env=${envelopeId?.slice(0, 8) ?? '-'}`);
          // Honest disposition — deliberately dropped, will never render.
          if (envelopeId) {
            noteDestroyedEnvelope({envelopeId, reason: 'group-nonmember-legacy', peer});
          }
          return;
        }
      }
      // Audit P2-9 — blocked group senders don't render via the legacy
      // branch either. Mirrors the 1:1 M-07 drop: crypto/ratchet handling
      // already completed identically, only the render is suppressed.
      if (isPeerBlocked(peer.userId)) {
        console.log('[group:recv.legacy.blocked] peer=' + peer.userId.slice(0, 8));
        return;
      }
      const legacyMsg: LocalMessage = {
        id:               unwrapped.clientMsgId ?? makeId(),
        conversation_id:  conversationId,
        sender_id:        peer.userId,
        type:             attachmentMessageType(unwrapped.attachment),
        content:          unwrapPlaintextGroupInnerBody(unwrapped.body, unwrapped.group.groupId),
        media_mime:       unwrapped.attachment?.mimeType,
        media_object_key: unwrapped.attachment?.objectKey,
        // Round 8 — capture the per-file AES key + IV on the
        // received row so attachments survive a backup-restore.
        media_key:        unwrapped.attachment?.keyB64,
        media_iv:         unwrapped.attachment?.ivB64,
        media_meta:       attachmentMediaMeta(unwrapped.attachment),
        status:           'delivered',
        is_encrypted:     true,
        created_at:       new Date().toISOString(),
        peer,
        envelope_id:      envelopeId,
        expires_at:       unwrapped.expiresAtSec ? unwrapped.expiresAtSec * 1000 : undefined,
        reply_to_msg_id:  unwrapped.replyTo?.msgId,
        reply_to_preview: unwrapped.replyTo?.preview,
      };
      store.appendMessage(conversationId, legacyMsg);
      // Audit P0-N14 — synchronous persist BEFORE we exit the txn,
      // so the COMMIT flushes ratchet + plaintext together.
      if (sqlMessages) {await sqlMessages.upsert(legacyMsg);}
      return;
    }
    const inner = parseResult.envelope;

    if (inner.kind === 'admin' && inner.adminAction) {
      const action = inner.adminAction;
      console.log('[group-create:recv] admin action type=', action.type, 'from peer=', peer.userId);
      // Self-heal — a member that lost the group key asks us to re-share it.
      // We can only help if we hold this group's state; the factory handler
      // then enforces owner-gating (only the owner can mint a verifying
      // create signature), roster-gating (never re-share to a non-member),
      // and per-(group,requester) rate-limiting. Never mutates state.
      if (action.type === 'key-request') {
        // Fail-closed: only react if WE hold this group's state AND the
        // requester is a CURRENT member. The roster-gate in
        // reshareGroupKeyState is the authoritative anti-leak control, but
        // gating here too means a non-member's (or removed member's)
        // request does NOT make us fetch a cert, sign a create, or spin up
        // a session — shrinking the amplification surface to real members.
        if (existing && isGroupMember(existing, peer.userId)) {
          return {kind: 'reshare-group-key', groupId: existing.groupId, toUserId: peer.userId};
        }
        return;
      }
      if (action.type === 'create') {
        // First time seeing this group; the sender shipped the full
        // initial state including the master key. The cert chain is
        // already verified above (verifySenderCert). Round 5 / Security
        // S4 — additionally verify the creatorSignature so a stolen
        // cert can't be paired with a substituted member list / master
        // key. We require the sender to be the owner of the group
        // they're creating (anyone can encrypt and ship a "create" via
        // someone else's session, but only the owner's identity priv
        // key produces a verifying signature).
        let sigCheck: {ok: true} | {ok: false; reason: string};
        if (action.state.owner === peer.userId) {
          // Owner is the sender — verify the create signature against the
          // sender's (= owner's) authenticated cert identity.
          sigCheck = await verifyGroupCreateSignature({
            state:                action.state,
            senderIdentityKeyB64: claims.senderIdentityKey,
            creatorSignature:     action.creatorSignature,
          });
          if (!sigCheck.ok) {
            if (sigCheck.reason === 'missing') {
              // Legacy v1 sender — accept under the rollout-window policy.
              console.warn(`[group-create:recv] WARNING legacy unsigned create from peer=${peer.userId}`);
            } else {
              console.warn(`[group-create:recv] DROP create — sig-check ${sigCheck.reason} from peer=${peer.userId}`);
              useMessengerStore.getState().setError('Group create sig invalid — dropped');
              return;
            }
          }
        } else {
          // Audit G-05 (2026-07-02): a MEMBER relayed the OWNER's signed create
          // (owner offline → they can't self-heal a keyless member). This is
          // NOT a forgery vector: verify the creatorSignature against the
          // OWNER's identity key — only a genuine owner signature verifies, and
          // it covers (groupId, members, masterKeyB64, epoch), so a stale sig
          // from before a rekey fails to verify and the relay harmlessly drops.
          // A missing signature is NOT accepted for a relay (unlike the legacy
          // owner path) — a relayed create MUST carry a real owner signature.
          let ownerIdKeyB64: string | undefined;
          try {
            // Resolve the OWNER's identity key (local trust row first, then the
            // authority-signed bundle on cold contact) — the same resolver the
            // rest of doHandleIncoming uses for cert continuity.
            ownerIdKeyB64 = keys
              ? await resolveExpectedSenderIdentity({userId: action.state.owner, deviceId: 1}, ownStore, keys, peerIdentityCache)
              : undefined;
          } catch { /* keys unavailable — can't verify the relay */ }
          if (!ownerIdKeyB64) {
            console.warn(`[group-create:recv] DROP relayed create — owner identity unavailable groupId=${action.state.groupId.slice(0, 8)}`);
            return;
          }
          sigCheck = await verifyGroupCreateSignature({
            state:                action.state,
            senderIdentityKeyB64: ownerIdKeyB64,
            creatorSignature:     action.creatorSignature,
          });
          if (!sigCheck.ok) {
            console.warn(`[group-create:recv] DROP relayed create — owner-sig ${sigCheck.reason} groupId=${action.state.groupId.slice(0, 8)} relayer=${peer.userId.slice(0, 8)}`);
            return;
          }
          console.log(`[group-create:recv] G-05 accepted relayed owner-signed create for ${action.state.groupId.slice(0, 8)} via member ${peer.userId.slice(0, 8)}`);
        }
        // MISSION-GROUP G1 (epoch-monotonicity) — `create` bootstraps a group,
        // but for an externally-assigned id (the mission Ops Room) the id is
        // fixed and well-known, so a stale/duplicate signed `create` could be
        // replayed to OVERWRITE an advanced group: rolling the epoch back,
        // re-admitting removed members, and resetting the master key. Never
        // install a create that isn't strictly newer than what we already hold —
        // accept only when we have no local state for this group, or the incoming
        // epoch is higher. Also converges duplicate same-epoch creates on the
        // first writer (not the last), closing the B-35-class divergence window.
        // B-41 — keyless-placeholder bootstrap exception. The epoch guard must
        // NOT reject a create when we hold NO master key for this group yet.
        // A member can end up with a keyless state at an equal/higher epoch:
        // e.g. it received an `add` admin action that advanced its epoch, or a
        // synthetic key-request stub, but never the key itself. The owner then
        // re-broadcasts the keyed state as a `create` at its CURRENT epoch
        // (ensureCallGroupKey resync — no epoch bump), which `epoch <= existing`
        // would drop as "stale" — leaving the member permanently keyless: group
        // messages never decrypt and group calls die at the key-wait ("Call
        // failed", joiner joins the room but never produces). Accepting it is
        // NOT a downgrade: the create is owner-signature-verified above, and
        // there is no established keyed state to roll back. Only enforce
        // epoch-monotonicity (the replay / re-admit-removed-member / key-reset
        // defence) once we actually hold a key worth protecting.
        if (existing && existing.masterKeyB64 && action.state.epoch < existing.epoch) {
          console.warn(`[group-create:recv] DROP stale/replayed create for ${action.state.groupId} — epoch ${action.state.epoch} < local ${existing.epoch}`);
          return;
        }
        // Audit G-04 (2026-07-02): SAME-epoch heal. A member forked at the
        // same epoch but holding a DIFFERENT master key (B-35 owner-reinstall /
        // duplicate-create race) could never be repaired — the old `<=` guard
        // dropped the owner's re-shared `create` (which re-delivers the key at
        // the CURRENT epoch, no bump). Accept a same-epoch create ONLY when it
        // carries a VALID owner signature (sigCheck.ok — NOT the legacy-unsigned
        // bypass) and the key actually differs. This is not a downgrade: the
        // epoch is unchanged, only the owner can produce a verifying signature,
        // and there is exactly one canonical key per epoch, so replacing
        // converges the fork onto the owner's key rather than rolling anything
        // back. An identical-key same-epoch create is an idempotent duplicate.
        if (existing && existing.masterKeyB64 && action.state.epoch === existing.epoch) {
          if (action.state.masterKeyB64 === existing.masterKeyB64) {
            // Idempotent duplicate — but it can still REPAIR a lost inbox
            // row: a device can hold groups[gid] crypto state while missing
            // conversations[gid] (the original create's row write lost to a
            // persist race, or a pre-fix install). The early return used to
            // precede the upsert, so redelivery could never fix an
            // invisible group (handoff §2.5 Seam A). Repair from the
            // locally-trusted `existing` state, never the wire copy.
            if (existing.name !== 'Call' &&
                !useMessengerStore.getState().conversations[action.state.groupId]) {
              upsertGroupConversationFromState(existing, peer.userId);
            }
            return;
          }
          if (!sigCheck.ok) {
            console.warn(`[group-create:recv] DROP same-epoch create for ${action.state.groupId} — unsigned, cannot heal a fork without owner auth`);
            return;
          }
          // Audit MEDIUM-2 — rollback guard. If this "new" key is one we already
          // superseded at this group, a (valid-but-stale) owner-create is being
          // replayed to roll us BACK to a retired key. There is no ordering
          // field in the signed bytes to catch this, so refuse a key we know is
          // older. A genuine forward heal always presents a fresh key.
          if (isGroupKeySuperseded(action.state.groupId, action.state.masterKeyB64)) {
            console.warn(`[group-create:recv] DROP same-epoch create for ${action.state.groupId} — key already superseded (rollback attempt)`);
            return;
          }
          // Record the key we're leaving as superseded so it can never be
          // re-installed by a later replay.
          markGroupKeySuperseded(action.state.groupId, existing.masterKeyB64);
          console.log(`[group-create:recv] G-04 same-epoch owner-signed HEAL — converging forked key for ${action.state.groupId} at epoch ${action.state.epoch}`);
          // fall through to setGroupState — replaces the divergent key
        }
        if (existing && !existing.masterKeyB64 && action.state.epoch < existing.epoch) {
          console.log(`[group-create:recv] keyless-placeholder bootstrap — accepting create epoch ${action.state.epoch} < local ${existing.epoch} (no local key to protect)`);
        }
        console.log('[group-create:recv] CREATE for groupId=', action.state.groupId, 'name=', JSON.stringify(action.state.name), 'members=', Object.keys(action.state.members));
        // Audit G-05 — persist the owner's create signature so THIS member can
        // later relay it to a keyless peer if the owner is offline.
        store.setGroupState(action.creatorSignature
          ? {...action.state, creatorSigB64: action.creatorSignature}
          : action.state);
        // BS-CALL-ADHOC — an ad-hoc call key arrives as a `'Call'`-named
        // group create. The recipient's useGroupCall for an escalated 1:1
        // keys the FrameCryptor off `direct:<host>`, so alias the master
        // key under that id too. Harmless for real groups (different name).
        if (action.state.name === 'Call') {
          try {
            useMessengerStore.getState().setGroupState({
              ...action.state,
              groupId: `direct:${action.state.owner}`,
            });
          } catch { /* alias best-effort — host path still works */ }
        }
        // ALSO upsert the conversation row so the chat appears in
        // this user's inbox. Without this the receiver's groupState
        // is populated but no `conversations[groupId]` entry exists,
        // so MessengerHomeScreen renders nothing — exactly the bug
        // where "Sirajul created a group but I don't see it on my
        // side". Mirrors the sender's createGroupChat upsert shape.
        //
        // BS-CALL-GHOST — but NOT for an ad-hoc `'Call'` group. Those are
        // transient call-key carriers (ensureCallGroupKey mints a fresh
        // 'Call' group per escalated 1:1 call); the key + its direct:<owner>
        // alias are already filed above. Upserting them too dropped a
        // permanent "Call" entry into the recipient's chat list — and since
        // every call/retry mints a NEW groupId, they ACCUMULATED (2 retries
        // = 2 ghost "Call" chats). The host never upserts these (setGroupState
        // only), so it was recipient-only. Skip the inbox row; the call still
        // works (it reads the key, not the conversation).
        if (action.state.name !== 'Call') {
          // Handoff §2.7-3/-5 — shared single writer; preserves local-only
          // fields (unread/mute/pin/custom name/last_message) when the row
          // already exists, so a re-shared create doesn't reset them.
          upsertGroupConversationFromState(action.state, peer.userId);
        }
        // Bug-hunt #3.B — `create` is the first time we hold the master
        // key for this group. Any text envelope that arrived before this
        // moment was stashed via the no_key branch above; signal the
        // outer wrapper to drain it AFTER the txn commits. Per-row
        // replay runs in its own fresh txn (no SQLite write lock held
        // when this returns).
        return {kind: 'drain-group', groupId: action.state.groupId};
      } else if (existing) {
        // Audit fix #26 — pass the verified sender userId so admin
        // gating works. Non-admin actions are silently no-op'd by
        // applyAdminAction.
        const next = applyAdminAction(existing, action, peer.userId);
        // Bug-hunt #5 — telemetry on stale-epoch admin no-ops. The
        // reducer drops actions where `atEpoch !== state.epoch` (out-
        // of-order delivery, or non-admin sender) by returning the
        // SAME state reference. Without this breadcrumb, a recipient
        // who processed step 2 (rekey @ E+1) before step 1 (add @ E)
        // would silently desync — `next === existing` here means the
        // local state stayed at E while the rest of the group moved
        // to E+2. Surface so operators can correlate "group X stopped
        // decrypting" reports with the underlying ordering bug.
        if (next === existing) {
          // Audit P1-G6 — disambiguate the no-op reason so operators
          // don't have to guess between "stale epoch" and "non-admin
          // sender." `leave` is the only action that doesn't need admin
          // rights; for everything else, compute the gate decision here
          // so the breadcrumb names the actual cause.
          const stateEpoch = existing.epoch;
          const actionWithEpoch = action as {type: string; atEpoch?: number};
          const senderIsAdmin = existing.members[peer.userId]?.admin === true;
          const senderIsMember = existing.members[peer.userId] !== undefined;
          let reason: string;
          if (action.type === 'leave' && !senderIsMember) {
            reason = 'leaver-not-member';
          } else if (action.type !== 'leave' && !senderIsAdmin) {
            reason = 'non-admin-sender';
          } else if (typeof actionWithEpoch.atEpoch === 'number' && actionWithEpoch.atEpoch !== stateEpoch) {
            reason = `stale-epoch action=${actionWithEpoch.atEpoch} state=${stateEpoch}`;
          } else {
            reason = 'unknown';
          }
          crashLog(
            `[group-admin] dropped ${actionWithEpoch.type} action: ` +
            `sender=${peer.userId.slice(0, 8)} ` +
            `reason=${reason}`,
          );
          // Bug-hunt #3.D — stash stale-epoch actions so the NEXT admin
          // commit that advances local state can replay them. Only stash
          // the stale-epoch family (the others are genuine policy drops
          // — non-admin sender or non-member leaver — replay won't help
          // and the receiver would just keep dropping the same row).
          if (
            pendingAdminActions &&
            reason.startsWith('stale-epoch') &&
            typeof actionWithEpoch.atEpoch === 'number'
          ) {
            await pendingAdminActions.stash({
              groupId:      existing.groupId,
              actionEpoch:  actionWithEpoch.atEpoch,
              senderUserId: peer.userId,
              action,
              receivedAtMs: Date.now(),
            });
          }
        }
        store.setGroupState(next);
        // Audit G-03 (2026-07-02): a voluntary `leave` bumps the epoch but does
        // NOT rotate the master key (the leaver can't authorize the rekey), so
        // the departed member keeps a valid key and could read post-leave
        // messages. Have a DESIGNATED remaining admin rekey the group so the
        // key rotates. Deterministic: owner-if-still-a-member, else the
        // lowest-userId remaining admin — and deriveRekeyMasterKey is itself
        // deterministic, so even a designation race converges on one key (no
        // fork). Fires only when the leave actually changed state.
        if (action.type === 'leave' && next !== existing) {
          const admins = Object.entries(next.members)
            .filter(([, m]) => (m as {admin?: boolean}).admin)
            .map(([uid]) => uid)
            .sort();
          const designated = (next.members[next.owner] && (next.members[next.owner] as {admin?: boolean}).admin)
            ? next.owner
            : admins[0];
          if (designated && designated === config.ownUserId && next.masterKeyB64) {
            const leaverId = (action as {type: 'leave'; userId?: string}).userId ?? peer.userId;
            emitGroupKeySignal({kind: 'leave-rekey', groupId: next.groupId, leaverId});
          }
        }
        // Audit P0-G2 — when an admin action rotates the master key
        // (rekey, or a future addAndRekey planner), evict the old
        // CryptoKey from the in-process cache. Reasoning identical to
        // the send-side dispose above — we MUST NOT let the previous
        // key linger in cache, because a replay of pre-rekey ciphertext
        // would otherwise decrypt cleanly. Compare masterKeyB64 so we
        // only dispose when it actually changed (non-rekey actions —
        // add/remove/rename — leave the key intact).
        if (existing.masterKeyB64 !== next.masterKeyB64) {
          disposeGroupKey(existing.masterKeyB64);
          // Bug-hunt #3.B — master key rotated; drain any pending
          // group envelopes that were waiting for this rekey to land.
          // Signal the outer wrapper to run the drain after the txn
          // commits.
          return {kind: 'drain-group', groupId: existing.groupId};
        }
      }
      // Admin messages don't render in the chat list.
      return;
    }

    // Audit P1-N4 — drop text envelopes from senders that aren't
    // members of the group at the receiver's CURRENT epoch.
    //
    // A removed member still holds the prior master key on their
    // device; if they queue a text envelope before being removed and
    // it arrives after the remove+rekey lands locally, parseGroupMessage
    // will FAIL to decrypt (we already rotated the key) and we drop
    // via `reason: 'tamper'` above. But two race windows still leak:
    //
    //   (a) The remove hasn't been processed yet on this receiver —
    //       parseGroupMessage decrypts under the OLD key. Without this
    //       gate the removed peer's late text would still render.
    //   (b) The sender is racing the admin event from a peer that
    //       hasn't applied `remove` yet (out-of-order delivery) and is
    //       broadcasting under the still-valid old key.
    //
    // Either way: a `text` envelope from someone NOT in `existing.members`
    // (at our current epoch) should drop silently. The cert chain says
    // the peer is who they claim to be, but they aren't a member, so
    // the message has no place in the group thread.
    if (existing && !isGroupMember(existing, peer.userId)) {
      console.warn(`[group:recv] DROP text — peer=${peer.userId} not a member of groupId=${unwrapped.group.groupId.slice(0, 8)} at epoch=${existing.epoch}`);
      return;
    }

    // Audit G-08 (2026-07-02): compare the sender's membership transcript hash
    // (P1-G1) against ours. A mismatch at the SAME epoch means the two members
    // applied a DIFFERENT admin sequence — a fork / equivocation (e.g. a
    // server/admin sent us {add Bob} but them {add Eve}). Detection-only: we
    // surface a diagnostic and still render (a benign out-of-order delivery
    // also mismatches transiently and settles on the next admin action). This
    // is the comparison the P1-G1 transcript hash was built for but never did.
    const senderTH = (unwrapped.group as {senderTranscriptHash?: string} | undefined)?.senderTranscriptHash;
    if (existing && senderTH && existing.transcriptHash && senderTH !== existing.transcriptHash) {
      // Divergence: either a genuine fork/equivocation, or a benign transient
      // (one side hasn't applied a recent admin action yet). crashLog only —
      // never a user-facing error and never a drop.
      crashLog(`[group:recv] G-08 transcript divergence groupId=${unwrapped.group.groupId.slice(0, 8)} sender=${peer.userId.slice(0, 8)} local=${existing.transcriptHash.slice(0, 12)} theirs=${senderTH.slice(0, 12)} epoch=${existing.epoch}`);
    }

    // Text message
    const groupMsg: LocalMessage = {
      id:               unwrapped.clientMsgId ?? makeId(),
      conversation_id:  conversationId,
      sender_id:        peer.userId,
      // GROUP MEDIA FIX — render an image/video/doc when the sealed payload
      // carried an attachment (was hardcoded 'text', so group media never
      // appeared even after the send-side fix). Mirrors the legacy-plaintext
      // and 1:1 receive rows: derive the type + carry the per-file AES key +
      // IV + object key so the attachment downloads and decrypts.
      type:             attachmentMessageType(unwrapped.attachment),
      content:          inner.body,
      media_mime:       unwrapped.attachment?.mimeType,
      media_object_key: unwrapped.attachment?.objectKey,
      media_key:        unwrapped.attachment?.keyB64,
      media_iv:         unwrapped.attachment?.ivB64,
      media_meta:       attachmentMediaMeta(unwrapped.attachment),
      status:           'delivered',
      is_encrypted:     true,
      // Audit MSG-09 — stamp SEND time from the authenticated aad.ts (now
      // valid up to the 30-day relay dwell, MSG-01) so a message drained after
      // reconnect sorts by when it was SENT, not when it was received.
      // appendMessage's binary-splice handles out-of-order insertion.
      created_at:       new Date(typeof unwrapped.aad?.ts === 'number' ? unwrapped.aad.ts : Date.now()).toISOString(),
      peer,
      envelope_id:      envelopeId,
      expires_at:       unwrapped.expiresAtSec ? unwrapped.expiresAtSec * 1000 : undefined,
      reply_to_msg_id:  unwrapped.replyTo?.msgId,
      reply_to_preview: unwrapped.replyTo?.preview,
    };
    // M-08 — don't let the sealed-archive replay resurrect a group message the
    // user deleted before reinstalling.
    if (isRestoreTombstoned(groupMsg.id)) {
      console.log('[group:recv.tombstoned] msgId=' + groupMsg.id.slice(0, 8));
      return;
    }
    // Audit P2-9 — blocked group senders' messages don't render. Mirrors
    // the 1:1 M-07 drop below: crypto/ratchet handling already completed
    // identically (decrypt + txn commit + seen/ack), only the render is
    // suppressed so the blocked peer can't reach the user through groups.
    if (isPeerBlocked(peer.userId)) {
      console.log('[group:recv.blocked] peer=' + peer.userId.slice(0, 8));
      return;
    }
    store.appendMessage(conversationId, groupMsg);
    // Audit P0-N14 — synchronous persist BEFORE we exit the txn.
    if (sqlMessages) {await sqlMessages.upsert(groupMsg);}
    return;
  }

  // Reaction envelopes don't create a new message — they patch an
  // existing one's `reactions` map. Body is empty in this branch.
  if (unwrapped.reaction) {
    // Audit P2-9 — M-07 gate BEFORE the reaction is applied (previously a
    // blocked peer's reaction patched the bubble unimpeded).
    if (isPeerBlocked(peer.userId)) {
      console.log('[recv.reaction.blocked] peer=' + peer.userId.slice(0, 8));
      return;
    }
    applyReaction(
      conversationId,
      peer.userId,
      unwrapped.reaction.targetMsgId,
      unwrapped.reaction.emoji,
      unwrapped.reaction.remove ?? false,
    );
    return;
  }

  const oneToOneMsg: LocalMessage = {
    id:                unwrapped.clientMsgId ?? makeId(),
    conversation_id:   conversationId,
    sender_id:         peer.userId,
    type:              attachmentMessageType(unwrapped.attachment),
    content:           unwrapped.body,
    media_mime:        unwrapped.attachment?.mimeType,
    media_object_key:  unwrapped.attachment?.objectKey,
    // Round 8 — preserve the attachment key + IV.
    media_key:         unwrapped.attachment?.keyB64,
    media_iv:          unwrapped.attachment?.ivB64,
    media_meta:        attachmentMediaMeta(unwrapped.attachment),
    status:            'delivered',
    is_encrypted:      true,
    // Audit MSG-09 — send time from the authenticated aad.ts (see group path).
    created_at:        new Date(typeof unwrapped.aad?.ts === 'number' ? unwrapped.aad.ts : Date.now()).toISOString(),
    peer,
    envelope_id:       envelopeId,
    expires_at:        unwrapped.expiresAtSec ? unwrapped.expiresAtSec * 1000 : undefined,
    reply_to_msg_id:   unwrapped.replyTo?.msgId,
    reply_to_preview:  unwrapped.replyTo?.preview,
  };
  const bodyLen = oneToOneMsg.content?.length ?? 0;
  // M-07 — drop an inbound message from a blocked peer; appendMessage would
  // otherwise resurrect the conversation the user just blocked. M-08 — drop a
  // message the user deleted before reinstalling that the sealed-archive replay
  // is re-delivering. The envelope is still marked seen/acked by the caller so
  // the relay stops re-pushing it.
  if (isPeerBlocked(peer.userId)) {
    console.log('[recv.text.append.blocked] peer=' + peer.userId.slice(0, 8));
    return;
  }
  if (isRestoreTombstoned(oneToOneMsg.id)) {
    console.log('[recv.text.append.tombstoned] msgId=' + oneToOneMsg.id.slice(0, 8));
    return;
  }
  console.log('[recv.text.append] convId=' + conversationId.slice(0, 16) + ' msgId=' + oneToOneMsg.id.slice(0, 8) + ' bodyLen=' + bodyLen);
  useMessengerStore.getState().appendMessage(conversationId, oneToOneMsg);
  // Re-read to confirm the append landed in the slice ChatScreen subscribes to.
  const afterCount = useMessengerStore.getState().messages[conversationId]?.length ?? -1;
  console.log('[recv.text.append.after] convId=' + conversationId.slice(0, 16) + ' messagesCount=' + afterCount);
  // Audit P0-N14 — synchronous persist BEFORE the txn COMMITs.
  if (sqlMessages) {await sqlMessages.upsert(oneToOneMsg);}
}

/**
 * Fold a reaction patch into an existing local message. The message
 * might not exist yet (out-of-order delivery of reaction-before-target
 * during catch-up) — in that case we silently drop; the reactor can
 * react again once both sides are back in sync, and the second reaction
 * will land after the target has been stored.
 */
function applyReaction(
  conversationId: string,
  fromUserId:    string,
  targetMsgId:   string,
  emoji:         string,
  remove:        boolean,
): void {
  const store = useMessengerStore.getState();
  const list  = store.messages[conversationId];
  if (!list) {return;}
  // Find target by the sender-chosen opaque id we store when encoding.
  // We key reply_to_msg_id off the same id, so the lookup pattern is
  // the "clientMsgId" of the target — recorded on the target via the
  // local message's `id` field on the OUTGOING side. On the peer's
  // side we can't trivially recover that id unless they put it on
  // the originating envelope. For Phase-1 we search by message.id
  // which is generated on RECEIVE for incoming messages — callers
  // who want cross-peer reactions must use reply_to_msg_id routing
  // (the plaintext `replyTo.msgId` we now carry).
  const msg = list.find(m => m.id === targetMsgId || m.reply_to_msg_id === targetMsgId);
  if (!msg) {return;}
  const next: Record<string, string> = {...(msg.reactions ?? {})};
  if (remove) {delete next[fromUserId];}
  else        {next[fromUserId] = emoji;}
  store.updateMessageReactions(conversationId, msg.id, next);
}

/**
 * Replay every outbox row that's due for a retry. Called on every
 * `socket.on('connect')` and once at startup (in case the previous
 * session crashed mid-send). Uses the HTTP relay path because:
 *   - It's synchronous: success/failure is immediate, no 5s watchdog.
 *   - It returns a server-side dedupe-friendly retractToken.
 *   - The WS path was the one that originally lost the message; not
 *     ideal to retry through the same fragile channel.
 *
 * Concurrency: serialised — multiple connect events would otherwise
 * each kick off their own drain and race on the same row. A
 * module-level boolean is the right size for this.
 */
/**
 * A4 — a DEFERRED outbox row. Written by the group fan-out when a peer's
 * session/seal/encrypt failed at send time, so there is NO ready outerSealed.
 * The drain re-establishes the session and re-seals with a FRESH AAD timestamp
 * via the injected `reseal` callback, then ships. Distinguished from a normal
 * sealed row by `deferred: true`. The stored `sealedBody` is the group
 * master-key-wrapped inner envelope (reused as-is); only the per-peer
 * sealed-sender outer wrap is re-minted.
 */
interface DeferredOutboxPayload {
  deferred:     true;
  sealedBody:   string;
  expiresAtSec?: number;
  attachment?:  SealedAttachment;
  groupId:      string;
  kind:         'text' | 'admin';
  clientMsgId:  string;
}
type ResealDeferredFn = (
  row: {peerUserId: string; peerDeviceId: number; clientMsgId: string},
  payload: DeferredOutboxPayload,
) => Promise<{outerSealed: string; expiresAtSec?: number}>;

let drainOutboxInflight = false;
async function drainOutbox(
  outbox: SqlOutboxStore,
  relay:  RelayHttpClient,
  isOurEpoch: () => boolean,
  reseal?: ResealDeferredFn,
): Promise<void> {
  if (drainOutboxInflight) {return;}
  drainOutboxInflight = true;
  try {
    const rows = await outbox.dueRows();
    if (rows.length === 0) {return;}
    console.log(`[messenger.outbox] draining ${rows.length} row(s)`);
    for (const row of rows) {
      if (!isOurEpoch()) {return;}
      let payload: {outerSealed?: string; expiresAtSec?: number} & Partial<DeferredOutboxPayload>;
      try {
        payload = JSON.parse(row.payload) as typeof payload;
      } catch (e) {
        // Corrupted payload — drop the row so the drain doesn't loop
        // forever on it. Surface in logs so we can investigate.
        console.warn(`[messenger.outbox] dropping corrupt row ${row.clientMsgId}:`, asErrorMessage(e));
        await outbox.markDelivered(row.clientMsgId, row.peerUserId, row.peerDeviceId);
        continue;
      }
      try {
        // A4 — resolve the outer sealed envelope. A DEFERRED row has none yet:
        // re-seal it now (fresh session + fresh AAD timestamp) via the injected
        // crypto callback. If the callback is absent (no crypto context) leave
        // the row for a drain that has it. A re-seal throw (peer STILL
        // unprovisioned) falls to the catch below → recordAttempt → next drain.
        let outerSealed: string;
        let expiresAtSec: number | undefined;
        if (payload.deferred) {
          if (!reseal) { continue; }
          const sealedNow = await reseal(
            {peerUserId: row.peerUserId, peerDeviceId: row.peerDeviceId, clientMsgId: row.clientMsgId},
            payload as DeferredOutboxPayload,
          );
          outerSealed  = sealedNow.outerSealed;
          expiresAtSec = sealedNow.expiresAtSec;
        } else if (payload.outerSealed) {
          outerSealed  = payload.outerSealed;
          expiresAtSec = payload.expiresAtSec;
        } else {
          // Neither a sealed nor a deferred row — corrupt shape. Drop it.
          console.warn(`[messenger.outbox] dropping row with no payload ${row.clientMsgId}`);
          await outbox.markDelivered(row.clientMsgId, row.peerUserId, row.peerDeviceId);
          continue;
        }
        const r = await relay.send({
          recipient:    {userId: row.peerUserId, deviceId: row.peerDeviceId},
          outerSealed,
          clientMsgId:  row.clientMsgId,
          expiresAtSec,
        });
        // Success — flip UI + drop the row. updateMessageStatus is
        // idempotent if the original send already flipped to 'sent'
        // (e.g. WS path won the race).
        useMessengerStore.getState().updateMessageStatus(
          row.conversationId, row.messageId, 'sent',
        );
        if (r.retractToken) {
          useMessengerStore.getState().updateMessageRetractToken(
            row.conversationId, row.messageId, r.retractToken,
          );
        }
        // Audit MSG-03 — record the envelopeId so delivered/read ticks fire
        // for outbox-drained (reconnect) sends too.
        if (r.envelopeId) {
          useMessengerStore.getState().updateMessageEnvelopeId(
            row.conversationId, row.messageId, r.envelopeId,
          );
        }
        await outbox.markDelivered(row.clientMsgId, row.peerUserId, row.peerDeviceId);
      } catch (e) {
        const {attempts, failed} = await outbox.recordAttempt(row.clientMsgId, row.peerUserId, row.peerDeviceId);
        console.warn(`[messenger.outbox] retry failed clientMsgId=${row.clientMsgId} peer=${row.peerUserId}/${row.peerDeviceId} attempts=${attempts} terminal=${failed}: ${asErrorMessage(e)}`);
        if (failed) {
          // L17 — don't DOWNGRADE a bubble that already reached at least one
          // peer. In a group, one permanently-unprovisioned member exhausting
          // MAX_ATTEMPTS must not flip the whole message to 'failed' when the
          // other members received it (the send path already set 'sent', or a
          // sibling peer-row drained to 'sent'). Only surface 'failed' when the
          // message never reached anyone — i.e. it is still 'sending'.
          const cur = useMessengerStore.getState()
            .messages[row.conversationId]?.find(m => m.id === row.messageId);
          if (cur?.status === 'sending') {
            useMessengerStore.getState().updateMessageStatus(
              row.conversationId, row.messageId, 'failed',
            );
          }
        }
      }
    }
  } finally {
    drainOutboxInflight = false;
  }
}

async function drainRelay(
  own: SessionManager,
  ownStore: CryptoStore,
  relay: RelayHttpClient,
  config: ProductionConfig,
  keys?: KeysHttpClient,
  nudgeAfterRebuild?: (peer: SessionAddress) => void | Promise<void>,
  /** Fix #11: passed through to handleIncoming for identity-cache eviction. */
  peerIdentityCache?: Map<string, {idKey: string; fetchedAt: number}>,
  /** Audit P0-N14 — shared SQLCipher handle for atomic receive. */
  txnDb?: TxnDbHandle | null,
  sqlMessages?: SqlMessageStore | null,
  /** Audit P0-N6 — persistent receive-side dedup. */
  seenEnvelopes?: SeenEnvelopeStore | null,
  /** Audit 1:1 P1-1 — cert revocation cache. */
  revokedJtiCache?: RevokedJtiCache | null,
  /** Bug-hunt #3 — pending stash threaded through to handleIncoming. */
  pendingGroupEnvelopes?: PendingGroupEnvelopeStore | null,
  pendingAdminActions?: PendingAdminActionStore | null,
): Promise<void> {
  // Fix #5: paginate. The previous version pulled ONCE with limit=50
  // and returned even when the server still had a backlog (e.g. user
  // was offline for a week and 200 envelopes piled up). Loop until
  // the server returns an empty page, with a hard cap of 10 iters
  // (= 500 envelopes) to avoid runaway if ack is silently failing.
  //
  // Restore-after-reinstall fix #4 — on the very first drain after a
  // fresh install (the AsyncStorage `bravo.relay.bootstrap-done` flag
  // is unset for this owner), pull with `bootstrap=true` so the server
  // raises the per-call cap to relay.maxBootstrapLimit (default 1000)
  // instead of the steady-state 100. Closes the gap where a multi-week
  // backlog only delivered the most-recent slice on a reinstall.
  const HARD_CAP_ITERATIONS = 10;
  const ownIdentity = await ownStore.getIdentityKeyPair();

  let bootstrap = false;
  const bootstrapKey = `bravo.relay.bootstrap-done.${config.ownUserId}`;
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const flag = await AsyncStorage.getItem(bootstrapKey);
    bootstrap = flag !== '1';
  } catch { /* AsyncStorage unavailable in tests — treat as not-bootstrap */ }

  for (let iter = 0; iter < HARD_CAP_ITERATIONS; iter++) {
    const pageLimit = (bootstrap && iter === 0) ? 1000 : 50;
    const {envelopes} = await relay.pull({
      limit:     pageLimit,
      bootstrap: bootstrap && iter === 0,
    });
    if (envelopes.length === 0) {
      // Mark bootstrap-done on the FIRST successful empty drain.
      if (bootstrap) {
        try {
          const AsyncStorage = require('@react-native-async-storage/async-storage').default;
          await AsyncStorage.setItem(bootstrapKey, '1');
        } catch { /* ignore */ }
      }
      return;
    }
    for (const env of envelopes) {
      let unwrapped;
      try {
        unwrapped = await unwrapOuter({
          ownIdentityPrivKey: ownIdentity.privKey,
          ownIdentityPubKey:  ownIdentity.pubKey,
          outerSealedB64:     env.outerSealed,
        });
      } catch (e) {
        // Drop unrecoverable envelopes — happens if a v1 message somehow
        // lingered past the rollout window or another client minted with
        // the wrong recipient key. ACK so we don't loop on the next pull.
        //
        // Diagnostic breadcrumb — same site as handleDeliver's unwrap
        // failure but on the HTTP catch-up path; correlate the two
        // counters in Crashlytics to know whether drops are biased to
        // push-deliver vs pull-deliver.
        crashLog(`[messenger] drainRelay-unwrap-failed envId=${env.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
        console.warn('[messenger] drainRelay unwrap failed', asErrorMessage(e));
        // Fix #5 — count toward the "missing-ratchet" telemetry.
        try {
          const {noteUndecryptable} = require('../backup/sessionRatchetRecovery') as
            typeof import('../backup/sessionRatchetRecovery');
          noteUndecryptable(`drain-unwrap:${asErrorMessage(e).slice(0, 40)}`);
        } catch { /* module not loaded yet — fine */ }
        // B-46 — surface the silent destruction (sender unknowable —
        // sealed wrap — so a banner count is the disclosure ceiling).
        try { useMessengerStore.getState().noteUndecryptableDrop(env.envelopeId); } catch { /* store mid-swap — fine */ }
        // 'discarded' — destroyed, sender unknown (inside the broken wrap).
        try { await relay.ack(env.envelopeId, env.ackToken, 'discarded'); } catch { /* swallow */ }
        continue;
      }
      // Audit P0-N6 — dedup gate on the HTTP catch-up path too. The
      // bootstrap drain (or the post-reconnect coalesced drain) is
      // exactly when the relay's flushPendingOnConnect re-pushes
      // every queued envelope, so without this we'd double-decrypt
      // the same ciphertext and corrupt the ratchet.
      if (seenEnvelopes && await seenEnvelopes.wasSeen(env.envelopeId)) {
        // Seen ⇒ a prior receive txn committed — honest 'delivered'.
        try { await relay.ack(env.envelopeId, env.ackToken, 'delivered'); } catch { /* swallow */ }
        continue;
      }
      // Audit P0-1 — same pre-decrypt cert verify as the WS deliver path
      // (see handleDeliver). On v3 wraps the outer GCM tag already
      // proved the cert in the wire matches what the sender used to
      // derive the AAD; we additionally verify the authority signature
      // (and identity continuity when we have a trust anchor) BEFORE
      // any decrypt is attempted. A bad cert drops the envelope here
      // without exposing the closeSession path.
      let drainTrustedPeer = unwrapped.sender;
      if (unwrapped.wireVersion === 3 && unwrapped.senderCert) {
        try {
          // Audit P0-8 — same TOFU-tightening as the WS deliver path.
          // Local trust row first, authority-signed bundle on cold
          // contact, undefined on dual failure (legacy availability).
          const drainExpectedIdentity = keys
            ? await resolveExpectedSenderIdentity(unwrapped.sender, ownStore, keys, peerIdentityCache)
            : await (async () => {
                const local = await ownStore.loadIdentityKey(
                  `${unwrapped.sender.userId}.${unwrapped.sender.deviceId}`,
                );
                return local ? toBase64(local) : undefined;
              })();
          const claims = await verifySenderCert({
            cert:                unwrapped.senderCert,
            authorityPubKeyB64:  config.authorityPubKeyB64,
            expectedIdentityKey: drainExpectedIdentity,
            // Audit 1:1 P1-1 — fresh-only revocation gating, see WS path.
            revokedJtis: revokedJtiCache?.isFresh() ? revokedJtiCache.snapshot() : undefined,
          });
          drainTrustedPeer = {
            userId:   claims.senderUserId,
            deviceId: claims.senderSignalDeviceId,
          };
        } catch (e) {
          // BS-CERT-MISMATCH fix: the original code did `throw e` here
          // for IdentityKeyMismatchError, intending to reach the refresh-
          // and-retry handler in the sequential try/catch below at line
          // ~4811. That never worked: a throw inside a for-loop body
          // exits the loop entirely — the handler was dead code from
          // this path. Fix: run the refresh inline here, then either
          // set drainTrustedPeer to continue, leave on relay, or
          // ACK-drop. The post-handleIncoming handler below still fires
          // for errors that come from handleIncoming itself (not here).
          if (e instanceof IdentityKeyMismatchError) {
            crashLog(`[P0-1] drain v3 cert mismatch envId=${env.envelopeId.slice(0, 8)} — running inline refresh`);
            if (keys) {
              const {refreshPeerIdentityIfRotated} = require('../crypto/peerIdentityRefresh') as
                typeof import('../crypto/peerIdentityRefresh');
              const outcome = await refreshPeerIdentityIfRotated(
                e.claims.senderUserId,
                e.claims.senderSignalDeviceId,
                e.claims.senderIdentityKey,
                keys,
                ownStore,
              );
              crashLog(`[messenger] drain-cert-pre-verify-rotation envId=${env.envelopeId.slice(0,8)} outcome=${outcome.result} reason=${outcome.reason ?? '-'}`);
              if (outcome.result === 'refreshed' && outcome.sessionReset) { void notePeerIdentityChanged(e.claims.senderUserId); }
              if (outcome.result === 'refreshed') {
                try {peerIdentityCache?.delete(`${e.claims.senderUserId}.${e.claims.senderSignalDeviceId}`);} catch { /* ignore */ }
                if (outcome.sessionReset) {
                  try { useMessengerStore.getState().setError("A contact's security code changed — their messages will resume on a new secure session."); } catch { /* ignore */ }
                }
                // Trust refreshed — set drainTrustedPeer from the
                // mismatch claims and fall through to handleIncoming.
                drainTrustedPeer = {userId: e.claims.senderUserId, deviceId: e.claims.senderSignalDeviceId};
              } else if (outcome.result === 'unavailable') {
                // Keys-service blip — leave on relay.
                continue;
              } else {
                // stale-cert / no-change — ACK-drop.
                try { await relay.ack(env.envelopeId, env.ackToken, 'discarded'); } catch { /* swallow */ }
                continue;
              }
            } else {
              // No keys client — cannot refresh; ACK-drop.
              try { await relay.ack(env.envelopeId, env.ackToken, 'discarded'); } catch { /* swallow */ }
              continue;
            }
          } else {
            crashLog(`[P0-1] drain v3 cert pre-verify failed envId=${env.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
            try { await relay.ack(env.envelopeId, env.ackToken, 'discarded'); } catch { /* swallow */ }
            continue;
          }
        }
      }

      // P0-1 Layer A — wrap handleIncoming so a single bad envelope
      // can't kill the entire drain. The previous code let any throw
      // (including the recoverable `sender identity key mismatch`)
      // propagate up; the drain's outer catch then logged the failure
      // ONCE and abandoned every later envelope in the same page. With
      // 1000-envelope bootstrap pulls this was a guaranteed silent
      // truncation after any peer rotated identity. See bravo_log_5564
      // / 5554 (May 23) for the live repro.
      //
      // On `IdentityKeyMismatchError`: refetch the peer's bundle from
      // the keys-service. If keys-service confirms the cert's claimed
      // identity, update local trust + retry handleIncoming ONCE under
      // the refreshed key. Cap at one retry to avoid loops.
      // Audit L16 (2026-07-02): honour the WS-path in-flight set here too. The
      // relay's flushPendingOnConnect re-pushes queued envelopes over the WS
      // (handleDeliver) at the SAME time this HTTP drain runs, and both only
      // consult the persistent wasSeen() (which commits at the END of the
      // receive txn). Without this guard the same ciphertext fed libsignal
      // twice — one won the ratchet, the other threw bad-MAC and raised a
      // spurious "message failed to decrypt" banner (and could fire an
      // unnecessary rehandshake nudge). The finally below releases it on every
      // exit path (including the `continue`s in the catch).
      if (inFlightEnvelopes.has(env.envelopeId)) { continue; }
      inFlightEnvelopes.add(env.envelopeId);
      let handled = false;
      try {
        await handleIncoming(
          own, ownStore, drainTrustedPeer, unwrapped.ciphertext, config,
          env.envelopeId, keys, nudgeAfterRebuild, peerIdentityCache,
          txnDb ?? null, sqlMessages ?? null, seenEnvelopes ?? null,
          pendingGroupEnvelopes ?? null, pendingAdminActions ?? null,
        );
        handled = true;
      } catch (e) {
        // B-30 — first-message recovery asked to leave this envelope on the
        // relay for a bounded redelivery; skip the ack below so the next pull
        // re-fetches it (the session rebuild was kicked off in handleIncoming).
        if (e instanceof LeaveOnRelayError) {
          console.warn(`[messenger] drain first-msg leave-on-relay env=${env.envelopeId.slice(0, 8)}`);
          continue;
        }
        // Audit P0-1(b) — transient LOCAL SQL failure (nested-txn collision,
        // SQLITE_BUSY/locked, disk I/O pressure): the receive txn rolled back
        // and the relay still holds the envelope, so skip the ack (the next
        // drain redelivers) instead of ack-`discarded` destroying it.
        if (isTransientSqlError(e)) {
          crashLog(`[messenger] drain transient-sql leave-on-relay env=${env.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
          continue;
        }
        // IdentityKeyMismatchError is imported at the top of the file
        // for the P0-1 pre-decrypt cert verify path; reuse the same
        // binding here instead of the legacy require.
        if (e instanceof IdentityKeyMismatchError) {
          const {refreshPeerIdentityIfRotated} = require('../crypto/peerIdentityRefresh') as
            typeof import('../crypto/peerIdentityRefresh');
          const outcome = await refreshPeerIdentityIfRotated(
            e.claims.senderUserId,
            e.claims.senderSignalDeviceId,
            e.claims.senderIdentityKey,
            keys,
            ownStore,
          );
          crashLog(`[messenger] drain-identity-rotation envId=${env.envelopeId.slice(0,8)} outcome=${outcome.result} reason=${outcome.reason ?? '-'}`);
          if (outcome.result === 'refreshed' && outcome.sessionReset) { void notePeerIdentityChanged(e.claims.senderUserId); }
          if (outcome.result === 'refreshed') {
            // Also evict the in-memory cache so subsequent sends use
            // the freshly-stored identity straight away.
            try {peerIdentityCache?.delete(`${e.claims.senderUserId}.${e.claims.senderSignalDeviceId}`);} catch { /* ignore */ }
            // BS-IDKEY — surface the rotation to the user (Signal/WhatsApp
            // "safety number changed" model). The rotation is authority-
            // confirmed so we trust it, but the user should SEE that the
            // peer's keys changed rather than have it happen invisibly.
            if (outcome.sessionReset) {
              try {
                useMessengerStore.getState().setError(
                  'A contact’s security code changed — their messages will resume on a new secure session.',
                );
              } catch { /* ignore */ }
            }
            try {
              // Audit P0-1 — peer address comes from the now-refreshed
              // authority claims, not the inner forgeable `s` field.
              const refreshedPeer = {
                userId:   e.claims.senderUserId,
                deviceId: e.claims.senderSignalDeviceId,
              };
              await handleIncoming(
                own, ownStore, refreshedPeer, unwrapped.ciphertext, config,
                env.envelopeId, keys, nudgeAfterRebuild, peerIdentityCache,
                txnDb ?? null, sqlMessages ?? null, seenEnvelopes ?? null,
                pendingGroupEnvelopes ?? null, pendingAdminActions ?? null,
              );
              handled = true;
            } catch (e2) {
              // BS-IDKEY — EXPECTED when sessionReset fired: the envelope
              // that carried the rotation was sealed to the now-archived
              // ratchet, so it cannot decrypt. That single message is lost
              // (one message, once per rotation) but the session is reset,
              // so every subsequent message rebuilds + delivers. Ack-drop
              // it (handled=true) so it doesn't wedge the drain or get
              // retried forever. A NON-reset post-refresh failure is a
              // genuine problem and stays a soft drop.
              if (outcome.sessionReset) {
                crashLog(`[messenger] drain rotation env=${env.envelopeId.slice(0,8)} dropped (sealed to archived ratchet) — session reset, future msgs ok`);
                // Destroyed (sealed to the archived ratchet) — honest disposition.
                noteDestroyedEnvelope({envelopeId: env.envelopeId, reason: 'rotation-archived-ratchet'});
                handled = true;
              } else if (isTransientSqlError(e2)) {
                // Audit P0-1(b) — local storage hiccup on the retry:
                // leave on relay, never destroy.
                crashLog(`[messenger] drain post-refresh transient-sql leave-on-relay env=${env.envelopeId.slice(0, 8)}`);
                continue;
              } else {
                console.warn('[messenger] drain post-refresh handle failed', asErrorMessage(e2));
                try {
                  const {noteUndecryptable} = require('../backup/sessionRatchetRecovery') as
                    typeof import('../backup/sessionRatchetRecovery');
                  noteUndecryptable(`drain-post-refresh:${asErrorMessage(e2).slice(0, 40)}`);
                } catch { /* ignore */ }
              }
            }
          } else if (outcome.result === 'unavailable') {
            // keys-service unreachable — leave the envelope on the
            // relay so a future drain can retry. Mark handled=false
            // (the ack below is skipped) and continue the loop.
            console.warn(`[messenger] drain identity-refresh unavailable env=${env.envelopeId.slice(0,8)} — leaving on relay for retry`);
            continue;
          } else {
            // stale-cert / no-change — drop the envelope.
            console.warn(`[messenger] drain identity-mismatch dropped env=${env.envelopeId.slice(0,8)} reason=${outcome.reason}`);
            try {
              const {noteUndecryptable} = require('../backup/sessionRatchetRecovery') as
                typeof import('../backup/sessionRatchetRecovery');
              noteUndecryptable(`drain-cert-mismatch:${outcome.reason ?? 'unknown'}`);
            } catch { /* ignore */ }
          }
        } else {
          // Non-rotation failure — log + count + ack-drop (matches
          // the prior catch-all behaviour for malformed AAD / bad MAC).
          crashLog(`[messenger] drain-handle-failed envId=${env.envelopeId.slice(0, 8)} err=${asErrorMessage(e).slice(0, 120)}`);
          console.warn('[messenger] drain handleIncoming failed', asErrorMessage(e));
          try {
            const {noteUndecryptable} = require('../backup/sessionRatchetRecovery') as
              typeof import('../backup/sessionRatchetRecovery');
            noteUndecryptable(`drain-handle:${asErrorMessage(e).slice(0, 40)}`);
          } catch { /* ignore */ }
        }
      } finally {
        // Audit L16 — release the in-flight marker on EVERY exit (success,
        // throw, or the `continue`s in the catch above). finally runs before
        // a `continue` transfers control, so the marker never leaks.
        inFlightEnvelopes.delete(env.envelopeId);
      }
      // Audit P0-N9 — present the possession-proof token from the pull
      // response. Server falls back to recipient-identity if absent
      // during the rollout window. ACK regardless of handled outcome
      // EXCEPT when refresh-and-retry deferred via `continue` above —
      // that branch skips ack so the relay re-delivers later.
      // Handoff §3.6(c) — same ack-outcome split as the WS path: an
      // unrecoverable failure (or a destroyed-note from the deep path)
      // acks 'discarded' so the sender's tick stays honest.
      {
        const destroyedInfo = takeDestroyedEnvelope(env.envelopeId);
        const disposition = (!handled || destroyedInfo) ? 'discarded' as const : 'delivered' as const;
        try { await relay.ack(env.envelopeId, env.ackToken, disposition); } catch { /* redelivery ok */ }
      }
    }
    // Round 8 — DO NOT mark bootstrap-done on a short page. Previously
    // this branch flipped the flag whenever envelopes.length < pageLimit,
    // which masquerades as "tail reached" but can also mean "page hit
    // a server-side cap mid-window" or "single-row delivery during
    // initial drain." Either case left the user permanently undershooting
    // on every subsequent reconnect (50-cap drains, multi-week backlog
    // never fully delivered). The empty-drain branch above is the only
    // reliable "we have everything" signal; just continue iterating
    // until we see one.
    if (envelopes.length < pageLimit) {
      // Don't return — let the next iteration confirm with an empty page.
      // The HARD_CAP_ITERATIONS bound still prevents runaway.
      continue;
    }
    // After a successful first iteration, drop bootstrap so subsequent
    // pages of the same drain use the steady-state cap.
    bootstrap = false;
  }
  // Diagnostic breadcrumb — hitting the cap means ack is silently
  // failing and the same envelopes keep coming back. Wire to telemetry
  // so we know when a user is stuck in a redelivery loop.
  crashLog(`[bravo.drainRelay] hard-cap iters=${HARD_CAP_ITERATIONS} (ack loop?)`);
  console.warn('[bravo.drainRelay] hit hard cap of', HARD_CAP_ITERATIONS, 'pages — bailing to avoid runaway');
}

function convoIdFor(peer: SessionAddress): string {
  // Phase-1 convention: one 1:1 conversation per peer userId.
  // Local UI key — asymmetric by design (Alice sees `direct:bob`, Bob
  // sees `direct:alice`). For the AAD binding, use
  // `directConvoAadId(self, peer)` instead so both sides agree.
  return `direct:${peer.userId}`;
}

/**
 * Audit P0-N2 follow-up — symmetric 1:1 conversation id for the
 * sealed-sender AAD binding ONLY. Sender and receiver compute the
 * same string regardless of which side is which, so a captured
 * envelope cannot be replayed in the opposite direction with the
 * AAD verifying clean.
 *
 * Local UI thread keys remain asymmetric (`convoIdFor(peer)` above)
 * because the screens already store per-peer state and changing the
 * UI key would require a migration. Splitting "AAD identity" from
 * "local UI key" lets both invariants hold without churn.
 *
 * The format `direct:<lex-smaller>|<lex-larger>` is deterministic
 * across platforms and sort orders without needing a locale.
 */
function directConvoAadId(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `direct:${lo}|${hi}`;
}

function makeId(): string {
  const rand = new Uint8Array(8);
  crypto.getRandomValues(rand);
  return Array.from(rand, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Send a tiny `control: 'rehandshake'` envelope to `peer`. Triggered
 * by receive-side recovery after a `DecryptError` was caught and the
 * outgoing session was rebuilt. The recipient (original sender)
 * decrypts a fresh PreKeyWhisperMessage, libsignal session-replaces
 * its existing record on the way through, and the broken ratchet
 * is healed without user action. Best-effort: any failure here
 * just leaves the manual reset path as the fallback.
 */
async function sendRehandshakeNudge(args: {
  own:        SessionManager;
  ownStore:   CryptoStore;
  keys:       KeysHttpClient;
  peer:       SessionAddress;
  ownAddress: SessionAddress;
  certCache:  SenderCertCache;
  transport:  TransportClient;
  relay:      RelayHttpClient;
}): Promise<void> {
  try {
    const cert = await args.certCache.get();
    // Round 5 / Security S1 — bind recipient + ts.
    const sealed = sealPayload(cert, '', {
      control: 'rehandshake',
      aad: {to: args.peer, ts: Date.now()},
    });
    const ct = await args.own.encrypt(args.peer, sealed);
    const recipientIdKeyB64 = await recipientIdentityKeyB64(args.ownStore, args.keys, args.peer);
    const outerSealed = await wrapOuter({
      recipientIdentityKeyB64: recipientIdKeyB64,
      sender:                  args.ownAddress,
      ciphertext:              ct,
      cert, // P0-1: cert bound into outer AAD
    });
    try {
      args.transport.send({
        event: 'envelope.send',
        data: {
          to:           args.peer,
          outerSealed,
          clientMsgId:  makeId(),
          urgent:       false,
        },
      });
    } catch {
      await args.relay.send({
        recipient:    args.peer,
        outerSealed,
        clientMsgId:  makeId(),
        urgent:       false,
      });
    }
  } catch { /* swallow — manual reset is the safety net */ }
}

// Per-peer cooldown for the bundle-refetch path triggered by
// DecryptError lives in `./sessionWipeProtection` so the in-process
// state and the SQLCipher-backed persistence share one source of truth.
// Bug-hunt #1.C: was previously a local unbounded Map (P1-7) — the
// centralised module bounds it via the persistent store row + the
// cache-warm fill on boot, and survives cold start.

// Audit P0-1 — protection state lives in `./sessionWipeProtection`.
// Extracted so the test suite can exercise the policy without pulling
// op-sqlite + the full production runtime into the messenger-crypto
// Jest project (which is node-env only).

function asErrorMessage(e: unknown): string {
  if (e instanceof Error) {return e.message;}
  return String(e);
}

/**
 * Fix #16: classify a frame-handler error as recoverable (soft
 * banner — the runtime is already self-healing) vs fatal (red
 * banner — user action may be required).
 *
 * Recoverable cases:
 *   - DecryptError: identity rotation already triggered rebuild path
 *   - 'fetch'/'network'/'timeout' substrings: transient network blips
 * Everything else (auth failures, contract violations, malformed
 * frames) goes to the fatal slot so the user actually sees them.
 */
function isRecoverableFrameError(e: unknown): boolean {
  if (e instanceof DecryptError) {return true;}
  const msg = asErrorMessage(e).toLowerCase();
  return msg.includes('network') || msg.includes('timeout') || msg.includes('aborted')
    || msg.includes('econn') || msg.includes('fetch failed');
}
