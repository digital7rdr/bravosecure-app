/**
 * §35A §F — CPO mid-session revocation re-check. We exercise the REAL authStore
 * recheckMembership/endCpoAccess logic with the API layer mocked. signOut() is stubbed
 * (its full teardown does heavy lazy requires of the messenger runtime that don't belong
 * in a store unit test) — we only assert that it IS invoked on revocation.
 */
jest.mock('@services/api', () => ({
  authApi: {me: jest.fn()},
  agentApi: {setDuty: jest.fn(() => Promise.resolve())},
  getDeviceId: jest.fn(() => Promise.resolve('dev-1')),
  tokenStore: {get: jest.fn(), getRefresh: jest.fn(), set: jest.fn(), clear: jest.fn()},
  subscriptionApi: {},
}));
jest.mock('@modules/observability', () => ({setUser: jest.fn()}));
jest.mock('expo-local-authentication', () => ({}));

import {useAuthStore} from '@store/authStore';
import {authApi, agentApi} from '@services/api';

const mockMe = authApi.me as jest.Mock;
const mockSetDuty = agentApi.setDuty as jest.Mock;

const API_USER = {
  id: 'u1', email: 'guard@x.io', display_name: 'Guard One', role: 'agent',
  subscription_tier: 'lite', phone_e164: '+10000000000',
};
const mockSignOut = jest.fn(() => Promise.resolve());

function meReturns(account_kind: string, membership_status: string | null) {
  mockMe.mockResolvedValueOnce({
    user: API_USER, account_kind, org: {id: 'o1', name: 'Acme CP'},
    must_set_password: false, membership_status,
  });
}

describe('authStore.recheckMembership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the slice we touch + stub the heavy signOut teardown.
    useAuthStore.setState({accessEnded: false, user: null, isAuthenticated: true, signOut: mockSignOut});
  });

  it('active CPO → no teardown, just refreshes the local user', async () => {
    meReturns('cpo', 'active');
    await useAuthStore.getState().recheckMembership();
    expect(mockSetDuty).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessEnded).toBe(false);
    expect(useAuthStore.getState().user?.org?.name).toBe('Acme CP');
  });

  it('suspended CPO → setDuty(false) + signOut() + accessEnded', async () => {
    meReturns('cpo', 'suspended');
    await useAuthStore.getState().recheckMembership();
    expect(mockSetDuty).toHaveBeenCalledWith(false);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessEnded).toBe(true);
  });

  it('removed CPO → teardown', async () => {
    meReturns('cpo', 'removed');
    await useAuthStore.getState().recheckMembership();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessEnded).toBe(true);
  });

  it('individual account → never torn down', async () => {
    meReturns('individual', null);
    await useAuthStore.getState().recheckMembership();
    expect(mockSetDuty).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessEnded).toBe(false);
  });

  it('a 401 on the re-check is itself a revocation signal', async () => {
    mockMe.mockRejectedValueOnce({isAxiosError: true, response: {status: 401}});
    await useAuthStore.getState().recheckMembership();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessEnded).toBe(true);
  });

  it('a transient network error does NOT log the guard out', async () => {
    mockMe.mockRejectedValueOnce(new Error('Network Error'));
    await useAuthStore.getState().recheckMembership();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessEnded).toBe(false);
  });

  it('endCpoAccess is idempotent (a second call is a no-op)', async () => {
    meReturns('cpo', 'suspended');
    await useAuthStore.getState().recheckMembership();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    // Already torn down — calling again must not re-run setDuty/signOut.
    await useAuthStore.getState().endCpoAccess();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSetDuty).toHaveBeenCalledTimes(1);
  });
});
