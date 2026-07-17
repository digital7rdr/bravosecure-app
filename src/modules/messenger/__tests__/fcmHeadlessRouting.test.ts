/**
 * Killed-app headless FCM routing:
 *   - P2-BR-5: a contact's GROUP message must NOT be silenced just because their
 *     1:1 DM is muted — mute suppression applies ONLY to an unambiguous explicit
 *     conversationId, never to a DM heuristically resolved from senderUserId.
 *   - P1-BR-1: a group ring must thread roomId (= callId) + roomToken into the
 *     notification so the accept path can sfu.join the host's room.
 *   - P1-7: a missed-call notification must carry fromUserId so its tap can
 *     deep-link to the caller's thread (never a ghost CallScreen).
 */

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockStore.set(k, v); },
    removeItem: async (k: string) => { mockStore.delete(k); },
  },
}));
jest.mock('react-native', () => ({Platform: {OS: 'android'}, NativeModules: {}}));
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    displayNotification: jest.fn(async () => {}),
    cancelNotification:  jest.fn(async () => {}),
    createChannel:       jest.fn(async () => 'ch'),
    deleteChannel:       jest.fn(async () => {}),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1, MESSAGING: 2},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));
// Ring admission stays HMAC-gated in production; the display-routing under test
// is downstream of a valid verdict, so stub the verifier as ok.
jest.mock('../push/voipWakeVerify', () => ({verifyVoipWake: jest.fn(async () => ({ok: true}))}));

import notifee from '@notifee/react-native';
import {handleHeadlessFcm} from '../push/fcmHeadless';

const display = notifee.displayNotification as jest.Mock;

const OWNER = 'owner-a';
const PEER  = 'peer-alice';
type Convo = {is_muted?: boolean; type?: string; peer?: {userId?: string}};
function seed(convos: Record<string, Convo>): void {
  mockStore.set('messenger-store-v1', JSON.stringify({
    state: {_ownUserId: OWNER, vaultByOwner: {[OWNER]: {conversations: convos}}},
    version: 0,
  }));
}
const msg = (data: Record<string, string>) => handleHeadlessFcm({data} as never);

beforeEach(() => { mockStore.clear(); display.mockClear(); });

describe('msg-wake mute gate (P2-BR-5)', () => {
  it('does NOT suppress a group message when the sender\'s 1:1 DM is muted (ambiguous)', async () => {
    seed({[`direct:${PEER}`]: {type: 'direct', peer: {userId: PEER}, is_muted: true}});
    // No explicit conversationId — the wake could be a GROUP message.
    await msg({kind: 'msg-wake', senderUserId: PEER});
    expect(display).toHaveBeenCalledTimes(1); // banner shown, NOT silenced
  });

  it('suppresses only when the wake names its conversation explicitly and it is muted', async () => {
    seed({'uuid-muted': {type: 'direct', peer: {userId: PEER}, is_muted: true}});
    await msg({kind: 'msg-wake', conversationId: 'uuid-muted', senderUserId: PEER});
    expect(display).not.toHaveBeenCalled();
  });

  it('shows a banner for an explicit, unmuted conversation', async () => {
    seed({'uuid-open': {type: 'group', is_muted: false}});
    await msg({kind: 'msg-wake', conversationId: 'uuid-open'});
    expect(display).toHaveBeenCalledTimes(1);
    expect(display.mock.calls[0][0].id).toBe('bravo-msg-uuid-open');
  });
});

describe('group ring threads roomId + roomToken (P1-BR-1)', () => {
  it('derives roomId from callId for a group kind and carries roomToken into the notif data', async () => {
    await msg({
      kind: 'voip-wake', callId: 'room-42', callKind: 'group-voice',
      fromUserId: 'host-1', roomToken: 'tok-abc', nonce: 'n', exp: '9999999999', sig: 's',
    });
    expect(display).toHaveBeenCalledTimes(1);
    const arg = display.mock.calls[0][0];
    expect(arg.id).toBe('bravo-call-room-42');
    expect(arg.data.roomId).toBe('room-42');     // group rings reuse callId AS roomId
    expect(arg.data.roomToken).toBe('tok-abc');  // echoed for sfu.join
  });
});

describe('missed-call notification carries fromUserId (P1-7 tap contract)', () => {
  it('a call-cancel with missed=1 posts a missed-call banner tagged with fromUserId', async () => {
    await msg({kind: 'call-cancel', callId: 'call-9', missed: '1', fromUserId: 'peer-7', callKind: 'voice'});
    const missed = display.mock.calls.map(c => c[0]).find(n => n.id === 'bravo-missed-call-9');
    expect(missed).toBeDefined();
    expect(missed.data.kind).toBe('missed-call');
    expect(missed.data.fromUserId).toBe('peer-7');
  });
});
