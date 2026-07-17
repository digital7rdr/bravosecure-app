import {Test} from '@nestjs/testing';
import {ConfigModule, ConfigService} from '@nestjs/config';
import {MediaService} from './media.service';
import {RedisService} from '../redis/redis.service';
import {BadRequestException, ForbiddenException} from '@nestjs/common';
import configuration from '../config/configuration';

/**
 * P0-V5: tests use a fake Redis to drive recipient-grant scenarios.
 * `sismember`/`exists`/`sadd`/`expire` mirror the surface MediaService
 * uses; the fake is in-memory so each `svc()` call gets fresh state.
 */
function fakeRedis(expireLog?: string[]): RedisService {
  const sets = new Map<string, Set<string>>();
  const kv   = new Map<string, string>();
  return {
    client: {
      async sismember(key: string, member: string): Promise<number> {
        return sets.get(key)?.has(member) ? 1 : 0;
      },
      async exists(key: string): Promise<number> {
        return sets.has(key) || kv.has(key) ? 1 : 0;
      },
      async sadd(key: string, ...members: string[]): Promise<number> {
        let set = sets.get(key);
        if (!set) { set = new Set(); sets.set(key, set); }
        let added = 0;
        for (const m of members) { if (!set.has(m)) { set.add(m); added++; } }
        return added;
      },
      async expire(key: string, _seconds: number): Promise<number> { expireLog?.push(key); return 1; },
      // A10 — owner record surface (media-owner:<key>).
      async set(key: string, value: string): Promise<'OK'> { kv.set(key, value); return 'OK'; },
      async get(key: string): Promise<string | null> { return kv.get(key) ?? null; },
      async del(...keys: string[]): Promise<number> {
        let n = 0;
        for (const k of keys) { if (sets.delete(k)) { n++; } if (kv.delete(k)) { n++; } }
        return n;
      },
    },
  } as unknown as RedisService;
}

function svc(overrides: Record<string, string> = {}, expireLog?: string[]) {
  const baseEnv = {
    MEDIA_S3_ENDPOINT:         'http://127.0.0.1:9000',
    MEDIA_S3_BUCKET:           'test-bucket',
    MEDIA_S3_REGION:           'auto',
    MEDIA_S3_ACCESS_KEY_ID:    'test',
    MEDIA_S3_SECRET_ACCESS_KEY:'test-secret',
    MEDIA_PRESIGN_TTL_SECONDS: '300',
    ...overrides,
  };
  Object.entries(baseEnv).forEach(([k, v]) => { process.env[k] = v; });
  const cfg = {
    get: (k: string): unknown => {
      const c = configuration();
      const parts = k.split('.');
      let cur: unknown = c;
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[p];
        } else {
          return undefined;
        }
      }
      return cur;
    },
  } as ConfigService;
  return new MediaService(cfg, fakeRedis(expireLog));
}

