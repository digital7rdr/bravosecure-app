/**
 * Audit row #5 (C1/C2/C3 + #6) — SFU + call.offer authority unit tests.
 *
 * The gateway is heavy to bring up fully (mediasoup workers, Redis
 * adapter, real socket.io server) so these tests stub the deps the
 * authority paths actually touch:
 *   - RoomTokenService.issue/verify   (HMAC binding)
 *   - SfuService.hostOf               (cancel/ring host check)
 *   - SfuService.bindFanout           (constructor side effect only)
 *
 * Scope:
 *   - sfu.ring rejects non-host                                  (C3)
 *   - sfu.ring rejects too-many recipients                       (C3)
 *   - sfu.ring.cancel rejects non-host                           (C2)
 *   - sfu.ring.decline rejects when secret-set + no token        (C2)
 *   - sfu.ring.decline admits valid (roomId, callerId) token     (C2)
 *   - call.offer rejects when `auth` is missing                  (#6)
 */
import {ConfigService} from '@nestjs/config';
import {Logger} from '@nestjs/common';
import {MessengerGateway} from './messenger.gateway';
import {RoomTokenService} from '../sfu/room-token.service';

const SECRET = 'sfu-room-token-secret-at-least-32-chars-long';

// Minimal SfuService stub — covers only what the authority gates need.
function stubSfu(opts: {host?: string | null}) {
  return {
    bindFanout:          () => { /* no-op */ },
    hostOf:              () => opts.host ?? null,
    participantsInRoom:  () => [] as string[],
  } as unknown as import('../sfu/sfu.service').SfuService;
}

// Minimal hub stub — emits are recorded so we can assert ring fan-out
// when authority passes, OR is empty when it fails.
function stubHub() {
  const emits: Array<{room: string; event: string; data: unknown}> = [];
  const server = {
    to: (room: string) => ({
      emit: (event: string, data: unknown) => emits.push({room, event, data}),
    }),
  };
  return {
    obj:   {server, userRoom: (uid: string) => `u:${uid}`} as unknown as import('./socket-hub').SocketHub,
    emits,
  };
}

function stubPush() {
  return {
    sendVoipWake:   async () => ({sent: 0, stubbed: false}),
    // P2-15 — sfu.ring.cancel now fires a cancel push per target.
    sendCallCancel: async () => 0,
  } as unknown as import('../push/push.service').PushService;
}

function tokenService(secret: string = SECRET): RoomTokenService {
  const cfg: Partial<ConfigService> = {
    get: (k: string) => (k === 'sfu.roomTokenSecret' ? secret : undefined) as unknown,
  };
  return new RoomTokenService(cfg as ConfigService);
}

// Construct a gateway with the stubs above. We only test the public
// handlers — JwtService, ConnectionRegistry, EnvelopeService, Redis
// are never reached by the authority paths under test.
function makeGateway(opts: {
  host?:   string | null;
  secret?: string;
}): {gw: MessengerGateway; emits: Array<{room: string; event: string; data: unknown}>} {
  const hub = stubHub();
  const rts = tokenService(opts.secret ?? SECRET);
  const gw = new MessengerGateway(
    /* jwt        */ {} as never,
    /* registry   */ {} as never,
    /* hub        */ hub.obj,
    /* presence   */ {} as never,
    /* envelopes  */ {} as never,
    /* push       */ stubPush(),
    /* sfu        */ stubSfu({host: opts.host ?? null}),
    /* redis      */ {} as never,
    /* roomToken  */ rts,
    // P1-11 — handleSfuRing now block-filters targets; default: nobody blocked.
    /* privacy    */ {isBlockedEither: async () => false} as never,
  );
  // Silence the gateway logger so test output stays clean.
  (gw as unknown as {logger: Logger}).logger = {
    log:   () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {},
  } as unknown as Logger;
  return {gw, emits: hub.emits};
}

function fakeClient(callerId: string): import('socket.io').Socket {
  return {
    id:   'sock-1',
    data: {
      claims:         {sub: callerId},
      signalDeviceId: 1,
    },
  } as unknown as import('socket.io').Socket;
}

// ─── C3: sfu.ring host check + recipient cap ──────────────────────────

