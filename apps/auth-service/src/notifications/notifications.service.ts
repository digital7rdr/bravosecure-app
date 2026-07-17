import {Injectable, Logger} from '@nestjs/common';
import type {QueryResultRow} from 'pg';
import {DatabaseService} from '../database/database.service';

/**
 * N-20 — durable per-user notification inbox.
 *
 * Before this, every server-driven wake (booking / dispatch / mission / payout /
 * SOS / incident) lived ONLY as a 5-min Redis detail blob + a fire-and-forget
 * FCM wake. Any device that missed the wake (dead/absent push token, Doze,
 * reinstall, app killed >5 min) lost the event permanently, and no client
 * surface could ever backfill or reconcile — so the in-app "bell" could never
 * stay in sync. This table is the durable record written at the single
 * BookingPushBridge fan-out point, read by the mobile ActivityCenter (and,
 * later, the ops console) so both surfaces share ONE source of truth.
 *
 * Metadata-only (P0-N8): we store the coarse class + kind + optional
 * booking/mission ids — the SAME shape the JWT-gated Redis detail blob already
 * carried — never a message body, description, coordinates, or key. Retrieval
 * is JWT-gated and scoped to the recipient (user_id = req.user.sub).
 */

const UUID_RE = /^[0-9a-fA-F-]{32,36}$/;

export interface NotificationRow extends QueryResultRow {
  id:          string;
  event_class: string;
  kind:        string;
  booking_id:  string | null;
  mission_id:  string | null;
  created_at:  Date | string;
  read_at:     Date | string | null;
}

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);
  constructor(private readonly db: DatabaseService) {}

  /**
   * Record a notification row. Fire-and-forget by contract — a DB hiccup
   * (or a not-yet-migrated table) must never break the push fan-out it rides
   * alongside, so this swallows errors after logging.
   */
  async record(
    userId: string,
    n: {eventClass: string; kind: string; bookingId?: string | null; missionId?: string | null},
  ): Promise<void> {
    if (!userId || !n.kind) {return;}
    try {
      await this.db.q(
        `INSERT INTO public.notifications (user_id, event_class, kind, booking_id, mission_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, n.eventClass, n.kind, n.bookingId ?? null, n.missionId ?? null],
      );
    } catch (e) {
      this.log.warn(`notification record failed kind=${n.kind}: ${(e as Error).message}`);
    }
  }

  /** Recent notifications for a user, newest first. `sinceIso` enables an
   *  incremental foreground sync (only rows newer than the client's watermark). */
  async list(userId: string, opts: {sinceIso?: string; limit?: number} = {}): Promise<NotificationRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const params: unknown[] = [userId];
    let where = 'user_id = $1';
    if (opts.sinceIso) {
      params.push(opts.sinceIso);
      where += ` AND created_at > $${params.length}`;
    }
    params.push(limit);
    try {
      return await this.db.q<NotificationRow>(
        `SELECT id, event_class, kind, booking_id, mission_id, created_at, read_at
           FROM public.notifications
          WHERE ${where}
          ORDER BY created_at DESC
          LIMIT $${params.length}`,
        params,
      );
    } catch (e) {
      this.log.warn(`notification list failed sub=${userId}: ${(e as Error).message}`);
      return [];
    }
  }

  async markRead(userId: string, ids: string[]): Promise<void> {
    const clean = ids.filter(id => typeof id === 'string' && UUID_RE.test(id)).slice(0, 500);
    if (clean.length === 0) {return;}
    await this.db.q(
      `UPDATE public.notifications SET read_at = now()
        WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL`,
      [userId, clean],
    );
  }

  async markAllRead(userId: string): Promise<void> {
    await this.db.q(
      `UPDATE public.notifications SET read_at = now()
        WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
  }
}
