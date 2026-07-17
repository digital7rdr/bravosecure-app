import {Injectable, Logger, type OnModuleInit, type OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {BookingStateMachine} from '../booking/state-machine.service';
import {OpsAuditService} from '../ops/ops-audit.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {DispatchService} from './dispatch.service';

/**
 * Sweep 3 — arrival no-show watchdog (BUILD_RUNBOOK Step 16 / LB13).
 *
 * DISTINCT from the Step 8 crew-SLA sweep (crew-sla.service.ts):
 *   • crew-SLA / AGENCY_NO_SHOW = agency accepted but never CREWED (no mission) by
 *     crew_deadline_at → TERMINAL, client refunded, agency breached.
 *   • THIS / arrival-no-show = agency crewed it (mission DISPATCHED) but the crew
 *     never ARRIVED (mission never reached PICKUP, pickup_at IS NULL) by
 *     arrival_deadline_at → NOT terminal. Re-dispatch the SAME booking to another
 *     agency. The escrow hold PERSISTS (HELD) — the client is NEVER re-charged; the
 *     replacement agency's accept() re-points the hold to itself (dispatch.service).
 *
 * On a hit it: flips CONFIRMED → DISPATCHING (a new SYSTEM transition, Step 16),
 * ABORTs the no-show mission + stands its crew down (so those CPOs free up), marks
 * the no-show agency's prior ACCEPTED offer SUPERSEDED (so the matchmaker never
 * re-offers it this booking), bumps that agency's reliability_breaches, then
 * re-enters DispatchService.offerNext to find the next-nearest eligible agency.
 *
 * Multi-pod safe via the Redis `SET NX` lock (LB9). DARK on AUTO_DISPATCH_ENABLED.
 *
 * ⚠️ SINGLE OWNER per concern: this is THE arrival-no-show sweep; crew-sla.service.ts
 * is THE crew-SLA sweep. They use DIFFERENT lock keys + scan DIFFERENT candidates
 * (no-mission vs mission-DISPATCHED-stale) so they never act on the same booking.
 *
 * MONEY: this sweep moves NO money. The hold stays HELD across the re-dispatch (the
 * one money-correctness rule vs the crew-SLA template, which REFUNDS because it is
 * terminal). Re-attribution of the hold's payee happens in the replacement accept().
 */
const SWEEP_INTERVAL_MS = 60_000;         // 1 min
const LOCK_KEY = 'lock:dispatch-arrival-noshow';
const LOCK_TTL_MS = 55_000;               // < interval so a crashed sweeper doesn't pin the lock
const LIVENESS_KEY = 'dispatch:watchdog:arrival:last_run';
const BATCH = 50;

@Injectable()
export class ArrivalNoShowService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ArrivalNoShowService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly fsm: BookingStateMachine,
    private readonly audit: OpsAuditService,
    private readonly push: BookingPushBridge,
    private readonly dispatch: DispatchService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled()) {
      this.log.log('auto-dispatch off — arrival-no-show sweeper not started');
      return;
    }
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    this.log.log(`arrival-no-show sweeper started (interval=${SWEEP_INTERVAL_MS}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private enabled(): boolean {
    return this.config.get<boolean>('featureFlags.autoDispatch') ?? false;
  }

  /** Public for tests — runs one sweep iteration. */
  async sweepOnce(): Promise<{redispatched: number; skipped_lock: boolean; skipped_flag: boolean}> {
    if (!this.enabled()) {
      return {redispatched: 0, skipped_lock: false, skipped_flag: true};
    }
    const got = await this.redis.client.set(LOCK_KEY, String(Date.now()), 'PX', LOCK_TTL_MS, 'NX');
    if (got !== 'OK') {
      return {redispatched: 0, skipped_lock: true, skipped_flag: false};
    }
    try {
      const due = await this.db.q<{id: string}>(
        // Uses the lite_bookings_arrival_due partial index. Scope to AUTO bookings whose
        // crew was assigned (mission DISPATCHED) but never reached PICKUP by the deadline.
        `SELECT b.id
           FROM lite_bookings b
           JOIN missions m ON m.booking_id = b.id
          WHERE b.status = 'CONFIRMED'
            AND b.dispatch_mode = 'auto'
            AND b.arrival_deadline_at IS NOT NULL
            AND b.arrival_deadline_at < NOW()
            AND m.status = 'DISPATCHED'
            AND m.pickup_at IS NULL
          ORDER BY b.arrival_deadline_at ASC
          LIMIT ${BATCH}`,
      );
      let redispatched = 0;
      for (const r of due) {
        try {
          if (await this.reDispatch(r.id)) {
            redispatched++;
          }
        } catch (e) {
          this.log.warn(`arrival-no-show re-dispatch failed for ${r.id}: ${(e as Error).message}`);
        }
      }
      await this.redis.client.set(LIVENESS_KEY, String(Date.now()), 'EX', 600).catch(() => undefined);
      return {redispatched, skipped_lock: false, skipped_flag: false};
    } finally {
      await this.redis.client.del(LOCK_KEY).catch(() => undefined);
    }
  }

  /** One booking, in its own txn: re-check under BOTH the booking + mission row
   *  locks, flip CONFIRMED → DISPATCHING, abort the no-show mission + stand its crew
   *  down, supersede its offer, bump the agency breach. The hold stays HELD. Audit +
   *  client wake + the offerNext re-entry happen AFTER the commit. */
  private async reDispatch(bookingId: string): Promise<boolean> {
    const result = await this.db.withTransaction(async tx => {
      const cur = await tx.qOne<{status: string; client_id: string; assigned_provider_user_id: string | null}>(
        `SELECT status, client_id, assigned_provider_user_id
           FROM lite_bookings WHERE id = $1 FOR UPDATE`,
        [bookingId],
      );
      if (!cur || cur.status !== 'CONFIRMED') {
        return null; // raced — completed/cancelled/already re-dispatched
      }
      // Lock the mission row too (booking-then-mission order) so a concurrent lead
      // PICKUP flip serializes behind us: if the lead arrived first we see PICKUP and
      // bail; if we win, the lead's WHERE status='DISPATCHED' finds 0 rows and no-ops.
      const mission = await tx.qOne<{id: string; status: string; pickup_at: Date | null}>(
        // LM-B1: skip ABORTED history rows from a prior re-dispatch — lock the live one.
        `SELECT id, status, pickup_at FROM missions
          WHERE booking_id = $1 AND status <> 'ABORTED' FOR UPDATE`,
        [bookingId],
      );
      if (!mission || mission.status !== 'DISPATCHED' || mission.pickup_at !== null) {
        return null; // crew arrived in time (or no mission) — not a no-show
      }
      this.fsm.assert('CONFIRMED', 'DISPATCHING', 'SYSTEM');
      const upd = await tx.q(
        `UPDATE lite_bookings
            SET status = 'DISPATCHING',
                assigned_provider_user_id = NULL,
                crew_deadline_at = NULL,
                arrival_deadline_at = NULL,
                dispatch_started_at = NOW()
          WHERE id = $1 AND status = 'CONFIRMED' RETURNING id`,
        [bookingId],
      );
      if (upd.length === 0) {
        return null; // raced
      }
      // Tear down the no-show agency's mission so it leaves their board + frees capacity.
      await tx.q(
        `UPDATE missions SET status = 'ABORTED', ended_at = NOW()
          WHERE id = $1 AND status = 'DISPATCHED'`,
        [mission.id],
      );
      // Stand the crew down — the active-unique index (mission_crew_agent_active_uq)
      // is on (agent_id) WHERE status<>'off' regardless of mission status, so without
      // this those CPOs stay "busy" forever and can never be re-crewed. RETURNING the
      // freed crew so we can clear their mission card after the commit.
      const stoodDown = await tx.q<{agent_id: string}>(
        `UPDATE mission_crew SET status = 'off'
          WHERE mission_id = $1 AND status <> 'off' RETURNING agent_id`,
        [mission.id],
      );
      // Retire the no-show agency's ACCEPTED offer so the matchmaker's SUPERSEDED
      // exclusion (dispatch.service RANKING_SQL) never re-offers it this booking.
      await tx.q(
        `UPDATE dispatch_offers SET status = 'SUPERSEDED', responded_at = NOW()
          WHERE booking_id = $1 AND status = 'ACCEPTED'`,
        [bookingId],
      );
      // Provider-fault breach — the agency committed crew but no one arrived.
      if (cur.assigned_provider_user_id) {
        await tx.q(
          `UPDATE agents SET reliability_breaches = reliability_breaches + 1 WHERE user_id = $1`,
          [cur.assigned_provider_user_id],
        );
      }
      // NB: the escrow hold is deliberately NOT touched — it stays HELD and is carried
      // to the replacement agency (re-pointed in its accept()). The client paid once.
      return {clientId: cur.client_id, missionId: mission.id, crewIds: stoodDown.map(c => c.agent_id)};
    });
    if (!result) {
      return false;
    }
    await this.audit.record({
      actor_id: null, actor_role: 'SYSTEM', action: 'dispatch.arrival_no_show',
      subject_type: 'booking', subject_id: bookingId,
    });
    // LM-V6 — booking-status audit row (cron transitions were previously invisible
    // in lite_booking_audit, so the client-facing timeline skipped this hop).
    await this.db.q(
      `INSERT INTO lite_booking_audit (booking_id, from_status, to_status, actor_id, actor_role, metadata)
       VALUES ($1, 'CONFIRMED', 'DISPATCHING', NULL, 'SYSTEM', $2::jsonb)`,
      [bookingId, JSON.stringify({reason: 'arrival_no_show', mission_id: result.missionId})],
    ).catch(e => this.log.warn(`audit insert failed for ${bookingId}: ${(e as Error).message}`));
    // Clear the no-show crew's mission card (best-effort; they also poll).
    for (const cpo of result.crewIds) {
      void this.push.missionAborted(cpo, result.missionId, bookingId).catch(() => undefined);
    }
    // Re-enter the cascade AFTER the commit — the booking is now durably DISPATCHING,
    // so offerNext re-reads it and offers the next-nearest eligible agency. The prior
    // round's offers still count toward MAX_OFFERS (budget is intentionally NOT reset —
    // it biases a chronically-failing booking toward NO_PROVIDER rather than infinite
    // re-dispatch). Best-effort: a failure here leaves the booking DISPATCHING for the
    // next sweep tick to re-drive.
    try {
      await this.dispatch.offerNext(bookingId);
    } catch (e) {
      this.log.warn(`offerNext after re-dispatch failed for ${bookingId}: ${(e as Error).message}`);
    }
    // Best-effort wake — the client app also polls GET /bookings/:id. This is a
    // "reassigning your detail" reassurance, NOT a terminal no-provider event.
    void this.push.bookingReDispatching(result.clientId, bookingId).catch(() => undefined);
    return true;
  }
}
