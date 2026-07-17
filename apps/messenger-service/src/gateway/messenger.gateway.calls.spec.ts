/**
 * 2026-07-10 audit-wave gateway call fixes:
 *  - P1-11    block (M-07) enforced on calls: call.offer silent-drop +
 *             sfu.ring target filtering (no forward, no queue, no VoIP wake)
 *  - P1-14    callee DECLINE clears the DECLINER's queued Redis artifacts,
 *             not data.to (the caller)
 *  - P1-15/P2-13  clearPendingCallArtifacts keeps the pending-offer index
 *             entry when keeping the missed-marker (reconnect drain reachable)
 *  - P1-BR-5  active 1:1 calls get a disconnect grace window; ringing
 *             sessions keep the immediate bye; reconnect cancels the timer
 *  - P2-3     sfu.ring is rate-limited
 *  - P2-BR-8  1:1 VoIP wake reads data.kind (callType fallback)
 *  - P3-P-1   sfu.join fails CLOSED in production when the room-token
 *             secret is unset
 *  - P1-BR-3  declineCallViaHttp fan-out (backs POST /calls/:callId/decline)
 *
 * Same harness style as the privacy/sfu-auth specs: handlers invoked off the
 * prototype with a hand-built `this`, or a fully-constructed gateway with
 * stubbed deps where the path touches constructor wiring.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type {Socket} from 'socket.io';
import {ConfigService} from '@nestjs/config';
import {Logger} from '@nestjs/common';
import {MessengerGateway} from './messenger.gateway';
import {RoomTokenService} from '../sfu/room-token.service';

const proto: any = MessengerGateway.prototype;

const ME = 'me-user';
const PEER = 'peer-user';

function fakeClient(sub = ME, deviceId = 7): Socket & {emit: jest.Mock; join: jest.Mock} {
  return {
    id:   `sock-${sub}`,
    data: {claims: {sub}, signalDeviceId: deviceId, sessionId: `s-${sub}`},
    emit: jest.fn(),
    join: jest.fn(async () => undefined),
  } as unknown as Socket & {emit: jest.Mock; join: jest.Mock};
}

// ─── P1-11: call.offer block enforcement + P2-BR-8 wake kind ─────────────

describe('P1-11 — handleCallOffer block enforcement (M-07 on calls)', () => {
  function offerThis(opts: {blocked: boolean}) {
    const redisClient = {
      set:    jest.fn(async () => 'OK'),
      sadd:   jest.fn(async () => 1),
      expire: jest.fn(async () => 1),
    };
    const push = {sendVoipWake: jest.fn(async () => ({sent: 1, stubbed: false}))};
    const self = {
      rateGate:        () => null,
      privacy:         {isBlockedEither: jest.fn(async () => opts.blocked)},
      trackCallStart:  jest.fn(() => undefined),
      forwardToDevice: jest.fn(async () => undefined),
      push,
      redis: {client: redisClient},
    };
    return {self, redisClient, push};
  }

  const offer = (kind?: string, extra: Record<string, unknown> = {}) => ({
    callId: 'call-0001',
    to:     {userId: PEER, deviceId: 1},
    sdp:    'v=0',
    kind,
    auth:   {v: 1} as never,
    ...extra,
  });

  it('silent-drops when blocked: no error, no track, no forward, no queue, no wake', async () => {
    const {self, redisClient, push} = offerThis({blocked: true});
    const ret = await proto.handleCallOffer.call(self, offer('voice'), fakeClient());
    expect(ret).toBeUndefined();                       // no block oracle to the caller
    expect(self.trackCallStart).not.toHaveBeenCalled();
    expect(self.forwardToDevice).not.toHaveBeenCalled();
    expect(redisClient.set).not.toHaveBeenCalled();    // no pending offer, no marker
    expect(redisClient.sadd).not.toHaveBeenCalled();
    expect(push.sendVoipWake).not.toHaveBeenCalled();  // killed device never rings
    expect(self.privacy.isBlockedEither).toHaveBeenCalledWith(ME, PEER);
  });

  it('unblocked offer still forwards, queues, and wakes', async () => {
    const {self, redisClient, push} = offerThis({blocked: false});
    await proto.handleCallOffer.call(self, offer('voice'), fakeClient());
    expect(self.trackCallStart).toHaveBeenCalled();
    expect(self.forwardToDevice).toHaveBeenCalled();
    expect(redisClient.set).toHaveBeenCalled();
    expect(push.sendVoipWake).toHaveBeenCalled();
  });

  it('P2-BR-8: wake kind comes from data.kind — video offer wakes as video', async () => {
    const {self, push} = offerThis({blocked: false});
    await proto.handleCallOffer.call(self, offer('video'), fakeClient());
    expect(push.sendVoipWake).toHaveBeenCalledWith(PEER, 'call-0001', ME, undefined, 'video');
  });

  it('P2-BR-8: voice offer wakes as voice; legacy callType still honoured', async () => {
    const {self, push} = offerThis({blocked: false});
    await proto.handleCallOffer.call(self, offer('voice'), fakeClient());
    expect(push.sendVoipWake).toHaveBeenCalledWith(PEER, 'call-0001', ME, undefined, 'voice');

    const {self: s2, push: p2} = offerThis({blocked: false});
    await proto.handleCallOffer.call(s2, offer(undefined, {callType: 'video'}), fakeClient());
    expect(p2.sendVoipWake).toHaveBeenCalledWith(PEER, 'call-0001', ME, undefined, 'video');
  });
});

// ─── P1-15 / P2-13: srem stays inside the keepMarker guard ───────────────

describe('P1-15/P2-13 — clearPendingCallArtifacts keepMarker keeps the index', () => {
  function clearThis() {
    const del  = jest.fn(async () => 1);
    const srem = jest.fn(async () => 1);
    return {self: {redis: {client: {del, srem}}}, del, srem};
  }

  it('keepMarker: deletes ONLY the offer payload — marker AND index survive', async () => {
    const {self, del, srem} = clearThis();
    await proto.clearPendingCallArtifacts.call(self, 'u1', 2, 'c1', {keepMarker: true});
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith('pending-call-offer:u1:2:c1');
    // The reconnect call.missed drain enumerates ONLY the index — it must
    // stay reachable while the marker is kept.
    expect(srem).not.toHaveBeenCalled();
  });

  it('default: deletes payload + marker + index entry', async () => {
    const {self, del, srem} = clearThis();
    await proto.clearPendingCallArtifacts.call(self, 'u1', 2, 'c1');
    expect(del).toHaveBeenCalledWith('pending-call-offer:u1:2:c1');
    expect(del).toHaveBeenCalledWith('missed-call-marker:u1:2:c1');
    expect(srem).toHaveBeenCalledWith('pending-call-offer-idx:u1:2', 'c1');
  });
});

// ─── P1-14: decline clears the DECLINER's keys, not data.to ──────────────

describe('P1-14 — handleCallHangup targets the ringing callee\'s artifacts', () => {
  const CALLER = 'caller-user';
  const CALLEE = 'callee-user';

  function hangupThis(state: 'ringing' | 'active') {
    const session = {
      callId:    'c1',
      caller:    {userId: CALLER, deviceId: 3},
      callee:    {userId: CALLEE, deviceId: 7},
      state,
      createdAt: Date.now(),
    };
    const clearPendingCallArtifacts = jest.fn(async () => undefined);
    const push = {sendCallCancel: jest.fn(async () => 0)};
    const self = {
      rateGate:           () => null,
      callSessions:       new Map([[session.callId, session]]),
      authorizeCallFrame: proto.authorizeCallFrame,
      trackCallEnd:       proto.trackCallEnd,
      gcCallTombstones:   proto.gcCallTombstones,
      clearPendingCallArtifacts,
      forwardToDevice:    jest.fn(async () => undefined),
      push,
    };
    return {self, session, clearPendingCallArtifacts, push};
  }

  it('callee DECLINE clears the callee\'s own keys (keepMarker=false) — not the caller\'s', async () => {
    const {self, clearPendingCallArtifacts, push} = hangupThis('ringing');
    // Decline: FROM the callee, addressed TO the caller (data.to = caller).
    await proto.handleCallHangup.call(
      self,
      {callId: 'c1', to: {userId: CALLER, deviceId: 3}, reason: 'declined'},
      fakeClient(CALLEE, 7),
    );
    // Pre-fix this hit (CALLER, 3) — the caller's non-existent keys — leaving
    // the callee's 6h marker + index alive → phantom "Missed call" + ghost ring.
    expect(clearPendingCallArtifacts).toHaveBeenCalledWith(
      CALLEE, 7, 'c1', {keepMarker: false},
    );
    // A decline is not a caller-gave-up: no missed-call cancel push.
    expect(push.sendCallCancel).not.toHaveBeenCalled();
    expect(self.forwardToDevice).toHaveBeenCalled(); // hangup still relayed
  });

  it('caller gives up on unanswered ring: callee keys cleared with keepMarker + cancel push to callee', async () => {
    const {self, clearPendingCallArtifacts, push} = hangupThis('ringing');
    await proto.handleCallHangup.call(
      self,
      {callId: 'c1', to: {userId: CALLEE, deviceId: 7}, reason: 'cancelled'},
      fakeClient(CALLER, 3),
    );
    expect(clearPendingCallArtifacts).toHaveBeenCalledWith(
      CALLEE, 7, 'c1', {keepMarker: true},
    );
    expect(push.sendCallCancel).toHaveBeenCalledWith(CALLEE, 'c1', CALLER, 'voice', true);
  });

  it('hangup of an ACTIVE call clears the callee\'s keys without keeping a marker', async () => {
    const {self, clearPendingCallArtifacts, push} = hangupThis('active');
    await proto.handleCallHangup.call(
      self,
      {callId: 'c1', to: {userId: CALLER, deviceId: 3}, reason: 'ended'},
      fakeClient(CALLEE, 7),
    );
    expect(clearPendingCallArtifacts).toHaveBeenCalledWith(
      CALLEE, 7, 'c1', {keepMarker: false},
    );
    expect(push.sendCallCancel).not.toHaveBeenCalled();
  });
});

// ─── P1-BR-5: disconnect grace for ACTIVE calls ──────────────────────────

describe('P1-BR-5 — disconnect grace for connected 1:1 calls (B-58 server half)', () => {
  const GRACE_MS = 12_000;

  function disconnectThis(state: 'ringing' | 'active') {
    const emit = jest.fn();
    const session = {
      callId:    'c1',
      caller:    {userId: ME, deviceId: 7},
      callee:    {userId: PEER, deviceId: 1},
      state,
      createdAt: Date.now(),
    };
    const client = fakeClient(ME, 7);
    const socketCalls = new WeakMap<object, Set<string>>();
    socketCalls.set(client, new Set(['c1']));
    const self = {
      registry:                  {remove: jest.fn(() => true)},
      clearTypingTimersFrom:     jest.fn(),
      sfuSocketTags:             new WeakMap(),
      sfuLeaveGrace:             new Map(),
      socketCalls,
      callSessions:              new Map([[session.callId, session]]),
      callDisconnectGrace:       new Map(),
      scheduleCallDisconnectBye: proto.scheduleCallDisconnectBye,
      cancelCallDisconnectByes:  proto.cancelCallDisconnectByes,
      trackCallEnd:              proto.trackCallEnd,
      hub: {
        deviceRoom: (a: {userId: string; deviceId: number}) => `u:${a.userId}:${a.deviceId}`,
        server:     {to: () => ({emit})},
      },
      presence: {onDisconnect: jest.fn(async () => false), set: jest.fn()},
      logger:   {log: () => {}, warn: () => {}, error: () => {}},
    };
    return {self, client, emit, session};
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('ACTIVE call: no immediate bye; bye fires after the grace window', async () => {
    const {self, client, emit, session} = disconnectThis('active');
    await proto.handleDisconnect.call(self, client);
    expect(emit).not.toHaveBeenCalled();               // survives the blip
    expect(session.state).toBe('active');              // not tombstoned yet
    expect(self.callDisconnectGrace.size).toBe(1);

    jest.advanceTimersByTime(GRACE_MS);
    expect(emit).toHaveBeenCalledWith('call.hangup', {
      callId: 'c1', from: {userId: ME, deviceId: 7}, reason: 'failed',
    });
    expect(session.state).toBe('ended');
    expect(self.callDisconnectGrace.size).toBe(0);
  });

  it('same-device reconnect within grace cancels the bye — call survives', async () => {
    const {self, client, emit, session} = disconnectThis('active');
    await proto.handleDisconnect.call(self, client);
    // handleConnection runs this for the reconnecting (user, device).
    proto.cancelCallDisconnectByes.call(self, ME, 7);
    jest.advanceTimersByTime(GRACE_MS * 2);
    expect(emit).not.toHaveBeenCalled();
    expect(session.state).toBe('active');
    expect(self.callDisconnectGrace.size).toBe(0);
  });

  it('peer hangup during grace makes the deferred bye a no-op', async () => {
    const {self, client, emit, session} = disconnectThis('active');
    await proto.handleDisconnect.call(self, client);
    proto.trackCallEnd.call(self, 'c1');               // peer ended it meanwhile
    emit.mockClear();
    jest.advanceTimersByTime(GRACE_MS);
    expect(emit).not.toHaveBeenCalled();               // no duplicate bye
    expect(session.state).toBe('ended');
  });

  it('RINGING call keeps the immediate bye (no grace)', async () => {
    const {self, client, emit, session} = disconnectThis('ringing');
    await proto.handleDisconnect.call(self, client);
    expect(emit).toHaveBeenCalledWith('call.hangup', {
      callId: 'c1', from: {userId: ME, deviceId: 7}, reason: 'failed',
    });
    expect(session.state).toBe('ended');
    expect(self.callDisconnectGrace.size).toBe(0);
  });
});

// ─── P1-BR-3: declineCallViaHttp fan-out ─────────────────────────────────

describe('P1-BR-3 — declineCallViaHttp (POST /calls/:callId/decline backing)', () => {
  const CALLER = 'caller-user';

  function declineThis(opts: {host?: string | null; withSession?: boolean} = {}) {
    const emits: Array<{room: string; event: string; data: unknown}> = [];
    const session = {
      callId:    'c1',
      caller:    {userId: CALLER, deviceId: 3},
      callee:    {userId: ME, deviceId: 7},
      state:     'ringing' as const,
      createdAt: Date.now(),
    };
    const clearPendingCallArtifacts = jest.fn(async () => undefined);
    const clearPendingGroupRingArtifacts = jest.fn(async () => undefined);
    const push = {sendCallCancel: jest.fn(async () => 0)};
    const self = {
      hub: {
        userRoom: (uid: string) => `u:${uid}`,
        server: {
          to: (room: string) => ({
            emit: (event: string, data: unknown) => emits.push({room, event, data}),
          }),
        },
      },
      sfu:          {hostOf: () => opts.host ?? null},
      callSessions: new Map(opts.withSession === false ? [] : [[session.callId, session]]),
      trackCallEnd: proto.trackCallEnd,
      clearPendingCallArtifacts,
      clearPendingGroupRingArtifacts,
      push,
    };
    return {self, emits, session, clearPendingCallArtifacts, clearPendingGroupRingArtifacts, push};
  }

  it('direct: hangup{declined} to the caller, artifacts cleared for the DECLINER, cancel push to own devices', async () => {
    const {self, emits, session, clearPendingCallArtifacts, push} = declineThis();
    await proto.declineCallViaHttp.call(
      self, {userId: ME, deviceId: 7}, 'c1', {peerUserId: CALLER, kind: 'direct'},
    );
    expect(emits).toContainEqual({
      room:  `u:${CALLER}`,
      event: 'call.hangup',
      data:  {callId: 'c1', from: {userId: ME, deviceId: 7}, reason: 'declined'},
    });
    expect(session.state).toBe('ended');               // in-flight frames stop relaying
    // P1-14 addressing — the decliner's own keys, marker dropped.
    expect(clearPendingCallArtifacts).toHaveBeenCalledWith(ME, 7, 'c1');
    expect(push.sendCallCancel).toHaveBeenCalledWith(ME, 'c1', CALLER, 'voice', false);
  });

  it('direct: idempotent when the call is already gone (no session, no throw)', async () => {
    const {self, emits} = declineThis({withSession: false});
    await expect(proto.declineCallViaHttp.call(
      self, {userId: ME, deviceId: 7}, 'ghost-call', {peerUserId: CALLER},
    )).resolves.toBeUndefined();
    expect(emits).toContainEqual(expect.objectContaining({event: 'call.hangup'}));
  });

  it('group: ring-declined to the host + member ring artifacts cleared', async () => {
    const {self, emits, clearPendingGroupRingArtifacts} = declineThis({host: 'host-user'});
    await proto.declineCallViaHttp.call(
      self, {userId: ME, deviceId: 7}, 'room-1', {kind: 'group', roomId: 'room-1'},
    );
    expect(emits).toContainEqual({
      room:  'u:host-user',
      event: 'sfu.ring.declined',
      data:  {roomId: 'room-1', conversationId: '', from: {userId: ME, deviceId: 7}},
    });
    expect(clearPendingGroupRingArtifacts).toHaveBeenCalledWith(ME, 'room-1');
  });

  it('group: room already gone (no host) → artifacts still cleared, no emit, no throw', async () => {
    const {self, emits, clearPendingGroupRingArtifacts} = declineThis({host: null});
    await proto.declineCallViaHttp.call(
      self, {userId: ME, deviceId: 7}, 'room-1', {kind: 'group'},
    );
    expect(emits).toEqual([]);
    expect(clearPendingGroupRingArtifacts).toHaveBeenCalledWith(ME, 'room-1'); // roomId falls back to callId
  });
});

// ─── Fully-constructed gateway: sfu.ring block filter, rate limit, join gate ──

const SECRET = 'sfu-room-token-secret-at-least-32-chars-long';

function tokenService(secret: string): RoomTokenService {
  const cfg: Partial<ConfigService> = {
    get: (k: string) => (k === 'sfu.roomTokenSecret' ? secret : undefined) as unknown,
  };
  return new RoomTokenService(cfg as ConfigService);
}

function makeGateway(opts: {
  host?:    string | null;
  secret?:  string;
  blocked?: (uid: string) => boolean;
  joinRoom?: jest.Mock;
}) {
  const emits: Array<{room: string; event: string; data: unknown}> = [];
  const hub = {
    server: {
      to: (room: string) => ({
        emit: (event: string, data: unknown) => emits.push({room, event, data}),
      }),
    },
    userRoom: (uid: string) => `u:${uid}`,
  };
  const wakes: Array<{uid: string; kind?: string}> = [];
  const push = {
    sendVoipWake:   jest.fn(async (uid: string, _cid: string, _from: string, _tok?: string, kind?: string) => {
      wakes.push({uid, kind});
      return {sent: 1, stubbed: false};
    }),
    sendCallCancel: jest.fn(async () => 0),
  };
  const sfu = {
    bindFanout: () => { /* no-op */ },
    hostOf:     () => opts.host ?? null,
    joinRoom:   opts.joinRoom ?? jest.fn(async () => ({participantTag: 'tag-1'})),
  };
  const gw = new MessengerGateway(
    /* jwt        */ {} as never,
    /* registry   */ {} as never,
    /* hub        */ hub as never,
    /* presence   */ {} as never,
    /* envelopes  */ {} as never,
    /* push       */ push as never,
    /* sfu        */ sfu as never,
    /* redis      */ {} as never,
    /* roomToken  */ tokenService(opts.secret ?? SECRET),
    /* privacy    */ {isBlockedEither: async (_a: string, b: string) => opts.blocked?.(b) ?? false} as never,
  );
  (gw as unknown as {logger: Logger}).logger = {
    log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {},
  } as unknown as Logger;
  // clearInterval the P0-6 recheck so Jest doesn't leak the handle.
  gw.onModuleDestroy();
  return {gw, emits, push, wakes, sfu};
}