describe('MediaService', () => {
  it('creates a presigned upload URL with a server-generated key', async () => {
    const s = svc();
    const res = await s.createUploadUrl({contentLength: 1024, contentType: 'application/octet-stream'});
    expect(res.objectKey).toMatch(/^att\/[a-f0-9-]{36}$/);
    expect(res.uploadUrl).toContain('http://127.0.0.1:9000');
    expect(res.uploadUrl).toContain('test-bucket');
    expect(res.uploadUrl).toContain(encodeURIComponent(res.objectKey).replace(/%2F/g, '/'));
    expect(res.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects zero or excessive content length', async () => {
    const s = svc();
    await expect(s.createUploadUrl({contentLength: 0, contentType: 'x/y'})).rejects.toThrow(BadRequestException);
    await expect(s.createUploadUrl({contentLength: 1e12, contentType: 'x/y'})).rejects.toThrow(BadRequestException);
  });

  it('rejects malformed MIME type', async () => {
    const s = svc();
    await expect(s.createUploadUrl({contentLength: 1, contentType: 'notamime'})).rejects.toThrow(BadRequestException);
  });

  it('creates a presigned download URL for valid keys only when caller is granted', async () => {
    const s = svc();
    const up = await s.createUploadUrl({contentLength: 1, contentType: 'application/octet-stream'});
    // P0-V5: register the recipient first so the download check passes.
    await s.registerGrants(up.objectKey, 'sender-uid', ['recipient-uid']);
    const res = await s.createDownloadUrl(up.objectKey, 'recipient-uid');
    expect(res.downloadUrl).toContain('http://127.0.0.1:9000');
  });

  it('rejects path-traversal and arbitrary keys on download', async () => {
    const s = svc();
    await expect(s.createDownloadUrl('../other',    'uid')).rejects.toThrow(BadRequestException);
    await expect(s.createDownloadUrl('att/../oops', 'uid')).rejects.toThrow(BadRequestException);
    await expect(s.createDownloadUrl('plain',       'uid')).rejects.toThrow(BadRequestException);
  });

  it('P0-V5 rejects download when caller is not in the recipient grant set', async () => {
    const s = svc();
    const up = await s.createUploadUrl({contentLength: 1, contentType: 'application/octet-stream'});
    await s.registerGrants(up.objectKey, 'sender-uid', ['recipient-A']);
    await expect(s.createDownloadUrl(up.objectKey, 'attacker-uid')).rejects.toThrow(ForbiddenException);
  });

  it('P0-V5 admits under lax mode when no grant set has been registered', async () => {
    delete process.env.MEDIA_REQUIRE_RECIPIENT_GRANT;
    const s = svc();
    const up = await s.createUploadUrl({contentLength: 1, contentType: 'application/octet-stream'});
    // No registerGrants call → grant set absent → lax mode admits.
    const res = await s.createDownloadUrl(up.objectKey, 'any-uid');
    expect(res.downloadUrl).toContain('http://127.0.0.1:9000');
  });

  it('P0-V5 strict mode rejects even when no grant set has been registered', async () => {
    process.env.MEDIA_REQUIRE_RECIPIENT_GRANT = 'true';
    try {
      const s = svc();
      const up = await s.createUploadUrl({contentLength: 1, contentType: 'application/octet-stream'});
      await expect(s.createDownloadUrl(up.objectKey, 'any-uid')).rejects.toThrow(ForbiddenException);
    } finally {
      delete process.env.MEDIA_REQUIRE_RECIPIENT_GRANT;
    }
  });

  it('media-parity M3 — a download REFRESHES the grant + owner TTLs (30d cliff fix)', async () => {
    const expireLog: string[] = [];
    const s = svc({}, expireLog);
    const up = await s.createUploadUrl({contentLength: 1, contentType: 'image/jpeg'});
    await s.registerGrants(up.objectKey, 'sender-uid', ['recipient-uid']);
    const before = expireLog.length; // registerGrants refreshes the grant TTL once
    await s.createDownloadUrl(up.objectKey, 'recipient-uid');
    // The download must have re-expired BOTH the grant and the owner key
    // so actively-viewed media survives past 30 days.
    const refreshed = expireLog.slice(before);
    expect(refreshed.some(k => k.startsWith('media-grant:'))).toBe(true);
    expect(refreshed.some(k => k.startsWith('media-owner:'))).toBe(true);
  });

  it('P0-V5 registerGrants always includes the sender in the set', async () => {
    const s = svc();
    const up = await s.createUploadUrl({contentLength: 1, contentType: 'application/octet-stream'});
    await s.registerGrants(up.objectKey, 'sender-uid', ['recipient-A']);
    // Sender can pull their own upload even when not in recipientUserIds.
    const res = await s.createDownloadUrl(up.objectKey, 'sender-uid');
    expect(res.downloadUrl).toContain('http://127.0.0.1:9000');
  });

  it('P0-V5 registerGrants rejects malformed object keys and empty sets', async () => {
    const s = svc();
    await expect(s.registerGrants('bad-key',          'sender', ['r'])).rejects.toThrow(BadRequestException);
    await expect(s.registerGrants('att/00000000-0000-0000-0000-000000000000', 'sender', []))
      .rejects.toThrow(BadRequestException);
  });

  it('fails clean when credentials are not configured', async () => {
    const s = svc({MEDIA_S3_ACCESS_KEY_ID: '', MEDIA_S3_SECRET_ACCESS_KEY: ''});
    await expect(s.createUploadUrl({contentLength: 1, contentType: 'x/y'})).rejects.toThrow(/media_storage_not_configured/);
  });

  // F16 media-config-endpoint-guard-gap
  it('fails clearly when keys are set but endpoint is unset and region is the auto placeholder', async () => {
    const s = svc({MEDIA_S3_ENDPOINT: '', MEDIA_S3_REGION: 'auto'});
    await expect(s.createUploadUrl({contentLength: 1, contentType: 'x/y'}))
      .rejects.toThrow(/MEDIA_S3_ENDPOINT/);
  });

  // A10 r2-media-never-purged — owner-checked purge
  describe('purgeObject (A10)', () => {
    const KEY = 'att/11111111-1111-1111-1111-111111111111';

    it('rejects a malformed object key', async () => {
      const s = svc();
      await expect(s.purgeObject('vault/not-an-att-key', 'sender')).rejects.toThrow(BadRequestException);
    });

    it('rejects a caller who is not the registered owner', async () => {
      const s = svc();
      await s.registerGrants(KEY, 'sender', ['recipient']);
      // a recipient (or anyone) who is not the sender cannot purge
      await expect(s.purgeObject(KEY, 'recipient')).rejects.toThrow(ForbiddenException);
    });

    it('rejects when there is no owner record at all', async () => {
      const s = svc();
      await expect(s.purgeObject(KEY, 'sender')).rejects.toThrow(ForbiddenException);
    });

    it('purges for the owner (sender) and drops the grant + owner records', async () => {
      const s = svc();
      await s.registerGrants(KEY, 'sender', ['recipient']);
      const res = await s.purgeObject(KEY, 'sender');
      expect(res.ok).toBe(true);
      // owner gone → a second purge by the (now-unregistered) owner is denied
      await expect(s.purgeObject(KEY, 'sender')).rejects.toThrow(ForbiddenException);
    });
  });
});

// Import ConfigModule to satisfy ts-jest's module resolution even
// though the test wires ConfigService by hand.
void ConfigModule;
void Test;
