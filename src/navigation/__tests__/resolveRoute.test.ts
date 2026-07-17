import {resolveAuthedRoute} from '../resolveRoute';

describe('resolveAuthedRoute — §35A root switch (pure)', () => {
  it('routes an individual to the client tabs', () => {
    expect(resolveAuthedRoute({accountKind: 'individual'})).toBe('client');
    expect(resolveAuthedRoute({})).toBe('client'); // no account_kind yet → client default
  });

  it('routes an agency operator to the agency shell', () => {
    expect(resolveAuthedRoute({accountKind: 'agency'})).toBe('agency');
  });

  it('keeps the legacy/pendingProvider agency fallback (account_kind not yet flipped)', () => {
    expect(resolveAuthedRoute({legacyRole: 'agent'})).toBe('agency');
    expect(resolveAuthedRoute({legacyRole: 'service_provider'})).toBe('agency');
    expect(resolveAuthedRoute({pendingProvider: true})).toBe('agency');
  });

  describe('CPO', () => {
    it('first login (must set password) → activation', () => {
      expect(resolveAuthedRoute({accountKind: 'cpo', mustSetPassword: true, membershipStatus: 'active'}))
        .toBe('cpo-activation');
    });

    it('active, password already set → CPO shell', () => {
      expect(resolveAuthedRoute({accountKind: 'cpo', mustSetPassword: false, membershipStatus: 'active'}))
        .toBe('cpo');
      expect(resolveAuthedRoute({accountKind: 'cpo'})).toBe('cpo'); // membership null treated as active
    });

    it('password set but onboarding not cleared (DOCS_PENDING) → cpo-onboarding', () => {
      expect(resolveAuthedRoute({accountKind: 'cpo', mustSetPassword: false, membershipStatus: 'active', cpoNeedsOnboarding: true}))
        .toBe('cpo-onboarding');
    });

    it('still-needs-password beats onboarding (sets password first)', () => {
      expect(resolveAuthedRoute({accountKind: 'cpo', mustSetPassword: true, membershipStatus: 'active', cpoNeedsOnboarding: true}))
        .toBe('cpo-activation');
    });

    it('revocation beats onboarding (suspended CPO never reaches docs)', () => {
      expect(resolveAuthedRoute({accountKind: 'cpo', membershipStatus: 'suspended', cpoNeedsOnboarding: true}))
        .toBe('access-ended');
    });

    it('onboarding flag is ignored for a non-CPO', () => {
      expect(resolveAuthedRoute({accountKind: 'agency', cpoNeedsOnboarding: true})).toBe('agency');
      expect(resolveAuthedRoute({accountKind: 'individual', cpoNeedsOnboarding: true})).toBe('client');
    });

    it('suspended or removed → access-ended (even with must_set_password)', () => {
      expect(resolveAuthedRoute({accountKind: 'cpo', membershipStatus: 'suspended'})).toBe('access-ended');
      expect(resolveAuthedRoute({accountKind: 'cpo', membershipStatus: 'removed'})).toBe('access-ended');
      // Revocation beats activation — a removed CPO never reaches set-password.
      expect(resolveAuthedRoute({accountKind: 'cpo', mustSetPassword: true, membershipStatus: 'removed'}))
        .toBe('access-ended');
    });

    it('CPO precedence wins even if a legacy role/pending flag is also set', () => {
      expect(resolveAuthedRoute({accountKind: 'cpo', membershipStatus: 'active', legacyRole: 'agent', pendingProvider: true}))
        .toBe('cpo');
    });
  });
});
