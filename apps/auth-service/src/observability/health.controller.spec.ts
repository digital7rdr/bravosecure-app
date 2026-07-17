import {HttpException} from '@nestjs/common';
import {HealthController} from './health.controller';
import type {DatabaseService} from '../database/database.service';
import type {RedisService} from '../redis/redis.service';
import type {ConfigService} from '@nestjs/config';
import type {DispatchMetricsService} from './dispatch-metrics.service';

const db = {q: jest.fn()};
const client = {get: jest.fn()};
const redis = {client};
const config = {get: jest.fn()};
const metrics = {prometheus: jest.fn()};

function ctrl(): HealthController {
  return new HealthController(
    db as unknown as DatabaseService,
    redis as unknown as RedisService,
    config as unknown as ConfigService,
    metrics as unknown as DispatchMetricsService,
  );
}

describe('HealthController (Step 26)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    db.q.mockResolvedValue([{}]);                  // DB up
    client.get.mockResolvedValue(String(Date.now())); // Redis up + watchdog fresh
    config.get.mockReturnValue(false);             // auto-dispatch off by default
  });

  it('/health is always ok (liveness)', () => {
    expect(ctrl().health().status).toBe('ok');
  });

  it('/ready true when DB + Redis are up (watchdog skipped while auto-dispatch off)', async () => {
    const r = await ctrl().ready();
    expect(r.ready).toBe(true);
    expect(r.checks).toEqual({db: true, redis: true, watchdog: true});
  });

  it('/ready 503 when the DB is unreachable', async () => {
    db.q.mockRejectedValue(new Error('no db'));
    await expect(ctrl().ready()).rejects.toBeInstanceOf(HttpException);
  });

  it('/ready 503 when the watchdog liveness key is stale (auto-dispatch on)', async () => {
    config.get.mockReturnValue(true);
    client.get.mockImplementation((k: string) =>
      k === 'dispatch:watchdog:offer:last_run'
        ? Promise.resolve(String(Date.now() - 5 * 60_000)) // 5 min stale
        : Promise.resolve('ok'));
    await expect(ctrl().ready()).rejects.toBeInstanceOf(HttpException);
  });

  it('/ready ok when auto-dispatch on AND watchdog fresh', async () => {
    config.get.mockReturnValue(true);
    client.get.mockResolvedValue(String(Date.now()));
    const r = await ctrl().ready();
    expect(r.checks.watchdog).toBe(true);
  });

  it('/metrics returns the registry text', () => {
    metrics.prometheus.mockReturnValue('dispatch_no_provider_total{region="AE"} 1\n');
    expect(ctrl().metricsText()).toContain('dispatch_no_provider_total');
  });
});
