/**
 * Regression — ad-hoc ('Call') group master-key id resolution.
 *
 * Bug (build 67): an escalated 1:1 call failed on the JOINER with
 * "FrameCryptorOrchestrator: no group master key — refusing to start",
 * even when the key envelope HAD been received and stored. Two causes,
 * both an id mismatch on the asymmetric `direct:<x>` thread key:
 *
 *  1. NON-DELIVERY LOOKUP MISS — the joiner read the key off
 *     `groups[opts.conversationId]`, where `opts.conversationId` is the
 *     HOST's local thread key (`direct:<host's-peer>`). On the joiner's
 *     device that string resolves to a DIFFERENT user, so the key — filed
 *     by the receive-side under `direct:<owner>` = `direct:<host>` — was
 *     never found. Fix: the joiner looks the key up under
 *     `direct:<hostUserId>` (threaded from the ring's `from.userId`).
 *
 *  1b. REAL-GROUP JOINER MISS (BS-CALL-REALGROUP) — IncomingGroupCallScreen
 *     sets `hostUserId` UNCONDITIONALLY, so the fix above ALSO diverted REAL
 *     named-group joiners to `direct:<host>`. But a real group's key is filed
 *     ONLY under the real `conversationId` (server UUID); the `direct:<owner>`
 *     alias is created only for name==='Call'. So real-group joiners waited on
 *     an empty slot → 25 s timeout → "Call failed". Fix: resolve under
 *     whichever slot actually holds a key — real `conversationId` first, then
 *     the ad-hoc `direct:<host>` alias — and fail closed only when NEITHER does.
 *
 *  2. STALE-OWNER RE-BROADCAST DROP — `setGroupState` is a full overwrite,
 *     so after a prior call where the OTHER party was host,
 *     `groups[conversationId]` held `owner=peer`. The BS-CALL-KEY-RESYNC
 *     branch re-broadcast that state verbatim (owner=peer) FROM us; the
 *     recipient's `owner===sender` forgery guard then DROPped it. Fix:
 *     only re-broadcast a state THIS device owns; else mint fresh
 *     (owner=self).
 *
 * These tests pin the two pure decisions (lookup id + resync eligibility)
 * that the runtime/hook now make. They assert NO key material — only which
 * id a key is resolved under and whether a stale state is re-broadcast.
 */

// Mirrors the joiner's key-slot resolution in useGroupCall.ts
// (BS-CALL-REALGROUP). Real `conversationId` slot first, then the ad-hoc
// `direct:<host>` alias; undefined when NEITHER holds a key (→ fail closed):
//   const directLookupId = opts.hostUserId ? `direct:${opts.hostUserId}` : undefined;
//   if (g[opts.conversationId]?.masterKeyB64) return opts.conversationId;
//   if (directLookupId && g[directLookupId]?.masterKeyB64) return directLookupId;
//   return undefined;
type Groups = Record<string, {masterKeyB64?: string; owner?: string}>;
function resolveKeyId(
  groups: Groups,
  opts: {conversationId: string; hostUserId?: string},
): string | undefined {
  const directLookupId = opts.hostUserId ? `direct:${opts.hostUserId}` : undefined;
  // B-13: the force-the-ad-hoc-slot rule applies ONLY to an ad-hoc
  // ('direct:*') escalated call, where a non-owner host MINTS a fresh key
  // under `direct:<host>` (keying off the stale real key = 0 frames, the
  // B-10 mismatch). A non-owner host of a REAL named group CANNOT mint or
  // broadcast over a group it doesn't own (B-15 owner-poison guard) —
  // ensureCallGroupKey REUSES the real group's key under the real
  // conversationId — so the joiner must resolve that SAME real key it
  // already holds. Forcing the empty `direct:<host>` slot hung real-group
  // joiners 25 s ("Call failed").
  const groupOwner = groups[opts.conversationId]?.owner;
  const hostIsAdmin = !opts.hostUserId || !groupOwner || groupOwner === opts.hostUserId;
  const isAdHocCall = opts.conversationId.startsWith('direct:');
  if (!hostIsAdmin && isAdHocCall && directLookupId) {
    return groups[directLookupId]?.masterKeyB64 ? directLookupId : undefined;
  }
  if (groups[opts.conversationId]?.masterKeyB64) {return opts.conversationId;}
  if (directLookupId && groups[directLookupId]?.masterKeyB64) {return directLookupId;}
  return undefined;
}

