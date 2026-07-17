/**
 * B-41 — group `create` epoch guard must allow a keyless-placeholder bootstrap.
 *
 * Bug: a member that holds a KEYLESS group state at an equal/higher epoch
 * (e.g. it received an `add` admin action that advanced its epoch, or a
 * synthetic key-request stub, but never the master key itself) dropped the
 * very owner-signed `create` that delivers the key — because the
 * epoch-monotonicity guard rejected `incomingEpoch <= existing.epoch` as a
 * "stale/replayed create". Result: the member stayed permanently keyless —
 * group messages never decrypt, and a group CALL dies at the key-wait
 * ("Call failed"; the joiner joins the SFU room but never produces media).
 *
 * Fix (productionRuntime `group-create:recv`): only enforce epoch-monotonicity
 * once we actually hold a master key worth protecting. With no local key there
 * is no established keyed state to roll back, and the create is already
 * owner-signature-verified, so accepting it is a bootstrap, not a downgrade.
 *
 * This pins the PURE decision the runtime now makes (mirrors the inline guard;
 * asserts no key material — only accept/drop).
 */

// Mirrors productionRuntime.ts `group-create:recv`:
//   if (existing && existing.masterKeyB64 && action.state.epoch <= existing.epoch) { DROP }
function shouldDropCreate(
  existing: {masterKeyB64?: string; epoch: number} | undefined,
  incomingEpoch: number,
): boolean {
  return !!(existing?.masterKeyB64 && incomingEpoch <= existing.epoch);
}

describe('group create epoch guard — keyless bootstrap (B-41)', () => {
  it('accepts a create when there is no local state at all', () => {
    expect(shouldDropCreate(undefined, 0)).toBe(false);
    expect(shouldDropCreate(undefined, 5)).toBe(false);
  });

  it('ACCEPTS a same-epoch create when the local placeholder has NO key (the fix)', () => {
    const keyless = {masterKeyB64: '', epoch: 3};
    expect(shouldDropCreate(keyless, 3)).toBe(false);
  });

  it('ACCEPTS a lower-epoch create when the local placeholder has NO key', () => {
    const keyless = {masterKeyB64: undefined, epoch: 7};
    expect(shouldDropCreate(keyless, 2)).toBe(false);
  });

  it('still DROPS a stale/replayed create when we hold a real key (replay defence intact)', () => {
    const keyed = {masterKeyB64: 'AAAA', epoch: 4};
    expect(shouldDropCreate(keyed, 4)).toBe(true); // same epoch
    expect(shouldDropCreate(keyed, 2)).toBe(true); // older epoch
  });

  it('accepts a strictly-newer create even when we hold a key (normal epoch advance)', () => {
    const keyed = {masterKeyB64: 'AAAA', epoch: 4};
    expect(shouldDropCreate(keyed, 5)).toBe(false);
  });
});
