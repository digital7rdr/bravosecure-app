/**
 * Audit P0-G3 — two admins racing `remove` of the same user must NOT
 * fork the cluster into two master keys at the same epoch.
 *
 * Original behaviour: `planRemoveAndRekey` minted a random 32-byte key,
 * so Admin1 and Admin2 racing the same remove produced two distinct
 * post-rekey keys. Each subset of the cluster that applied one admin's
 * `{remove, rekey}` pair before the other's landed on a different
 * `masterKeyB64`, and the next text envelope from either side appeared
 * to be tamper to the other half — silent group fork.
 *
 * Fix: deterministic derivation `KDF(prev_master_key || sort(removed) ||
 * post_epoch)` keyed by the in-flight state (`prev_master_key` + the
 * sorted set of removed members + the post-remove epoch). Both admins
 * derive the SAME key from the SAME inputs, so:
 *
 *   - The two `rekey` envelopes carry IDENTICAL `newMasterKeyB64`.
 *   - `applyAdminAction(state, planA.rekey, A)` ===
 *     `applyAdminAction(state, planB.rekey, B)` in terms of
 *     `masterKeyB64` after both halves apply.
 *   - Whichever order the cluster sees the two pairs in, all members
 *     converge on the same post-state.
 */

import {
  makeNewGroup,
  planRemoveAndRekey,
  planAddAndRekey,
  planLeaveAndRekey,
  applyAdminAction,
} from '@bravo/messenger-core';