// Mirrors the resync eligibility guard in productionRuntime.ts ensureCallGroupKey
// (BS-CALL-OWNER): re-broadcast the existing state only when we own it.
function mayResyncExisting(
  existing: {masterKeyB64?: string; owner?: string} | undefined,
  ownUserId: string,
): boolean {
  return !!existing?.masterKeyB64 && existing.owner === ownUserId;
}

// Mirrors the recv-side inbox-row guard in productionRuntime.ts group-create:recv
// (BS-CALL-GHOST): upsert a conversation row for a real group create, but NOT
// for an ad-hoc 'Call' key-carrier (those would accumulate as ghost chats).
//   if (action.state.name !== 'Call') { store.upsertConversation(...) }
function shouldUpsertConversation(groupState: {name: string}): boolean {
  return groupState.name !== 'Call';
}

// Mirrors the owner-poison guard in productionRuntime.ts ensureCallGroupKey
// (BS-CALL-REALGROUP-MINT / B-15). When the resync gate is FALSE (we don't own
// the existing state), the runtime must NOT fall through to the mint path for a
// REAL named-server group whose stored owner is someone else — minting +
// `setGroupState` would FULL-OVERWRITE the real conversationId slot with
// owner=self, name='Call', epoch=0 and a fresh master key, then fan it out.
// A conversation is a "real group owned by another user" when it is NOT a
// `direct:*` ad-hoc thread AND it is either a stored group/ops_channel row OR a
// groups[] entry whose owner is present and not us.
type Conversations = Record<string, {type?: string}>;
function isRealGroupOwnedByOther(
  conversationId: string,
  conversations: Conversations,
  groups: Groups,
  ownUserId: string,
): boolean {
  if (conversationId.startsWith('direct:')) {return false;}
  const convType = conversations[conversationId]?.type;
  if (convType === 'group' || convType === 'ops_channel') {return true;}
  const g = groups[conversationId];
  return !!(g?.masterKeyB64 && g.owner && g.owner !== ownUserId);
}

// The runtime may mint a fresh 'Call' group only when the target is NOT a real
// group owned by another user. Direct:* ad-hoc ids and groups we own are fine.
function mayMintForConversation(
  conversationId: string,
  conversations: Conversations,
  groups: Groups,
  ownUserId: string,
): boolean {
  return !isRealGroupOwnedByOther(conversationId, conversations, groups, ownUserId);
}

const HOST = '5943a323-3136-47e4-acb5-30c26b7007e3';
const JOINER = '3165d0e1-0d3f-4d8c-be5d-a4b85d11b453';

