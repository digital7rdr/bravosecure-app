/**
 * HTTP-backed `SnapshotTransport` — adapts the messenger-service
 * /backup/identity/sessions endpoints to the `SnapshotTransport`
 * contract that `ratchetSnapshot.ts` defines.
 *
 * Wired by the runtime at boot via
 *   `setSnapshotTransport(makeHttpSnapshotTransport())`.
 *
 * Failure semantics — the contract is "the rotation/restore flow must
 * survive a missing backend". Returning `{ok: true}` on upload-failure
 * keeps the local capture path running (the next capture cycle will
 * retry); returning `null` on fetch-failure lets the restore path
 * fall through to the existing ratchet-recovery counter (no fatal).
 *
 * Pre-migration backends: `backupClient.getSessions` already maps the
 * 503 `service_disabled` shape to `null`, and `putSessions` surfaces
 * the same kind so we can swallow it identically here.
 */

import {backupClient, BackupError} from './backupClient';
import type {SnapshotTransport, RatchetSnapshotEnvelope} from './ratchetSnapshot';

export function makeHttpSnapshotTransport(): SnapshotTransport {
  return {
    async upload(env: RatchetSnapshotEnvelope): Promise<{ok: true}> {
      try {
        await backupClient.putSessions({blob: env.blob, seq: env.seq});
        return {ok: true};
      } catch (e) {
        // M-16 / F9 — only swallow the "backend genuinely not deployed"
        // case (there is no server state to stay in sync with, so a no-op
        // is safe and the seq may advance harmlessly). EVERYTHING else —
        // network / server / unauthorized / locked — is PROPAGATED so the
        // scheduler's `writeSeq` (which runs only after a successful
        // upload) does NOT advance the rollback floor past what the server
        // actually holds, and retries on the next capture cycle. The old
        // code swallowed all of these as success, which silently dropped
        // every snapshot AND drifted the local floor arbitrarily far ahead.
        if (e instanceof BackupError) {
          if (e.kind === 'service_disabled' || e.kind === 'no_backup') {
            return {ok: true};
          }
          console.warn(`[ratchet-snapshot] upload failed (${e.kind}); not advancing seq, will retry next cycle`);
        } else {
          console.warn('[ratchet-snapshot] upload failed (non-BackupError); will retry next cycle');
        }
        throw e;
      }
    },

    async fetchLatest(): Promise<RatchetSnapshotEnvelope | null> {
      try {
        const row = await backupClient.getSessions();
        if (!row) {return null;}
        return {blob: row.blob, seq: row.seq};
      } catch (e) {
        // A missing / pre-migration backend reduces to `no_snapshot`
        // (applyRatchetSnapshot handles null). But a NON-BackupError here
        // is a programming bug (e.g. a TypeError) — re-throw it rather
        // than masking it as "no snapshot exists", which the old dead
        // both-branches-return-null code silently did.
        if (e instanceof BackupError) {
          return null;
        }
        throw e;
      }
    },
  };
}
