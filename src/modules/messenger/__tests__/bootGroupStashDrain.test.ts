/**
 * B-31 — an undrained group envelope stash is replayed on boot once the master
 * key is restored from disk.
 *
 * A group text stashed (no_key/tamper) in a prior session is normally drained
 * by the admin create/rekey post-txn request; once that admin envelope is ACKed
 * off the relay it is never redelivered, so a stash row left undrained across a
 * restart has nothing to re-trigger it — the key is on disk and the message is
 * decryptable, yet it never renders. The boot key-restore path now re-runs the
 * existing per-row drain for every group whose key it just restored.
 *
 * `productionRuntime.ts` is too heavy to import in jest (every messenger test
 * uses replicas + the real stores/crypto), so these tests pin:
 *   1. the real, exported fail-closed selection (`selectGroupIdsToDrain`), and
 *   2. the recovery mechanism over the REAL PendingGroupEnvelopeStore + REAL
 *      group crypto — Scenario A (keyed group → stash re-decrypts) and
 *      Scenario B (keyless group → not selected, stash retained, fail-closed).
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
    },
  };
});

import {
  groupEncrypt,
  parseGroupMessage,
  genFreshGroupMasterKey,
  type SealedPayload,
} from '@bravo/messenger-core';
import {PendingGroupEnvelopeStore} from '../store/pendingGroupEnvelopeStore';
import {useMessengerStore} from '../store/messengerStore';
import {selectGroupIdsToDrain} from '../runtime/bootGroupStashDrain';

interface Row {
  envelope_id:    string;
  group_id:       string;
  peer_user_id:   string;
  peer_device_id: number;
  sealed_json:    string;
  received_at_ms: number;
  attempts:       number;
}

// Minimal SQLite mock — the subset of statements PendingGroupEnvelopeStore
// emits that these tests exercise (stash + listForGroup). Mirrors the mock in
// tamperKeyDivergenceStash.test.ts / pendingGroupEnvelopeStore.test.ts.
function makeMockDb() {
  const rows: Row[] = [];
  const execute = async (sql: string, params?: unknown[]): Promise<{rows?: unknown[]; rowsAffected?: number}> => {
    if (/^INSERT OR REPLACE INTO pending_group_envelopes/.test(sql)) {
      const p = params as [string, string, string, number, string, number];
      const existing = rows.findIndex(r => r.envelope_id === p[0]);
      const row: Row = {
        envelope_id: p[0], group_id: p[1], peer_user_id: p[2],
        peer_device_id: p[3], sealed_json: p[4], received_at_ms: p[5], attempts: 0,
      };
      if (existing >= 0) {rows.splice(existing, 1, row);} else {rows.push(row);}
      return {rowsAffected: 1};
    }
    if (/^SELECT envelope_id, group_id/.test(sql)) {
      const groupId = (params as unknown[])[0] as string;
      const matched = rows
        .filter(r => r.group_id === groupId)
        .sort((a, b) => a.received_at_ms - b.received_at_ms);
      return {rows: matched.map(r => ({...r}))};
    }
    return {rows: []};
  };
  return {db: {execute}, rows};
}

const GROUP_A = 'g-keyed';
const GROUP_B = 'g-keyless';
const PEER = {userId: 'alice', deviceId: 1};

/** Real master-key-wrapped group sealed payload (shape matches broadcastToGroup). */
async function makeWrappedGroupEnvelope(groupId: string, keyB64: string): Promise<SealedPayload> {
  const clientMsgId = 'cmid-1';
  const inner = JSON.stringify({groupId, kind: 'text', clientMsgId, body: 'ops brief at 14:00'});
  const wrapped = await groupEncrypt(keyB64, inner);
  return {
    body:  JSON.stringify(wrapped),
    group: {groupId, kind: 'text', clientMsgId},
  } as unknown as SealedPayload;
}

describe('B-31 selectGroupIdsToDrain — fail-closed boot-drain selection', () => {
  it('selects only groups whose master key is already on the device', () => {
    expect(
      selectGroupIdsToDrain({
        [GROUP_A]: {masterKeyB64: 'a-key'},
        [GROUP_B]: {}, // Scenario B — key never persisted
      }),
    ).toEqual([GROUP_A]);
  });

  it('skips groups with an empty/undefined key (Scenario B stays fail-closed)', () => {
    expect(selectGroupIdsToDrain({[GROUP_B]: {masterKeyB64: ''}})).toEqual([]);
    expect(selectGroupIdsToDrain({[GROUP_B]: {}})).toEqual([]);
  });

  it('returns an empty list when there are no groups', () => {
    expect(selectGroupIdsToDrain({})).toEqual([]);
  });
});

describe('B-31 boot-drain recovery — keyed stash re-decrypts; keyless stays fail-closed', () => {
  beforeEach(() => {
    useMessengerStore.getState().reset();
  });

  it('Scenario A: a restored on-disk key makes the prior-session stash decryptable + selected', async () => {
    const masterKey = genFreshGroupMasterKey();
    const sealed = await makeWrappedGroupEnvelope(GROUP_A, masterKey);

    const {db} = makeMockDb();
    const store = new PendingGroupEnvelopeStore(db as never);
    // Stashed in a PRIOR session (it was no_key at the time).
    await store.stash({
      envelopeId: 'env-A', groupId: GROUP_A,
      peerUserId: PEER.userId, peerDeviceId: PEER.deviceId,
      sealed, receivedAtMs: 1,
    });

    // Boot restores the master key into the live store (the merge step).
    useMessengerStore.setState({
      groups: {[GROUP_A]: {groupId: GROUP_A, masterKeyB64: masterKey, members: {[PEER.userId]: {}}}},
    } as never);

    // The boot drain selects this group (its key is present)...
    expect(selectGroupIdsToDrain(useMessengerStore.getState().groups as never)).toContain(GROUP_A);

    // ...so the per-row drain re-parses the SAME stashed payload with the now-
    // present key and recovers the plaintext (what replayGroupSealedDecode does).
    const [row] = await store.listForGroup(GROUP_A);
    const res = await parseGroupMessage(JSON.parse(row.sealedJson) as SealedPayload, masterKey);
    expect(res.ok).toBe(true);
    if (res.ok) {expect(res.envelope.body).toBe('ops brief at 14:00');}
  });

  it('Scenario B: a group with no key on disk is NOT selected → stash retained, nothing rendered', async () => {
    const masterKey = genFreshGroupMasterKey();
    const sealed = await makeWrappedGroupEnvelope(GROUP_B, masterKey);

    const {db} = makeMockDb();
    const store = new PendingGroupEnvelopeStore(db as never);
    await store.stash({
      envelopeId: 'env-B', groupId: GROUP_B,
      peerUserId: PEER.userId, peerDeviceId: PEER.deviceId,
      sealed, receivedAtMs: 1,
    });

    // Boot restores groups, but this member never persisted GROUP_B's key.
    useMessengerStore.setState({
      groups: {[GROUP_B]: {groupId: GROUP_B, members: {}}},
    } as never);

    // Not selected — the owner-side resync for a truly-lost key is
    // architecture-gated and left untouched.
    expect(selectGroupIdsToDrain(useMessengerStore.getState().groups as never)).not.toContain(GROUP_B);

    // Stash retained for a future legitimate create/rekey; nothing rendered.
    const stashed = await store.listForGroup(GROUP_B);
    expect(stashed.map(r => r.envelopeId)).toEqual(['env-B']);
    expect(useMessengerStore.getState().messages[GROUP_B] ?? []).toHaveLength(0);
  });
});
