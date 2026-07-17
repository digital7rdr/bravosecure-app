/**
 * P1-B-1 — resumable sealed-envelope archive drain.
 *
 * The `sealed_envelope_archive` replay recovers every message received
 * while the client mirror was locked (the reinstall window). It used to
 * live inline in BackupRestoreScreen with three defects:
 *
 *   1. The H-2 restore-incomplete marker was cleared BEFORE the drain
 *      ran, so a kill mid-drain (Doze/OOM) left the next boot believing
 *      the restore completed — the archive was never re-pulled and those
 *      messages were permanently absent.
 *   2. Any drain error was caught, logged, and fell through to the
 *      SUCCESS overlay — fail-silent.
 *   3. The (timestampMs, envelopeId) tuple cursor was a loop local, so
 *      partial progress was always discarded.
 *
 * This module owns the loop: it arms a per-owner `archive-replay-
 * incomplete` marker before the first page, persists the tuple cursor
 * after every page (mirroring restoreResume's message cursor), and
 * clears marker + cursor only after the walk reaches a natural end.
 * Page-fetch errors PROPAGATE so the caller can surface a retry state;
 * the marker + cursor survive, and both the boot gate (RESTORE-RESUME)
 * and the next manual retry resume from the persisted cursor instead of
 * re-walking (or worse, skipping) the archive.
 *
 * Per-envelope replay failures are still swallowed (a single poison
 * envelope must not wedge the drain forever) — unchanged behaviour.
 */
import {backupClient} from './backupClient';
import {
  readArchiveCursor, writeArchiveCursor, clearArchiveCursor,
  markArchiveReplayIncomplete, clearArchiveReplayIncomplete,
} from './restoreResume';

export interface ArchivedEnvelope {
  envelopeId:  string;
  outerSealed: string;
  timestampMs: number;
}

export async function drainSealedArchive(
  ownerUserId: string,
  replay: (env: ArchivedEnvelope) => Promise<boolean>,
  opts: {onProgress?: (replayed: number) => void} = {},
): Promise<{replayed: number}> {
  // Arm the marker BEFORE the first fetch so a kill anywhere inside the
  // drain is detected on the next boot.
  await markArchiveReplayIncomplete(ownerUserId);
  const resume = await readArchiveCursor(ownerUserId);
  let cursorMs: number | undefined = resume?.cursorMs;
  let cursorId: string | undefined = resume?.cursorId;
  if (resume) {
    console.log(`[bravo.restore.archive] resuming from cursor ms=${resume.cursorMs} id=${resume.cursorId.slice(0, 8)}`);
  }
  let replayed = 0;
  // Round 8 — tuple cursor (sinceMs, sinceId) + 1000-page cap. Short
  // pages don't break the loop; only an empty page confirms the end.
  for (let page = 0; page < 1000; page++) {
    const {envelopes} = await backupClient.getSealedArchive(cursorMs, 500, cursorId);
    if (envelopes.length === 0) {break;}
    for (const env of envelopes) {
      try {
        const ok = await replay(env);
        if (ok) {replayed++;}
      } catch (e) {
        console.warn(`[bravo.restore.archive] replay skipped ${env.envelopeId.slice(0, 8)}: ${(e as Error).message}`);
      }
    }
    const tail = envelopes[envelopes.length - 1];
    cursorMs = tail.timestampMs;
    cursorId = tail.envelopeId;
    await writeArchiveCursor(ownerUserId, {cursorMs, cursorId});
    try { opts.onProgress?.(replayed); } catch { /* observer fault — never abort */ }
  }
  // Natural end — the drain is durable-complete; disarm resume state.
  await clearArchiveCursor(ownerUserId);
  await clearArchiveReplayIncomplete(ownerUserId);
  return {replayed};
}
