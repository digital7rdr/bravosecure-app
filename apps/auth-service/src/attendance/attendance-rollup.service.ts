import {Injectable, Logger, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';

/**
 * Auto-absent rollup (Dept Chat v2, Step 6). A CPO assigned to a shift whose
 * window has ended with NO session for that shift is marked 'absent' — a CPO is
 * never silently left blank.
 *
 * Mirrors the canonical Redis SET NX-locked setInterval sweep
 * (booking/payment-pending-expiry.service.ts; convention pinned in
 * dispatch/README.md) — NEVER @nestjs/schedule. Single-fire across replicas via
 * the lock. Gated on featureFlags.deptChatV2 (like dispatch/offer-expiry gates
 * on autoDispatch) so it doesn't run while the module ships dark.
 *
 * The insert is idempotent: `WHERE NOT EXISTS (a session for this shift+cpo)`,
 * and the absent marker it writes carries the shift_id, so a re-run sees it and
 * skips. LOCK_TTL_MS < SWEEP_INTERVAL_MS so a crashed pod can't pin the lock.
 */
const SWEEP_INTERVAL_MS = 5 * 60_000; // 5 min — attendance is not time-critical
const LOCK_KEY = 'lock:attendance-absent-rollup';
const LOCK_TTL_MS = 4 * 60_000 + 30_000; // 4m30s, shorter than the interval

@Injectable()
export class AttendanceRollupService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AttendanceRollupService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  private enabled(): boolean {
    return this.config.get<boolean>('featureFlags.deptChatV2') === true;
  }

  onModuleInit(): void {
    if (!this.enabled()) {
      this.log.log('dept-chat-v2 off — attendance auto-absent rollup not started');
      return;
    }
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    this.log.log(`attendance auto-absent rollup started (interval=${SWEEP_INTERVAL_MS}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Public for tests — one rollup iteration. */
  async sweepOnce(): Promise<{marked: number; skipped_lock: boolean; skipped_flag: boolean}> {
    if (!this.enabled()) return {marked: 0, skipped_lock: false, skipped_flag: true};

    const got = await this.redis.client.set(LOCK_KEY, String(Date.now()), 'PX', LOCK_TTL_MS, 'NX');
    if (got !== 'OK') return {marked: 0, skipped_lock: true, skipped_flag: false};
    try {
      // Idempotent conditional insert — one absent marker per ended shift the CPO
      // was assigned to but never logged a session for. Bounded to the last 2 days
      // so the scan stays cheap and old shifts aren't re-evaluated forever.
      const rows = await this.db.q<{id: string}>(
        `INSERT INTO cpo_shift_sessions
           (org_user_id, cpo_user_id, status, shift_id, clock_in_at, attendance_status, review_status)
         SELECT s.org_user_id, a.cpo_user_id, 'closed', a.shift_id, s.start_at, 'absent', 'none'
           FROM cpo_shift_assignments a
           JOIN cpo_shifts s ON s.id = a.shift_id AND s.archived_at IS NULL
          WHERE s.end_at < NOW()
            AND s.end_at > NOW() - INTERVAL '2 days'
            AND NOT EXISTS (
              SELECT 1 FROM cpo_shift_sessions x
               WHERE x.cpo_user_id = a.cpo_user_id AND x.shift_id = a.shift_id
            )
            -- D6-c — don't auto-mark absent if a manager set a day-status marker
            -- (leave / sick_leave / off_duty / absent) for the shift's date. Those markers
            -- carry NO shift_id, so the shift_id NOT EXISTS above never sees them.
            AND NOT EXISTS (
              SELECT 1 FROM cpo_shift_sessions d
               WHERE d.cpo_user_id = a.cpo_user_id
                 AND d.shift_id IS NULL
                 AND d.attendance_status IN ('leave','sick_leave','off_duty','absent')
                 AND d.clock_in_at::date = s.start_at::date
            )
         RETURNING id`,
      );
      if (rows.length > 0) this.log.log(`attendance rollup marked ${rows.length} absent`);
      return {marked: rows.length, skipped_lock: false, skipped_flag: false};
    } finally {
      await this.redis.client.del(LOCK_KEY).catch(() => undefined);
    }
  }
}
