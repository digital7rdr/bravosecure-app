/**
 * P1-B-1 — sealed-archive drain is resumable and fail-loud.
 *
 * Pre-fix, the drain lived inline in BackupRestoreScreen: the H-2
 * restore-incomplete marker was cleared BEFORE it ran, drain errors were
 * swallowed under the success overlay, and the page cursor was a loop
 * local — a Doze/OOM kill or a transient network error mid-drain
 * permanently lost the un-replayed archive tail.
 *
 * These tests pin the new contract of drainSealedArchive:
 *   1. the archive-replay-incomplete marker is armed BEFORE the first
 *      page fetch and cleared only AFTER a natural end;
 *   2. the (timestampMs, envelopeId) tuple cursor persists per page;
 *   3. a page-fetch error PROPAGATES with marker + cursor intact;
 *   4. a retry resumes from the persisted cursor (no re-replay of
 *      already-drained pages);
 *   5. a poison envelope is skipped without wedging the drain.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear: async () => { store.clear(); },
    },
  };
});

const mockGetSealedArchive = jest.fn();
jest.mock('../backup/backupClient', () => ({
  __esModule: true,
  backupClient: {
    getSealedArchive: (...args: unknown[]) => mockGetSealedArchive(...args),
  },
}));

import {drainSealedArchive} from '../backup/archiveReplay';
import {
  isArchiveReplayIncomplete, readArchiveCursor, writeArchiveCursor,
} from '../backup/restoreResume';

const OWNER = 'owner-1';

interface Env { envelopeId: string; outerSealed: string; timestampMs: number }

function makeEnvs(count: number, startMs = 1000): Env[] {
  return Array.from({length: count}, (_, i) => ({
    envelopeId:  `env-${String(startMs + i).padStart(6, '0')}`,
    outerSealed: 'b64',
    timestampMs: startMs + i,
  }));
}

/** Serve `all` in pages of `pageSize`, honoring the (sinceMs, sinceId) tuple. */
function serveFrom(all: Env[], pageSize = 2) {
  mockGetSealedArchive.mockImplementation(async (sinceMs?: number, _limit?: number, sinceId?: string) => {
    const after = all.filter(e => {
      if (sinceMs === undefined) {return true;}
      if (e.timestampMs !== sinceMs) {return e.timestampMs > sinceMs;}
      return sinceId === undefined ? false : e.envelopeId > sinceId;
    });
    return {envelopes: after.slice(0, pageSize)};
  });
}

describe('P1-B-1 — drainSealedArchive', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.clear();
  });

  it('arms the incomplete marker BEFORE the first page and clears it only after the natural end', async () => {
    const all = makeEnvs(3);
    let markerDuringFirstPage: boolean | null = null;
    mockGetSealedArchive.mockImplementation(async (sinceMs?: number, _l?: number, sinceId?: string) => {
      if (markerDuringFirstPage === null) {
        markerDuringFirstPage = await isArchiveReplayIncomplete(OWNER);
      }
      const after = all.filter(e => sinceMs === undefined
        ? true
        : (e.timestampMs !== sinceMs ? e.timestampMs > sinceMs : (sinceId !== undefined && e.envelopeId > sinceId)));
      return {envelopes: after.slice(0, 2)};
    });

    const replay = jest.fn(async () => true);
    const res = await drainSealedArchive(OWNER, replay);

    expect(markerDuringFirstPage).toBe(true);            // armed before fetch
    expect(res.replayed).toBe(3);
    expect(replay).toHaveBeenCalledTimes(3);
    expect(await isArchiveReplayIncomplete(OWNER)).toBe(false); // cleared after end
    expect(await readArchiveCursor(OWNER)).toBeNull();          // cursor cleared
  });

  it('persists the tuple cursor after every page', async () => {
    const all = makeEnvs(4);
    const cursorsSeen: Array<{cursorMs: number; cursorId: string} | null> = [];
    serveFrom(all, 2);
    await drainSealedArchive(OWNER, async () => {
      cursorsSeen.push(await readArchiveCursor(OWNER));
      return true;
    });
    // First page's replays run before any cursor write; the second
    // page's replays see the first page's persisted tail.
    expect(cursorsSeen[0]).toBeNull();
    expect(cursorsSeen[2]).toEqual({cursorMs: all[1].timestampMs, cursorId: all[1].envelopeId});
  });

  it('a page-fetch error PROPAGATES and leaves marker + cursor intact', async () => {
    const all = makeEnvs(4);
    let call = 0;
    mockGetSealedArchive.mockImplementation(async (sinceMs?: number, _l?: number, sinceId?: string) => {
      call++;
      if (call === 2) {throw new Error('network down');}
      const after = all.filter(e => sinceMs === undefined
        ? true
        : (e.timestampMs !== sinceMs ? e.timestampMs > sinceMs : (sinceId !== undefined && e.envelopeId > sinceId)));
      return {envelopes: after.slice(0, 2)};
    });

    const replay = jest.fn(async () => true);
    await expect(drainSealedArchive(OWNER, replay)).rejects.toThrow('network down');
    // Fail-LOUD, not fail-silent: the caller decides the retry UX.
    expect(await isArchiveReplayIncomplete(OWNER)).toBe(true);
    expect(await readArchiveCursor(OWNER)).toEqual({
      cursorMs: all[1].timestampMs, cursorId: all[1].envelopeId,
    });
    expect(replay).toHaveBeenCalledTimes(2); // only page 1 replayed
  });

  it('a retry resumes from the persisted cursor instead of re-replaying page 1', async () => {
    const all = makeEnvs(4);
    // Simulate the state the previous test left behind.
    await writeArchiveCursor(OWNER, {cursorMs: all[1].timestampMs, cursorId: all[1].envelopeId});
    serveFrom(all, 2);
    const replayed: string[] = [];
    const res = await drainSealedArchive(OWNER, async e => { replayed.push(e.envelopeId); return true; });
    expect(replayed).toEqual([all[2].envelopeId, all[3].envelopeId]);
    expect(res.replayed).toBe(2);
    expect(await isArchiveReplayIncomplete(OWNER)).toBe(false);
    expect(await readArchiveCursor(OWNER)).toBeNull();
  });

  it('a poison envelope is skipped without wedging the drain', async () => {
    const all = makeEnvs(3);
    serveFrom(all, 3);
    const res = await drainSealedArchive(OWNER, async e => {
      if (e.envelopeId === all[1].envelopeId) {throw new Error('unseal failed');}
      return true;
    });
    expect(res.replayed).toBe(2);
    expect(await isArchiveReplayIncomplete(OWNER)).toBe(false);
  });
});
