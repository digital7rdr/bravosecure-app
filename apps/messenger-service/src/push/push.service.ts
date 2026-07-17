import {Injectable, Logger, OnModuleInit, OnModuleDestroy, OnApplicationBootstrap} from '@nestjs/common';
import {RedisService} from '../redis/redis.service';
import * as admin from 'firebase-admin';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {ApnsClient} from './apnsClient';

/**
 * Push notification service (M12 + BE-4.3) — real FCM delivery.
 *
 * Two separate token channels:
 *   - DATA  (regular APNs / FCM)  — envelope-delivery wake hints
 *   - VOIP  (iOS PushKit / high-priority FCM) — inbound-call rings
 *
 * Why VoIP is separate:
 *   - iOS PushKit requires a distinct VoIP certificate + its own token.
 *   - Android: the same FCM token works for both, but we mark VoIP
 *     pushes as `priority=high` + `android.priority=high` so Doze mode
 *     bypasses kick in and the device wakes immediately.
 *
 * Firebase Admin SDK is initialised lazily on first send. Looks for
 * credentials in this order:
 *   1. GOOGLE_APPLICATION_CREDENTIALS env var (path to service account
 *      JSON) — standard Google convention.
 *   2. /home/ubuntu/bravo/firebase-service-account.json — staging EC2
 *      conventional path.
 *   3. ./firebase-service-account.json relative to the running process.
 *
 * If none are found, sends are no-ops with a one-time warning logged
 * (so dev environments without credentials don't spam the logs and
 * tests don't have to mock the SDK).
 *
 * PERMANENT RULE (enforced by log-audit test):
 *   Push payloads NEVER carry message content. Wake hints only.
 *   App pulls from /envelopes after wake. Applies to VoIP too — the
 *   VoIP payload is just `{kind: 'voip-wake', callId}`.
 */

const DATA_KEY_PREFIX = 'push-token:';
const VOIP_KEY_PREFIX = 'push-voip-token:';
/**
 * Audit P0-N2 (verify-all) — JTI binding for every registered push
 * token. Each register* call captures the caller's JTI; a periodic cron
 * walks every push token, looks up its bound JTI in the shared
 * `jti:<id>` allowlist auth-service writes, and DELs the token row
 * whenever the JTI is gone. This closes the "user A signs out
 * gracefully but DELETE /push/register* hits a network blip" hole AND
 * the "session forcibly revoked by auth-service /auth/session DELETE
 * or password-change while client offline" hole — anything that
 * invalidates the JTI now cascades to push-token cleanup within one
 * cron tick (~60s), so the next user on the same physical device
 * never inherits the previous user's wake stream.
 */
const PUSH_JTI_PREFIX = 'push-jti:';
/**
 * Cross-service revoke tombstone. auth-service writes
 * `push-revoke:<userId>:<deviceId>` on a GENUINE session revoke (logout /
 * password-change / `/auth/session DELETE` / single-device takeover) and
 * clears it on the next login/refresh. The orphan-token GC reaps a device's
 * push tokens on tombstone presence — NOT on natural access-token-jti expiry.
 *
 * Why: the prior GC keyed liveness off the 15-min access-token jti, so a
 * KILLED app (which never refreshes) had its FCM/APNs token reaped ~15 min
 * after going quiet, permanently killing all background notifications until
 * the app was reopened. The session, not the access token, is the real
 * liveness boundary.
 */
const PUSH_REVOKE_PREFIX = 'push-revoke:';
/**
 * Round 5 / Security S3 — per-user/per-device VoIP wake key. The server
 * signs every VoIP wake payload with HMAC-SHA256 over this key so the
 * receiving client can prove the wake originated from us (and not a
 * man-in-the-middle replaying an earlier captured wake to make the
 * recipient ring-spam). The key is minted at registerVoipToken time
 * and shipped back to the client over the JWT-authenticated channel.
 *
 * We use a SEPARATE key per device — that means a compromise of one
 * device's wake key doesn't allow forging wakes for the user's other
 * devices. Rotates implicitly when the client re-registers (every
 * fresh install / token refresh / logout-login mints a new key).
 */
const VOIP_WAKE_KEY_PREFIX = 'push-voip-wake-key:';
/**
 * CRIT-1 (scale) — per-user device-id index. The hot senders used to run a
 * whole-keyspace `SCAN MATCH push-token:<uid>:*` on EVERY message/wake, i.e.
 * O(total-keys-in-Redis) per push — the dominant scaling failure at 100k+
 * users. Instead we keep a Redis SET of the user's registered deviceIds per
 * channel (`push-index-data:<uid>` / `push-index-voip:<uid>`) maintained on
 * register/unregister/cleanup/GC, so a send enumerates a user's devices with
 * one O(devices) SMEMBERS instead of scanning the keyspace.
 *
 * Migration: for tokens registered before this index existed (and to avoid a
 * per-message SCAN for genuinely token-less users) the first lookup with an
 * empty index does ONE scoped SCAN, backfills the index, and drops a
 * `push-index-mig:<uid>` marker so no user is ever SCANned more than once.
 * Clients re-register on every launch, so the index self-populates quickly.
 */
const DATA_INDEX_PREFIX = 'push-index-data:';
const VOIP_INDEX_PREFIX = 'push-index-voip:';
const INDEX_MIG_PREFIX  = 'push-index-mig:';
const TOKEN_TTL_DAYS  = 90;
const TOKEN_TTL_SECONDS = TOKEN_TTL_DAYS * 24 * 3600;
const VOIP_WAKE_TTL_SECONDS = 30;
const VOIP_WAKE_KEY_BYTES = 32;
/**
 * N-32 / P2-14 — chat-wake burst-coalescing window (seconds). The first wake
 * triggers the client's envelope pull which drains the whole burst, so we
 * suppress duplicate wakes to the same (recipient, sender) inside this window
 * and re-fire exactly once at the window end for anything that arrived during
 * it (the killed-app banner-only path never pulls, so a windowed message would
 * otherwise produce ZERO notification).
 */
const CHAT_DEBOUNCE_SEC = 6;
/**
 * P2-BR-4 — chat-wake FCM TTL (ms). The relay dwells envelopes for 30 days,
 * so a device offline >24 h used to get ZERO message notifications on
 * reconnect (the old 24 h TTL had FCM drop the wake). Raise to FCM's maximum
 * of 2,419,200 s (28 days) so a Dozed/offline device is still woken when it
 * comes back within the dwell window.
 */
const CHAT_WAKE_FCM_TTL_MS = 2_419_200 * 1000;

export type PushPlatform = 'ios' | 'android';

export interface DeviceTokenRecord {
  userId:    string;
  deviceId:  string;
  platform:  PushPlatform;
  token:     string;
  updatedAt: number;
}