describe('MessengerGateway.handleSfuRing — audit row #5 (C3)', () => {
  it('rejects non-host caller with not_host', async () => {
    const {gw, emits} = makeGateway({host: 'user-real-host'});
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Eve',
        recipientUserIds: ['user-victim'],
      },
      fakeClient('user-attacker'),
    );
    // sfuError() helper wraps the symbolic code into `message` and
    // uses a generic `code: 'sfu_error'` envelope. The discriminator
    // for the actual rejection reason is the `message` field.
    expect(result).toEqual({ok: false, data: {code: 'sfu_error', message: 'not_host'}});
    expect(emits).toEqual([]); // no fanout
  });

  it('rejects when hostOf returns null (unknown / reaped room)', async () => {
    const {gw, emits} = makeGateway({host: null});
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-ghost',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Anyone',
        recipientUserIds: ['user-someone'],
      },
      fakeClient('user-anyone'),
    );
    expect(result).toEqual({ok: false, data: {code: 'sfu_error', message: 'not_host'}});
    expect(emits).toEqual([]);
  });

  it('rejects too_many_targets when recipient list exceeds 250', async () => {
    const {gw, emits} = makeGateway({host: 'user-host'});
    const big = Array.from({length: 251}, (_, i) => `user-${i}`);
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Host',
        recipientUserIds: big,
      },
      fakeClient('user-host'),
    );
    expect(result).toEqual({
      ok:   false,
      data: {code: 'sfu_error', message: 'too_many_targets'},
    });
    expect(emits).toEqual([]);
  });

  it('admits host caller within the cap', async () => {
    const {gw, emits} = makeGateway({host: 'user-host'});
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Host',
        recipientUserIds: ['user-bob', 'user-carol'],
      },
      fakeClient('user-host'),
    );
    expect(result).toEqual({ok: true});
    // Two recipients → two ring fanouts.
    expect(emits.filter(e => e.event === 'sfu.ring.incoming')).toHaveLength(2);
  });
});

// ─── C2: sfu.ring.cancel host gate + token verify ─────────────────────

describe('MessengerGateway.handleSfuRingCancel — audit row #5 (C2)', () => {
  it('rejects non-host with not_host', () => {
    const {gw, emits} = makeGateway({host: 'user-real-host'});
    const result = gw.handleSfuRingCancel(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        recipientUserIds: ['user-victim'],
      },
      fakeClient('user-attacker'),
    );
    expect(result).toEqual({ok: false, data: {code: 'sfu_error', message: 'not_host'}});
    expect(emits).toEqual([]);
  });

  it('rejects host with mismatched token (binding to wrong room)', () => {
    const rts = tokenService();
    const {token} = rts.issue('room-OTHER', 'user-host');
    const {gw, emits} = makeGateway({host: 'user-host'});
    const result = gw.handleSfuRingCancel(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        recipientUserIds: ['user-victim'],
        roomToken:        token,
      },
      fakeClient('user-host'),
    );
    expect('ok' in result && result.ok).toBe(false);
  });

  it('admits host with valid token + fans cancel to recipients', () => {
    const rts = tokenService();
    const {token} = rts.issue('room-aaa', 'user-host');
    const {gw, emits} = makeGateway({host: 'user-host'});
    const result = gw.handleSfuRingCancel(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        recipientUserIds: ['user-victim-a', 'user-victim-b'],
        roomToken:        token,
      },
      fakeClient('user-host'),
    );
    expect(result).toEqual({ok: true});
    expect(emits.filter(e => e.event === 'sfu.ring.cancelled')).toHaveLength(2);
  });
});

// ─── C2: sfu.ring.decline token gate ──────────────────────────────────

describe('MessengerGateway.handleSfuRingDecline — audit row #5 (C2)', () => {
  it('rejects missing token when secret is configured', () => {
    const {gw} = makeGateway({});
    const result = gw.handleSfuRingDecline(
      {roomId: 'room-aaa', conversationId: 'conv-1'},
      fakeClient('user-bob'),
    );
    expect('ok' in result && result.ok).toBe(false);
    expect(result).toMatchObject({data: {code: 'sfu_error', message: 'room_token_required'}});
  });

  it('rejects token bound to a different user (borrowed token)', () => {
    const rts = tokenService();
    // Alice's ring token, replayed by Bob.
    const {token} = rts.issue('room-aaa', 'user-alice');
    const {gw} = makeGateway({});
    const result = gw.handleSfuRingDecline(
      {roomId: 'room-aaa', conversationId: 'conv-1', roomToken: token},
      fakeClient('user-bob'),
    );
    expect('ok' in result && result.ok).toBe(false);
  });

  it('admits the actual ring recipient with their valid token', () => {
    const rts = tokenService();
    const {token} = rts.issue('room-aaa', 'user-bob');
    const {gw} = makeGateway({});
    const result = gw.handleSfuRingDecline(
      {roomId: 'room-aaa', conversationId: 'conv-1', roomToken: token},
      fakeClient('user-bob'),
    );
    expect(result).toEqual({ok: true});
  });
});

// ─── Row #6: call.offer rejects missing auth ──────────────────────────

describe('MessengerGateway.handleCallOffer — audit row #6', () => {
  it('rejects missing offer.auth with missing_offer_auth', async () => {
    const {gw} = makeGateway({});
    // call.offer requires several Socket harness internals (rate limit
    // gate, trackCallStart, forwardToDevice). We stub the parts that
    // would run BEFORE / AFTER the new auth check so the test exercises
    // only the new branch. rateGate is private; bypass by stubbing.
    (gw as unknown as {rateGate: () => null}).rateGate = () => null;
    const result = await gw.handleCallOffer(
      {
        callId:  'call-1',
        to:      {userId: 'user-victim', deviceId: 1},
        sdp:     'v=0...',
        kind:    'voice',
        // auth: undefined  ← the gap row #6 closed
      } as never,
      fakeClient('user-attacker'),
    );
    expect(result).toEqual({
      event: 'error',
      data:  {code: 'missing_offer_auth', message: 'call.offer requires auth block'},
    });
  });
});
