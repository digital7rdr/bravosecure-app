/**
 * M1A — deriveEntitlements: org-OR-tier, never double-gate. Cloud vault is
 * Pro+; the enterprise feature set unlocks via paid tier OR org tenancy.
 * authStore is mocked — deriveEntitlements is pure over the user shape, and
 * the real store drags native deps (expo-local-authentication) into a unit test.
 */
jest.mock('@store/authStore', () => ({
  useAuthStore: Object.assign(jest.fn(), {getState: () => ({user: null})}),
}));

import {deriveEntitlements} from '@store/entitlements';

const base = {id: 'u1', email: 'x@y.z', full_name: 'X', role: 'individual'};

describe('entitlements M1A', () => {
  it('lite individual: no vault, no dept channels', () => {
    const e = deriveEntitlements({...base, subscription_tier: 'lite'} as never);
    expect(e.hasCloudVault).toBe(false);
    expect(e.hasDeptChannels).toBe(false);
    expect(e.effective).toBe('lite');
  });

  it('active pro individual: vault yes, dept channels no', () => {
    const e = deriveEntitlements({...base, subscription_tier: 'pro', pro_active_until: null} as never);
    expect(e.hasCloudVault).toBe(true);
    expect(e.hasDeptChannels).toBe(false);
    expect(e.hasSM512Label).toBe(true);
  });

  it('active enterprise individual: vault + dept channels (founder: inherit the 3 features)', () => {
    const e = deriveEntitlements({...base, subscription_tier: 'enterprise', pro_active_until: null} as never);
    expect(e.hasCloudVault).toBe(true);
    expect(e.hasDeptChannels).toBe(true);
    expect(e.isEnterprise).toBe(true);
    expect(e.isOrgAffiliated).toBe(false);
  });

  it('LAPSED enterprise individual: everything locks again', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const e = deriveEntitlements({...base, subscription_tier: 'enterprise', pro_active_until: past} as never);
    expect(e.hasCloudVault).toBe(false);
    expect(e.hasDeptChannels).toBe(false);
    expect(e.effective).toBe('lite');
  });

  it('lite ORG member (managed CPO): keeps vault + dept channels via tenancy', () => {
    const e = deriveEntitlements({
      ...base, subscription_tier: 'lite', account_kind: 'cpo',
      membership_status: 'active', org: {id: 'o1', name: 'Acme'},
    } as never);
    expect(e.hasCloudVault).toBe(true);
    expect(e.hasDeptChannels).toBe(true);
    expect(e.isOrgAffiliated).toBe(true);
  });

  it('SUSPENDED org member on lite: tenancy no longer entitles', () => {
    const e = deriveEntitlements({
      ...base, subscription_tier: 'lite', account_kind: 'cpo',
      membership_status: 'suspended', org: {id: 'o1', name: 'Acme'},
    } as never);
    expect(e.hasCloudVault).toBe(false);
    expect(e.hasDeptChannels).toBe(false);
  });

  it('agency/provider account: enterprise set regardless of tier (rule 7 untouched)', () => {
    const e = deriveEntitlements({
      ...base, role: 'service_provider', subscription_tier: 'lite', account_kind: 'agency',
    } as never);
    expect(e.isEnterprise).toBe(true);
    expect(e.hasDeptChannels).toBe(true);
    expect(e.hasCloudVault).toBe(true);
  });

  it('null user: fully locked', () => {
    const e = deriveEntitlements(null as never);
    expect(e.hasCloudVault).toBe(false);
    expect(e.hasDeptChannels).toBe(false);
    expect(e.effective).toBe('lite');
  });
});