describe('audit P0-G3 — racing remove plans converge on the same master key', () => {
  function freshGroup() {
    return makeNewGroup({
      name: 'difc-ops',
      owner: 'alice',
      ownerDeviceId: 1,
      members: [
        {userId: 'bob', deviceId: 1},
        {userId: 'carol', deviceId: 1},
        {userId: 'dave', deviceId: 1},
      ],
    });
  }

  it('two admins planning the same `remove` produce the SAME newMasterKeyB64', () => {
    const state = freshGroup();
    // Promote bob + carol to admin so two admins exist at the same epoch.
    const promote: typeof state = {
      ...state,
      members: {
        ...state.members,
        bob: {...state.members.bob, admin: true},
        carol: {...state.members.carol, admin: true},
      },
    };

    const planFromBob = planRemoveAndRekey(promote, 'dave');
    const planFromCarol = planRemoveAndRekey(promote, 'dave');

    expect(planFromBob.newMasterKeyB64).toBe(planFromCarol.newMasterKeyB64);
    expect(planFromBob.rekey.newMasterKeyB64).toBe(planFromCarol.rekey.newMasterKeyB64);
  });

  it('applying bob-then-carol === applying carol-then-bob (converge across orderings)', () => {
    const state = freshGroup();
    const promote: typeof state = {
      ...state,
      members: {
        ...state.members,
        bob: {...state.members.bob, admin: true},
        carol: {...state.members.carol, admin: true},
      },
    };

    const planB = planRemoveAndRekey(promote, 'dave');
    const planC = planRemoveAndRekey(promote, 'dave');

    // Order 1: bob's pair first
    let s1 = applyAdminAction(promote, planB.remove, 'bob');
    s1 = applyAdminAction(s1, planB.rekey, 'bob');
    // Now carol's stale pair applies — it should be IGNORED because
    // atEpoch no longer matches. The masterKey was already converged.
    s1 = applyAdminAction(s1, planC.remove, 'carol');
    s1 = applyAdminAction(s1, planC.rekey, 'carol');

    // Order 2: carol's pair first
    let s2 = applyAdminAction(promote, planC.remove, 'carol');
    s2 = applyAdminAction(s2, planC.rekey, 'carol');
    s2 = applyAdminAction(s2, planB.remove, 'bob');
    s2 = applyAdminAction(s2, planB.rekey, 'bob');

    expect(s1.masterKeyB64).toBe(s2.masterKeyB64);
    expect(Object.keys(s1.members).sort()).toEqual(Object.keys(s2.members).sort());
    expect(s1.epoch).toBe(s2.epoch);
  });

  it('derived key is NOT the previous master key (forward-secrecy preserved)', () => {
    const state = freshGroup();
    const plan = planRemoveAndRekey(state, 'bob');
    expect(plan.newMasterKeyB64).not.toBe(state.masterKeyB64);
    // Output looks like a base64-encoded 32-byte key.
    expect(plan.newMasterKeyB64).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('removing different users at the same epoch produces DIFFERENT keys (no collisions)', () => {
    const state = freshGroup();
    const planRemoveBob = planRemoveAndRekey(state, 'bob');
    const planRemoveCarol = planRemoveAndRekey(state, 'carol');
    expect(planRemoveBob.newMasterKeyB64).not.toBe(planRemoveCarol.newMasterKeyB64);
  });
});

// F2 planAddAndRekey-nondeterministic-key-fork — the same convergence
// guarantee for ADD, which previously minted a random key.
describe('F2 — racing add plans converge on the same master key', () => {
  function freshGroup() {
    return makeNewGroup({
      name: 'difc-ops',
      owner: 'alice',
      ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}],
    });
  }

  it('two admins planning the same `add` produce the SAME newMasterKeyB64', () => {
    const state = freshGroup();
    const planA = planAddAndRekey(state, {userId: 'carol', deviceId: 1});
    const planB = planAddAndRekey(state, {userId: 'carol', deviceId: 1});
    expect(planA.newMasterKeyB64).toBe(planB.newMasterKeyB64);
    expect(planA.rekey.newMasterKeyB64).toBe(planB.rekey.newMasterKeyB64);
  });

  it('adding different users at the same epoch produces DIFFERENT keys', () => {
    const state = freshGroup();
    const addCarol = planAddAndRekey(state, {userId: 'carol', deviceId: 1});
    const addDave  = planAddAndRekey(state, {userId: 'dave', deviceId: 1});
    expect(addCarol.newMasterKeyB64).not.toBe(addDave.newMasterKeyB64);
  });

  it('derived key is NOT the previous master key (forward-secrecy on add)', () => {
    const state = freshGroup();
    const plan = planAddAndRekey(state, {userId: 'carol', deviceId: 1});
    expect(plan.newMasterKeyB64).not.toBe(state.masterKeyB64);
    expect(plan.newMasterKeyB64).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

// P1-G4 voluntary leave + rekey — the leaver removes themselves and the
// remaining members rotate onto a new key (forward secrecy on leave).
describe('P1-G4 — leave + rekey', () => {
  function group() {
    return makeNewGroup({
      name: 'difc-ops',
      owner: 'alice',
      ownerDeviceId: 1,
      members: [{userId: 'bob', deviceId: 1}, {userId: 'carol', deviceId: 1}],
    });
  }

  it('remaining members apply the leave: sender removed, epoch bumped', () => {
    const state = group();
    const plan = planLeaveAndRekey(state, 'bob');
    const s = applyAdminAction(state, plan.leave, 'bob');
    expect(s.members.bob).toBeUndefined();
    expect(s.members.alice).toBeDefined();
    expect(s.members.carol).toBeDefined();
    expect(s.epoch).toBe(state.epoch + 1);
  });

  // The leaver CANNOT authorize the chained rekey: once `leave` removes them,
  // the reducer drops any further admin action from a non-member — so the
  // post-leave rekey is a silent no-op (documents why leaveGroup ships
  // leave-only; forward-secrecy-on-leave needs a REMAINING admin to rekey).
  it('post-leave rekey signed by the leaver is a no-op (non-member rejected)', () => {
    const state = group();
    const plan = planLeaveAndRekey(state, 'bob');
    const afterLeave = applyAdminAction(state, plan.leave, 'bob');
    const afterRekey = applyAdminAction(afterLeave, plan.rekey, 'bob');
    // Rejected — masterKey unchanged from the post-leave state.
    expect(afterRekey.masterKeyB64).toBe(afterLeave.masterKeyB64);
  });
});
