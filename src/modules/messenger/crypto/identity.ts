import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';
import type { CryptoStore, PreKeyBundle, SessionAddress } from './types';
import { toBase64 } from './encoding';
import { StoreError } from './errors';

/**
 * One-time install keying. Generates the long-lived identity key pair,
 * registration id, signed pre-key (with signature), and an initial pool
 * of one-time pre-keys. Persists everything into the supplied store.
 *
 * Idempotent: with `force: false` (default) the call no-ops if identity
 * already exists — safe to call on every app boot.
 *
 * Audit fix #8 — the original implementation could leave the store in
 * a half-installed state if the process was killed mid-loop (identity
 * + a few prekeys but no signed prekey, or N/M prekeys persisted). On
 * the next boot the partial-state check `getIdentityKeyPair()` would
 * succeed and skip the rest of the work, leaving the user unable to
 * receive PreKeyWhisperMessage envelopes ("signedPreKey not found"
 * thrown deep inside libsignal). We now:
 *
 *   1. Use signed_pre_key as the COMPLETION SENTINEL — boot considers
 *      install complete only when both identity AND signed prekey
 *      exist. Any boot finding only identity falls through to retry.
 *   2. Wrap the whole loop in a SQLCipher transaction when the store
 *      exposes a `getDb()` (production path). On failure the BEGIN
 *      block rolls back and the next boot starts cleanly. The in-
 *      memory test store has no transactional support; we no-op the
 *      BEGIN/COMMIT for it (failures there are surfaced loudly to the
 *      developer anyway).
 */
export async function installIdentity(
  store: CryptoStore,
  opts: { preKeyCount?: number; force?: boolean } = {},
): Promise<void> {
  const { preKeyCount = 100, force = false } = opts;
  if (!force) {
    try {
      await store.getIdentityKeyPair();
      // Completion sentinel: signed_pre_key id 1 must also exist. If
      // it doesn't, an earlier install crashed between identity-write
      // and signed-prekey-write — re-run the rest of the work.
      const spk = await store.loadSignedPreKey(1);
      if (spk) {return;}
      console.warn('[crypto/identity] identity present but signed prekey missing — re-running install');
    } catch {
      /* fall through */
    }
  }

  // Optional transactional bracket. The production SqlCipherProtocolStore
  // exposes `getDb()` which returns the underlying op-sqlite handle; we
  // wrap the install in BEGIN / COMMIT so a crash mid-loop rolls back.
  // The InMemoryProtocolStore (used in tests) lacks transactional
  // support; we no-op there. Closure-style so the writes inside still
  // go through the public CryptoStore API and we don't have to bypass
  // the type boundary.
  type TxStore = { getDb?: () => { execute: (sql: string) => Promise<unknown> } };
  const txStore = store as unknown as TxStore;
  const db = txStore.getDb?.();
  let inTx = false;
  if (db) {
    await db.execute('BEGIN');
    inTx = true;
  }

  try {
    const registrationId = KeyHelper.generateRegistrationId();
    const identity = await KeyHelper.generateIdentityKeyPair();
    const saveOwn = store as unknown as {
      saveOwnIdentity?: (r: number, pub: ArrayBuffer, priv: ArrayBuffer) => Promise<void>;
      setOwnIdentity?: (r: number, pub: ArrayBuffer, priv: ArrayBuffer) => void;
    };
    if (saveOwn.saveOwnIdentity) {
      await saveOwn.saveOwnIdentity(registrationId, identity.pubKey, identity.privKey);
    } else if (saveOwn.setOwnIdentity) {
      saveOwn.setOwnIdentity(registrationId, identity.pubKey, identity.privKey);
    } else {
      throw new StoreError('store cannot persist own identity');
    }

    // Generate prekeys BEFORE writing the signed prekey so the sentinel
    // (signed_pre_key id 1) is the LAST row to land. Any crash inside
    // the loop leaves no signed prekey, the next boot sees the missing
    // sentinel, and re-runs install end-to-end.
    for (let i = 1; i <= preKeyCount; i++) {
      const pk = await KeyHelper.generatePreKey(i);
      await store.storePreKey(pk.keyId, pk.keyPair);
    }

    const signedPreKeyId = 1;
    const signedPreKey = await KeyHelper.generateSignedPreKey(identity, signedPreKeyId);
    await store.storeSignedPreKey(signedPreKeyId, signedPreKey.keyPair, signedPreKey.signature);

    if (inTx && db) {await db.execute('COMMIT');}
  } catch (e) {
    if (inTx && db) {
      try { await db.execute('ROLLBACK'); }
      catch (rbErr) { console.warn('[crypto/identity] rollback failed', rbErr); }
    }
    throw e;
  }
}

/**
 * Build the public bundle uploaded to the server so peers can start
 * sessions with us. Reads the stored signature — we do NOT re-sign here
 * (the library's low-level signer is not public API). Pops one pre-key
 * from the pool if `preKeyId` is supplied.
 */
export async function buildOwnPreKeyBundle(
  store: CryptoStore,
  address: SessionAddress,
  signedPreKeyId = 1,
  preKeyId?: number,
): Promise<PreKeyBundle> {
  const identity = await store.getIdentityKeyPair();
  const registrationId = await store.getLocalRegistrationId();
  const spk = await store.loadSignedPreKey(signedPreKeyId);
  if (!spk) {throw new StoreError(`signed pre-key ${signedPreKeyId} missing`);}
  if (!spk.signature) {
    throw new StoreError(`signed pre-key ${signedPreKeyId} has no stored signature`);
  }

  const bundle: PreKeyBundle = {
    registrationId,
    address,
    identityKey: toBase64(identity.pubKey),
    signedPreKey: {
      keyId: signedPreKeyId,
      publicKey: toBase64(spk.pubKey),
      signature: toBase64(spk.signature),
    },
  };

  if (preKeyId !== null && preKeyId !== undefined) {
    const pk = await store.loadPreKey(preKeyId);
    if (pk) {
      bundle.preKey = { keyId: preKeyId, publicKey: toBase64(pk.pubKey) };
    }
  }
  return bundle;
}
