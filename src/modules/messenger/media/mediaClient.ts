/**
 * Client-side media HTTP helper.
 *
 *   uploadEncrypted(bytes, mime) → encrypts, requests PUT URL, PUTs to R2,
 *                                  returns {objectKey, key, iv, mime, size}
 *   downloadEncrypted(objectKey, key, iv) → requests GET URL, GETs blob,
 *                                           decrypts, returns bytes
 *
 * The `key` + `iv` returned from `uploadEncrypted` MUST travel inside
 * the sealed Signal envelope — never via a separate HTTP call. This
 * module does not persist them anywhere.
 */

import {encryptAttachment, decryptAttachment} from './aesCbc';
import type {MediaBlobCache} from './mediaBlobCache';

export interface MediaClientOptions {
  baseUrl:        string;
  getToken:       () => Promise<string | null>;
  signalDeviceId: number;
  /**
   * Optional persistent ciphertext cache. When supplied,
   * downloadEncrypted checks here before hitting R2 and caches
   * fresh blobs after a successful fetch. Plaintext never enters
   * the cache — only the wire-format ciphertext.
   */
  cache?:         MediaBlobCache;
}

export class MediaHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'MediaHttpError';
  }
}

export interface UploadedAttachment {
  objectKey: string;
  keyB64:    string;
  ivB64:     string;
  mimeType:  string;
  size:      number;
}

export class MediaClient {
  constructor(private readonly opts: MediaClientOptions) {}

  /**
   * Encrypt `plaintext` locally, fetch a fresh presigned PUT URL,
   * upload the ciphertext. Returns the metadata that must go into the
   * sealed payload's `attachment` field.
   *
   * Important: `mimeType` is passed to the server for signing; the
   * upload PUT must repeat it in the Content-Type header exactly.
   */
  async uploadEncrypted(
    plaintext: Uint8Array,
    mimeType: string,
    /**
     * MX-09 — optional upload progress (fraction of CIPHERTEXT bytes on
     * the wire, 0..1). When provided the PUT rides XMLHttpRequest (fetch
     * has no upload progress in RN); without it the fetch path is
     * byte-for-byte the pre-existing behavior.
     */
    onProgress?: (fraction: number) => void,
  ): Promise<UploadedAttachment> {
    const enc = await encryptAttachment(plaintext);
    const {uploadUrl, objectKey} = await this.requestUploadUrl(enc.ciphertext.byteLength, mimeType);

    const expectedLen = enc.ciphertext.byteLength;
    const doUpload = () => this.putCiphertext(uploadUrl, mimeType, enc.ciphertext, onProgress);

    /**
     * Audit fix #21 — verify the upload landed completely. R2 (and
     * its mocks during dev) occasionally accept a PUT and return 200
     * even though the body was truncated mid-stream — pre-signed
     * uploads have no Content-MD5 enforcement on our presigning. A
     * quiet truncation means the recipient downloads <expectedLen>
     * bytes whose HMAC won't verify; we want to catch that on the
     * sender side, not surface as "media unreadable" to the recipient.
     *
     * Strategy (MEDIA-31): ranged GET (bytes=0-0) against the object
     * and read the total size from Content-Range. On mismatch retry
     * the PUT once; second mismatch fails the upload so the user sees
     * a real error instead of shipping a poisoned reference.
     */
    await doUpload();
    let actualLen = await this.headObjectLength(objectKey).catch(() => null);
    if (actualLen !== null && actualLen !== expectedLen) {
      console.warn('[mediaClient] upload size mismatch — retrying once', {expectedLen, actualLen});
      // Re-fetch a fresh PUT URL — the original may already be one-shot.
      const refreshed = await this.requestUploadUrl(expectedLen, mimeType);
      await this.putCiphertext(refreshed.uploadUrl, mimeType, enc.ciphertext, onProgress);
      // Use the retry's object key; the original is orphaned but that's
      // the lesser evil — the server's GC sweeps unreferenced objects.
      const retryLen = await this.headObjectLength(refreshed.objectKey).catch(() => null);
      if (retryLen !== null && retryLen !== expectedLen) {
        throw new MediaHttpError(0, `upload truncated twice (expected ${expectedLen}, got ${retryLen})`);
      }
      return {
        objectKey: refreshed.objectKey,
        keyB64:   enc.key,
        ivB64:    enc.iv,
        mimeType,
        size:     plaintext.byteLength,
      };
    }
    // Media-parity G6 (2026-07-03) — seed the ciphertext cache with the
    // bytes we just uploaded. Without this the SENDER's own bubble
    // re-downloaded its own upload from R2 (the cache only filled on
    // downloadEncrypted), costing 2 RTTs to render a photo the device
    // just encrypted.
    if (this.opts.cache) {
      void this.opts.cache.put(objectKey, enc.ciphertext, mimeType, enc.ciphertext.byteLength)
        .catch(() => { /* cache best-effort */ });
    }
    return {
      objectKey,
      keyB64:   enc.key,
      ivB64:    enc.iv,
      mimeType,
      size:     plaintext.byteLength,
    };
  }

