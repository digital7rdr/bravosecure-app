import {Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {AuditService} from '../kafka/audit.service';
import {OpsAuditService} from '../ops/ops-audit.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';

export interface SosStatusDto {
  id:                string;
  status:            string;
  triggered_at:      string;
  acknowledged_at:   string | null;
  acknowledged_by:   string | null;
  escalated_at:      string | null;
  resolved_at:       string | null;
}

/**
 * Audit fix 0.7 — client-side SOS triggered from the Lite dashboard.
 *
 * The original flow was UI-only: tapping the button transitioned the
 * local state to "activated" and never reached the server. This service
 * persists the alert into `sos_events`, fans an event into ops audit so
 * the live activity feed lights up, and emits a Kafka event for the
 * dispatch / pager surfaces.
 *
 * NOT booking-scoped — a panic press from anywhere in the app should
 * be recorded even if the user has no active booking. `bookingId` is
 * optional; the row carries `user_id + status='active'` and ops sees
 * it in the unacknowledged feed.
 */
@Injectable()
export class SosService {
  private readonly log = new Logger(SosService.name);

  constructor(
    private readonly db:        DatabaseService,
    private readonly redis:     RedisService,
    private readonly audit:     AuditService,
    private readonly opsAudit:  OpsAuditService,
    private readonly push:      BookingPushBridge,
  ) {}

  async raise(
    userId: string,
    args: {bookingId?: string; lat?: number; lng?: number; reason?: string; payload?: Record<string, unknown>},
  ): Promise<{id: string; triggered_at: string}> {
    const reason  = (args.reason ?? 'panic_button').slice(0, 64);
    const payload = JSON.stringify({
      ...(args.payload ?? {}),
      source:    'lite_dashboard',
      reason,
    });

    // Optional point geometry — only set when the client supplied a fix.
    // The EWKT string carries `lat`/`lng` as literals (PostGIS does not
    // accept bound parameters inside an EWKT body), so we re-validate
    // the numbers at the service boundary as a defense in depth on top
    // of the DTO's @IsLatitude/@IsLongitude. `Number.isFinite` rejects
    // Infinity/NaN; the range bounds match PostGIS's SRID=4326 domain.
    // The whole EWKT string is then passed as the bound parameter $3
    // to ST_GeogFromText, so even if a future regression makes one of
    // these checks fall over, the value still never reaches the SQL
    // text as code.
    const isFiniteLat = typeof args.lat === 'number' && Number.isFinite(args.lat) && args.lat >= -90  && args.lat <= 90;
    const isFiniteLng = typeof args.lng === 'number' && Number.isFinite(args.lng) && args.lng >= -180 && args.lng <= 180;
    const point = (isFiniteLat && isFiniteLng)
      ? `SRID=4326;POINT(${Number(args.lng)} ${Number(args.lat)})`
      : null;

    const row = await this.db.qOne<{id: string; triggered_at: Date}>(
      `INSERT INTO public.sos_events
         (user_id, booking_id, location, status, payload, reason, lat, lng)
       VALUES (
         $1, $2,
         CASE WHEN $3::text IS NULL THEN NULL ELSE ST_GeogFromText($3) END,
         'active', $4::jsonb, $5, $6, $7
       )
       RETURNING id, triggered_at`,
      [
        userId,
        args.bookingId ?? null,
        point,
        payload,
        reason,
        isFiniteLat ? args.lat : null,
        isFiniteLng ? args.lng : null,
      ],
    );
    if (!row) throw new Error('sos_insert_failed');

    // Ops live feed — surfaces under the unacknowledged badge.
    await this.opsAudit.emit({
      kind:     'sos',
      severity: 'err',
      actor:    userId,
      subject:  args.bookingId ?? row.id,
      message:  `SOS · client panic · ${reason}`,
    });
    // System audit (Kafka).
    await this.audit.emit({
      event_type: 'client.sos.raise',
      user_id:    userId,
      device_id:  null,
      ip:         'client',
      outcome:    'success',
      detail:     reason,
    });

    // Fan a wake to every CPO crewed on the booking so they see the
    // panic event without needing the live tracker mounted. Same Redis
    // channel BookingPushBridge uses; messenger-service subscribes and
    // dispatches via FCM. Only fires when the SOS is booking-scoped —
    // an off-mission panic press has no crew to notify.
    if (args.bookingId) {
      try {
        const crew = await this.db.q<{user_id: string; mission_id: string}>(
          // LM-B1 — skip ABORTED history missions + stood-down crew rows.
          `SELECT mc.agent_id AS user_id, m.id AS mission_id
             FROM mission_crew mc
             JOIN missions m ON m.id = mc.mission_id
            WHERE m.booking_id = $1
              AND m.status NOT IN ('COMPLETED', 'ABORTED')
              AND mc.status <> 'off'`,
          [args.bookingId],
        );
        // F5 — the AGENCY monitoring desk was blind to SOS (no push, no banner);
        // include the assigned provider org in the fan-out.
        const provider = await this.db.qOne<{assigned_provider_user_id: string | null}>(
          `SELECT assigned_provider_user_id FROM lite_bookings WHERE id = $1`,
          [args.bookingId],
        );
        // A1 SOS-WAKE-DROPPED-AT-RELAY — fan out through the OPAQUE
        // BookingPushBridge (eventId + coarse 'sos' class), NOT a hand-rolled
        // publish. The legacy payload here carried NO eventId, so the
        // messenger-service push subscriber bailed on `!frame.eventId` and the
        // panic alert never reached FCM. Group by mission so each CPO's wake
        // carries their own missionId in the encrypted detail blob.
        const byMission = new Map<string, string[]>();
        for (const c of crew) {
          const arr = byMission.get(c.mission_id) ?? [];
          arr.push(c.user_id);
          byMission.set(c.mission_id, arr);
        }
        for (const [missionId, userIds] of byMission) {
          const withProvider = provider?.assigned_provider_user_id
            ? [...new Set([...userIds, provider.assigned_provider_user_id])]
            : userIds;
          await this.push.sosAlert(withProvider, missionId, args.bookingId);
        }
      } catch (e) {
        this.log.warn(`client SOS fanout failed: ${(e as Error).message}`);
      }
    }

    return {id: row.id, triggered_at: row.triggered_at.toISOString()};
  }

  async cancel(userId: string, sosId: string): Promise<void> {
    // Only the originating user can cancel their own active SOS. Ops
    // keeps acknowledge/escalate/resolve on the ops side; cancel here
    // is the client's "false alarm" path (user releases hold-to-cancel
    // from the Lite dashboard).
    await this.db.q(
      `UPDATE public.sos_events
          SET status      = 'false_alarm',
              resolved_at = NOW(),
              resolved_by = $1
        WHERE id = $2 AND user_id = $1 AND status = 'active'`,
      [userId, sosId],
    );
    await this.audit.emit({
      event_type: 'client.sos.cancel',
      user_id:    userId,
      device_id:  null,
      ip:         'client',
      outcome:    'success',
    });
  }

  /**
   * Audit fix 0.7 (round-trip) — read the lifecycle stamps so the
   * dashboard can wait for ops's ack before showing "Ops Room On
   * Standby" (instead of optimistically lying to the user).
   *
   * Scoped to the originating user — a row from someone else's panic
   * press returns 404 even with a valid JWT.
   */
  async status(userId: string, sosId: string): Promise<SosStatusDto> {
    const row = await this.db.qOne<{
      id:              string;
      status:          string;
      triggered_at:    Date;
      acknowledged_at: Date | null;
      acknowledged_by: string | null;
      escalated_at:    Date | null;
      resolved_at:     Date | null;
    }>(
      `SELECT id, status, triggered_at,
              acknowledged_at, acknowledged_by,
              escalated_at, resolved_at
         FROM public.sos_events
        WHERE id = $1 AND user_id = $2`,
      [sosId, userId],
    );
    if (!row) throw new NotFoundException('sos_not_found');
    return {
      id:              row.id,
      status:          row.status,
      triggered_at:    row.triggered_at.toISOString(),
      acknowledged_at: row.acknowledged_at?.toISOString() ?? null,
      acknowledged_by: row.acknowledged_by,
      escalated_at:    row.escalated_at?.toISOString() ?? null,
      resolved_at:     row.resolved_at?.toISOString() ?? null,
    };
  }
}