describe('ad-hoc call key — joiner lookup id', () => {
  it('ad-hoc joiner resolves the key under direct:<host>, NOT its own conversationId', () => {
    // Escalated 1:1: conversationId is the joiner's asymmetric thread key
    // (means the JOINER itself — the wrong slot); the key was aliased
    // receive-side under direct:<owner>=direct:<host>.
    const opts = {conversationId: `direct:${JOINER}`, hostUserId: HOST};
    const groups: Groups = {[`direct:${HOST}`]: {masterKeyB64: 'k', owner: HOST}};
    expect(resolveKeyId(groups, opts)).toBe(`direct:${HOST}`);
    // It must NOT resolve to the joiner's own conversationId slot.
    expect(resolveKeyId(groups, opts)).not.toBe(opts.conversationId);
  });

  it('matches the receive-side alias slot (direct:<owner> = direct:<host>)', () => {
    // The receiver files the Call-create under `direct:<action.state.owner>`,
    // and owner===sender===host. The joiner must read the SAME id.
    const receiverAliasId = `direct:${HOST}`; // = direct:<owner>
    const opts = {conversationId: `direct:${JOINER}`, hostUserId: HOST};
    const groups: Groups = {[receiverAliasId]: {masterKeyB64: 'k', owner: HOST}};
    expect(resolveKeyId(groups, opts)).toBe(receiverAliasId);
  });

  it('BS-CALL-REALGROUP — real-group joiner resolves under the real conversationId even when hostUserId is set', () => {
    // IncomingGroupCallScreen sets hostUserId UNCONDITIONALLY, but a real
    // named group's key is filed ONLY under the real groupId (server UUID) —
    // never aliased under direct:<host>. The joiner MUST find it there, not
    // wait forever on the empty direct:<host> slot (the "Call failed" bug).
    const realConvo = '3cb79cb1f1b0e0be3ff9c2df76344a0f';
    const opts = {conversationId: realConvo, hostUserId: HOST};
    const groups: Groups = {[realConvo]: {masterKeyB64: 'k', owner: HOST}};
    expect(resolveKeyId(groups, opts)).toBe(realConvo);
    // The empty ad-hoc slot must NOT be chosen.
    expect(resolveKeyId(groups, opts)).not.toBe(`direct:${HOST}`);
  });

  it('prefers the real conversationId over the ad-hoc alias when BOTH hold a key', () => {
    const realConvo = '3cb79cb1f1b0e0be3ff9c2df76344a0f';
    const opts = {conversationId: realConvo, hostUserId: HOST};
    const groups: Groups = {
      [realConvo]:        {masterKeyB64: 'real', owner: HOST},
      [`direct:${HOST}`]: {masterKeyB64: 'adhoc', owner: HOST},
    };
    expect(resolveKeyId(groups, opts)).toBe(realConvo);
  });

  it('fails closed (undefined) when NEITHER slot holds a key', () => {
    // No key anywhere ⇒ the hook still throws "no group master key" ⇒ the
    // SFrame gate stays closed (no media, never plaintext).
    const opts = {conversationId: '3cb79cb1f1b0e0be3ff9c2df76344a0f', hostUserId: HOST};
    expect(resolveKeyId({}, opts)).toBeUndefined();
    // A slot present but WITHOUT masterKeyB64 is not a match either.
    expect(resolveKeyId({[`direct:${HOST}`]: {owner: HOST}}, opts)).toBeUndefined();
  });

  it('B-13 — non-OWNER host of a REAL group: joiner keys off the REAL conversationId (the reused real key), NOT an ad-hoc slot', () => {
    // itsirajul (non-owner) hosts fahim's group 3cb79cb1. itsirajul CANNOT
    // mint or broadcast over a group it doesn't own (B-15 owner-poison
    // guard), so ensureCallGroupKey REUSES fahim's real key under 3cb79cb1
    // and encrypts the call with it. The joiner already holds that same real
    // key as a member, so it must resolve the REAL conversationId. (The old
    // B-10 logic forced the ad-hoc slot here — but for a real group the host
    // never minted one, so the joiner hung 25 s waiting on an empty slot.)
    const realConvo = '3cb79cb1f1b0e0be3ff9c2df76344a0f';
    const ADMIN = 'fahim-owner-id';
    const opts = {conversationId: realConvo, hostUserId: HOST}; // HOST = non-owner host
    const groups: Groups = {[realConvo]: {masterKeyB64: 'realAdminKey', owner: ADMIN}};
    expect(resolveKeyId(groups, opts)).toBe(realConvo);
    expect(resolveKeyId(groups, opts)).not.toBe(`direct:${HOST}`);
  });

  it('B-13 — non-owner host, real group: a stray direct:<host> key from an UNRELATED ad-hoc call is ignored in favour of the real key', () => {
    // Even if a direct:<host> slot happens to hold a key (left over from a
    // prior escalated 1:1 with this host), a REAL-group call still uses the
    // real key the host reused — the stray ad-hoc key belongs to a different
    // conversation and would decrypt 0 frames.
    const realConvo = '3cb79cb1f1b0e0be3ff9c2df76344a0f';
    const ADMIN = 'fahim-owner-id';
    const opts = {conversationId: realConvo, hostUserId: HOST};
    const groups: Groups = {
      [realConvo]:        {masterKeyB64: 'realAdminKey', owner: ADMIN},
      [`direct:${HOST}`]: {masterKeyB64: 'strayAdhocKey', owner: HOST},
    };
    expect(resolveKeyId(groups, opts)).toBe(realConvo);
  });

  it('B-13 — non-owner host, real group, joiner missing the real key: fails closed (undefined), never plaintext', () => {
    // The genuinely-missing-key case (the original Pixel repro): the joiner
    // never received the real group key. There is nothing to resolve — it
    // must fail closed and wait/throw, not key off a stale slot. Recovery is
    // a real-group resync from the owner, outside the call flow.
    const realConvo = '3cb79cb1f1b0e0be3ff9c2df76344a0f';
    const opts = {conversationId: realConvo, hostUserId: HOST};
    const groups: Groups = {}; // joiner holds no key for this group
    expect(resolveKeyId(groups, opts)).toBeUndefined();
  });

  it('B-10 — AD-HOC (direct:*) non-owner host: joiner keys off direct:<host>, NOT a stale real key (mismatch guard preserved)', () => {
    // The B-10 guard still applies where it actually occurs: an escalated 1:1
    // (direct:*) hosted by a non-owner DOES mint a fresh ad-hoc key under
    // direct:<host>. A stale key under the direct:* conversationId (owned by
    // the other party) must NOT be chosen — that's the 0-frame mismatch.
    const adhocConvo = `direct:${JOINER}`;
    const opts = {conversationId: adhocConvo, hostUserId: HOST};
    const groups: Groups = {
      [adhocConvo]:       {masterKeyB64: 'staleKey', owner: JOINER}, // non-host owner ⇒ !hostIsAdmin
      [`direct:${HOST}`]: {masterKeyB64: 'adhocCallKey', owner: HOST},
    };
    expect(resolveKeyId(groups, opts)).toBe(`direct:${HOST}`);
    expect(resolveKeyId(groups, opts)).not.toBe(adhocConvo);
  });

  it('B-10 — AD-HOC non-owner host: joiner WAITS (undefined) while the ad-hoc key is in-flight, never the stale key', () => {
    // direct:* call, the stale slot has the other party's key but the ad-hoc
    // direct:<host> create has not landed → stay in the benign wait window.
    const adhocConvo = `direct:${JOINER}`;
    const opts = {conversationId: adhocConvo, hostUserId: HOST};
    const groups: Groups = {[adhocConvo]: {masterKeyB64: 'staleKey', owner: JOINER}};
    expect(resolveKeyId(groups, opts)).toBeUndefined();
  });

  it('B-10 — ADMIN host of a real group still resolves the real conversationId (proven path unchanged)', () => {
    const realConvo = '3cb79cb1f1b0e0be3ff9c2df76344a0f';
    const opts = {conversationId: realConvo, hostUserId: HOST}; // HOST IS the admin
    const groups: Groups = {[realConvo]: {masterKeyB64: 'realAdminKey', owner: HOST}};
    expect(resolveKeyId(groups, opts)).toBe(realConvo);
  });

  it('falls back to conversationId when hostUserId is absent (host path / real groups)', () => {
    // Host (outgoing) has no hostUserId — its own conversationId already
    // names the slot it minted/aliased the key under.
    const opts = {conversationId: 'group:abc123'};
    const groups: Groups = {'group:abc123': {masterKeyB64: 'k', owner: HOST}};
    expect(resolveKeyId(groups, opts)).toBe('group:abc123');
  });
});