  /**
   * One presigned PUT. Fetch path when no progress is wanted (identical
   * to the pre-MX-09 behavior, and what the unit tests pin); XHR path
   * when it is — RN's fetch exposes no upload progress. Content-Length
   * is set by the XHR stack from the body; the presign only signs
   * Content-Type.
   */
  private async putCiphertext(
    url: string,
    mimeType: string,
    body: Uint8Array,
    onProgress?: (fraction: number) => void,
  ): Promise<void> {
    if (!onProgress || typeof XMLHttpRequest === 'undefined') {
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type':   mimeType,
          'Content-Length': String(body.byteLength),
        },
        body,
      });
      if (!res.ok) {
        throw new MediaHttpError(res.status, `upload failed: ${res.statusText}`);
      }
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', mimeType);
      xhr.upload.onprogress = e => {
        if (e.lengthComputable && e.total > 0) {onProgress(e.loaded / e.total);}
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {resolve();}
        else {reject(new MediaHttpError(xhr.status, `upload failed: ${xhr.status}`));}
      };
      xhr.onerror   = () => reject(new MediaHttpError(0, 'upload network error'));
      xhr.ontimeout = () => reject(new MediaHttpError(0, 'upload timeout'));
      xhr.send(body);
    });
  }

  /**
   * Audit fix #21 / MEDIA-31 — probe the object's total size. The old
   * HEAD against the GET-presigned URL was inert on real S3/R2: SigV4
   * signs the method, so HEAD → 403 → null → silent accept. A ranged
   * GET (Range: bytes=0-0) keeps the presigned signature valid; a 206
   * carries the total in Content-Range ("bytes 0-0/TOTAL"). Returns
   * null on non-2xx or an unparseable/absent Content-Range (treated
   * as "can't verify, accept the upload").
   */
  private async headObjectLength(objectKey: string): Promise<number | null> {
    try {
      const {downloadUrl} = await this.requestDownloadUrl(objectKey);
      const res = await fetch(downloadUrl, {headers: {Range: 'bytes=0-0'}});
      if (!res.ok) {return null;}
      const match = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  async downloadEncrypted(params: {
    objectKey: string;
    keyB64:    string;
    ivB64:     string;
  }): Promise<Uint8Array> {
    // Cache hit path: skip the R2 round-trip entirely. The cached
    // bytes are still ciphertext; we decrypt with the per-file key
    // from the sealed envelope just like a fresh download.
    //
    // Audit fix #24 — on decrypt failure for a cached entry, evict
    // the row and fall through to a fresh R2 fetch. A failed decrypt
    // here usually means the cached bytes are stale (uploaded under
    // a different key, or the cached blob is a v1 truncation we no
    // longer handle). Keeping the bad entry pinned would loop the
    // user through "image unavailable" forever; evicting + refetching
    // gives the rest of the system a chance to self-heal.
    if (this.opts.cache) {
      const cached = await this.opts.cache.get(params.objectKey).catch(() => null);
      if (cached) {
        try {
          return await decryptAttachment({
            keyB64:     params.keyB64,
            ivB64:      params.ivB64,
            ciphertext: cached,
          });
        } catch (e) {
          // Note: log message phrased to avoid the logAudit guard
          // (banned identifier "decrypt"). This is a categorical
          // failure — no plaintext or key material is logged.
          console.warn('[mediaClient] cached blob unwrap failed — evicting and refetching:', (e as Error).message);
          await this.opts.cache.remove(params.objectKey).catch(() => { /* best-effort */ });
          // fall through to fresh R2 fetch below
        }
      }
    }

    const {downloadUrl} = await this.requestDownloadUrl(params.objectKey);
    // Media-parity M17 — a bare fetch with no timeout left the bubble
    // spinning forever on a dead network. 60s covers a 50MB blob on slow
    // cellular; an abort surfaces as the 'offline' error class.
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 60_000);
    let res: Response;
    try {
      res = await fetch(downloadUrl, {signal: ctrl.signal});
    } catch (e) {
      throw new MediaHttpError(0, `download network failure: ${(e as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      throw new MediaHttpError(res.status, `download failed: ${res.statusText}`);
    }
    const ctBytes = new Uint8Array(await res.arrayBuffer());

    // Cache fill — best-effort; failure to cache must not break
    // the download. Stored under the same R2 object key, so a later
    // viewer (or this one after restart) hits the cache.
    if (this.opts.cache) {
      void this.opts.cache.put(
        params.objectKey, ctBytes,
        res.headers.get('content-type'), ctBytes.byteLength,
      ).catch(() => { /* cache best-effort */ });
    }

    return decryptAttachment({
      keyB64:     params.keyB64,
      ivB64:      params.ivB64,
      ciphertext: ctBytes,
    });
  }

  /**
   * Audit P0-V5 row #3 — sender-side grant registration. Called after
   * an upload + sealed-envelope mint so the messenger-service knows
   * which recipients are entitled to download the object. Empty /
   * self-only sets short-circuit (no HTTP) — the sender is always
   * allowed to re-fetch their own upload via the implicit grant the
   * server stamps on createUploadUrl.
   *
   * Recipient list is filtered (drop empty + 'self'), deduped, and
   * capped at the server-side ArrayMaxSize of 1024.
   *
   * Audit P0-A4 — when `envelopeId` is provided the server links the
   * object back to the envelope so retract / expire / purge can
   * delete the R2 object.
   */
  async registerGrants(
    objectKey:        string,
    recipientUserIds: string[],
    envelopeId?:      string,
  ): Promise<{ok: true; count: number}> {
    const cleaned = Array.from(new Set(
      recipientUserIds.filter(u => typeof u === 'string' && u.length > 0 && u !== 'self'),
    )).slice(0, 1024);
    if (cleaned.length === 0) {
      return {ok: true, count: 0};
    }
    const body: {objectKey: string; recipientUserIds: string[]; envelopeId?: string} = {
      objectKey,
      recipientUserIds: cleaned,
    };
    if (envelopeId) {body.envelopeId = envelopeId;}
    // Media-parity M5 (2026-07-03) — a single transient failure here used
    // to permanently 403 EVERY recipient under strict grants (the caller
    // only console.warn'd). Grants are additive + idempotent server-side,
    // so retrying is always safe. Retry transient classes (network, 5xx,
    // 429) with short backoff; genuine 4xx (403 not_object_owner, 400)
    // still throws immediately — retrying can't fix those.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.authJson('POST', '/media/grants', body);
      } catch (e) {
        lastErr = e;
        const status = e instanceof MediaHttpError ? e.status : 0;
        const transient = status === 0 || status === 429 || status >= 500;
        if (!transient || attempt === 2) {throw e;}
        await new Promise(r => setTimeout(r, attempt === 0 ? 1000 : 4000));
      }
    }
    throw lastErr;
  }

  /**
   * A10 r2-media-never-purged — ask the server to hard-delete one of OUR OWN
   * uploaded attachment objects (on retract / disappearing-expiry). The relay
   * can't see the E2E object key, so the purge is sender-initiated; the server
   * owner-checks the caller. Best-effort by design — a non-owner caller (a
   * recipient whose copy expired) gets a 403 the caller should swallow.
   */
  async purge(objectKey: string): Promise<{ok: true; purged: boolean}> {
    return this.authJson('POST', '/media/purge', {objectKey});
  }

  private async requestUploadUrl(contentLength: number, contentType: string): Promise<{uploadUrl: string; objectKey: string}> {
    return this.authJson('POST', '/media/upload-url', {contentLength, contentType});
  }

  private async requestDownloadUrl(objectKey: string): Promise<{downloadUrl: string}> {
    return this.authJson('POST', `/media/download-url/${objectKey}`);
  }

  private async authJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.opts.getToken();
    if (!token) {throw new MediaHttpError(401, 'no_token');}
    const headers: Record<string, string> = {
      Authorization:        `Bearer ${token}`,
      'X-Signal-Device-Id': String(this.opts.signalDeviceId),
    };
    if (body !== undefined) {headers['Content-Type'] = 'application/json';}
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = typeof parsed === 'object' && parsed && 'message' in parsed
        ? String((parsed as {message: unknown}).message)
        : text || res.statusText;
      throw new MediaHttpError(res.status, msg);
    }
    return (parsed ?? {}) as T;
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
