import {Test} from '@nestjs/testing';
import {ConfigModule, ConfigService} from '@nestjs/config';
import RedisMock from 'ioredis-mock';
import type {Socket} from 'socket.io';
import {RedisService} from '../redis/redis.service';
import {ConnectionRegistry} from '../gateway/connection-registry';
import {SocketHub} from '../gateway/socket-hub';
import {EnvelopeStore} from './envelope.store';
import {EnvelopeService} from './envelope.service';
import {BackupService} from '../backup/backup.service';
import configuration from '../config/configuration';
import type {SessionAddress} from '../gateway/protocol';

// Audit P0-7 — ioredis-mock's Lua emulator does not faithfully run
// `redis.call(...)` from inside a script. Force the EnvelopeStore.put
// fallback path (ZCARD-then-MULTI) for unit tests; production keeps
// the atomic Lua path. The P0-7 dedicated suite still exercises BOTH
// the legitimate path AND the cap rejection — see "audit P0-7 …".
process.env['RELAY_DISABLE_LUA_CAP'] = 'true';

/**
 * End-to-end relay flow with a mocked Redis, a mocked connection
 * registry entry, and a spy SocketHub. Proves:
 *  1. submit → pull returns exactly the envelope we submitted
 *  2. ACK hard-deletes (subsequent pull is empty)
 *  3. ACK enforces recipient ownership
 *  4. Online recipient gets an `envelope.deliver` emitted via the hub —
 *     WITH NO sender hint anywhere on the wire (Sealed Sender v2)
 *  5. Orphan sweep drops ZSET members whose main key has expired
 *  6. Outer-sealed size limit is enforced
 *  7. Persisted envelope and fan-out frame BOTH carry no sender field
 *  8. M12 retract — capability token, single-use, idempotent on miss
 */

function fakeSocket(): Socket {
  return {emit: jest.fn(), disconnect: jest.fn()} as unknown as Socket;
}

/**
 * Records every `emitToDevice` call so the test can assert on frames
 * without needing a real socket.io Server. `server.to(...).emit(...)`
 * is the production code path; we just stub it at the SocketHub layer.
 */
class SpyHub extends SocketHub {
  emits: Array<{addr: SessionAddress; event: string; data: unknown}> = [];
  override emitToDevice(addr: SessionAddress, event: string, data: unknown): void {
    this.emits.push({addr, event, data});
  }
}

async function setup(mock: InstanceType<typeof RedisMock>) {
  // Stub BackupService — relay's archiveSealedEnvelope hook is
  // fire-and-forget; tests don't care whether it ran, but Nest's DI
  // requires a provider. Returning a noop here keeps the relay specs
  // independent of Supabase + the BackupModule import graph.
  const stubBackup = {archiveSealedEnvelope: async () => undefined} as unknown as BackupService;
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({isGlobal: true, load: [configuration]})],
    providers: [
      RedisService,
      ConnectionRegistry,
      {provide: SocketHub, useClass: SpyHub},
      EnvelopeStore,
      EnvelopeService,
      {provide: BackupService, useValue: stubBackup},
    ],
  })
    .overrideProvider(RedisService)
    .useValue({client: mock} as unknown as RedisService)
    .compile();

  return {
    service:  moduleRef.get(EnvelopeService),
    store:    moduleRef.get(EnvelopeStore),
    registry: moduleRef.get(ConnectionRegistry),
    hub:      moduleRef.get(SocketHub) as SpyHub,
    redis:    mock,
    config:   moduleRef.get(ConfigService),
  };
}

/**
 * Sample base64 outer-sealed blob. Shape is opaque to the relay; we
 * just need a string that passes DTO length validation. The actual
 * X25519 + AES-GCM round-trip lives in the client-side
 * `outerEcies.test.ts` suite.
 */
const outerSealed = Buffer.from('a'.repeat(120)).toString('base64');