describe('P1-11 — handleSfuRing filters blocked targets (WS ring + VoIP wake)', () => {
  it('rings only unblocked members; blocked user gets neither frame nor wake', async () => {
    const {gw, emits, wakes} = makeGateway({
      host:    'user-host',
      blocked: uid => uid === 'user-blocked',
    });
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Host',
        recipientUserIds: ['user-blocked', 'user-ok'],
      },
      fakeClient('user-host', 1),
    );
    expect(result).toEqual({ok: true});
    const rings = emits.filter(e => e.event === 'sfu.ring.incoming');
    expect(rings).toHaveLength(1);
    expect(rings[0].room).toBe('u:user-ok');
    expect(wakes.map(w => w.uid)).toEqual(['user-ok']);
  });

  it('all-blocked recipient list is a silent no-op success', async () => {
    const {gw, emits, wakes} = makeGateway({host: 'user-host', blocked: () => true});
    const result = await gw.handleSfuRing(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        callType:         'voice',
        callerName:       'Host',
        recipientUserIds: ['user-blocked'],
      },
      fakeClient('user-host', 1),
    );
    expect(result).toEqual({ok: true});                // no oracle
    expect(emits.filter(e => e.event === 'sfu.ring.incoming')).toHaveLength(0);
    expect(wakes).toEqual([]);
  });
});

