import {Injectable, Logger} from '@nestjs/common';
import * as crypto from 'node:crypto';
import {RedisService} from '../redis/redis.service';
import {NotificationsService} from '../notifications/notifications.service';

/**
 * Cross-service bridge for booking + agent push notifications.
 *
 * Publishes opaque event correlation IDs on the shared Redis `push:events`
 * channel; messenger-service's PushService subscribes and ships ONLY the
 * opaque `eventClass` + `eventId` over FCM data. The mobile client uses
 * the opaque ID to pull encrypted event details via the JWT-gated
 * `/events/by-id/:eventId` route over the regular sealed-relay channel.
 *
 * P0-N8 — DO NOT add `bookingId`, `missionId`, the literal `kind` value,
 * or any user-identifying field to the published payload. FCM data fields
 * are cleartext between this server and the device; Google operates the
 * intermediary. Per-user real-time SOS / mission feeds would be visible.
 *
 * The event details (bookingId, missionId, kind specifics) are stored
 * Redis-side keyed by the opaque eventId with a short TTL (5min) and
 * fetched via the encrypted relay. That way:
 *   - FCM sees: `{eventClass: 'sos', eventId: <opaque>, userId: <opaque>}`
 *   - Encrypted body delivered via sealed-sender envelope carries the rest.
 *
 * Same pattern as MissionEventsService — fire-and-forget, never throws,
 * a missed delivery falls back to the mobile client's in-app polling.
 */
@Injectable()
export class BookingPushBridge {
  private readonly log = new Logger(BookingPushBridge.name);
  static readonly CHANNEL = 'push:events';

  /** Per-event payload TTL — long enough for a Doze-thaw retry, short
   *  enough that a leaked eventId from a stale FCM log is useless.
   *  N-27 — raised 300→900 so it exceeds the messenger-service FCM data TTL
   *  (10 min). At 300 a wake delivered in the 5–10 min window (still inside
   *  FCM's own validity) deterministically hydrated to a 404 and rendered
   *  NOTHING; the blob must outlive the push it backs. Still bounded (15 min). */
  private static readonly EVENT_TTL_SECONDS = 900;

  constructor(
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Publish a wake event. `details` are stored separately under
   * `push-event:<eventId>` (TTL 5min) and resolved via the encrypted
   * relay by the mobile client. The pub/sub payload carries ONLY the
   * opaque IDs and the coarse class label.
   *
   * `eventClass` IS visible to FCM/APNs and is intentionally coarse —
   * one bit per category at most. The cleartext SOS feed leak the
   * audit flagged comes from per-instance bookingId/missionId; the
   * class label alone is operationally necessary so the client can
   * route the wake to the right module without unwrapping first.
   */
  private async publish(
    userId: string,
    eventClass: 'agent' | 'booking' | 'mission' | 'payout' | 'sos' | 'dispatch' | 'incident',
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      const eventId = crypto.randomBytes(16).toString('base64url');
      // A2 — RECIPIENT-BIND the detail blob: key by `push-event:<userId>:
      // <eventId>` so the `GET /events/by-id/:eventId` hydration route can only
      // resolve it for the authenticated recipient (req.user.sub). A leaked
      // opaque eventId is then useless to any other account, on top of the
      // 5-min TTL. The wire payload below stays {userId, eventClass, eventId}.
      await this.redis.client.set(
        `push-event:${userId}:${eventId}`,
        JSON.stringify(details),
        'EX', BookingPushBridge.EVENT_TTL_SECONDS,
      );
      await this.redis.client.publish(
        BookingPushBridge.CHANNEL,
        JSON.stringify({userId, eventClass, eventId}),
      );
      // N-20 — also write a DURABLE inbox row so a device that misses the
      // transient FCM wake (dead token, Doze, reinstall, killed >TTL) can
      // still backfill it from GET /me/notifications, and the in-app bell can
      // stay in sync. Metadata-only, same shape as the Redis detail blob.
      await this.notifications.record(userId, {
        eventClass,
        kind:      typeof details.kind === 'string' ? details.kind : eventClass,
        bookingId: typeof details.bookingId === 'string' ? details.bookingId : null,
        missionId: typeof details.missionId === 'string' ? details.missionId : null,
      });
    } catch (e) {
      this.log.warn(`push publish failed class=${eventClass}: ${(e as Error).message}`);
    }
  }

  // ─── Client-side push ─────────────────────────────────────────────

  async bookingApproved(userId: string, bookingId: string, status = 'OPS_APPROVED'): Promise<void> {
    return this.publish(userId, 'booking', {kind: 'booking-approved', bookingId, status});
  }

  /** Auto-dispatch: wake an AGENCY that just received a job offer — render the
   *  incoming-offer card. The countdown still binds to the server `expires_at`. */
  async dispatchOffer(providerUserId: string, bookingId: string): Promise<void> {
    return this.publish(providerUserId, 'dispatch', {kind: 'dispatch-offer', bookingId});
  }