describe('EnvelopeService — sealed-sender relay flow', () => {
  let sharedRedis: InstanceType<typeof RedisMock>;

  beforeAll(() => { sharedRedis = new RedisMock(); });
  beforeEach(async () => { await sharedRedis.flushall(); });

  it('submit → pull returns the envelope (no sender field)', async () => {
    const {service} = await setup(sharedRedis);
    const res = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed, clientMsgId: 'c-1',
    });
    expect(res.envelopeId).toBeTruthy();
    expect(res.deliveredNow).toBe(false);

    const pulled = await service.pull({userId: 'bob', deviceId: 1}, 0, 10);
    expect(pulled).toHaveLength(1);
    expect(pulled[0].envelopeId).toBe(res.envelopeId);
    expect(pulled[0].outerSealed).toBe(outerSealed);
    const record = pulled[0] as unknown as Record<string, unknown>;
    expect(record.sender).toBeUndefined();
    expect(record.senderUserId).toBeUndefined();
    expect(record.senderAddressHint).toBeUndefined();
  });

  it('persisted Redis payload has no sender field anywhere', async () => {
    const {service, redis} = await setup(sharedRedis);
    const {envelopeId} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    const raw = await redis.get(`env:${envelopeId}`);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed.senderAddressHint).toBeUndefined();
    expect(parsed.sender).toBeUndefined();
    expect(parsed.senderUserId).toBeUndefined();
    // Sanity: the stored envelope DOES carry the opaque outer-sealed blob.
    expect(parsed.outerSealed).toBe(outerSealed);
  });

  it('ack hard-deletes the envelope', async () => {
    const {service} = await setup(sharedRedis);
    const {envelopeId} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    // Messaging-transport audit P1-4 — requireAckToken now defaults
    // to true, so the ack must present the token issued at pull/deliver.
    const [pulled0] = await service.pull({userId: 'bob', deviceId: 1}, 0, 10);
    await service.ack({userId: 'bob', deviceId: 1}, envelopeId, pulled0.ackToken);
    const pulled = await service.pull({userId: 'bob', deviceId: 1}, 0, 10);
    expect(pulled).toHaveLength(0);
  });

  it('ack from non-recipient is forbidden', async () => {
    const {service} = await setup(sharedRedis);
    const {envelopeId} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    await expect(
      service.ack({userId: 'mallory', deviceId: 9}, envelopeId),
    ).rejects.toThrow(/not_recipient/);
  });

  // ─── Audit P0-N9 — possession-proof ack tokens ────────────────────

  it('audit P0-N9 — pull attaches a stable per-envelope ackToken', async () => {
    const {service} = await setup(sharedRedis);
    const {envelopeId} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    const pulled = await service.pull({userId: 'bob', deviceId: 1}, 0, 10);
    expect(pulled).toHaveLength(1);
    const first = pulled[0].ackToken;
    expect(first).toBeTruthy();
    expect(typeof first).toBe('string');
    // Second pull (before ack) returns the SAME token — important so a
    // hybrid client that received the envelope via WS then re-pulls via
    // HTTP can ack with either token interchangeably.
    const pulled2 = await service.pull({userId: 'bob', deviceId: 1}, 0, 10);
    expect(pulled2[0].ackToken).toBe(first);
    // Sanity: another envelope gets a DIFFERENT token (random per-id).
    const second = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    const pulled3 = await service.pull({userId: 'bob', deviceId: 1}, 0, 10);
    const otherToken = pulled3.find(p => p.envelopeId === second.envelopeId)?.ackToken;
    expect(otherToken).toBeTruthy();
    expect(otherToken).not.toBe(first);
    expect(envelopeId).toBeTruthy();
  });

  it('audit P0-N9 — fanout deliver frame includes the ackToken', async () => {
    const {service, registry, hub} = await setup(sharedRedis);
    registry.add({
      userId: 'bob', deviceId: 1, authDeviceId: 'a', socket: fakeSocket(),
      sessionId: 's', lastSeenMs: Date.now(),
    });
    await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    expect(hub.emits).toHaveLength(1);
    const d = hub.emits[0].data as Record<string, unknown>;
    expect(d.ackToken).toBeTruthy();
    expect(typeof d.ackToken).toBe('string');
  });

  it('audit P0-N9 — ack with the correct token succeeds and hard-deletes', async () => {
    const {service} = await setup(sharedRedis);
    const {envelopeId} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    const [pulled] = await service.pull({userId: 'bob', deviceId: 1}, 0, 10);
    await service.ack({userId: 'bob', deviceId: 1}, envelopeId, pulled.ackToken);
    const after = await service.pull({userId: 'bob', deviceId: 1}, 0, 10);
    expect(after).toHaveLength(0);
  });

  it('audit P0-N9 — ack with a WRONG token is forbidden', async () => {
    const {service} = await setup(sharedRedis);
    const {envelopeId} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    // Pulling mints the token; ignore it and present a guess instead.
    await service.pull({userId: 'bob', deviceId: 1}, 0, 10);
    await expect(
      service.ack({userId: 'bob', deviceId: 1}, envelopeId, 'totally-wrong-token'),
    ).rejects.toThrow(/bad_ack_token/);
    // Envelope still present (the ack was rejected).
    const after = await service.pull({userId: 'bob', deviceId: 1}, 0, 10);
    expect(after).toHaveLength(1);
  });

  it('audit P0-N9 — ack token is dropped after a successful ack (replay no-ops)', async () => {
    const {service, redis} = await setup(sharedRedis);
    const {envelopeId} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    const [pulled] = await service.pull({userId: 'bob', deviceId: 1}, 0, 10);
    await service.ack({userId: 'bob', deviceId: 1}, envelopeId, pulled.ackToken);
    // The ack_token:{envelopeId} key is gone now.
    expect(await redis.get(`ack_token:${envelopeId}`)).toBeNull();
    // A replayed ack with the same token is a silent no-op (envelope
    // already deleted → idempotent return). Not a Forbidden, because
    // the existence-check at the top of ack() bails before token
    // validation.
    await service.ack({userId: 'bob', deviceId: 1}, envelopeId, pulled.ackToken);
  });

  it('audit P0-N9 — ack without a token is accepted (rollout window) when requireAckToken=false', async () => {
    const {service, config} = await setup(sharedRedis);
    const {envelopeId} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    // Messaging-transport audit P1-4 — the default flipped to true.
    // This test still asserts the legacy fallback path works when an
    // operator explicitly opts back in via RELAY_REQUIRE_ACK_TOKEN=false
    // (emergency rollback). Patch only the one key the ack() guard
    // reads; everything else still hits the real ConfigService so
    // dwellSeconds / maxCiphertextBytes resolve to their defaults.
    const real = config.get.bind(config);
    jest.spyOn(config, 'get').mockImplementation((key: string) => {
      if (key === 'relay.requireAckToken') return false;
      return real(key);
    });
    // Legacy client path — no ackToken on the ack call.
    await service.ack({userId: 'bob', deviceId: 1}, envelopeId);
    const after = await service.pull({userId: 'bob', deviceId: 1}, 0, 10);
    expect(after).toHaveLength(0);
  });

  it('audit P0-N9 — ack without a token is rejected when requireAckToken=true (default)', async () => {
    const {service} = await setup(sharedRedis);
    // Messaging-transport audit P1-4 — strict mode is the default now,
    // no config override needed.
    const {envelopeId} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    await expect(
      service.ack({userId: 'bob', deviceId: 1}, envelopeId),
    ).rejects.toThrow(/ack_token_required/);
  });

  it('audit P0-N9 — defends the wipe attack: malicious device cannot ack an unread envelope', async () => {
    // Scenario from the audit report: an attacker who somehow obtains
    // Bob's JWT cannot iterate envelope IDs and ack them blind. Without
    // possession of the deliver-time token, the ack is rejected even
    // though the caller IS the legitimate recipient.
    const {service} = await setup(sharedRedis);
    const {envelopeId} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    // Attacker guesses a random token instead of pulling the envelope.
    const guessedToken = Buffer.from('a'.repeat(24)).toString('base64url');
    await expect(
      service.ack({userId: 'bob', deviceId: 1}, envelopeId, guessedToken),
    ).rejects.toThrow(/bad_ack_token/);
    // Legitimate device pulls and acks normally — envelope still here.
    const [pulled] = await service.pull({userId: 'bob', deviceId: 1}, 0, 10);
    await service.ack({userId: 'bob', deviceId: 1}, envelopeId, pulled.ackToken);
    const after = await service.pull({userId: 'bob', deviceId: 1}, 0, 10);
    expect(after).toHaveLength(0);
  });

  it('fans out to a connected recipient via the hub (frame has no sender field)', async () => {
    const {service, registry, hub} = await setup(sharedRedis);
    registry.add({
      userId: 'bob', deviceId: 1, authDeviceId: 'a', socket: fakeSocket(), sessionId: 's', lastSeenMs: Date.now(),
    });
    const {deliveredNow} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    expect(deliveredNow).toBe(true);
    expect(hub.emits).toHaveLength(1);
    const {event, data} = hub.emits[0];
    expect(event).toBe('envelope.deliver');
    const d = data as Record<string, unknown>;
    expect(d.outerSealed).toBe(outerSealed);
    expect(d.from).toBeUndefined();
    expect(d.sender).toBeUndefined();
    expect(d.senderAddressHint).toBeUndefined();
    // The wire shape no longer carries the inner Signal ciphertext at all.
    expect(d.ciphertext).toBeUndefined();
  });

  it('orphan sweep prunes ZSET members whose main key has expired', async () => {
    const {service, redis} = await setup(sharedRedis);
    const {envelopeId} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    await redis.del(`env:${envelopeId}`);
    expect(await redis.zcard('pending:bob:1')).toBe(1);
    const dropped = await service.sweepAllOrphans();
    expect(dropped).toBe(1);
    expect(await redis.zcard('pending:bob:1')).toBe(0);
  });

  it('rejects outer-sealed over the size limit', async () => {
    const {service, config} = await setup(sharedRedis);
    const cap = config.get<number>('relay.maxCiphertextBytes')!;
    const over = 'x'.repeat(cap + 1);
    await expect(
      service.submitEnvelope({recipient: {userId: 'bob', deviceId: 1}, outerSealed: over}),
    ).rejects.toThrow(/outer_sealed_too_large/);
  });

  it('rejects an empty outer-sealed string', async () => {
    const {service} = await setup(sharedRedis);
    await expect(
      service.submitEnvelope({recipient: {userId: 'bob', deviceId: 1}, outerSealed: ''}),
    ).rejects.toThrow(/invalid_outer_sealed/);
  });

  it('M12: retract with a valid token hard-deletes the envelope', async () => {
    const {service} = await setup(sharedRedis);
    const {envelopeId, retractToken} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    expect(retractToken).toMatch(/^[0-9a-f-]{36}$/i);

    const res = await service.retract(retractToken);
    expect(res.retracted).toBe(true);

    const pulled = await service.pull({userId: 'bob', deviceId: 1}, 0, 10);
    expect(pulled.find(e => e.envelopeId === envelopeId)).toBeUndefined();
  });

  it('M12: retract is single-use (replay returns {retracted: false})', async () => {
    const {service} = await setup(sharedRedis);
    const {retractToken} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed,
    });
    await service.retract(retractToken);
    const again = await service.retract(retractToken);
    expect(again.retracted).toBe(false);
  });

  it('M12: retract with an unknown token is a harmless no-op', async () => {
    const {service} = await setup(sharedRedis);
    const res = await service.retract('00000000-0000-4000-a000-000000000000');
    expect(res.retracted).toBe(false);
  });

  it('M12: retract rejects malformed tokens', async () => {
    const {service} = await setup(sharedRedis);
    await expect(service.retract('not-a-uuid')).rejects.toThrow(/invalid_retract_token/);
  });

  // Audit P0-N5 — server-side dedup. Watchdog retries + HTTP fallback
  // can hand the same (recipient, clientMsgId) to submitEnvelope more
  // than once; the second submit must reuse the first envelopeId
  // instead of creating a duplicate bubble for the recipient.

  it('audit P0-N5 — dedups two submits with the same (recipient, clientMsgId)', async () => {
    const {service, redis} = await setup(sharedRedis);
    const recipient = {userId: 'bob', deviceId: 1};
    const a = await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'dup-1'});
    const b = await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'dup-1'});
    expect(b.envelopeId).toBe(a.envelopeId);
    expect(b.retractToken).toBe(a.retractToken);
    // Recipient sees exactly ONE envelope despite two POSTs.
    expect(await redis.zcard('pending:bob:1')).toBe(1);
    // Only one stored env:* key exists.
    const envKeys = await redis.keys('env:*');
    expect(envKeys).toHaveLength(1);
  });

  it('audit P0-N5 — dedup is scoped per (recipient, clientMsgId), not global', async () => {
    const {service} = await setup(sharedRedis);
    // Same clientMsgId, different recipients (group fan-out pattern).
    const r1 = await service.submitEnvelope({
      recipient: {userId: 'alice', deviceId: 1}, outerSealed, clientMsgId: 'group-1',
    });
    const r2 = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed, clientMsgId: 'group-1',
    });
    const r3 = await service.submitEnvelope({
      recipient: {userId: 'carol', deviceId: 1}, outerSealed, clientMsgId: 'group-1',
    });
    expect(r1.envelopeId).not.toBe(r2.envelopeId);
    expect(r2.envelopeId).not.toBe(r3.envelopeId);
    expect(r1.envelopeId).not.toBe(r3.envelopeId);
  });

  it('audit P0-N5 — submits without a clientMsgId are never deduped', async () => {
    const {service} = await setup(sharedRedis);
    const recipient = {userId: 'bob', deviceId: 1};
    const a = await service.submitEnvelope({recipient, outerSealed});
    const b = await service.submitEnvelope({recipient, outerSealed});
    expect(b.envelopeId).not.toBe(a.envelopeId);
  });

  it('audit P0-N5 — dedup echoes the same clientMsgId on the cached result', async () => {
    const {service} = await setup(sharedRedis);
    const recipient = {userId: 'bob', deviceId: 1};
    await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'echo-1'});
    const b = await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'echo-1'});
    expect(b.clientMsgId).toBe('echo-1');
  });

  // Audit P0-T6 — sender-facing double-tick. When the recipient acks
  // an envelope, the relay must emit `envelope.delivered` back to the
  // ORIGINAL submitter device so the sender can paint the double-tick.
  // Sealed-sender stays intact: the submitter mapping lives in a
  // transient Redis key consumed at ack time, never persisted into
  // `env:*` payload, never archived. HTTP submits (no submitter)
  // must succeed silently with no emit because HTTP callers have no
  // live socket to notify.

  it('audit P0-T6 — recipient ack fires envelope.delivered to the original submitter', async () => {
    const {service, hub} = await setup(sharedRedis);
    const submitter = {userId: 'alice', deviceId: 1};
    const recipient = {userId: 'bob',   deviceId: 1};
    const {envelopeId} = await service.submitEnvelope({
      recipient, outerSealed, submitter,
    });
    // Submit alone must NOT fire delivered — the recipient hasn't acked yet.
    expect(hub.emits.find(e => e.event === 'envelope.delivered')).toBeUndefined();

    // Messaging-transport audit P1-4 — token required by default.
    const [pulled] = await service.pull(recipient, 0, 10);
    await service.ack(recipient, envelopeId, pulled.ackToken);

    const deliveredEmits = hub.emits.filter(e => e.event === 'envelope.delivered');
    expect(deliveredEmits).toHaveLength(1);
    expect(deliveredEmits[0].addr).toEqual(submitter);
    expect(deliveredEmits[0].data).toEqual({envelopeId});
  });

  it('audit P0-T6 — submitter mapping is NEVER persisted in the env:* payload', async () => {
    const {service, redis} = await setup(sharedRedis);
    const submitter = {userId: 'alice', deviceId: 1};
    const {envelopeId} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed, submitter,
    });
    const raw = await redis.get(`env:${envelopeId}`);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    // Sealed-sender invariant: no sender identity may live in the
    // persisted envelope. The submitter mapping is a SEPARATE,
    // transient key (`submitter:{envelopeId}`) — never in env:*.
    expect(parsed.submitter).toBeUndefined();
    expect(parsed.senderUserId).toBeUndefined();
    expect(parsed.from).toBeUndefined();
    // And the transient key DOES exist alongside, with the same TTL.
    const submitterRaw = await redis.get(`submitter:${envelopeId}`);
    expect(submitterRaw).toBe('alice:1');
  });

  it('audit P0-T6 — submitter mapping is consumed (deleted) on ack', async () => {
    const {service, redis} = await setup(sharedRedis);
    const submitter = {userId: 'alice', deviceId: 1};
    const recipient = {userId: 'bob',   deviceId: 1};
    const {envelopeId} = await service.submitEnvelope({
      recipient, outerSealed, submitter,
    });
    expect(await redis.get(`submitter:${envelopeId}`)).toBe('alice:1');

    // Messaging-transport audit P1-4 — token required by default.
    const [pulled] = await service.pull(recipient, 0, 10);
    await service.ack(recipient, envelopeId, pulled.ackToken);

    // Single-use: ack consumes the mapping so a hypothetical replay
    // can't re-fire delivered for the same envelopeId.
    expect(await redis.get(`submitter:${envelopeId}`)).toBeNull();
  });

  it('audit P0-T6 — ack does NOT fire delivered when no submitter was recorded (HTTP path)', async () => {
    const {service, hub} = await setup(sharedRedis);
    const recipient = {userId: 'bob', deviceId: 1};
    // No submitter passed — mimics the HTTP controller path where
    // sealed-sender is preserved by simply omitting submitter identity.
    const {envelopeId} = await service.submitEnvelope({recipient, outerSealed});

    // Messaging-transport audit P1-4 — token required by default.
    const [pulled] = await service.pull(recipient, 0, 10);
    await service.ack(recipient, envelopeId, pulled.ackToken);

    const deliveredEmits = hub.emits.filter(e => e.event === 'envelope.delivered');
    expect(deliveredEmits).toHaveLength(0);
  });

  it('audit P0-T6 — a second ack of the same envelopeId is a silent no-op (no double-emit)', async () => {
    const {service, hub} = await setup(sharedRedis);
    const submitter = {userId: 'alice', deviceId: 1};
    const recipient = {userId: 'bob',   deviceId: 1};
    const {envelopeId} = await service.submitEnvelope({
      recipient, outerSealed, submitter,
    });

    // Messaging-transport audit P1-4 — token required by default.
    const [pulled] = await service.pull(recipient, 0, 10);
    await service.ack(recipient, envelopeId, pulled.ackToken);
    // Second ack — the envelope is gone, so the early-return fires
    // and we don't even reach takeSubmitter. Net effect: only ONE
    // delivered emit across both calls.
    await service.ack(recipient, envelopeId);

    expect(hub.emits.filter(e => e.event === 'envelope.delivered')).toHaveLength(1);
  });

  it('audit P0-T6 — non-recipient ack throws AND does not fire delivered', async () => {
    const {service, hub} = await setup(sharedRedis);
    const submitter = {userId: 'alice', deviceId: 1};
    const {envelopeId} = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed, submitter,
    });

    await expect(
      service.ack({userId: 'mallory', deviceId: 9}, envelopeId),
    ).rejects.toThrow(/not_recipient/);
    expect(hub.emits.filter(e => e.event === 'envelope.delivered')).toHaveLength(0);
  });

  // ─── Handoff §3.6(c) — ack disposition (honest sender tick) ────────
  //
  // The ack used to carry two meanings ("delete this" + "recipient has
  // it") in one signal, so a receiver that ACK-dropped a terminal
  // decrypt failure produced the same sender-facing ✓✓ as a real
  // delivery. `disposition: 'discarded'` deletes the envelope but emits
  // `envelope.undeliverable` instead of `envelope.delivered`.

  it('3.6c — ack(disposition=discarded) deletes but emits envelope.undeliverable, not delivered', async () => {
    const {service, hub, redis} = await setup(sharedRedis);
    const submitter = {userId: 'alice', deviceId: 1};
    const recipient = {userId: 'bob',   deviceId: 1};
    const {envelopeId} = await service.submitEnvelope({recipient, outerSealed, submitter});

    const [pulled] = await service.pull(recipient, 0, 10);
    await service.ack(recipient, envelopeId, pulled.ackToken, 'discarded');

    // Hard-delete still happened (ack-for-delete semantics unchanged).
    expect(await redis.get(`env:${envelopeId}`)).toBeNull();
    // Honest receipt: undeliverable to the submitter, and NO delivered.
    expect(hub.emits.filter(e => e.event === 'envelope.delivered')).toHaveLength(0);
    const undeliverable = hub.emits.filter(e => e.event === 'envelope.undeliverable');
    expect(undeliverable).toHaveLength(1);
    expect(undeliverable[0].addr).toEqual(submitter);
    expect(undeliverable[0].data).toEqual({envelopeId});
  });

  it('3.6c — missing disposition defaults to delivered (legacy clients unchanged)', async () => {
    const {service, hub} = await setup(sharedRedis);
    const submitter = {userId: 'alice', deviceId: 1};
    const recipient = {userId: 'bob',   deviceId: 1};
    const {envelopeId} = await service.submitEnvelope({recipient, outerSealed, submitter});

    const [pulled] = await service.pull(recipient, 0, 10);
    await service.ack(recipient, envelopeId, pulled.ackToken);

    expect(hub.emits.filter(e => e.event === 'envelope.delivered')).toHaveLength(1);
    expect(hub.emits.filter(e => e.event === 'envelope.undeliverable')).toHaveLength(0);
  });

  it('3.6c — offline sender gets the queued undeliverable on flushPendingDelivered', async () => {
    const {service, hub} = await setup(sharedRedis);
    const submitter = {userId: 'alice', deviceId: 1};
    const recipient = {userId: 'bob',   deviceId: 1};
    const {envelopeId} = await service.submitEnvelope({recipient, outerSealed, submitter});

    const [pulled] = await service.pull(recipient, 0, 10);
    await service.ack(recipient, envelopeId, pulled.ackToken, 'discarded');
    hub.emits.length = 0; // discard the live emit — simulate sender offline

    await service.flushPendingDelivered(submitter);
    const replayed = hub.emits.filter(e => e.event === 'envelope.undeliverable');
    expect(replayed).toHaveLength(1);
    expect(replayed[0].data).toEqual({envelopeId});

    // Drained — a second flush replays nothing.
    hub.emits.length = 0;
    await service.flushPendingDelivered(submitter);
    expect(hub.emits.filter(e => e.event === 'envelope.undeliverable')).toHaveLength(0);
  });

  it('F7 — queued read receipt replays on flushPendingDelivered, then drains', async () => {
    const {service, hub} = await setup(sharedRedis);
    const target  = {userId: 'alice', deviceId: 1};
    const receipt = {from: {userId: 'bob', deviceId: 1}, envelopeIds: ['e-1', 'e-2']};
    await service.queueReadReceipt(target, receipt);

    await service.flushPendingDelivered(target);
    const replayed = hub.emits.filter(e => e.event === 'read-receipt');
    expect(replayed).toHaveLength(1);
    expect(replayed[0].addr).toEqual(target);
    expect(replayed[0].data).toEqual(receipt);   // frame shape unchanged

    hub.emits.length = 0;
    await service.flushPendingDelivered(target);
    expect(hub.emits.filter(e => e.event === 'read-receipt')).toHaveLength(0);
  });

  it('F7 — read-receipt queue is per DEVICE (no cross-device steal)', async () => {
    const {service, hub} = await setup(sharedRedis);
    const receipt = {from: {userId: 'bob', deviceId: 1}, envelopeIds: ['e-1']};
    await service.queueReadReceipt({userId: 'alice', deviceId: 1}, receipt);

    // A different device of the same user connecting must NOT consume it.
    await service.flushPendingDelivered({userId: 'alice', deviceId: 2});
    expect(hub.emits.filter(e => e.event === 'read-receipt')).toHaveLength(0);

    await service.flushPendingDelivered({userId: 'alice', deviceId: 1});
    expect(hub.emits.filter(e => e.event === 'read-receipt')).toHaveLength(1);
  });

  it('3.6c — discarded ack with no submitter mapping (HTTP submit) emits nothing', async () => {
    const {service, hub} = await setup(sharedRedis);
    const recipient = {userId: 'bob', deviceId: 1};
    const {envelopeId} = await service.submitEnvelope({recipient, outerSealed});

    const [pulled] = await service.pull(recipient, 0, 10);
    await service.ack(recipient, envelopeId, pulled.ackToken, 'discarded');

    expect(hub.emits.filter(e => e.event === 'envelope.undeliverable')).toHaveLength(0);
    expect(hub.emits.filter(e => e.event === 'envelope.delivered')).toHaveLength(0);
  });

  // ─── Sprint-6 — purge-stale-recipient queue ───────────────────────
  //
  // After the recipient's identity rotates, every queued envelope is
  // unrecoverable on the client (the matching priv key was discarded
  // with the old install). The relay drops the entire pending queue
  // for the caller's (userId, deviceId) so the next drain isn't
  // stalled on known-dead envelopes for the full 30-day dwell.

  it('Sprint-6 — purges every queued envelope for the caller and returns the count', async () => {
    const {service, redis} = await setup(sharedRedis);
    const recipient = {userId: 'bob', deviceId: 1};
    // Three envelopes queued under bob:1.
    const a = await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'a'});
    const b = await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'b'});
    const c = await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'c'});
    expect(await redis.zcard('pending:bob:1')).toBe(3);

    const res = await service.purgeStaleRecipientQueue(recipient, 'old-identity-b64');
    expect(res.purged).toBe(3);

    // Pending ZSET drained, env:* payloads gone.
    expect(await redis.zcard('pending:bob:1')).toBe(0);
    expect(await redis.get(`env:${a.envelopeId}`)).toBeNull();
    expect(await redis.get(`env:${b.envelopeId}`)).toBeNull();
    expect(await redis.get(`env:${c.envelopeId}`)).toBeNull();

    // Subsequent pull is empty — confirms the user-facing behaviour
    // (no more "outer sealed authentication failed" on every drain).
    const pulled = await service.pull(recipient, 0, 10);
    expect(pulled).toHaveLength(0);
  });

  it('Sprint-6 — is idempotent: re-running on an empty queue returns 0', async () => {
    const {service} = await setup(sharedRedis);
    const recipient = {userId: 'bob', deviceId: 1};
    const first = await service.purgeStaleRecipientQueue(recipient, 'old-id');
    expect(first.purged).toBe(0);
    const second = await service.purgeStaleRecipientQueue(recipient, 'old-id');
    expect(second.purged).toBe(0);
  });

  it('Sprint-6 — is scoped per (userId, deviceId): other devices untouched', async () => {
    const {service, redis} = await setup(sharedRedis);
    const dev1 = {userId: 'bob', deviceId: 1};
    const dev2 = {userId: 'bob', deviceId: 2};
    // Same user, two devices. Only dev1 rotated.
    await service.submitEnvelope({recipient: dev1, outerSealed, clientMsgId: 'd1-a'});
    await service.submitEnvelope({recipient: dev2, outerSealed, clientMsgId: 'd2-a'});
    await service.submitEnvelope({recipient: dev2, outerSealed, clientMsgId: 'd2-b'});
    expect(await redis.zcard('pending:bob:1')).toBe(1);
    expect(await redis.zcard('pending:bob:2')).toBe(2);

    const res = await service.purgeStaleRecipientQueue(dev1, 'old-id');
    expect(res.purged).toBe(1);

    // dev2's queue is unaffected.
    expect(await redis.zcard('pending:bob:1')).toBe(0);
    expect(await redis.zcard('pending:bob:2')).toBe(2);
  });

  it('Sprint-6 — drops the ack-token + submitter aux keys alongside env:*', async () => {
    const {service, redis} = await setup(sharedRedis);
    const recipient = {userId: 'bob', deviceId: 1};
    const submitter = {userId: 'alice', deviceId: 1};
    const {envelopeId} = await service.submitEnvelope({recipient, outerSealed, submitter});
    // Pulling mints the ack token.
    await service.pull(recipient, 0, 10);
    expect(await redis.get(`ack_token:${envelopeId}`)).toBeTruthy();
    expect(await redis.get(`submitter:${envelopeId}`)).toBe('alice:1');

    await service.purgeStaleRecipientQueue(recipient, 'old-id');

    expect(await redis.get(`ack_token:${envelopeId}`)).toBeNull();
    expect(await redis.get(`submitter:${envelopeId}`)).toBeNull();
  });

  it('Sprint-6 — rejects an empty supersededIdentity (defends against malformed body)', async () => {
    const {service} = await setup(sharedRedis);
    const recipient = {userId: 'bob', deviceId: 1};
    await expect(
      service.purgeStaleRecipientQueue(recipient, ''),
    ).rejects.toThrow(/invalid_superseded_identity/);
    await expect(
      service.purgeStaleRecipientQueue(recipient, undefined as unknown as string),
    ).rejects.toThrow(/invalid_superseded_identity/);
  });

  it('Sprint-6 — does NOT touch other users\' queues', async () => {
    const {service, redis} = await setup(sharedRedis);
    const bob = {userId: 'bob',   deviceId: 1};
    const ali = {userId: 'alice', deviceId: 1};
    await service.submitEnvelope({recipient: bob, outerSealed, clientMsgId: 'b1'});
    await service.submitEnvelope({recipient: ali, outerSealed, clientMsgId: 'a1'});
    await service.submitEnvelope({recipient: ali, outerSealed, clientMsgId: 'a2'});

    // Bob rotates and purges his queue.
    const res = await service.purgeStaleRecipientQueue(bob, 'bob-old-id');
    expect(res.purged).toBe(1);

    // Alice's queue is completely unaffected.
    expect(await redis.zcard('pending:alice:1')).toBe(2);
    const aliPull = await service.pull(ali, 0, 10);
    expect(aliPull).toHaveLength(2);
  });

  // ─── Audit P0-7 — per-recipient pending-queue ceiling ─────────────
  //
  // Without a cap, a stolen JWT (or any authenticated submitter) can
  // flood `pending:{user}:{device}` and bury the recipient's view
  // (pull is clamped to 1000) AND torch sealed-archive rows for 90
  // days. The cap is enforced atomically in `EnvelopeStore.put`; the
  // service maps the resulting error to HTTP 429.

  it('audit P0-7 — submits succeed below the ceiling', async () => {
    process.env['RELAY_MAX_PENDING_PER_DEVICE'] = '5';
    try {
      const {service, redis} = await setup(sharedRedis);
      const recipient = {userId: 'bob', deviceId: 1};
      for (let i = 0; i < 5; i++) {
        await service.submitEnvelope({recipient, outerSealed, clientMsgId: `c-${i}`});
      }
      expect(await redis.zcard('pending:bob:1')).toBe(5);
    } finally {
      delete process.env['RELAY_MAX_PENDING_PER_DEVICE'];
    }
  });

  it('audit P0-7 — submit AT the ceiling is rejected with 429 relay_queue_full', async () => {
    process.env['RELAY_MAX_PENDING_PER_DEVICE'] = '3';
    try {
      const {service, redis} = await setup(sharedRedis);
      const recipient = {userId: 'bob', deviceId: 1};
      await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'a'});
      await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'b'});
      await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'c'});
      await expect(
        service.submitEnvelope({recipient, outerSealed, clientMsgId: 'd'}),
      ).rejects.toMatchObject({status: 429, message: 'relay_queue_full'});
      // Queue stays at the ceiling — the rejection did NOT add a row.
      expect(await redis.zcard('pending:bob:1')).toBe(3);
    } finally {
      delete process.env['RELAY_MAX_PENDING_PER_DEVICE'];
    }
  });

  it('audit P0-7 — rejected submit releases dedup so a later legitimate retry succeeds', async () => {
    process.env['RELAY_MAX_PENDING_PER_DEVICE'] = '2';
    try {
      const {service, redis} = await setup(sharedRedis);
      const recipient = {userId: 'bob', deviceId: 1};
      await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'a'});
      await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'b'});
      // Third submit hits the cap. The dedup key must be released so a
      // post-drain retry of clientMsgId='c' is treated as fresh, not
      // coalesced into a never-stored cached tuple.
      await expect(
        service.submitEnvelope({recipient, outerSealed, clientMsgId: 'c'}),
      ).rejects.toMatchObject({status: 429});
      expect(await redis.get('dedup:bob:1:c')).toBeNull();

      // Recipient drains one envelope — capacity opens.
      const [p1] = await service.pull(recipient, 0, 10);
      await service.ack(recipient, p1.envelopeId, p1.ackToken);

      // Retry with the same clientMsgId now succeeds normally.
      const retried = await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'c'});
      expect(retried.envelopeId).toBeTruthy();
      expect(await redis.zcard('pending:bob:1')).toBe(2);
    } finally {
      delete process.env['RELAY_MAX_PENDING_PER_DEVICE'];
    }
  });

  // ─── Audit P1-T5 — no enumeration oracle on expired-deadline ──────
  //
  // Previously, a submit with an already-elapsed `expiresAtSec` threw
  // BadRequestException('expires_in_past') with HTTP 400. Combined
  // with the validation-400 for invalid recipientUserId/deviceId, an
  // attacker iterating tuples could distinguish "valid recipient,
  // expired TTL" (400) from "invalid recipient" (400, different DTO
  // path) — leaking which (userId, deviceId) tuples exist. The new
  // behaviour silently accepts the submit and returns the standard
  // ack shape without persisting or fanning out.

  it('audit P1-T5 — already-expired submit returns 202 without persisting (no enumeration oracle)', async () => {
    const {service, redis} = await setup(sharedRedis);
    const recipient = {userId: 'bob', deviceId: 1};
    const pastSec = Math.floor(Date.now() / 1000) - 60;
    // Should NOT throw — quietly drops on the floor.
    const res = await service.submitEnvelope({
      recipient, outerSealed, clientMsgId: 'tt-1', expiresAtSec: pastSec,
    });
    expect(res.envelopeId).toBeTruthy();
    expect(res.retractToken).toBeTruthy();
    expect(res.deliveredNow).toBe(false);
    // No actual storage occurred.
    expect(await redis.zcard('pending:bob:1')).toBe(0);
    const envKeys = await redis.keys('env:*');
    expect(envKeys).toHaveLength(0);
  });

  it('audit P0-7 — ceiling is per (userId, deviceId), not global', async () => {
    process.env['RELAY_MAX_PENDING_PER_DEVICE'] = '2';
    try {
      const {service, redis} = await setup(sharedRedis);
      // bob:1 hits the cap…
      await service.submitEnvelope({recipient: {userId: 'bob', deviceId: 1}, outerSealed, clientMsgId: '1'});
      await service.submitEnvelope({recipient: {userId: 'bob', deviceId: 1}, outerSealed, clientMsgId: '2'});
      await expect(
        service.submitEnvelope({recipient: {userId: 'bob', deviceId: 1}, outerSealed, clientMsgId: '3'}),
      ).rejects.toMatchObject({status: 429});
      // …but bob:2 and alice:1 are untouched.
      await service.submitEnvelope({recipient: {userId: 'bob', deviceId: 2}, outerSealed, clientMsgId: 'x'});
      await service.submitEnvelope({recipient: {userId: 'alice', deviceId: 1}, outerSealed, clientMsgId: 'y'});
      expect(await redis.zcard('pending:bob:1')).toBe(2);
      expect(await redis.zcard('pending:bob:2')).toBe(1);
      expect(await redis.zcard('pending:alice:1')).toBe(1);
    } finally {
      delete process.env['RELAY_MAX_PENDING_PER_DEVICE'];
    }
  });

  // ─── Audit P1-16 — dedup claim released on ANY put failure ────────
  //
  // The P0-7 fix released the dedup claim only for PendingQueueFullError.
  // Any OTHER put failure (Redis OOM under noeviction, connection drop
  // between the claim and the put, failover mid-submit) left the SET-NX
  // claim in place with nothing persisted: the client's outbox retry hit
  // the still-claimed key and was echoed the cached tuple as FAKE success
  // — no envelope in Redis, message silently lost for the 30-day dwell.

  it('audit P1-16 — a non-queue-full put failure releases the dedup claim', async () => {
    const {service, store, redis} = await setup(sharedRedis);
    const recipient = {userId: 'bob', deviceId: 1};
    jest.spyOn(store, 'put').mockRejectedValueOnce(new Error('redis connection reset'));

    await expect(
      service.submitEnvelope({recipient, outerSealed, clientMsgId: 'p116-1'}),
    ).rejects.toThrow('redis connection reset');

    // The claim did not survive the failed put.
    expect(await redis.get('dedup:bob:1:p116-1')).toBeNull();
    // And nothing was persisted.
    expect(await redis.zcard('pending:bob:1')).toBe(0);
  });

  it('audit P1-16 — retry after a failed put is a REAL submit, not a cached fake success', async () => {
    const {service, store, redis} = await setup(sharedRedis);
    const recipient = {userId: 'bob', deviceId: 1};
    jest.spyOn(store, 'put').mockRejectedValueOnce(new Error('LOADING Redis is loading the dataset'));

    await expect(
      service.submitEnvelope({recipient, outerSealed, clientMsgId: 'p116-2'}),
    ).rejects.toThrow(/LOADING/);

    // Outbox retry with the same clientMsgId: must persist a fresh envelope
    // (pre-fix behavior returned the never-stored cached tuple as success).
    const retried = await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'p116-2'});
    expect(await redis.get(`env:${retried.envelopeId}`)).toBeTruthy();
    expect(await redis.zcard('pending:bob:1')).toBe(1);
    const pulled = await service.pull(recipient, 0, 10);
    expect(pulled).toHaveLength(1);
    expect(pulled[0].envelopeId).toBe(retried.envelopeId);
  });

  // ─── Audit P2-BR-3 — server-side wake-eligibility bit ─────────────
  //
  // The submit result tells the caller (HTTP controller / WS gateway)
  // whether firing the chat wake is warranted. Server-detectable
  // non-notification cases: a dedup HIT (retried send whose original
  // already woke the device) and a pre-expired submit (nothing persisted
  // or fanned out). The client-supplied `urgent` flag is gated at the
  // controller — see envelope.controller.spec.ts.

  it('audit P2-BR-3 — fresh submit is wakeEligible', async () => {
    const {service} = await setup(sharedRedis);
    const res = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed, clientMsgId: 'w-1',
    });
    expect(res.wakeEligible).toBe(true);
  });

  it('audit P2-BR-3 — dedup HIT (retried send) is NOT wakeEligible', async () => {
    const {service} = await setup(sharedRedis);
    const recipient = {userId: 'bob', deviceId: 1};
    const first = await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'w-2'});
    expect(first.wakeEligible).toBe(true);
    const retry = await service.submitEnvelope({recipient, outerSealed, clientMsgId: 'w-2'});
    expect(retry.envelopeId).toBe(first.envelopeId);
    expect(retry.wakeEligible).toBe(false);
  });

  it('audit P2-BR-3 — already-expired submit is NOT wakeEligible', async () => {
    const {service} = await setup(sharedRedis);
    const pastSec = Math.floor(Date.now() / 1000) - 60;
    const res = await service.submitEnvelope({
      recipient: {userId: 'bob', deviceId: 1}, outerSealed, clientMsgId: 'w-3', expiresAtSec: pastSec,
    });
    expect(res.wakeEligible).toBe(false);
  });

  // ─── Folded P2 (socket cluster) — non-destructive read-receipt drain ──
  //
  // The F7 queue drain used to pop (SMEMBERS+DEL) and THEN emit — an emit
  // failure or a crash between the two lost the receipts forever. Now the
  // drain peeks, emits, and deletes only what emitted; failures stay queued
  // for the next connect (client-side application is idempotent).

  it('folded-P2 — a read receipt survives an emit failure and replays on the next flush', async () => {
    const {service, hub, redis} = await setup(sharedRedis);
    const target  = {userId: 'alice', deviceId: 1};
    const receipt = {from: {userId: 'bob', deviceId: 1}, envelopeIds: ['e-1']};
    await service.queueReadReceipt(target, receipt);

    // First flush: the hub emit throws (half-dead socket / adapter error).
    jest.spyOn(hub, 'emitToDevice').mockImplementationOnce(() => {
      throw new Error('socket dead');
    });
    await service.flushPendingDelivered(target);
    // NOT destroyed by the failed drain.
    expect(await redis.scard('read-receipt-pending:alice:1')).toBe(1);
    expect(hub.emits.filter(e => e.event === 'read-receipt')).toHaveLength(0);

    // Second flush: emit succeeds → delivered, then (and only then) deleted.
    await service.flushPendingDelivered(target);
    const replayed = hub.emits.filter(e => e.event === 'read-receipt');
    expect(replayed).toHaveLength(1);
    expect(replayed[0].data).toEqual(receipt);
    expect(await redis.scard('read-receipt-pending:alice:1')).toBe(0);
  });

  it('folded-P2 — a malformed queued entry is dropped without wedging the queue', async () => {
    const {service, hub, redis} = await setup(sharedRedis);
    const target  = {userId: 'alice', deviceId: 1};
    await redis.sadd('read-receipt-pending:alice:1', 'not-json{');
    const receipt = {from: {userId: 'bob', deviceId: 1}, envelopeIds: ['e-9']};
    await service.queueReadReceipt(target, receipt);

    await service.flushPendingDelivered(target);

    // The valid frame delivered; the junk entry was removed alongside it.
    const replayed = hub.emits.filter(e => e.event === 'read-receipt');
    expect(replayed).toHaveLength(1);
    expect(replayed[0].data).toEqual(receipt);
    expect(await redis.scard('read-receipt-pending:alice:1')).toBe(0);
  });
});
