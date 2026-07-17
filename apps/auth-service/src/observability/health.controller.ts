import {Controller, Get, Header, HttpCode, HttpException, HttpStatus} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {DispatchMetricsService} from './dispatch-metrics.service';

/**
 * Liveness / readiness / metrics (BUILD_RUNBOOK Step 26). PUBLIC (no JWT) — returns only
 * coarse booleans + the Prometheus metric text, never PII. /health = process up;
 * /ready = Redis + DB reachable AND (when auto-dispatch is on) the offer watchdog ran
 * recently; /metrics = the dispatch metric registry as Prometheus text.
 */
// A watchdog last-run older than 2× its interval (offer sweep ~8s) is "dead" — be generous.
const WATCHDOG_STALE_MS = 60_000;
// The offer-expiry sweep stamps this SHARED Redis key on every lock-won run, so /ready is
// correct across pods (the in-process metric gauge only knows this pod's runs).
const WATCHDOG_LIVENESS_KEY = 'dispatch:watchdog:offer:last_run';

@Controller()
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly metrics: DispatchMetricsService,
  ) {}

  @Get('health')
  health(): {status: 'ok'; uptime_s: number} {
    return {status: 'ok', uptime_s: Math.round(process.uptime())};
  }

  @Get('ready')
  async ready(): Promise<{ready: true; checks: Record<string, boolean>}> {
    const checks: Record<string, boolean> = {db: false, redis: false, watchdog: true};
    try {
      await this.db.q('SELECT 1');
      checks.db = true;
    } catch {/* stays false */}
    try {
      await this.redis.client.get('health:ping');
      checks.redis = true;
    } catch {/* stays false */}

    // Only assert watchdog liveness when auto-dispatch is on (otherwise the sweeps don't
    // run by design). Read the SHARED Redis liveness key (multi-pod correct), not the
    // per-pod metric gauge.
    if (this.config.get<boolean>('featureFlags.autoDispatch')) {
      try {
        const raw = await this.redis.client.get(WATCHDOG_LIVENESS_KEY);
        const last = raw ? Number(raw) : NaN;
        checks.watchdog = Number.isFinite(last) && Date.now() - last < WATCHDOG_STALE_MS;
      } catch {
        checks.watchdog = false;
      }
    }

    const ok = Object.values(checks).every(Boolean);
    if (!ok) {
      // 503 so an orchestrator pulls the pod out of rotation; body still lists the checks.
      throw new HttpException({ready: false, checks}, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return {ready: true, checks};
  }

  @Get('metrics')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metricsText(): string {
    return this.metrics.prometheus();
  }
}