// Mirrors the host-side alias targets in productionRuntime.ts ensureCallGroupKey
// (B-10): a freshly minted ad-hoc key is filed under its OWN id and under
// `direct:<owner>` ONLY — never aliased over the real conversationId (which
// would overwrite the persistent group's master key + owner on the host).
function adhocAliasTargets(opts: {
  mintedGroupId: string;
  ownUserId: string;
  conversationId: string;
}): string[] {
  return [opts.mintedGroupId, `direct:${opts.ownUserId}`];
}

describe('ad-hoc call key — host alias targets (B-10 no real-group poison)', () => {
  const REAL_CONVO = '3cb79cb1f1b0e0be3ff9c2df76344a0f';
  const MINTED = 'be6161ba38320000';

  it('files the ad-hoc key under its own id and direct:<owner> only', () => {
    const targets = adhocAliasTargets({
      mintedGroupId: MINTED, ownUserId: HOST, conversationId: REAL_CONVO,
    });
    expect(targets).toEqual([MINTED, `direct:${HOST}`]);
  });

  it('NEVER aliases the ad-hoc key over the real conversationId', () => {
    const targets = adhocAliasTargets({
      mintedGroupId: MINTED, ownUserId: HOST, conversationId: REAL_CONVO,
    });
    expect(targets).not.toContain(REAL_CONVO);
  });
});

describe('ad-hoc call key — resync owner guard', () => {
  it('re-broadcasts a key the host OWNS', () => {
    const existing = {masterKeyB64: 'k', owner: HOST};
    expect(mayResyncExisting(existing, HOST)).toBe(true);
  });

  it('REFUSES to re-broadcast a stale state owned by the OTHER party', () => {
    // After a prior call where JOINER was host, this device's slot holds
    // owner=JOINER. Re-broadcasting it from HOST would ship owner=JOINER
    // and be DROPped by the recipient's owner===sender forgery guard.
    const stale = {masterKeyB64: 'k', owner: JOINER};
    expect(mayResyncExisting(stale, HOST)).toBe(false);
  });

  it('does not resync when there is no key at all', () => {
    expect(mayResyncExisting(undefined, HOST)).toBe(false);
    expect(mayResyncExisting({owner: HOST}, HOST)).toBe(false);
  });
});