describe('P2-3 — sfu.ring is rate-limited per socket', () => {
  it('rejects with rate_limited once the burst budget is spent', async () => {
    const {gw} = makeGateway({host: 'user-host'});
    const client = fakeClient('user-host', 1);
    const frame = {
      roomId:           'room-aaa',
      conversationId:   'conv-1',
      callType:         'voice' as const,
      callerName:       'Host',
      recipientUserIds: [] as string[],               // no fan-out side effects
    };
    for (let i = 0; i < 5; i++) {
      expect(await gw.handleSfuRing(frame, client)).toEqual({ok: true});
    }
    expect(await gw.handleSfuRing(frame, client)).toEqual({
      ok: false, data: {code: 'sfu_error', message: 'rate_limited'},
    });
  });
});

describe('P3-P-1 — sfu.join fails CLOSED in production without a token secret', () => {
  const OLD_ENV = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = OLD_ENV; });

  it('production + unset secret → tokenless join rejected, never admitted', async () => {
    process.env.NODE_ENV = 'production';
    const joinRoom = jest.fn(async () => ({participantTag: 'tag-1'}));
    const {gw} = makeGateway({secret: '', joinRoom});
    const result = await gw.handleSfuJoin({roomId: 'room-aaa'}, fakeClient('user-bob', 1));
    expect(result).toEqual({
      ok: false, data: {code: 'room_token_required', message: 'room_token_required'},
    });
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it('non-prod + unset secret still admits (dev/legacy compat)', async () => {
    process.env.NODE_ENV = 'test';
    const joinRoom = jest.fn(async () => ({participantTag: 'tag-1'}));
    const {gw} = makeGateway({secret: '', joinRoom});
    const result = await gw.handleSfuJoin({roomId: 'room-aaa'}, fakeClient('user-bob', 1));
    expect(joinRoom).toHaveBeenCalledWith('room-aaa', 'user-bob');
    expect(result).toEqual({participantTag: 'tag-1'});
  });

  it('secret set + missing token stays a hard reject (regression guard)', async () => {
    const joinRoom = jest.fn(async () => ({participantTag: 'tag-1'}));
    const {gw} = makeGateway({joinRoom});
    const result = await gw.handleSfuJoin({roomId: 'room-aaa'}, fakeClient('user-bob', 1));
    expect(result).toEqual({
      ok: false, data: {code: 'room_token_required', message: 'room_token_required'},
    });
    expect(joinRoom).not.toHaveBeenCalled();
  });
});

// ─── P2-15: host cancel sends the cancel push + clears queued rings ──────

describe('P2-15 — sfu.ring.cancel cancel-push parity for killed devices', () => {
  it('host cancel fans the WS frame AND the N-02-style cancel push per target', () => {
    const rts = tokenService(SECRET);
    const {token} = rts.issue('room-aaa', 'user-host');
    const {gw, emits, push} = makeGateway({host: 'user-host'});
    const result = gw.handleSfuRingCancel(
      {
        roomId:           'room-aaa',
        conversationId:   'conv-1',
        recipientUserIds: ['user-a', 'user-b'],
        roomToken:        token,
      },
      fakeClient('user-host', 1),
    );
    expect(result).toEqual({ok: true});
    expect(emits.filter(e => e.event === 'sfu.ring.cancelled')).toHaveLength(2);
    expect(push.sendCallCancel).toHaveBeenCalledTimes(2);
    expect(push.sendCallCancel).toHaveBeenCalledWith('user-a', 'room-aaa', 'user-host', 'voice', false);
    expect(push.sendCallCancel).toHaveBeenCalledWith('user-b', 'room-aaa', 'user-host', 'voice', false);
  });
});
