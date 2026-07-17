/**
 * B-86 — the host-side wiring the File Vault always specified but never
 * had: local biometric ceremony → short-lived MFA action token from
 * auth-service (`POST /auth/biometric/assert`, purpose `vault-access`)
 * → `VaultClient` encrypt-and-upload with the proof in `X-Mfa-Proof` →
 * real key material persisted in the local index.
 *
 * SECURITY (do not weaken — CLAUDE.md stop condition):
 *   - The server MfaGuard is the gate (single-use proof, ≤300 s, sub +
 *     device matched). This module only obtains and threads the proof;
 *     if the proof cannot be minted the operation FAILS CLOSED with an
 *     honest message — never a fake row (audit M-02/S1).
 *   - On production builds without a real Play Integrity attestation the
 *     assert endpoint rejects and vault moves stay disabled — that is
 *     the documented posture (keysClient.mintActionToken), not a bug.
 *   - Key material returned by the upload stays on-device in the vault
 *     index; never log it.
 */
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {API_BASE_URL, MSG_BASE_URL} from '@utils/constants';
import {KeysHttpClient} from '../transport/keysClient';
import {VaultClient} from './vaultClient';
import {useVaultStore, type VaultFile} from './vaultStore';

const getToken = () => AsyncStorage.getItem('auth:access_token');

export type VaultOpFailure = {
  ok: false;
  reason: 'no_pin' | 'cancelled' | 'mfa_unavailable' | 'transfer_failed';
  message: string;
};
export type VaultMoveResult = {ok: true} | VaultOpFailure;
export type VaultOpenResult = {ok: true; uri: string} | VaultOpFailure;

/**
 * Local user-presence ceremony. Devices without biometric hardware /
 * enrollment fall through to the vault's PIN gate + the server-side
 * attestation check — the cryptographic gate is the action token, not
 * this prompt. An explicit user CANCEL aborts the operation.
 */
async function runLocalBiometric(prompt: string): Promise<boolean> {
  try {
    const [hasHw, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    if (!hasHw || !enrolled) {return true;}
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: prompt,
      cancelLabel:   'Cancel',
    });
    return res.success;
  } catch {
    // Prompt infrastructure failure ≠ user refusal; the action token is
    // the real gate.
    return true;
  }
}

async function mintVaultProof(): Promise<string | null> {
  const keys = new KeysHttpClient({
    baseUrl:  API_BASE_URL,
    getToken,
    refreshToken: async () => {
      const {refreshAccessTokenShared} = require('@/services/api') as typeof import('@/services/api');
      await refreshAccessTokenShared();
    },
  });
  const res = await keys.mintActionToken('vault-access');
  return res?.actionToken ?? null;
}

const MFA_UNAVAILABLE_MSG =
  'The server declined the vault MFA challenge for this build, so the file was NOT moved. '
  + 'The vault gate stays closed rather than pretending to encrypt.';

/**
 * Encrypt-and-upload plaintext bytes into the vault and index the
 * returned key material. `sourceKey` is the dedup handle (`msg:<id>` for
 * chat attachments, `local:<ts>` for direct uploads).
 */
export async function moveBytesToVault(params: {
  sourceKey: string;
  name:      string;
  mimeType:  string;
  bytes:     Uint8Array;
}): Promise<VaultMoveResult> {
  const store = useVaultStore.getState();
  if (!store.hasPin()) {
    return {ok: false, reason: 'no_pin', message: 'Set up your File Vault PIN first (Messenger → Vault), then try again.'};
  }
  if (!(await runLocalBiometric('Confirm to move this file into your vault'))) {
    return {ok: false, reason: 'cancelled', message: 'Vault move cancelled.'};
  }
  const proof = await mintVaultProof();
  if (!proof) {
    return {ok: false, reason: 'mfa_unavailable', message: MFA_UNAVAILABLE_MSG};
  }
  const client = new VaultClient({
    baseUrl: MSG_BASE_URL,
    getToken,
    // signalDeviceId is hardcoded to 1 across the app (Phase-1 single-device).
    signalDeviceId: 1,
  });
  try {
    const up = await client.uploadEncrypted(params.bytes, params.mimeType, proof);
    if (!up.keyB64 || !up.ivB64 || !up.objectKey) {
      // M-02 invariant — never persist a row without real key material.
      return {ok: false, reason: 'transfer_failed', message: 'Vault upload returned no key material — nothing was saved.'};
    }
    useVaultStore.getState().addFile({
      objectKey: up.objectKey,
      sourceKey: params.sourceKey,
      keyB64:    up.keyB64,
      ivB64:     up.ivB64,
      name:      params.name,
      size:      up.size,
      mimeType:  params.mimeType,
      createdAt: Date.now(),
    });
    return {ok: true};
  } catch (e) {
    return {
      ok: false,
      reason: 'transfer_failed',
      message: e instanceof Error ? e.message : 'Vault upload failed.',
    };
  }
}

/**
 * Download + decrypt a vault file to a viewable temp uri. Every open is
 * its own MFA ceremony — proofs are single-use by design (server replay
 * guard), so there is nothing to cache.
 */
export async function openVaultFileUri(f: VaultFile): Promise<VaultOpenResult> {
  if (!f.keyB64 || !f.ivB64) {
    return {ok: false, reason: 'transfer_failed', message: 'This entry has no key material (legacy row) — remove it and re-add the file.'};
  }
  if (!(await runLocalBiometric('Confirm to open this vault file'))) {
    return {ok: false, reason: 'cancelled', message: 'Vault open cancelled.'};
  }
  const proof = await mintVaultProof();
  if (!proof) {
    return {ok: false, reason: 'mfa_unavailable', message: MFA_UNAVAILABLE_MSG};
  }
  const client = new VaultClient({baseUrl: MSG_BASE_URL, getToken, signalDeviceId: 1});
  try {
    const bytes = await client.downloadAndDecrypt({
      objectKey: f.objectKey,
      keyB64:    f.keyB64,
      ivB64:     f.ivB64,
      mfaProof:  proof,
    });
    const {writeTempBytes} = require('../media/mediaFiles') as typeof import('../media/mediaFiles');
    const uri = await writeTempBytes(bytes, f.mimeType, `vault-${f.objectKey}`);
    return {ok: true, uri};
  } catch (e) {
    return {
      ok: false,
      reason: 'transfer_failed',
      message: e instanceof Error ? e.message : 'Vault download failed.',
    };
  }
}

/** Vault index row matching a source handle (new rows) or legacy objectKey. */
export function findVaultRow(files: ReadonlyArray<VaultFile>, sourceKey: string): VaultFile | null {
  return files.find(f => f.sourceKey === sourceKey || f.objectKey === sourceKey) ?? null;
}
