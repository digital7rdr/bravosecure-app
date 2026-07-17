/**
 * Local-file <-> bytes bridge for the encrypted-attachment pipeline.
 *
 *   readUriBytes(uri)        — read a picked file (file:// or content://)
 *                              into a Uint8Array, ready for encrypt+upload.
 *   writeTempBytes(bytes,..) — write decrypted plaintext to a cache file
 *                              and return a file:// uri the native <Image>
 *                              / FileViewer can render. Caller owns cleanup.
 *
 * Plaintext bytes are only ever held in memory or in the app-private
 * cache dir (SQLCipher/keychain-protected device; cache is wiped on
 * uninstall). The decrypted temp file is the unavoidable cost of letting
 * the OS image/video/audio decoders read a uri — there is no API to feed
 * raw bytes to <Image>. We keep it in the private cache, not shared
 * storage, so other apps can't read it.
 */

import RNFS from 'react-native-fs';
import {Buffer} from '@craftzdog/react-native-buffer';

/**
 * Read a picked file uri into bytes. Handles both `file://` paths and
 * Android `content://` SAF uris (react-native-fs reads both on Android;
 * on iOS the picker hands back file:// already).
 */
export async function readUriBytes(uri: string): Promise<Uint8Array> {
  // RNFS.readFile with 'base64' is the portable path — it works for
  // content:// uris that a plain fs path read would reject. We decode the
  // base64 to bytes with the same Buffer polyfill the rest of the crypto
  // layer uses.
  const b64 = await RNFS.readFile(uri, 'base64');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Write decrypted plaintext bytes to a uniquely-named file in the app's
 * private cache directory and return its file:// uri. The extension is
 * derived from the mime so the OS decoder picks the right handler.
 *
 * `idHint` (the message id) keys the filename so re-decrypting the same
 * attachment reuses the same path instead of piling up temp files.
 */
export async function writeTempBytes(
  bytes: Uint8Array,
  mimeType: string,
  idHint: string,
): Promise<string> {
  const ext  = extForMime(mimeType);
  const safe = idHint.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'att';
  const path = `${RNFS.CachesDirectoryPath}/bravo-media-${safe}${ext}`;
  const exists = await RNFS.exists(path);
  if (!exists) {
    const b64 = Buffer.from(bytes).toString('base64');
    await RNFS.writeFile(path, b64, 'base64');
  }
  return `file://${path}`;
}

/**
 * Media-parity G4 (2026-07-03) — fast path: return the decrypted temp
 * file's uri when it already exists, WITHOUT touching bytes. The file
 * is the product of a prior authenticated (HMAC-verified) decrypt of
 * this exact message, so re-running the download+verify+decrypt+encode
 * pipeline just to arrive at the same path was pure waste — it ran on
 * every bubble mount and again when the viewer opened. Callers try
 * this first and only fall into the full pipeline on a miss.
 */
export async function statTempBytes(
  mimeType: string,
  idHint: string,
): Promise<string | null> {
  const ext  = extForMime(mimeType);
  const safe = idHint.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'att';
  const path = `${RNFS.CachesDirectoryPath}/bravo-media-${safe}${ext}`;
  try {
    return (await RNFS.exists(path)) ? `file://${path}` : null;
  } catch {
    return null;
  }
}

/**
 * Audit MEDIA-A2 (2026-07-02): delete the decrypted-plaintext cache file(s)
 * for a message id. writeTempBytes leaves plaintext in the private cache dir
 * ("caller owns cleanup"), but nothing deleted it — so a disappearing message
 * that burned (bubble + ciphertext-cache + R2 all purged) still left its
 * DECRYPTED plaintext on disk until the OS trimmed the cache. Called from the
 * store-removal subscriber and the expiry sweeper. Best-effort, never throws.
 */
export async function deleteTempBytes(idHint: string): Promise<void> {
  const safe = idHint.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'att';
  const prefix = `bravo-media-${safe}`;
  try {
    const entries = await RNFS.readDir(RNFS.CachesDirectoryPath);
    await Promise.all(
      entries
        .filter(e => e.isFile() && (e.name === prefix || e.name.startsWith(`${prefix}.`)))
        .map(e => RNFS.unlink(e.path).catch(() => undefined)),
    );
  } catch { /* cache dir unreadable — best effort */ }
}

function extForMime(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') {return '.jpg';}
  if (m === 'image/png')  {return '.png';}
  if (m === 'image/gif')  {return '.gif';}
  if (m === 'image/webp') {return '.webp';}
  if (m === 'video/mp4')  {return '.mp4';}
  if (m === 'video/quicktime') {return '.mov';}
  if (m === 'video/webm') {return '.webm';}
  if (m === 'video/3gpp') {return '.3gp';}
  if (m === 'audio/mp4' || m === 'audio/m4a' || m === 'audio/x-m4a') {return '.m4a';}
  if (m === 'audio/mpeg') {return '.mp3';}
  if (m === 'audio/ogg')  {return '.ogg';}
  if (m === 'audio/wav' || m === 'audio/x-wav') {return '.wav';}
  if (m === 'audio/aac')  {return '.aac';}
  if (m === 'application/pdf') {return '.pdf';}
  if (m === 'text/plain') {return '.txt';}
  if (m === 'application/zip') {return '.zip';}
  if (m === 'application/msword') {return '.doc';}
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {return '.docx';}
  if (m === 'application/vnd.ms-excel') {return '.xls';}
  if (m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {return '.xlsx';}
  if (m === 'application/vnd.ms-powerpoint') {return '.ppt';}
  if (m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {return '.pptx';}
  // Media-parity M14 — unknown mimes used to produce an EXTENSIONLESS
  // temp file, which external viewers (FileViewer/ACTION_VIEW resolvers
  // pick handlers by extension) could rarely open. '.bin' at least lets
  // the "open with…" chooser appear.
  return '.bin';
}
