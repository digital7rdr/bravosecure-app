/**
 * P2-14 / P2-BR-4 (background-reliability audit 2026-07-10) — chat-wake
 * debounce correctness + FCM TTL parity with the relay dwell.
 *
 * firebase-admin is module-mocked here (unlike push.service.spec.ts, which
 * exercises the credential-less stub paths) so the tests can drive the REAL
 * send branch: assert the FCM message shape (ttl) and simulate send failures.
 *
 * Contracts under test:
 *   1. P2-BR-4 — the chat wake ships with ttl = 28 days (FCM max), not 24 h,
 *      so a device offline >24 h still gets woken within the 30-day dwell.
 *   2. P2-14(a) — a leading wake whose FCM send FAILS must not arm the 6 s
 *      debounce (previously a failed send blacked out every retry in-window).
 *   3. P2-14(b) — messages arriving INSIDE the debounce window schedule
 *      exactly ONE trailing wake at window end (previously they produced
 *      zero notification on the killed-app banner-only path).
 *   4. P1-15 note — the N-02 call-cancel push TTL is 300 s, not 60 s.
 */

jest.mock('firebase-admin', () => ({
  apps: [],
  credential: {cert: jest.fn()},
  initializeApp: jest.fn(),
  messaging: jest.fn(),
}));

import {Test} from '@nestjs/testing';
import {ConfigModule} from '@nestjs/config';
import RedisMock from 'ioredis-mock';
import * as admin from 'firebase-admin';
import {RedisService} from '../redis/redis.service';
import {PushService, voipSign} from './push.service';
import configuration from '../config/configuration';

async function setup(mock: InstanceType<typeof RedisMock>): Promise<PushService> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({isGlobal: true, load: [configuration]})],
    providers: [
      RedisService,
      PushService,
      {provide: 'IORedisClient', useValue: mock},
    ],
  }).compile();

  const redis = moduleRef.get(RedisService);
  Object.defineProperty(redis, 'client', {value: mock, configurable: true});
  // Construct directly (no onModuleInit) — no FCM init / GC timer side effects.
  return new PushService(redis);
}

type MulticastArg = {
  tokens: string[];
  data: Record<string, string>;
  android: {priority: string; collapseKey: string; ttl: number};
};

