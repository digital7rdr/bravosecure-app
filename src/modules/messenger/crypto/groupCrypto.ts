/**
 * AES-256-GCM helpers for the group master key. Per the architecture
 * spec, group state and group message bodies are encrypted with a
 * symmetric master key shared via pairwise Signal sessions.
 *
 * The master key is a base64-encoded 32-byte secret; it lives in
 * GroupState.masterKeyB64 and is delivered through admin messages
 * when a group is created or rekeyed. Knowing the master key is
 * synonymous with group membership — never put it on the wire outside
 * a sealed Signal envelope.
 *
 * Outputs `{c, i}` rather than concatenated bytes so the JSON
 * representation stays human-debuggable in test fixtures.
 */

import {fromBase64, toBase64} from './encoding';
import {CryptoError} from './errors';

const IV_LEN = 12;            // GCM standard
const KEY_LEN_BYTES = 32;     // AES-256

export interface GroupCiphertext {
  /** base64 ciphertext (includes auth tag suffix per WebCrypto convention) */
  c: string;
  /** base64 12-byte IV */
  i: string;
}

/**
 * Audit fix #12 — cache imported CryptoKey by its base64 string so
 * sequential group encrypt/decrypt calls don't pay subtle.importKey
 * cost on every message. importKey is a hot path on the receive side
 * because every inbound group envelope requires a decrypt; on a busy
 * mission-group with backlog catch-up that adds up to noticeable jank.
 *
 * The map is keyed on the base64 string (not the bytes) since string
 * equality is cheap and the master key is already a base64 token in
 * GroupState. Cache lifetime is process-bound. Master keys rotate via
 * `applyAdminAction(rekey)` which mints a new base64 — old entries
 * become unreachable garbage collection candidates as soon as nothing
 * holds the old GroupState.
 */
const keyCache = new Map<string, Promise<CryptoKey>>();

async function importKey(keyB64: string): Promise<CryptoKey> {
  const cached = keyCache.get(keyB64);
  if (cached) {return cached;}
  const promise = (async () => {
    const raw = fromBase64(keyB64);
    if (raw.byteLength !== KEY_LEN_BYTES) {
      throw new CryptoError(`group key must be ${KEY_LEN_BYTES} bytes; got ${raw.byteLength}`);
    }
    return crypto.subtle.importKey('raw', raw, {name: 'AES-GCM'}, false, ['encrypt', 'decrypt']);
  })();
  keyCache.set(keyB64, promise);
  // Drop on rejection so a transient subtle.importKey failure doesn't
  // pin a permanent rejected-promise in the cache.
  promise.catch(() => keyCache.delete(keyB64));
  return promise;
}

/**
 * Encrypt `plaintext` (utf-8 string) with the group master key. Each
 * call mints a fresh random IV — never reuse one. Returns base64
 * fields suitable for embedding in a sealed payload body.
 */
export async function groupEncrypt(masterKeyB64: string, plaintext: string): Promise<GroupCiphertext> {
  const key = await importKey(masterKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const data = new TextEncoder().encode(plaintext);
  // toPlainAb-equivalent: wrap into a fresh ArrayBuffer for the
  // BufferSource type narrowing some RN environments require.
  const ivBuf = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength);
  const dataBuf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const ct = await crypto.subtle.encrypt({name: 'AES-GCM', iv: new Uint8Array(ivBuf)}, key, new Uint8Array(dataBuf));
  return {c: toBase64(ct), i: toBase64(ivBuf)};
}

export async function groupDecrypt(masterKeyB64: string, ciphertext: GroupCiphertext): Promise<string> {
  const key = await importKey(masterKeyB64);
  const iv = fromBase64(ciphertext.i);
  const ct = fromBase64(ciphertext.c);
  try {
    const pt = await crypto.subtle.decrypt({name: 'AES-GCM', iv: new Uint8Array(iv)}, key, new Uint8Array(ct));
    return new TextDecoder().decode(pt);
  } catch (e) {
    throw new CryptoError('group decrypt failed (wrong key or tampered ciphertext)', e);
  }
}

/**
 * Type guard — distinguishes a master-key-encrypted group payload
 * from a legacy plaintext envelope. Used at receive time so a fleet
 * with mixed clients still interoperates.
 */
export function isGroupCiphertext(x: unknown): x is GroupCiphertext {
  if (!x || typeof x !== 'object') {return false;}
  const o = x as Record<string, unknown>;
  return typeof o.c === 'string' && typeof o.i === 'string';
}