  /** Auto-dispatch: wake the CLIENT that an agency accepted their job. */
  async providerAccepted(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'provider-accepted', bookingId});
  }

  /** Auto-dispatch: wake the CLIENT that no agency was available (terminal). */
  async noProvider(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'no-provider', bookingId});
  }

  /** Auto-dispatch: wake the CLIENT that the accepting agency never crewed in time
   *  (crew-SLA breach). The escrow refund (Step 9) rides the same event. */
  async agencyNoShow(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'agency-no-show', bookingId});
  }

  /** Auto-dispatch (Step 16): wake the CLIENT that the assigned crew never arrived and
   *  the booking is being re-dispatched to another agency. The escrow hold is unchanged
   *  (the client is NOT re-charged) — this is a "reassigning your detail" reassurance. */
  async bookingReDispatching(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'booking-redispatching', bookingId});
  }

  /** LM-B7 — wake the CLIENT that their booking was cancelled because the escrow
   *  charge failed at accept-time (balance moved after the request-time soft-check).
   *  The client tops up and re-requests; the agency never learns why. */
  async paymentFailed(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'payment-failed', bookingId});
  }

  // ─── LM-N4 — previously-silent lifecycle transitions ──────────────

  /** Ops rejected the booking (was card-only — a backgrounded client never knew). */
  async bookingRejected(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'booking-rejected', bookingId});
  }

  /** The mission finished — wake the CLIENT to rate + view the receipt. */
  async bookingCompleted(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'booking-completed', bookingId});
  }

  /** The agency assigned a crew — wake the CLIENT ("your detail is being prepared"). */
  async crewAssigned(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'crew-assigned', bookingId});
  }

  /** LM-N4 — the lead started toward pickup (mission DISPATCHED→PICKUP). Wake the
   *  CLIENT ("your detail is en route") + deep-link into live tracking. The kind is
   *  `detail-*` (not `mission-*`) so it classifies as a CLIENT 'booking' event, not
   *  an agent 'mission' one (kindToActivityClass keys off the prefix). */
  async missionEnRoute(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'detail-enroute', bookingId});
  }

  /** LM-N4 — protection went live (mission PICKUP→LIVE). Wake the CLIENT
   *  ("protection is now active") + deep-link into live tracking. */
  async missionLive(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'detail-live', bookingId});
  }

  /** Credits were returned to the CLIENT's wallet on a path they didn't initiate
   *  (ops abort / dispute outcome) — the wallet must never change silently. */
  async refundIssued(clientUserId: string, bookingId: string, credits: number): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'refund-issued', bookingId, credits});
  }

  /** A dispute was opened on the booking — wake the AGENCY (its payout froze). */
  async disputeOpened(providerUserId: string, bookingId: string): Promise<void> {
    return this.publish(providerUserId, 'booking', {kind: 'dispute-opened', bookingId});
  }

  /** Ops resolved the dispute — wake a party with the outcome. */
  async disputeResolved(userId: string, bookingId: string, outcome: string): Promise<void> {
    return this.publish(userId, 'booking', {kind: 'dispute-resolved', bookingId, outcome});
  }

  // ─── Agent-side push ──────────────────────────────────────────────

  /** Agent's KYC decision settled (ACTIVE or REJECTED). */
  async agentDecided(userId: string, decision: 'APPROVED' | 'REJECTED'): Promise<void> {
    return this.publish(userId, 'agent', {kind: decision === 'APPROVED' ? 'agent-approved' : 'agent-rejected'});
  }

  /** Agent was picked for a dispatch — wake the device to render the mission card. */
  async missionDispatched(userId: string, missionId: string, bookingId: string): Promise<void> {
    return this.publish(userId, 'mission', {kind: 'mission-dispatched', missionId, bookingId});
  }

  /** Agent's mission was aborted by ops. */
  async missionAborted(userId: string, missionId: string, bookingId: string): Promise<void> {
    return this.publish(userId, 'mission', {kind: 'mission-aborted', missionId, bookingId});
  }

  /** LM-C7 — a crew member asked to close a mission (lead unreachable); wake the
   *  AGENCY manager to confirm from the missions board. */
  async missionCompleteRequested(providerUserId: string, missionId: string, bookingId: string): Promise<void> {
    return this.publish(providerUserId, 'mission', {kind: 'mission-complete-requested', missionId, bookingId});
  }

  /** Agent's wallet was credited on mission completion. */
  async payoutSettled(userId: string, bookingId: string, credits: number): Promise<void> {
    return this.publish(userId, 'payout', {kind: 'payout-settled', bookingId, credits});
  }

  /**
   * Fan-out for a CPO-raised SOS — wakes every other crew member on the
   * mission AND the principal so they see the alert even if no app
   * screen is mounted. The acker uses `OpsController.ackSos` to clear.
   *
   * P0-N8: previously published `{kind: 'sos-cpo-alert', missionId,
   * bookingId}` as the literal pub/sub payload — meaning FCM saw the
   * SOS class IN THE CLEAR per user in real time. Now publishes only
   * the opaque eventId + the coarse `eventClass: 'sos'`; the detail
   * blob lands behind the encrypted relay.
   */
  async sosAlert(userIds: readonly string[], missionId: string, bookingId: string): Promise<void> {
    for (const uid of userIds) {
      await this.publish(uid, 'sos', {kind: 'sos-cpo-alert', missionId, bookingId});
    }
  }

  // ─── Dept Chat v2 · incident push (Step 11) ───────────────────────────
  //
  // Metadata-only by construction: the FCM cleartext carries only the opaque
  // eventId + coarse 'incident' class. The ref/severity/status live in the
  // Redis detail blob fetched over the encrypted relay (P0-N8). The incident
  // description, coordinates, and photo are NEVER published.

  /** Wake the org manager(s) that a new incident was filed. */
  async incidentSubmitted(managerUserIds: readonly string[], ref: string | null, severity: string): Promise<void> {
    for (const uid of managerUserIds) {
      await this.publish(uid, 'incident', {kind: 'incident-submitted', ref, severity});
    }
  }

  /** Notify the submitter that their incident's status changed. */
  async incidentStatusChanged(submitterUserId: string, ref: string | null, status: string): Promise<void> {
    return this.publish(submitterUserId, 'incident', {kind: 'incident-status', ref, status});
  }
}