describe('PushService — P2-14 chat-wake debounce + P2-BR-4 wake TTL', () => {
  let mock: InstanceType<typeof RedisMock>;
  let push: PushService;
  let sendEachForMulticast: jest.Mock;

  beforeEach(async () => {
    mock = new RedisMock();
    push = await setup(mock);
    sendEachForMulticast = jest.fn();
    (admin.messaging as unknown as jest.Mock).mockReturnValue({
      sendEachForMulticast,
      sendEach: jest.fn(),
    });
    (push as unknown as {fcmReady: boolean}).fcmReady = true;
    await push.registerDeviceToken({
      userId: 'u1', deviceId: 'd1', platform: 'android', token: 'tok-1', updatedAt: Date.now(),
    });
  });

  afterEach(async () => {
    push.onModuleDestroy(); // clears any pending trailing chat-wake timers
    jest.useRealTimers();
    await mock.flushall();
    await mock.quit();
  });

  it('P2-BR-4 — chat wake ships with the 28-day FCM ttl (relay-dwell parity, was 24h)', async () => {
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});

    const r = await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    expect(r.sent).toBe(1);

    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    const arg = sendEachForMulticast.mock.calls[0][0] as MulticastArg;
    expect(arg.android.ttl).toBe(2_419_200 * 1000); // FCM max = 28 days
    expect(arg.android.priority).toBe('high');
    // PERMANENT RULE sanity — wake hint only, never content.
    expect(Object.keys(arg.data).sort()).toEqual(['conversationId', 'kind', 'senderUserId']);
  });

  it('P1-15 note — N-02 call-cancel push ttl raised from 60s to 300s', async () => {
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});

    const sent = await push.sendCallCancel('u1', 'call-1', 'from-1', 'voice', true);
    expect(sent).toBe(1);

    const arg = sendEachForMulticast.mock.calls[0][0] as MulticastArg;
    expect(arg.android.ttl).toBe(300 * 1000);
  });

  it('P2-14(a) — a FAILED leading FCM send does not arm the 6s debounce blackout', async () => {
    sendEachForMulticast.mockRejectedValueOnce(new Error('FCM 503'));

    const first = await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    expect(first.sent).toBe(0);
    // The failed leading wake released its debounce window.
    expect(await mock.get('push-chat-debounce:u1:sender-a')).toBeNull();

    // An immediate retry is a fresh leading edge and actually delivers.
    sendEachForMulticast.mockResolvedValueOnce({successCount: 1, responses: [{success: true}]});
    const second = await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    expect(second.sent).toBe(1);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(2);
  });

  it('P2-14(a) — a SUCCESSFUL leading send keeps the debounce armed (burst still coalesced)', async () => {
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});

    await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    expect(await mock.get('push-chat-debounce:u1:sender-a')).toBe('1');

    const second = await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    expect(second).toEqual({sent: 0, stubbed: false});
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
  });

  it('P2-14(b) — in-window messages schedule exactly ONE trailing wake that delivers at window end', async () => {
    jest.useFakeTimers({
      doNotFake: [
        'nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
        'queueMicrotask', 'Date', 'performance', 'hrtime',
      ],
    });
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});

    const first = await push.sendChatWake('u1', {senderUserId: 'sender-a'}); // leading edge
    expect(first.sent).toBe(1);

    const second = await push.sendChatWake('u1', {senderUserId: 'sender-a'}); // inside window
    expect(second).toEqual({sent: 0, stubbed: false});
    const third = await push.sendChatWake('u1', {senderUserId: 'sender-a'});  // inside window
    expect(third).toEqual({sent: 0, stubbed: false});

    // NX marker de-dupes: two in-window arrivals armed exactly one timer.
    const timers = (push as unknown as {trailingTimers: Set<unknown>}).trailingTimers;
    expect(timers.size).toBe(1);
    expect(await mock.get('push-chat-trailing:u1:sender-a')).toBe('1');

    // Window end: the leading debounce key would have expired by then. Date is
    // real in this test (fake timers only cover setTimeout), so simulate the
    // Redis TTL expiry manually.
    await mock.del('push-chat-debounce:u1:sender-a');

    jest.advanceTimersByTime(6_000);
    // Flush the async chain the fired timer kicked off (real immediates).
    for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r));

    // The trailing wake delivered a second real FCM send and cleaned up.
    expect(sendEachForMulticast).toHaveBeenCalledTimes(2);
    expect(timers.size).toBe(0);
  });

  it('P2-14(b) — no trailing wake is scheduled when the window saw no follow-up messages', async () => {
    sendEachForMulticast.mockResolvedValue({successCount: 1, responses: [{success: true}]});

    await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    const timers = (push as unknown as {trailingTimers: Set<unknown>}).trailingTimers;
    expect(timers.size).toBe(0);
    expect(await mock.exists('push-chat-trailing:u1:sender-a')).toBe(0);
  });

  it('P1-BR-1 — sendVoipWake carries conversationId UNSIGNED (HMAC canonical form unchanged)', async () => {
    const {wakeKeyB64} = await push.registerVoipToken({
      userId: 'u1', deviceId: 'd1', platform: 'android', token: 'tok-1', updatedAt: Date.now(),
    });
    const sendEach = jest.fn().mockResolvedValue({successCount: 1, responses: [{success: true}]});
    (admin.messaging as unknown as jest.Mock).mockReturnValue({sendEachForMulticast, sendEach});

    const r = await push.sendVoipWake('u1', 'call-1', 'sender-a', 'room-tok', 'group-voice', 'grp:c-9');
    expect(r.sent).toBe(1);

    const msg = (sendEach.mock.calls[0][0] as Array<{data: Record<string, string>}>)[0];
    expect(msg.data.conversationId).toBe('grp:c-9');
    expect(msg.data.roomToken).toBe('room-tok');
    expect(msg.data.callKind).toBe('group-voice');
    // The sig still verifies over kind|callId|nonce|exp ONLY — the new field
    // rides unsigned so old APKs keep verifying wakes that carry it.
    expect(msg.data.sig).toBe(voipSign(wakeKeyB64, {
      kind: 'voip-wake', callId: 'call-1', nonce: msg.data.nonce, exp: Number(msg.data.exp),
    }));
  });

  it('P1-BR-1 — sendVoipWake omits conversationId from the wire when not provided (1:1 path unchanged)', async () => {
    await push.registerVoipToken({
      userId: 'u1', deviceId: 'd1', platform: 'android', token: 'tok-1', updatedAt: Date.now(),
    });
    const sendEach = jest.fn().mockResolvedValue({successCount: 1, responses: [{success: true}]});
    (admin.messaging as unknown as jest.Mock).mockReturnValue({sendEachForMulticast, sendEach});

    await push.sendVoipWake('u1', 'call-2', 'sender-a');
    const msg = (sendEach.mock.calls[0][0] as Array<{data: Record<string, string>}>)[0];
    expect('conversationId' in msg.data).toBe(false);
    expect('roomToken' in msg.data).toBe(false);
  });
});
