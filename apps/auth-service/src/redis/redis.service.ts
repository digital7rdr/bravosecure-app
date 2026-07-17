import {Injectable, OnModuleInit, OnModuleDestroy, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import Redis from 'ioredis';

const JTI_PREFIX = 'jti:';
// Cross-service tombstone read by messenger-service's push-token GC. Its
// presence means "this device's session was genuinely revoked — reap its
// push token." Set ONLY on real revokes (logout / password-change /
// session-delete / single-device takeover), NEVER on access-token refresh
// rotation. TTL matches messenger's 90-day push-token TTL so the signal
// outlives any GC downtime; the GC deletes it once consumed.
const PUSH_REVOKE_PREFIX = 'push-revoke:';
const PUSH_REVOKE_TTL_SECONDS = 90 * 24 * 3600;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  client!: Redis;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.client = new Redis(this.config.get<string>('redisUrl')!, {
      lazyConnect:          true,
      maxRetriesPerRequest: 3,
      enableReadyCheck:     true,
    });
    this.client.on('error', (err: Error) => this.logger.error('Redis error', err.message));
    await this.client.connect();
    this.logger.log('Redis connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  // ── jti allowlist ────────────────────────────────────────────────────────
  async storeJti(jti: string, ttlSeconds: number): Promise<void> {
    await this.client.set(`${JTI_PREFIX}${jti}`, '1', 'EX', ttlSeconds);
  }

  async revokeJti(jti: string): Promise<void> {
    await this.client.del(`${JTI_PREFIX}${jti}`);
  }

  async revokeJtis(jtis: string[]): Promise<void> {
    if (!jtis.length) return;
    await this.client.del(jtis.map(j => `${JTI_PREFIX}${j}`));
  }

  async isJtiValid(jti: string): Promise<boolean> {
    return (await this.client.exists(`${JTI_PREFIX}${jti}`)) === 1;
  }

  // ── push-token revoke tombstone (consumed by messenger-service GC) ────────
  // Why: the previous push-token GC keyed liveness off the 15-min access-token
  // jti, so a KILLED app (which never refreshes) had its FCM/APNs token reaped
  // ~15 min after going quiet — silently killing all background notifications.
  // We now mark a tombstone only on a genuine session revoke; the GC reaps the
  // token on tombstone presence and leaves natural access-token expiry alone.
  async markPushRevoked(userId: string, deviceId: string): Promise<void> {
    await this.client.set(
      `${PUSH_REVOKE_PREFIX}${userId}:${deviceId}`, '1', 'EX', PUSH_REVOKE_TTL_SECONDS,
    );
  }

  async markPushRevokedMany(pairs: {userId: string; deviceId: string}[]): Promise<void> {
    if (!pairs.length) return;
    const pipe = this.client.pipeline();
    for (const {userId, deviceId} of pairs) {
      pipe.set(`${PUSH_REVOKE_PREFIX}${userId}:${deviceId}`, '1', 'EX', PUSH_REVOKE_TTL_SECONDS);
    }
    await pipe.exec();
  }

  // Cleared on every login/refresh (issueSession) so a device that was revoked
  // and then signs back in re-arms its push token instead of being re-reaped.
  async clearPushRevoked(userId: string, deviceId: string): Promise<void> {
    await this.client.del(`${PUSH_REVOKE_PREFIX}${userId}:${deviceId}`);
  }

  // ── Generic helpers used by biometric action tokens ─────────────────────
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async getAndDel(key: string): Promise<string | null> {
    const val = await this.client.get(key);
    if (val !== null) await this.client.del(key);
    return val;
  }

  // ── P0-V2 — per-userId TOTP attempt counter / lockout ────────────────────
  // RFC 6238 §5.2 mandates throttling the verifier. The /auth/totp/verify
  // endpoint is unauthenticated by design (the TOTP code IS the second
  // factor), so per-account throttling — not per-IP — is the only effective
  // gate against a credential-stuffing botnet across residential proxies.
  // Window: 10 attempts → lock for 15 min. Mirrors the login-lockout
  // pattern described in audit Round 5 P0-A2.
  private static readonly TOTP_FAIL_PREFIX = 'totp-fail:';
  private static readonly TOTP_LOCK_PREFIX = 'totp-lock:';

  async incrTotpFailures(userId: string, windowSeconds = 900): Promise<number> {
    const key = `${RedisService.TOTP_FAIL_PREFIX}${userId}`;
    const n = await this.client.incr(key);
    if (n === 1) await this.client.expire(key, windowSeconds);
    return n;
  }

  async clearTotpFailures(userId: string): Promise<void> {
    await this.client.del(`${RedisService.TOTP_FAIL_PREFIX}${userId}`);
  }

  async lockTotp(userId: string, lockSeconds = 900): Promise<void> {
    await this.client.set(`${RedisService.TOTP_LOCK_PREFIX}${userId}`, '1', 'EX', lockSeconds);
  }

  async isTotpLocked(userId: string): Promise<boolean> {
    return (await this.client.exists(`${RedisService.TOTP_LOCK_PREFIX}${userId}`)) === 1;
  }
}
