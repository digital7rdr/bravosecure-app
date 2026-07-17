/**
 * IDN-22 (F10) — signOut re-entrancy + overlay-flag hygiene. We exercise the
 * REAL signOut with every lazy-required messenger module mocked to a stub so
 * the teardown sequencing (guard → steps → finally) is what's under test.
 */
jest.mock('@services/api', () => ({
  authApi: {me: jest.fn(), signOut: jest.fn(() => Promise.resolve())},
  agentApi: {setDuty: jest.fn(() => Promise.resolve())},
  getDeviceId: jest.fn(() => Promise.resolve('dev-1')),
  tokenStore: {get: jest.fn(), getRefresh: jest.fn(), set: jest.fn(), clear: jest.fn()},
  subscriptionApi: {},
}));
jest.mock('@modules/observability', () => ({setUser: jest.fn()}));
jest.mock('expo-local-authentication', () => ({}));

// Stubs for every module signOut lazy-requires — the real ones pull native
// deps (op-sqlite, webrtc, keychain) that don't belong in a store unit test.
jest.mock('@/modules/messenger/runtime', () => ({
  getActiveOwnerKey: jest.fn(() => 'owner@x.io'),
  _resetMessengerRuntime: jest.fn(),
}));
jest.mock('@/modules/messenger/push/unregisterPush', () => ({
  revokeServerPushTokens: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/modules/messenger/webrtc/incomingOneToOneBanner', () => ({clearPendingOneToOne: jest.fn()}));
jest.mock('@/modules/messenger/runtime/callRegistry', () => ({endActiveCall: jest.fn()}));
jest.mock('@/modules/messenger/runtime/groupCallRegistry', () => ({endActiveGroupCall: jest.fn(() => Promise.resolve())}));
jest.mock('@/modules/messenger/runtime/bravoTones', () => ({stopAllTones: jest.fn(() => Promise.resolve())}));
jest.mock('@/modules/messenger/backup/messageMirror', () => ({disposeMirror: jest.fn()}));
jest.mock('@/modules/messenger/backup/mirrorBootstrap', () => ({stopMirrorBootstrap: jest.fn()}));
jest.mock('@/modules/messenger/backup/identityBackup', () => ({lockIdentityBackup: jest.fn()}));
jest.mock('@/modules/messenger/runtime/productionRuntime', () => ({disposeLiveRuntime: jest.fn()}));
jest.mock('@/modules/messenger/store/messengerStore', () => ({
  useMessengerStore: {getState: () => ({clearAllPresence: jest.fn()})},
}));
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({clearLiveTransport: jest.fn()}));
jest.mock('@/modules/messenger/webrtc/callDispatcher', () => ({clearAllCallDispatchState: jest.fn()}));
jest.mock('@/modules/messenger/webrtc/sfuDispatcher', () => ({clearAllSfuHandlers: jest.fn()}));
jest.mock('@/modules/messenger/webrtc/groupCallIdentityRegistry', () => ({clearAllRoomIdentities: jest.fn()}));
jest.mock('@/modules/messenger/webrtc/useGroupCall', () => ({clearAllLiveSfuHandles: jest.fn()}));
jest.mock('@/modules/messenger/webrtc/groupCallRingDispatcher', () => ({clearAllGroupCallRingHandlers: jest.fn()}));
jest.mock('@/modules/messenger/runtime/rttRegistry', () => ({clearRtt: jest.fn()}));
jest.mock('@/modules/messenger/push/fcmBootstrap', () => ({stopFcmBootstrap: jest.fn()}));
jest.mock('@/modules/messenger/push/voipWakeVerify', () => ({clearVoipWakeKey: jest.fn(() => Promise.resolve())}));
jest.mock('@/modules/messenger/runtime/wipeAtRest', () => ({
  wipeUserAtRest: jest.fn(() => Promise.resolve({errors: []})),
}));
jest.mock('@store/walletStore', () => ({useWalletStore: {getState: () => ({reset: jest.fn()})}}));
jest.mock('@store/bookingStore', () => ({useBookingStore: {getState: () => ({reset: jest.fn()})}}));

import {useAuthStore} from '@store/authStore';
import {authApi, getDeviceId} from '@services/api';
import {setUser as setObservabilityUser} from '@modules/observability';
import {wipeUserAtRest} from '@/modules/messenger/runtime/wipeAtRest';

const mockApiSignOut = authApi.signOut as jest.Mock;
const mockGetDeviceId = getDeviceId as jest.Mock;
const mockSetObsUser = setObservabilityUser as jest.Mock;
const mockWipe = wipeUserAtRest as jest.Mock;

describe('authStore.signOut — IDN-22 re-entrancy + flag hygiene', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDeviceId.mockResolvedValue('dev-1');
    mockApiSignOut.mockResolvedValue(undefined);
    useAuthStore.setState({isAuthenticated: true, isSigningOut: false});
  });

  it('a second call while one is in flight is a no-op', async () => {
    // Hold the auth-service revoke so the first call parks mid-teardown.
    let releaseApiSignOut!: () => void;
    mockApiSignOut.mockImplementationOnce(
      () => new Promise<void>(r => { releaseApiSignOut = r; }),
    );

    const p1 = useAuthStore.getState().signOut();
    // The flag is raised synchronously before the first await, so the
    // second call must early-return without starting its own teardown.
    expect(useAuthStore.getState().isSigningOut).toBe(true);
    const p2 = useAuthStore.getState().signOut();
    await p2;
    expect(mockGetDeviceId).toHaveBeenCalledTimes(1);

    // Flush pending microtasks so p1 reaches (and parks on) the held
    // authApi.signOut call before we release it.
    await new Promise(r => setTimeout(r, 0));
    expect(mockApiSignOut).toHaveBeenCalledTimes(1);
    releaseApiSignOut();
    await p1;
    expect(mockApiSignOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isSigningOut).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('clears isSigningOut in finally even when a step throws', async () => {
    mockSetObsUser.mockImplementationOnce(() => { throw new Error('sentry down'); });
    await expect(useAuthStore.getState().signOut()).rejects.toThrow('sentry down');
    // The button must not be bricked: flag cleared, next attempt runs.
    expect(useAuthStore.getState().isSigningOut).toBe(false);
    await useAuthStore.getState().signOut();
    expect(mockApiSignOut).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().isSigningOut).toBe(false);
  });

  it('plain signOut does NOT wipe at-rest; {wipeAtRest:true} does', async () => {
    await useAuthStore.getState().signOut();
    expect(mockWipe).not.toHaveBeenCalled();

    useAuthStore.setState({isAuthenticated: true, isSigningOut: false});
    await useAuthStore.getState().signOut({wipeAtRest: true});
    expect(mockWipe).toHaveBeenCalledTimes(1);
    expect(mockWipe).toHaveBeenCalledWith('owner@x.io');
  });
});