@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap {
  private readonly logger = new Logger(PushService.name);
  /** True once we've found credentials and called admin.initializeApp. */
  private fcmReady = false;
  /** True once we've LOGGED the missing-credentials warning, so we don't spam. */
  private fcmMissingLogged = false;

  /**
   * Audit P0-N2 — orphan-token GC tick interval. Same cadence as the
   * gateway's JTI recheck (60s) — fast enough that a "previous user's
   * pushes hit next user's lock screen" window is bounded to ~1 min,
   * cheap enough that the SCAN over `push-jti:*` is negligible cost.
   */
  private readonly PUSH_GC_INTERVAL_MS = 60_000;
  private pushGcInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * P2-14 — in-flight trailing chat-wake timers (one per active debounce
   * window that saw a follow-up message). Tracked so a shutdown clears them
   * rather than firing against a torn-down Redis client.
   */
  private readonly trailingTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly redis: RedisService) {}

  onModuleInit(): void {
    this.tryInitFcm();
    // Audit P0-N2 — start the orphan-push-token GC. Skipped under
    // NODE_ENV=test so the Jest suite doesn't have to clean up timers.
    if (process.env['NODE_ENV'] !== 'test') {
      this.pushGcInterval = setInterval(() => {
        void this.gcOrphanPushTokens().catch(e =>
          this.logger.warn(`push.gc failed: ${(e as Error).message}`),
        );
      }, this.PUSH_GC_INTERVAL_MS);
    }
  }

  onApplicationBootstrap(): void {
    // Redis pub/sub bridge for cross-service push fan-out. Auth-service
    // publishes opaque `{userId, eventClass, eventId}` on `push:events`; we
    // re-deliver via FCM. A dedicated duplicated connection is required — once a
    // connection subscribes it can't run regular commands.
    //
    // MUST run here, NOT in onModuleInit: RedisService.client is assigned in
    // RedisService.onModuleInit, and Nest does not guarantee a dependency's
    // onModuleInit completes before this provider's runs — so doing it at
    // onModuleInit raced `redis.client.duplicate()` against an undefined client
    // ("Cannot read properties of undefined (reading 'duplicate')") and the
    // subscriber silently never started, so NO server-driven wake ever reached
    // FCM. onApplicationBootstrap fires after ALL onModuleInit hooks complete,
    // so the connection is guaranteed live.
    this.bootstrapPushEventsSubscriber().catch(e => {
      this.logger.error(`push-events subscriber init failed: ${(e as Error).message}`);
    });
  }

  onModuleDestroy(): void {
    if (this.pushGcInterval) {
      clearInterval(this.pushGcInterval);
      this.pushGcInterval = null;
    }
    // P2-14 — cancel any pending trailing chat-wake timers on shutdown.
    for (const t of this.trailingTimers) clearTimeout(t);
    this.trailingTimers.clear();
  }

  private async bootstrapPushEventsSubscriber(): Promise<void> {
    const sub = this.redis.client.duplicate();
    sub.on('error', err => this.logger.warn(`push-events subscriber error: ${err.message}`));
    sub.on('message', (channel: string, raw: string) => {
      if (channel !== 'push:events') return;
      try {
        // P0-N8 / LB15 — the channel frame is OPAQUE: exactly {userId, eventClass, eventId}.
        // Forward ONLY the opaque eventId (+ the coarse class) as FCM data; the device
        // hydrates the real detail (bookingId/missionId/kind/credits) by eventId over the
        // JWT-gated encrypted relay (GET /events/by-id/:eventId). NEVER reconstruct a
        // bookingId/missionId/kind into the cleartext FCM `data` — Google/Apple operate the
        // intermediary, so that would leak a per-user real-time SOS/mission/booking feed.
        const frame = JSON.parse(raw) as {userId?: string; eventClass?: string; eventId?: string};
        if (!frame.userId || !frame.eventId) return;
        // N-27 — time-critical classes ride FCM high priority so Doze doesn't
        // defer them into a maintenance window (past the hydration TTL → 404 →
        // silent no-banner). dispatch-offer is a 30s-response revenue flow;
        // incident is a safety alert. Others stay normal (Google discourages
        // over-using high priority).
        const highPriority = frame.eventClass === 'sos'
          || frame.eventClass === 'dispatch'
          || frame.eventClass === 'incident';
        void this.sendDataOnlyToUser(
          frame.userId,
          {eventId: frame.eventId, eventClass: frame.eventClass ?? ''},
          `evt:${frame.userId}:${frame.eventId}`,
          highPriority,
        );
      } catch (e) {
        this.logger.warn(`push-events frame parse failed: ${(e as Error).message}`);
      }
    });
    await sub.subscribe('push:events');
    this.logger.log('subscribed to push:events');
  }

  /**
   * CRIT-1 — resolve a user's registered deviceIds for one channel from the
   * per-user index SET, avoiding a keyspace SCAN on the hot path. Falls back
   * to a single scoped SCAN + backfill for pre-index tokens, gated by a
   * per-user migration marker so no user is ever SCANned more than once (even
   * a genuinely token-less recipient).
   */
  private async userDeviceIds(
    indexPrefix: typeof DATA_INDEX_PREFIX | typeof VOIP_INDEX_PREFIX,
    keyPrefix:   typeof DATA_KEY_PREFIX | typeof VOIP_KEY_PREFIX,
    userId:      string,
  ): Promise<string[]> {
    const indexKey = `${indexPrefix}${userId}`;
    const ids = await this.redis.client.smembers(indexKey);
    if (ids.length > 0) return ids;
    // Empty index: either never-registered or pre-index tokens. Gate the
    // one-time SCAN behind a marker so we never scan the keyspace again.
    const migKey = `${INDEX_MIG_PREFIX}${indexPrefix}${userId}`;
    if (await this.redis.client.exists(migKey)) return [];
    const scanned = await scanKeys(this.redis, `${keyPrefix}${userId}:*`);
    const found = scanned.map(k => k.slice(`${keyPrefix}${userId}:`.length));
    if (found.length > 0) {
      await this.redis.client.sadd(indexKey, ...found);
      await this.redis.client.expire(indexKey, TOKEN_TTL_SECONDS);
    }
    await this.redis.client.set(migKey, '1', 'EX', TOKEN_TTL_SECONDS);
    return found;
  }

  /**
   * Load and parse a user's DeviceTokenRecords for one channel via the index,
   * pruning index entries whose token key has expired (self-healing).
   */
  private async loadUserTokenRecords(
    keyPrefix:   typeof DATA_KEY_PREFIX | typeof VOIP_KEY_PREFIX,
    indexPrefix: typeof DATA_INDEX_PREFIX | typeof VOIP_INDEX_PREFIX,
    userId:      string,
  ): Promise<DeviceTokenRecord[]> {
    const ids = await this.userDeviceIds(indexPrefix, keyPrefix, userId);
    if (ids.length === 0) return [];
    const records: DeviceTokenRecord[] = [];
    const stale: string[] = [];
    await Promise.all(ids.map(async did => {
      const raw = await this.redis.client.get(`${keyPrefix}${userId}:${did}`);
      if (!raw) { stale.push(did); return; }
      try { records.push(JSON.parse(raw) as DeviceTokenRecord); } catch { /* skip malformed */ }
    }));
    if (stale.length > 0) {
      await this.redis.client.srem(`${indexPrefix}${userId}`, ...stale);
    }
    return records;
  }

  /** Add a deviceId to a channel index (SET) and refresh its TTL. */
  private async indexAdd(
    indexPrefix: typeof DATA_INDEX_PREFIX | typeof VOIP_INDEX_PREFIX,
    userId: string,
    deviceId: string,
  ): Promise<void> {
    const indexKey = `${indexPrefix}${userId}`;
    await this.redis.client.sadd(indexKey, deviceId);
    await this.redis.client.expire(indexKey, TOKEN_TTL_SECONDS);
  }

  /** Remove a deviceId from a channel index (SET). */
  private async indexRemove(
    indexPrefix: typeof DATA_INDEX_PREFIX | typeof VOIP_INDEX_PREFIX,
    userId: string,
    deviceId: string,
  ): Promise<void> {
    await this.redis.client.srem(`${indexPrefix}${userId}`, deviceId);
  }

  /**
   * Common FCM data-only delivery path. Loads tokens, multicasts, GCs
   * dead tokens. Returns sent count for logging — callers ignore.
   */
  private async sendDataOnlyToUser(
    userId: string,
    data: Record<string, string>,
    collapseKey: string,
    highPriority = false,
  ): Promise<number> {
    if (!this.fcmReady) return 0;
    const records = await this.loadUserTokenRecords(DATA_KEY_PREFIX, DATA_INDEX_PREFIX, userId);
    if (records.length === 0) {
      // Why: this silent return hid a field incident (B-52) — dispatch-offer
      // wakes to a token-less provider vanished with zero trace while the
      // 30s offer expired → NO_PROVIDER. Mirror sendChatWake's no-tokens log
      // so ops can see the class (never log the data payload itself).
      this.logger.log(`push.data.no-tokens sub=${userId.slice(0, 8)} class=${data.eventClass ?? 'unknown'}`);
      return 0;
    }
    const androidTokens = records.filter(r => r.platform === 'android').map(r => r.token);
    const iosTokens = records.filter(r => r.platform === 'ios').map(r => r.token);
    let sent = 0;
    if (androidTokens.length > 0) {
      try {
        const resp = await admin.messaging().sendEachForMulticast({
          tokens: androidTokens,
          data,
          android: {
            priority: highPriority ? 'high' : 'normal',
            collapseKey,
            ttl: 10 * 60 * 1000,
          },
        });
        // Push audit P0-N4 — pass the DATA prefix so GC of dead tokens
        // touches only the DATA keyspace, not VOIP. On Android the same
        // FCM token is registered under both prefixes; cross-keyspace
        // deletion previously killed the user's incoming-call channel.
        await this.cleanupBadTokens(userId, resp, androidTokens, DATA_KEY_PREFIX);
        sent += resp.successCount;
      } catch (e) {
        this.logger.warn(`push.${data.kind} fcm fail sub=${userId.slice(0, 8)}: ${(e as Error).message}`);
      }
    }
    // LM-N3 — iOS tokens were silently dropped here, so EVERY lifecycle wake
    // (booking/mission/payout/SOS/dispatch) was Android-only. Ship the same
    // data-only payload over APNs (content-available background delivery).
    // The iOS client keeps its own gating (PushKit for calls); a token only
    // exists here once an iOS build actually registers one.
    if (iosTokens.length > 0) {
      try {
        const resp = await admin.messaging().sendEachForMulticast({
          tokens: iosTokens,
          data,
          apns: {
            headers: {
              'apns-priority': highPriority ? '10' : '5',
              'apns-collapse-id': collapseKey,
            },
            payload: {aps: {'content-available': 1}},
          },
        });
        await this.cleanupBadTokens(userId, resp, iosTokens, DATA_KEY_PREFIX);
        sent += resp.successCount;
      } catch (e) {
        this.logger.warn(`push.${data.kind} apns fail sub=${userId.slice(0, 8)}: ${(e as Error).message}`);
      }
    }
    return sent;
  }

  async registerDeviceToken(rec: DeviceTokenRecord, jti?: string): Promise<void> {
    await this.redis.client.set(
      `${DATA_KEY_PREFIX}${rec.userId}:${rec.deviceId}`,
      JSON.stringify(rec),
      'EX', TOKEN_TTL_SECONDS,
    );
    // CRIT-1 — keep the per-user device index in sync so sends never SCAN.
    await this.indexAdd(DATA_INDEX_PREFIX, rec.userId, rec.deviceId);
    if (jti) {
      // Audit P0-N2 — stamp the JTI binding so the GC cron can drop
      // this token when the JTI is revoked (logout, password change,
      // remote wipe). Same TTL as the token row so the binding never
      // outlives the thing it's protecting.
      await this.redis.client.set(
        `${PUSH_JTI_PREFIX}${rec.userId}:${rec.deviceId}`,
        jti,
        'EX', TOKEN_TTL_DAYS * 24 * 3600,
      );
    }
  }

  async unregisterDeviceToken(userId: string, deviceId: string): Promise<void> {
    await this.redis.client.del(`${DATA_KEY_PREFIX}${userId}:${deviceId}`);
    await this.indexRemove(DATA_INDEX_PREFIX, userId, deviceId);
    // Audit P0-N2 — drop the JTI binding alongside. If the VOIP
    // channel is still registered against the same (userId, deviceId)
    // it keeps its own binding (set by registerVoipToken).
    await this.maybeDropJtiBinding(userId, deviceId);
  }

  /**
   * Round 5 / Security S3 — register VoIP token AND return the per-device
   * wake key. The client persists it in keychain for HMAC verification
   * on each inbound VoIP wake.
   *
   * P0-N6: the original implementation minted a FRESH 90-day key on
   * EVERY POST. Any stolen JWT used to call /push/register-voip once
   * handed the attacker a freshly-signed 90-day forge capability AND
   * orphaned the legitimate keychain entry (which still held the old
   * key, so the victim couldn't verify legitimate wakes either).
   *
   * Now: if a wake key already exists for this (userId, deviceId), the
   * existing key is RETURNED unchanged and only the token + TTL are
   * refreshed. A new key is minted only when no key exists (first
   * register) or when the caller explicitly opts into rotation via
   * `rotateWakeKey: true` (used by the mobile "rotate wake key"
   * settings action — not exposed on the default register flow).
   */
  async registerVoipToken(
    rec: DeviceTokenRecord,
    opts: {rotateWakeKey?: boolean; jti?: string} = {},
  ): Promise<{wakeKeyB64: string}> {
    await this.redis.client.set(
      `${VOIP_KEY_PREFIX}${rec.userId}:${rec.deviceId}`,
      JSON.stringify({...rec, kind: 'voip'}),
      'EX', TOKEN_TTL_SECONDS,
    );
    // CRIT-1 — keep the per-user VoIP device index in sync.
    await this.indexAdd(VOIP_INDEX_PREFIX, rec.userId, rec.deviceId);
    if (opts.jti) {
      // Audit P0-N2 — JTI binding for VOIP token. See registerDeviceToken.
      await this.redis.client.set(
        `${PUSH_JTI_PREFIX}${rec.userId}:${rec.deviceId}`,
        opts.jti,
        'EX', TOKEN_TTL_DAYS * 24 * 3600,
      );
    }
    const wakeKeyRedisKey = `${VOIP_WAKE_KEY_PREFIX}${rec.userId}:${rec.deviceId}`;
    if (!opts.rotateWakeKey) {
      const existing = await this.redis.client.get(wakeKeyRedisKey);
      if (existing) {
        // Refresh TTL so the wake key stays valid alongside the token
        // record (without rotating its bytes).
        await this.redis.client.expire(wakeKeyRedisKey, TOKEN_TTL_DAYS * 24 * 3600);
        return {wakeKeyB64: existing};
      }
    }
    const wakeKey = crypto.randomBytes(VOIP_WAKE_KEY_BYTES);
    const wakeKeyB64 = wakeKey.toString('base64');
    await this.redis.client.set(
      wakeKeyRedisKey,
      wakeKeyB64,
      'EX', TOKEN_TTL_DAYS * 24 * 3600,
    );
    return {wakeKeyB64};
  }

  async unregisterVoipToken(userId: string, deviceId: string): Promise<void> {
    await this.redis.client.del(`${VOIP_KEY_PREFIX}${userId}:${deviceId}`);
    await this.indexRemove(VOIP_INDEX_PREFIX, userId, deviceId);
    // Round 5 / Security S3 — burn the wake key on unregister too so
    // a captured-but-unused token can't be paired with the same key
    // after a re-register.
    await this.redis.client.del(`${VOIP_WAKE_KEY_PREFIX}${userId}:${deviceId}`);
    await this.maybeDropJtiBinding(userId, deviceId);
  }

  /**
   * Audit P0-N2 — drop the JTI binding only if NEITHER data nor voip
   * token remains for this (userId, deviceId). Both channels share a
   * single binding so we keep the binding alive as long as either
   * channel is still registered, otherwise the binding leaks past
   * the last surviving token's TTL.
   */
  private async maybeDropJtiBinding(userId: string, deviceId: string): Promise<void> {
    const [data, voip] = await Promise.all([
      this.redis.client.exists(`${DATA_KEY_PREFIX}${userId}:${deviceId}`),
      this.redis.client.exists(`${VOIP_KEY_PREFIX}${userId}:${deviceId}`),
    ]);
    if (data === 0 && voip === 0) {
      await this.redis.client.del(`${PUSH_JTI_PREFIX}${userId}:${deviceId}`);
    }
  }

  /**
   * Audit P0-N2 — orphan-push-token GC (revoke-tombstone driven).
   *
   * Walks every `push-revoke:<userId>:<deviceId>` tombstone auth-service
   * writes on a GENUINE session revoke (logout, password change, remote
   * `/auth/session DELETE`, single-device takeover). For each, drops both
   * push-token channels, the wake key, and the jti binding — so the next
   * user on the same physical FCM/APNs slot inherits NOTHING — then deletes
   * the tombstone so the work isn't repeated.
   *
   * Why tombstone-driven and not "bound jti expired": the old design keyed
   * liveness off the 15-min access-token jti, so a KILLED app (which never
   * refreshes) had its token reaped ~15 min after going quiet, permanently
   * silencing background notifications. Natural access-token expiry is NOT a
   * revoke and must not reap the token — only an explicit tombstone does.
   *
   * Idempotent and safe to run on a cron. A device that revokes then signs
   * back in clears its own tombstone in auth-service issueSession BEFORE it
   * re-registers, so a re-armed token is never caught by a stale tombstone.
   */
  async gcOrphanPushTokens(): Promise<{scanned: number; dropped: number}> {
    const tombstones = await scanKeys(this.redis, `${PUSH_REVOKE_PREFIX}*`);
    if (tombstones.length === 0) return {scanned: 0, dropped: 0};
    let dropped = 0;
    for (const tombKey of tombstones) {
      // Key shape: push-revoke:<userId>:<deviceId>. userId is a UUID so the
      // first split-on-':' after the prefix is the userId; the remainder is
      // the deviceId (which may itself contain ':').
      const tail = tombKey.slice(PUSH_REVOKE_PREFIX.length);
      const firstColon = tail.indexOf(':');
      if (firstColon === -1) {
        await this.redis.client.del(tombKey);
        continue;
      }
      const userId   = tail.slice(0, firstColon);
      const deviceId = tail.slice(firstColon + 1);
      // Atomic-ish delete of every artifact bound to this (userId, deviceId)
      // plus the tombstone itself. A partial failure just re-runs next tick.
      await Promise.all([
        this.redis.client.del(`${DATA_KEY_PREFIX}${userId}:${deviceId}`),
        this.redis.client.del(`${VOIP_KEY_PREFIX}${userId}:${deviceId}`),
        this.redis.client.del(`${VOIP_WAKE_KEY_PREFIX}${userId}:${deviceId}`),
        this.redis.client.del(`${PUSH_JTI_PREFIX}${userId}:${deviceId}`),
        // CRIT-1 — drop the device from both channel indexes on revoke.
        this.redis.client.srem(`${DATA_INDEX_PREFIX}${userId}`, deviceId),
        this.redis.client.srem(`${VOIP_INDEX_PREFIX}${userId}`, deviceId),
        this.redis.client.del(tombKey),
      ]);
      dropped += 1;
      this.logger.log(`push.gc.revoked sub=${userId.slice(0, 8)} dev=${deviceId.slice(0, 8)} dropped`);
    }
    if (dropped > 0) {
      this.logger.warn(`push.gc.summary scanned=${tombstones.length} dropped=${dropped}`);
    }
    return {scanned: tombstones.length, dropped};
  }

  /**
   * Round 5 / Security S3 — load all current wake keys for a user.
   * Returned as a map keyed by deviceId since we may have multiple
   * devices registered. The cache is loaded once per sendVoipWake;
   * the wake-key lookup is cheap (Redis HGET-style scan) so the per-
   * call cost is dominated by FCM, not Redis.
   */
  private async loadVoipWakeKeys(userId: string): Promise<Map<string, string>> {
    // CRIT-1 — wake keys are minted alongside VoIP tokens under the same
    // deviceId, so the VoIP device index enumerates them without a SCAN.
    const ids = await this.userDeviceIds(VOIP_INDEX_PREFIX, VOIP_KEY_PREFIX, userId);
    const out = new Map<string, string>();
    await Promise.all(ids.map(async deviceId => {
      const wakeKey = await this.redis.client.get(`${VOIP_WAKE_KEY_PREFIX}${userId}:${deviceId}`);
      if (wakeKey) out.set(deviceId, wakeKey);
    }));
    return out;
  }

  /**
   * Generic data-only push (legacy stub kept for backwards compat).
   * Prefer `sendChatWake` for new chat-message wakes.
   */
  async sendToUser(userId: string): Promise<{sent: number; stubbed: boolean}> {
    const ids = await this.userDeviceIds(DATA_INDEX_PREFIX, DATA_KEY_PREFIX, userId);
    this.logger.log(`push.stub.enqueue sub=${userId.slice(0, 8)} devices=${ids.length}`);
    return {sent: ids.length, stubbed: true};
  }

  /**
   * Chat-message wake. Fans an FCM notification to every DATA-token-
   * registered device of `userId` so the recipient sees a heads-up
   * banner + drawer entry even when Bravo is backgrounded or killed.
   *
   * PERMANENT RULE: payload carries NO message content. The title is a
   * generic "New message" + sender display name (server already has
   * the name in cleartext for routing); the body never contains the
   * decrypted text. Decryption happens client-side after the wake,
   * via the existing /envelopes pull triggered on FCM receipt.
   *
   * The `data` block carries `{kind:'msg-wake', conversationId, senderUserId}`
   * so the in-app handler can route to the right chat thread on tap
   * without needing the message id (it'll fetch fresh envelopes anyway).
   */
  async sendChatWake(
    userId: string,
    opts: {senderName?: string; conversationId?: string; senderUserId?: string} = {},
  ): Promise<{sent: number; stubbed: boolean}> {
    // N-32 / P2-14 — coalesce a burst. The first (leading-edge) wake already
    // triggers the client's envelope pull, which drains the WHOLE burst, so N
    // rapid messages from the same sender don't need N FCM sends (and N device
    // re-alerts). Keyed by (recipient, sender) since conversationId is empty
    // under sealed sender; `NX` makes the check-and-set atomic. Two P2-14
    // fixes over the original leading-edge-only debounce:
    //   (a) release the window if this leading wake reaches ZERO devices (see
    //       fcmFailed below), so a failed send can't blackout retries for the
    //       whole window; and
    //   (b) messages that land INSIDE the window schedule one trailing wake at
    //       window end, so the killed-app banner-only path (which never pulls)
    //       still gets a notification for them.
    const debounceKey = opts.senderUserId
      ? `push-chat-debounce:${userId}:${opts.senderUserId}`
      : null;
    let armedDebounce = false;
    if (debounceKey) {
      try {
        const ok = await this.redis.client.set(debounceKey, '1', 'EX', CHAT_DEBOUNCE_SEC, 'NX');
        if (ok === null) {
          // Inside an active window → ensure one trailing wake fires at window
          // end, then skip this duplicate.
          await this.scheduleTrailingChatWake(userId, opts);
          this.logger.log(`push.chat.debounced sub=${userId.slice(0, 8)} sender=${opts.senderUserId!.slice(0, 8)}`);
          return {sent: 0, stubbed: false};
        }
        armedDebounce = true;
      } catch { /* debounce is best-effort — fall through and send */ }
    }
    let records = await this.loadUserTokenRecords(DATA_KEY_PREFIX, DATA_INDEX_PREFIX, userId);
    if (records.length === 0) {
      // B-48 — Android fallback: fcmBootstrap registers the SAME FCM token
      // under both channels, so when the DATA copy is missing (failed
      // /push/register, or the pre-fix asymmetric dead-token cleanup) the
      // VOIP copy still addresses the device. A msg-wake is a data-only FCM
      // frame with no HMAC requirement, so the VOIP token is a drop-in.
      // iOS VoIP (PushKit) tokens can't carry chat wakes — android only.
      records = (await this.loadUserTokenRecords(VOIP_KEY_PREFIX, VOIP_INDEX_PREFIX, userId))
        .filter(r => r.platform === 'android');
      if (records.length > 0) {
        this.logger.log(`push.chat.voip-fallback sub=${userId.slice(0, 8)} devices=${records.length}`);
      }
    }
    if (records.length === 0) {
      this.logger.log(`push.chat.no-tokens sub=${userId.slice(0, 8)}`);
      return {sent: 0, stubbed: false};
    }
    if (!this.fcmReady) {
      if (!this.fcmMissingLogged) {
        this.logger.warn(
          'push.chat.fcm-not-ready — Firebase Admin credentials missing. ' +
          'Set GOOGLE_APPLICATION_CREDENTIALS or place a service account at ' +
          '/home/ubuntu/bravo/firebase-service-account.json. Chat wakes are no-ops until then.',
        );
        this.fcmMissingLogged = true;
      }
      return {sent: 0, stubbed: true};
    }

    const androidTokens = records.filter(r => r.platform === 'android').map(r => r.token);

    let sent = 0;
    // P2-14 — track whether an actual FCM/APNs send threw, so a leading wake
    // that reached nobody can release its debounce window below.
    let fcmFailed = false;
    if (androidTokens.length > 0) {
      try {
        // BS-MSG1 — DATA-ONLY message (no `notification` block). The
        // client's setBackgroundMessageHandler draws the banner via
        // notifee against the `bravo-messages` channel it guarantees
        // exists. Two reasons this is the correct shape:
        //   1) A notification-block message targeting a channel the
        //      recipient never created (fresh install / first message
        //      from a non-contact) is SILENTLY DROPPED by Android 8+ —
        //      that was the "calls ring but messages show nothing" bug.
        //   2) Mixing a `notification` block with the client also drawing
        //      via notifee double-notifies when backgrounded. Data-only
        //      gives exactly one banner in every app state.
        const resp = await admin.messaging().sendEachForMulticast({
          tokens: androidTokens,
          data: {
            kind:           'msg-wake',
            conversationId: opts.conversationId ?? '',
            senderUserId:   opts.senderUserId ?? '',
          },
          android: {
            priority: 'high',
            // collapseKey by conversation so a flurry of messages from
            // the same chat coalesces rather than stacking 50 wakes.
            // Audit PUSH-B2 (2026-07-02): fall back to the SENDER, not the
            // recipient (`userId`). Callers that omit conversationId (the WS
            // gateway can't derive it under sealed-sender) previously degraded
            // the key to `msg-wake:<recipient>`, so under Doze a burst from
            // DIFFERENT chats all collapsed into ONE FCM slot and only the last
            // survived. Keying on the sender keeps distinct chats distinct.
            collapseKey: `msg-wake:${opts.conversationId || opts.senderUserId || userId}`,
            // P2-BR-4 — 28 days (FCM max), not 24 h. See CHAT_WAKE_FCM_TTL_MS.
            ttl: CHAT_WAKE_FCM_TTL_MS,
          },
        });
        sent += resp.successCount;
        // Push audit P0-N4 — chat-wake pulls from DATA prefix; clean
        // up bad tokens in DATA, not VOIP (which would silently kill
        // incoming-call delivery on Android where the FCM token is
        // shared across both keyspaces).
        await this.cleanupBadTokens(userId, resp, androidTokens, DATA_KEY_PREFIX);
      } catch (e) {
        fcmFailed = true;
        this.logger.error(`push.chat.fcm-send-failed sub=${userId.slice(0, 8)}: ${(e as Error).message}`);
      }
    }

    // N-36 — iOS DATA tokens were dropped entirely (chat wakes were Android
    // only), so an iOS build would receive ZERO message notifications. Ship the
    // same data-only payload over APNs content-available (background delivery),
    // mirroring the LM-N3 fix on the lifecycle-wake path. No-op until an iOS
    // build actually registers DATA tokens.
    const iosTokens = records.filter(r => r.platform === 'ios').map(r => r.token);
    if (iosTokens.length > 0) {
      try {
        const resp = await admin.messaging().sendEachForMulticast({
          tokens: iosTokens,
          data: {
            kind:           'msg-wake',
            conversationId: opts.conversationId ?? '',
            senderUserId:   opts.senderUserId ?? '',
          },
          apns: {
            headers: {
              'apns-priority': '10',
              'apns-collapse-id': `msg-wake:${opts.conversationId || opts.senderUserId || userId}`,
            },
            payload: {aps: {'content-available': 1}},
          },
        });
        await this.cleanupBadTokens(userId, resp, iosTokens, DATA_KEY_PREFIX);
        sent += resp.successCount;
      } catch (e) {
        fcmFailed = true;
        this.logger.warn(`push.chat.apns-send-failed sub=${userId.slice(0, 8)}: ${(e as Error).message}`);
      }
    }

    // P2-14 — a leading wake that reached ZERO devices because of an FCM/APNs
    // error must not leave the debounce armed; otherwise every retry inside
    // the window is coalesced into a send that notified nobody. Release it so
    // the next attempt starts a fresh window.
    if (armedDebounce && sent === 0 && fcmFailed && debounceKey) {
      await this.redis.client.del(debounceKey).catch(() => { /* best-effort */ });
    }

    this.logger.log(`push.chat.delivered sub=${userId.slice(0, 8)} sent=${sent}/${androidTokens.length + iosTokens.length}`);
    return {sent, stubbed: false};
  }

  /**
   * P2-14 — schedule a single trailing chat-wake at the end of the current
   * debounce window. A cross-cluster NX marker guarantees at most one trailing
   * wake per window (concurrent arrivals / multiple replicas all no-op after
   * the first). The timer fires after the window, by which point the leading
   * debounce key has expired, so the re-invocation becomes a fresh leading
   * edge and actually delivers. Fire-and-forget; the timer is unref'd so it
   * never holds the process open and is tracked for shutdown cleanup.
   */
  private async scheduleTrailingChatWake(
    userId: string,
    opts: {senderName?: string; conversationId?: string; senderUserId?: string},
  ): Promise<void> {
    if (!opts.senderUserId) return;
    const markerKey = `push-chat-trailing:${userId}:${opts.senderUserId}`;
    let claimed: string | null = null;
    try {
      claimed = await this.redis.client.set(markerKey, '1', 'EX', CHAT_DEBOUNCE_SEC, 'NX');
    } catch { return; /* best-effort */ }
    if (claimed !== 'OK') return; // a prior arrival already scheduled the trailing wake
    const timer = setTimeout(() => {
      this.trailingTimers.delete(timer);
      void this.sendChatWake(userId, opts).catch(e =>
        this.logger.warn(`push.chat.trailing-failed sub=${userId.slice(0, 8)}: ${(e as Error).message}`),
      );
    }, CHAT_DEBOUNCE_SEC * 1000);
    // Never let a pending trailing wake keep the process alive.
    timer.unref?.();
    this.trailingTimers.add(timer);
  }

  /**
   * N-02 — cancel/missed push for a ringing call the caller abandoned. Data-only
   * so the client's headless/background handler dismisses the ring notification
   * (and, when `missed`, posts a Missed-call entry) even on a killed device —
   * closing the "notification appears only AFTER the call" gap (a Doze-deferred
   * ring used to keep ringing for up to 45s after the caller hung up).
   *
   * Reaches the recipient over BOTH the VOIP and DATA android token channels
   * (the same physical FCM token on Android), so it lands regardless of which
   * channel woke the ring. No HMAC: a cancel only dismisses a notification and
   * callId is an unguessable UUID, so the wake's ring-admission threat model
   * doesn't apply.
   */
  async sendCallCancel(
    userId: string,
    callId: string,
    fromUserId: string,
    callKind: 'voice' | 'video',
    missed: boolean,
  ): Promise<number> {
    if (!this.fcmReady) return 0;
    const [voip, data] = await Promise.all([
      this.loadUserTokenRecords(VOIP_KEY_PREFIX, VOIP_INDEX_PREFIX, userId),
      this.loadUserTokenRecords(DATA_KEY_PREFIX, DATA_INDEX_PREFIX, userId),
    ]);
    const androidTokens = Array.from(new Set(
      [...voip, ...data].filter(r => r.platform === 'android').map(r => r.token),
    ));
    if (androidTokens.length === 0) {
      this.logger.log(`push.call-cancel.no-tokens sub=${userId.slice(0, 8)} call=${callId.slice(0, 8)}`);
      return 0;
    }
    let sent = 0;
    try {
      const resp = await admin.messaging().sendEachForMulticast({
        tokens: androidTokens,
        data: {kind: 'call-cancel', callId, fromUserId, callKind, missed: missed ? '1' : '0'},
        // Why: P1-15 — 60s TTL meant any device offline >60s never saw the
        // missed-call marker. 300s covers a Doze/elevator window while still
        // aging out long before the marker becomes misleading.
        android: {priority: 'high', collapseKey: `voip-cancel:${callId}`, ttl: 300 * 1000},
      });
      sent += resp.successCount;
    } catch (e) {
      this.logger.warn(`push.call-cancel.fcm-fail sub=${userId.slice(0, 8)} call=${callId.slice(0, 8)}: ${(e as Error).message}`);
    }
    this.logger.log(`push.call-cancel.delivered sub=${userId.slice(0, 8)} call=${callId.slice(0, 8)} missed=${missed} sent=${sent}/${androidTokens.length}`);
    return sent;
  }

  /**
   * Audit P0-C5 — per-(sender, recipient) VoIP wake budget.
   *
   * The budget gate is the cheap, perimeter-side defence against a
   * stolen JWT (or single misbehaving authed account) pumping
   * `call.offer` / `sfu.ring` at the WS limiter's full capacity to
   * ring-spam a chosen victim. Two buckets, both 60-second windows:
   *
   *   1. per-pair: 6 wakes from (sender → recipient) per minute
   *   2. per-recipient: 30 wakes against a single recipient per minute
   *      regardless of sender (distributed-attack catch).
   *
   * Implementation note: we read counters BEFORE incrementing so a
   * single denial doesn't bump the bucket past its cap and lock the
   * recipient out for the rest of the window. The atomic order is
   * "check pair → check recipient → increment both" — a small race
   * window can let one extra wake through under concurrent calls, but
   * the worst case is bounded to (cap + concurrency) per window, which
   * is still well below the harm threshold.
   *
   * Returns `{ok: true}` on admit; `{ok: false, reason: ...}` on deny.
   * Consumed automatically inside `sendVoipWake` — direct callers exist
   * only for tests.
   */
  async consumeVoipWakeBudget(
    senderUserId:    string,
    recipientUserId: string,
  ): Promise<{ok: true} | {ok: false; reason: 'pair_budget_exhausted' | 'recipient_budget_exhausted'}> {
    if (!senderUserId || !recipientUserId) {
      return {ok: false, reason: 'pair_budget_exhausted'};
    }
    const pairKey      = `push-voip-budget:pair:${senderUserId}:${recipientUserId}`;
    const recipientKey = `push-voip-budget:recipient:${recipientUserId}`;
    const PAIR_CAP      = 6;
    const RECIPIENT_CAP = 30;
    const WINDOW_SEC    = 60;

    const [pairCur, recipientCur] = await Promise.all([
      this.redis.client.get(pairKey),
      this.redis.client.get(recipientKey),
    ]);
    const pairCount      = pairCur      ? Number(pairCur)      : 0;
    const recipientCount = recipientCur ? Number(recipientCur) : 0;

    if (pairCount >= PAIR_CAP) {
      return {ok: false, reason: 'pair_budget_exhausted'};
    }
    if (recipientCount >= RECIPIENT_CAP) {
      return {ok: false, reason: 'recipient_budget_exhausted'};
    }

    // Admit and bump both counters. EXPIRE on first set so the bucket
    // rolls forward at most WINDOW_SEC after first use.
    const nextPair      = await this.redis.client.incr(pairKey);
    const nextRecipient = await this.redis.client.incr(recipientKey);
    if (nextPair      === 1) await this.redis.client.expire(pairKey,      WINDOW_SEC);
    if (nextRecipient === 1) await this.redis.client.expire(recipientKey, WINDOW_SEC);

    return {ok: true};
  }

  /**
   * High-priority VoIP wake. Fans to every VoIP-registered device of
   * `userId` with:
   *   - a `notification` block carrying a GENERIC "Incoming call" title;
   *     no caller name, no call-kind. Audit P1-N2 — we previously sent
   *     `callerName` (shortened userId) + `callKind` in the readable
   *     fields, exposing identifying metadata to FCM / APNs even though
   *     the call body itself is E2E-encrypted. Generic text means the
   *     push platform sees only an opaque callId.
   *   - a `data` block (`kind: 'voip-wake', callId, nonce, exp, sig`)
   *     enough for the on-device verifier to validate the HMAC envelope
   *     and route to a generic ring screen. Real caller name + kind +
   *     conversationId come from the WS `call.offer` frame the gateway
   *     queued in parallel — the device receives that as soon as it
   *     reconnects after the wake.
   *
   * Android: high priority + Doze bypass via android.priority='high'
   * + collapseKey scoped per-callId so older waiting wakes don't get
   * dropped by FCM's coalescer when the callId differs.
   *
   * iOS: PushKit / APNs HTTP/2 with the same minimal payload.
   */
  async sendVoipWake(
    userId:       string,
    callId:       string,
    senderUserId: string,
    // Audit PUSH-B6 — for a GROUP call ring, carry the recipient's per-user
    // room token so a killed-app decline can present it to sfu.ring.decline
    // (the server gate requires it). Self-authenticating (a server HMAC), so
    // it need not be inside the VoIP-wake signature.
    roomToken?:   string,
    // §5 parity decision (Ranak-approved 2026-07-05, relaxing audit P1-N2):
    // carry the call kind so the killed-app ring can say "Video call" /
    // route a group ring correctly. fromUserId (the pseudonymous sender
    // UUID, added to `data` below) lets the recipient's device resolve the
    // caller's LOCAL contact name instantly — WhatsApp-style — without ever
    // putting a cleartext name on the FCM wire. Both ride UNSIGNED so the
    // sig canonical form (kind|callId|nonce|exp) is unchanged and old APKs
    // keep verifying; they are display-only (a forged value could only
    // mislabel the ring — admission is still HMAC-gated).
    callKind?:    'voice' | 'video' | 'group-voice' | 'group-video',
    // P1-BR-1 — group-ring conversationId so a killed-app Answer can route
    // to the right GroupCallScreen (roomId=callId alone can't resolve the
    // thread). Rides UNSIGNED like fromUserId/callKind — the sig canonical
    // form (kind|callId|nonce|exp) is unchanged so old APKs keep verifying;
    // display/routing-only (admission is still HMAC- + room-token-gated).
    conversationId?: string,
  ): Promise<{sent: number; stubbed: boolean; reason?: 'pair_budget_exhausted' | 'recipient_budget_exhausted'}> {
    // Audit P0-C5 / row #7 — consume the per-(sender, recipient) wake
    // budget BEFORE doing any of the work below. A stolen JWT or single
    // misbehaving authed account pumping `call.offer` / `sfu.ring` at
    // the WS limiter's full capacity is otherwise free to ring-spam a
    // chosen victim's lock screen. Caps: 6/min per (sender, recipient),
    // 30/min per recipient (distributed-attack catch).
    const budget = await this.consumeVoipWakeBudget(senderUserId, userId);
    if (!budget.ok) {
      this.logger.warn(
        `push.voip.budget-deny sub=${userId.slice(0, 8)} sender=${senderUserId.slice(0, 8)} call=${callId.slice(0, 8)} reason=${budget.reason}`,
      );
      return {sent: 0, stubbed: false, reason: budget.reason};
    }

    const records = await this.loadUserTokenRecords(VOIP_KEY_PREFIX, VOIP_INDEX_PREFIX, userId);
    if (records.length === 0) {
      this.logger.warn(`push.voip.no-tokens sub=${userId.slice(0, 8)} call=${callId.slice(0, 8)}`);
      return {sent: 0, stubbed: false};
    }

    if (!this.fcmReady) {
      if (!this.fcmMissingLogged) {
        this.logger.warn(
          'push.voip.fcm-not-ready — Firebase Admin credentials missing. ' +
          'Set GOOGLE_APPLICATION_CREDENTIALS or place a service account at ' +
          '/home/ubuntu/bravo/firebase-service-account.json. VoIP wakes are no-ops until then.',
        );
        this.fcmMissingLogged = true;
      }
      return {sent: 0, stubbed: true};
    }

    // Round 5 / Security S3 + Audit P1-N2 — sign every wake with
    // HMAC-SHA256 using the per-device wake key minted at
    // registerVoipToken time. Signed fields: `kind || callId || nonce
    // || exp`. callKind was previously in the canonical form too, but
    // it pulled identifying metadata into the FCM/APNs payload (push
    // platform sees voice/video/group). Dropping it from the sig lets
    // us drop it from the wire entirely.
    //
    // Multi-device fix: each device gets a wake signed by ITS OWN
    // wake key. Previously we picked the first key returned by Redis
    // SCAN (non-deterministic order) and signed every device's wake
    // with that one key — device B would then HMAC-reject every wake
    // and the call would silently never ring there. Per-device signing
    // costs one extra Redis lookup per device but fixes the silent
    // multi-device failure.
    const wakeKeys = await this.loadVoipWakeKeys(userId);

    // Group records by platform and pair each with its wake key.
    type SignedRecord = {record: DeviceTokenRecord; wakeKey: string};
    const signedAndroid: SignedRecord[] = [];
    const signedIos:     SignedRecord[] = [];
    for (const r of records) {
      const wakeKey = wakeKeys.get(r.deviceId);
      if (!wakeKey) {
        // Device registered for VoIP push token but never minted a
        // wake key (registration race, key expiry, manual cleanup).
        // Skip — sending an unsigned wake would be rejected anyway,
        // and signing with someone else's key is the bug we're
        // fixing.
        this.logger.warn(
          `push.voip.missing-wake-key sub=${userId.slice(0, 8)} device=${r.deviceId.slice(0, 8)} call=${callId.slice(0, 8)}`,
        );
        continue;
      }
      if (r.platform === 'android') signedAndroid.push({record: r, wakeKey});
      else                          signedIos.push({record: r, wakeKey});
    }

    let sent = 0;

    // Android — one FCM call per device (sendEach takes a Message
    // array, each carrying its own token + data block).
    if (signedAndroid.length > 0) {
      const messages = signedAndroid.map(({record, wakeKey}) => {
        const nonce = crypto.randomBytes(16).toString('base64');
        const expSec = Math.floor(Date.now() / 1000) + VOIP_WAKE_TTL_SECONDS;
        const sig = voipSign(wakeKey, {kind: 'voip-wake', callId, nonce, exp: expSec});
        return {
          token: record.token,
          // DATA-ONLY (no `notification` block, top-level OR android). WhatsApp-style killed-app
          // ring: a `notification` block makes Android display the push itself and SKIP
          // setBackgroundMessageHandler, so the device's full-screen notifee ring
          // (callNotification.showIncomingCallNotif) + Telecom never fire when backgrounded/killed
          // — the user just gets a plain heads-up. Data-only high-priority guarantees the slim JS
          // handler (fcmHeadless, registered at bundle entry) runs and draws the full-screen ring.
          // Audit P1-N2 — still NO caller name / call kind on the wire (privacy); the real ring UI
          // renders the name locally after the WS `call.offer` frame lands.
          data: {
            kind:  'voip-wake',
            callId,
            // Round 5 / Security S3 — replay-protection envelope.
            nonce,
            exp:   String(expSec),
            sig,
            // Audit PUSH-B6 — group-call ring room token for killed-app decline.
            ...(roomToken ? {roomToken} : {}),
            // §5 (Ranak-approved 2026-07-05) — pseudonymous caller id + kind
            // for instant local-name ring labeling. See param doc above.
            fromUserId: senderUserId,
            ...(callKind ? {callKind} : {}),
            // P1-BR-1 — group-ring routing hint, unsigned. See param doc.
            ...(conversationId ? {conversationId} : {}),
          },
          android: {
            priority: 'high' as const,
            // collapse per-callId so a stale wake from an older call can't suppress this one.
            collapseKey: `voip-wake:${callId}`,
            ttl: 30 * 1000, // 30s — past this the call is dead anyway
          },
        };
      });
      try {
        const resp = await admin.messaging().sendEach(messages);
        sent += resp.successCount;
        // Push audit P0-N4 — VoIP wake pulls from VOIP prefix.
        const androidTokens = signedAndroid.map(s => s.record.token);
        await this.cleanupBadTokens(userId, resp, androidTokens, VOIP_KEY_PREFIX);
      } catch (e) {
        this.logger.error(`push.voip.fcm-send-failed sub=${userId.slice(0, 8)} call=${callId.slice(0, 8)}: ${(e as Error).message}`);
      }
    }

    // iOS — APNs HTTP/2 is already per-token, so we loop and send
    // each device with its own sig. sendVoipApns takes one token
    // array today; refactor for per-device signing is a one-token
    // loop here.
    for (const {record, wakeKey} of signedIos) {
      const nonce = crypto.randomBytes(16).toString('base64');
      const expSec = Math.floor(Date.now() / 1000) + VOIP_WAKE_TTL_SECONDS;
      const sig = voipSign(wakeKey, {kind: 'voip-wake', callId, nonce, exp: expSec});
      const sent_ios = await this.sendVoipApns(userId, callId, [record.token], {
        nonce, exp: expSec, sig,
      });
      sent += sent_ios;
    }

    this.logger.log(`push.voip.delivered sub=${userId.slice(0, 8)} call=${callId.slice(0, 8)} sent=${sent}/${records.length}`);
    return {sent, stubbed: false};
  }

  /**
   * iOS PushKit / APNs HTTP/2 VoIP push.
   *
   * Probes the four APNS_VOIP_* env vars; if any is missing or the
   * .p8 key file isn't readable we log ONCE and skip — Android FCM
   * delivery is unaffected. Once env is configured the same call
   * triggers real APNs delivery via the lazy-built ApnsClient.
   *
   * Token cleanup: BadDeviceToken / Unregistered responses delete
   * the dead token from Redis so the next call doesn't fire into
   * the void.
   */
  private apnsMissingEnvLogged = false;
  private apnsClient: ApnsClient | null = null;
  private async sendVoipApns(
    userId: string,
    callId: string,
    iosTokens: string[],
    payload: {nonce: string; exp: number; sig: string},
  ): Promise<number> {
    const client = this.ensureApnsClient();
    if (!client) {
      this.logger.log(`push.voip.ios-skip sub=${userId.slice(0, 8)} call=${callId.slice(0, 8)} tokens=${iosTokens.length} (APNs env not configured)`);
      return 0;
    }

    // Audit P1-N2 — minimal payload, no caller-identifying fields.
    const body = {
      kind:       'voip-wake',
      callId,
      nonce:      payload.nonce,
      exp:        String(payload.exp),
      sig:        payload.sig,
    };

    let sent = 0;
    const deadTokens: string[] = [];
    await Promise.all(iosTokens.map(async (tok) => {
      try {
        const res = await client.sendVoip(tok, body);
        if (res.status === 200) {
          sent += 1;
        } else if (res.status === 400 && (res.reason === 'BadDeviceToken' || res.reason === 'DeviceTokenNotForTopic')) {
          deadTokens.push(tok);
          this.logger.warn(`push.voip.ios-bad-token sub=${userId.slice(0, 8)} reason=${res.reason}`);
        } else if (res.status === 410 && res.reason === 'Unregistered') {
          deadTokens.push(tok);
          this.logger.warn(`push.voip.ios-unregistered sub=${userId.slice(0, 8)}`);
        } else {
          this.logger.warn(`push.voip.ios-fail sub=${userId.slice(0, 8)} status=${res.status} reason=${res.reason ?? 'unknown'}`);
        }
      } catch (e) {
        this.logger.error(`push.voip.ios-error sub=${userId.slice(0, 8)}: ${(e as Error).message}`);
      }
    }));

    if (deadTokens.length > 0) {
      await this.cleanupBadIosTokens(userId, deadTokens);
    }

    this.logger.log(`push.voip.ios-delivered sub=${userId.slice(0, 8)} call=${callId.slice(0, 8)} sent=${sent}/${iosTokens.length}`);
    return sent;
  }

  /**
   * Build (or return cached) APNs client. Returns null when env is
   * incomplete or the .p8 file isn't readable. Logs the missing-env
   * warning at most once per process lifetime so dev environments
   * don't get spammed.
   */
  private ensureApnsClient(): ApnsClient | null {
    if (this.apnsClient) {return this.apnsClient;}

    const keyId    = process.env.APNS_VOIP_KEY_ID;
    const teamId   = process.env.APNS_VOIP_TEAM_ID;
    const bundleId = process.env.APNS_VOIP_BUNDLE_ID;
    const keyPath  = process.env.APNS_VOIP_KEY_PATH;
    const sandbox  = process.env.APNS_VOIP_SANDBOX === '1';
    // P0-N7: optional SHA-256 pin of the .p8 contents. When set, the
    // client refuses to mint a JWT if the file's hash drifts (i.e.
    // a swapped .p8). Operator pipeline: rotate .p8 → rotate pin →
    // restart workers. Hash is hex; case-insensitive.
    const expectedKeySha256Hex = process.env.APNS_VOIP_KEY_SHA256;

    if (!keyId || !teamId || !bundleId || !keyPath) {
      if (!this.apnsMissingEnvLogged) {
        this.logger.warn(
          'push.voip.ios-skip — APNS_VOIP_* env not configured. ' +
          'Required: APNS_VOIP_KEY_ID, APNS_VOIP_TEAM_ID, APNS_VOIP_BUNDLE_ID, APNS_VOIP_KEY_PATH. ' +
          'Optional: APNS_VOIP_SANDBOX=1 for sandbox delivery during TestFlight smoke. ' +
          'iOS calls will not ring on backgrounded devices until this is wired.',
        );
        this.apnsMissingEnvLogged = true;
      }
      return null;
    }
    if (!fs.existsSync(keyPath)) {
      if (!this.apnsMissingEnvLogged) {
        this.logger.warn(`push.voip.ios-skip — APNS_VOIP_KEY_PATH file does not exist: ${keyPath}`);
        this.apnsMissingEnvLogged = true;
      }
      return null;
    }

    try {
      this.apnsClient = new ApnsClient({keyId, teamId, bundleId, keyPath, sandbox, expectedKeySha256Hex});
      this.logger.log(`push.voip.ios-init bundle=${bundleId} keyId=${keyId.slice(0, 4)}… sandbox=${sandbox}`);
      return this.apnsClient;
    } catch (e) {
      this.logger.error(`push.voip.ios-init-failed: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Drop iOS VoIP tokens APNs flagged as dead. Mirrors cleanupBadTokens
   * for Android FCM but scoped to the iOS slice so we don't iterate
   * Android records unnecessarily.
   */
  private async cleanupBadIosTokens(userId: string, deadTokens: string[]): Promise<void> {
    const ids = await this.userDeviceIds(VOIP_INDEX_PREFIX, VOIP_KEY_PREFIX, userId);
    let dropped = 0;
    for (const did of ids) {
      const raw = await this.redis.client.get(`${VOIP_KEY_PREFIX}${userId}:${did}`);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw) as DeviceTokenRecord;
        if (rec.platform === 'ios' && deadTokens.includes(rec.token)) {
          await this.redis.client.del(`${VOIP_KEY_PREFIX}${userId}:${did}`);
          await this.indexRemove(VOIP_INDEX_PREFIX, userId, did);
          dropped += 1;
        }
      } catch { /* malformed entry, leave alone */ }
    }
    if (dropped > 0) {
      this.logger.warn(`push.voip.ios-gc sub=${userId.slice(0, 8)} dropped=${dropped}`);
    }
  }

  /**
   * Try every credential source. Idempotent: if admin is already
   * initialised (e.g. a sibling NestJS instance also called this), the
   * second call would throw `default app already exists` — guard via
   * `fcmReady`.
   */
  private tryInitFcm(): void {
    if (this.fcmReady) return;
    const candidates = [
      process.env.GOOGLE_APPLICATION_CREDENTIALS,
      '/home/ubuntu/bravo/firebase-service-account.json',
      path.join(process.cwd(), 'firebase-service-account.json'),
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);

    for (const credPath of candidates) {
      if (!fs.existsSync(credPath)) continue;
      try {
        const raw = fs.readFileSync(credPath, 'utf8');
        const json = JSON.parse(raw) as {project_id?: string; client_email?: string; private_key?: string};
        if (!json.project_id || !json.client_email || !json.private_key) {
          this.logger.warn(`push.fcm-init-skip path=${credPath}: missing project_id / client_email / private_key`);
          continue;
        }
        // If a default app already exists (test re-init), reuse it.
        if (admin.apps.length === 0) {
          admin.initializeApp({
            credential: admin.credential.cert({
              projectId:   json.project_id,
              clientEmail: json.client_email,
              privateKey:  json.private_key.replace(/\\n/g, '\n'),
            }),
          });
        }
        this.fcmReady = true;
        this.logger.log(`push.fcm-init-ok project=${json.project_id} from=${credPath}`);
        return;
      } catch (e) {
        this.logger.warn(`push.fcm-init-failed path=${credPath}: ${(e as Error).message}`);
      }
    }
    // No creds found — leave fcmReady=false, sendVoipWake will stub.
  }

  /**
   * FCM batch-response handling: any token marked
   * `messaging/registration-token-not-registered` is permanently dead
   * (uninstall, data clear). Drop it from Redis so we don't keep retrying.
   *
   * Push audit P0-N4 — the `keyPrefix` parameter is REQUIRED. The
   * previous version hardcoded the scan to `VOIP_KEY_PREFIX` even
   * when called from `sendDataOnlyToUser` / `sendChatWake` /
   * `sendBookingPush` (which pull from `DATA_KEY_PREFIX`). On
   * Android fcmBootstrap registers the SAME FCM token under BOTH
   * prefixes; the result was:
   *   • dead DATA entries never cleaned (wrong-prefix scan never
   *     matched the right key),
   *   • the matching VOIP entry was wrongly deleted as a side effect
   *     when the chat-wake FCM returned `not-registered` for the
   *     shared token.
   * After the first dead-token chat-wake, the user's incoming-call
   * channel silently died — sendVoipWake then logged "no-tokens"
   * and every call dropped before ringing.
   *
   * The fix: caller passes the prefix it actually scanned, and the
   * reap matches by TOKEN VALUE in BOTH keyspaces.
   *
   * B-48 (2026-07-05) — reaping only the scanned keyspace created the
   * half-alive state: on Android the SAME FCM token lives under both
   * prefixes, and `registration-token-not-registered` means the token
   * itself is dead (uninstall / data clear / rotation) — dead for both
   * channels. Deleting only the DATA copy left a dead VOIP twin, so
   * messages logged `no-tokens` while calls fired into the void (and
   * vice versa). Now a dead token is dropped from BOTH keyspaces by
   * exact token match — inherently safe on iOS, where the APNs VoIP
   * token differs from the FCM token and simply never matches.
   */
  private async cleanupBadTokens(
    userId: string,
    resp: admin.messaging.BatchResponse,
    tokens: string[],
    keyPrefix: typeof DATA_KEY_PREFIX | typeof VOIP_KEY_PREFIX,
  ): Promise<void> {
    const toDelete: string[] = [];
    resp.responses.forEach((r, i) => {
      if (r.success) return;
      const code = (r.error as {code?: string} | undefined)?.code;
      if (code === 'messaging/registration-token-not-registered'
          || code === 'messaging/invalid-registration-token') {
        toDelete.push(tokens[i]);
      }
    });
    if (toDelete.length === 0) return;
    const scannedIsVoip = keyPrefix === VOIP_KEY_PREFIX;
    const dropped = await this.dropRecordsMatchingTokens(
      userId, toDelete, keyPrefix,
      scannedIsVoip ? VOIP_INDEX_PREFIX : DATA_INDEX_PREFIX,
    );
    const twinDropped = await this.dropRecordsMatchingTokens(
      userId, toDelete,
      scannedIsVoip ? DATA_KEY_PREFIX : VOIP_KEY_PREFIX,
      scannedIsVoip ? DATA_INDEX_PREFIX : VOIP_INDEX_PREFIX,
    );
    if (dropped + twinDropped > 0) {
      const kind = scannedIsVoip ? 'voip' : 'data';
      this.logger.warn(`push.${kind}.gc-bad-tokens sub=${userId.slice(0, 8)} dropped=${dropped} twin=${twinDropped}`);
    }
  }

  /**
   * Delete every record in one keyspace whose stored token value is in
   * `deadTokens`, pruning the channel index alongside. Tokens are stored
   * keyed by userId:deviceId — the deviceId isn't derivable from the token
   * alone, so this walks the user's device index.
   */
  private async dropRecordsMatchingTokens(
    userId: string,
    deadTokens: string[],
    keyPrefix: typeof DATA_KEY_PREFIX | typeof VOIP_KEY_PREFIX,
    indexPrefix: typeof DATA_INDEX_PREFIX | typeof VOIP_INDEX_PREFIX,
  ): Promise<number> {
    const ids = await this.userDeviceIds(indexPrefix, keyPrefix, userId);
    let dropped = 0;
    for (const did of ids) {
      const raw = await this.redis.client.get(`${keyPrefix}${userId}:${did}`);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw) as DeviceTokenRecord;
        if (deadTokens.includes(rec.token)) {
          await this.redis.client.del(`${keyPrefix}${userId}:${did}`);
          await this.indexRemove(indexPrefix, userId, did);
          dropped += 1;
        }
      } catch { /* malformed entry, leave alone */ }
    }
    return dropped;
  }
}

/**
 * Round 5 / Security S3 + Audit P1-N2 — canonical signing transform.
 *
 *   sig = base64(HMAC-SHA256(wakeKey, "voip-wake|<callId>|<nonce>|<exp>"))
 *
 * `callKind` was previously part of the canonical form but it forced
 * the field into the FCM/APNs payload (so the verifier could recompute
 * the hash), which leaked voice-vs-video metadata to the push platform.
 * Dropped from the sig AND from the wire — the wake now carries no
 * caller-identifying fields.
 *
 * Pipe-separated fields keep the canonical form unambiguous (callId
 * is a UUID, nonce is base64 (no `|`), exp is decimal). Same shape on
 * server + client.
 *
 * Exported for the test suite + the client-side mirror that lives in
 * the mobile app (see src/modules/messenger/push/voipWakeVerify.ts).
 */
export function voipSign(wakeKeyB64: string, fields: {
  kind:     'voip-wake';
  callId:   string;
  nonce:    string;
  exp:      number;
}): string {
  const key = Buffer.from(wakeKeyB64, 'base64');
  const msg = `${fields.kind}|${fields.callId}|${fields.nonce}|${fields.exp}`;
  return crypto.createHmac('sha256', key).update(msg).digest('base64');
}

async function scanKeys(redis: RedisService, pattern: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.client.scan(cursor, 'MATCH', pattern, 'COUNT', 128);
    cursor = next;
    for (const k of batch) out.push(k);
  } while (cursor !== '0');
  return out;
}