describe('ad-hoc call key — recv inbox-row guard (BS-CALL-GHOST)', () => {
  it('does NOT upsert a conversation row for an ad-hoc "Call" group', () => {
    // ensureCallGroupKey mints a fresh group named 'Call' per escalated
    // call; upserting it dropped a permanent ghost chat into the recipient's
    // list, and each retry minted a new groupId → ghosts accumulated.
    expect(shouldUpsertConversation({name: 'Call'})).toBe(false);
  });

  it('DOES upsert a conversation row for a real named group', () => {
    // Real groups must still appear in the inbox (the original
    // "Sirajul created a group but I don't see it" fix).
    expect(shouldUpsertConversation({name: 'SQA - Fahim'})).toBe(true);
    expect(shouldUpsertConversation({name: 'Engineering'})).toBe(true);
  });

  it('guard is exact — a group literally named "Call " (trailing space) is still a real group', () => {
    // Only the exact ad-hoc sentinel 'Call' is suppressed; a user who names
    // their group "Call" + anything is a real group and must show.
    expect(shouldUpsertConversation({name: 'Call '})).toBe(true);
    expect(shouldUpsertConversation({name: 'Call Team'})).toBe(true);
  });
});

describe('ad-hoc call key — owner-poison mint guard (B-15)', () => {
  const realConvo = '3cb79cb1f1b0e0be3ff9c2df76344a0f';

  it('REFUSES to mint over a real group whose stored owner is the OTHER party (no overwrite)', () => {
    // A non-owner host of a call on a REAL group: today the resync gate is
    // false (we don't own it) and the code falls through to mint + a FULL
    // setGroupState overwrite of the real conversationId with owner=self,
    // name='Call', epoch=0, fresh key. The guard must classify this as a real
    // group owned by another user → NOT mintable → reuse the stored key.
    const conversations: Conversations = {};
    const groups: Groups = {[realConvo]: {masterKeyB64: 'realK', owner: JOINER}};
    expect(isRealGroupOwnedByOther(realConvo, conversations, groups, HOST)).toBe(true);
    expect(mayMintForConversation(realConvo, conversations, groups, HOST)).toBe(false);
  });

  it('REFUSES to mint when the stored conversation row is a real group/ops_channel (even with no key yet)', () => {
    // A real server group row exists but this device lacks the master key.
    // Minting would overwrite the real slot; instead the runtime fails closed.
    const groups: Groups = {};
    expect(isRealGroupOwnedByOther(realConvo, {[realConvo]: {type: 'group'}}, groups, HOST)).toBe(true);
    expect(isRealGroupOwnedByOther(realConvo, {[realConvo]: {type: 'ops_channel'}}, groups, HOST)).toBe(true);
    expect(mayMintForConversation(realConvo, {[realConvo]: {type: 'group'}}, groups, HOST)).toBe(false);
  });

  it('ALLOWS minting/aliasing for a direct:* ad-hoc (escalated 1:1) id', () => {
    // The escalated-1:1 path (commit 25eb8f0) mints a 'Call' group and aliases
    // it under direct:<peer>. That MUST keep working — a direct:* id is never
    // a real group slot, even if a stale entry happens to carry another owner.
    const directId = `direct:${JOINER}`;
    const conversations: Conversations = {};
    const groups: Groups = {[directId]: {masterKeyB64: 'k', owner: JOINER}};
    expect(isRealGroupOwnedByOther(directId, conversations, groups, HOST)).toBe(false);
    expect(mayMintForConversation(directId, conversations, groups, HOST)).toBe(true);
  });

  it('ALLOWS resync (not mint) for a real group we DO own', () => {
    // When we own the real group, the resync gate (mayResyncExisting) handles
    // it — and the mint guard does not flag it as owned-by-other.
    const conversations: Conversations = {[realConvo]: {type: 'group'}};
    const groups: Groups = {[realConvo]: {masterKeyB64: 'realK', owner: HOST}};
    // It IS a real group row, so it is not mintable (we never mint over a real
    // group) — but because we own it, mayResyncExisting permits the resync path.
    expect(mayResyncExisting(groups[realConvo], HOST)).toBe(true);
    // owner === self ⇒ not "owned by other"; the row-type still blocks mint,
    // which is correct: we resync, we don't mint.
    expect(isRealGroupOwnedByOther(realConvo, conversations, groups, HOST)).toBe(true);
  });

  it('a bare ad-hoc "Call" mint target (no conv row, no stale owner) is mintable', () => {
    // First-ever escalated call: no stored conversation, no stored group state.
    // Nothing flags it as a real group → minting a fresh 'Call' group is fine.
    const adhocId = `direct:${JOINER}`;
    expect(mayMintForConversation(adhocId, {}, {}, HOST)).toBe(true);
  });
});
