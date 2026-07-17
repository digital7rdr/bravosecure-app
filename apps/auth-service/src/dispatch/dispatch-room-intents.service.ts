import {Injectable, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';

export interface DispatchRoomIntent {
  id: string;
  booking_id: string;
  conversation_id: string;
  member_user_id: string;
  action: 'add' | 'remove';
  created_at: string;
  // MISSION-GROUP (area 5) — the agency device bootstraps the Ops Room E2EE
  // group before applying adds; it needs the client (the room's initial
  // non-agency member) and the room title. The relay still holds no key.
  client_id: string;
  conversation_title: string | null;
}

/**
 * Dispatch-room membership-intent queue (BUILD_RUNBOOK Step 12) — the booking-Ops-Room
 * parallel of DepartmentService's channel-membership intents. The relay holds NO group
 * key: when an agency assigns/removes a CPO to a booking's Ops Room, the server records
 * the metadata + ENQUEUES an intent here; the AGENCY's device (the room creator/admin)
 * drains it and broadcasts the actual Signal rekey (planAddAndRekey / planRemoveAndRekey),
 * acking only after the rekey lands. This service writes/reads the queue only — it never
 * touches key material. Scoped by `org_user_id` (the agency) rather than channel-admin
 * membership, since the OrgManagerGuard already proves the caller owns that org.
 */
@Injectable()
export class DispatchRoomIntentsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Enqueue one add/remove intent for the agency to drain. Called (Step 13) from the
   * crew-assign handler — once per assigned/removed CPO. Pure INSERT; the agency device's
   * drain does the rekey. `orgUserId` is the agency that owns + must drain the room.
   */
  async enqueueRoomIntent(
    orgUserId: string,
    bookingId: string,
    conversationId: string,
    memberUserId: string,
    action: 'add' | 'remove',
    requestedBy: string,
  ): Promise<void> {
    // Idempotent enqueue: skip if an intent of the same (booking, member, action) is
    // already pending or done. Lets crew-assign safely RE-enqueue on a resume/retry
    // without minting a duplicate the agency device would loop on (an already-member
    // addGroupMember throws and never acks).
    await this.db.q(
      `INSERT INTO public.dispatch_room_intents
         (org_user_id, booking_id, conversation_id, member_user_id, action, requested_by)
       SELECT $1, $2, $3, $4, $5, $6
        WHERE NOT EXISTS (
          SELECT 1 FROM public.dispatch_room_intents
           WHERE booking_id = $2 AND member_user_id = $4 AND action = $5
             AND state IN ('pending', 'done'))`,
      [orgUserId, bookingId, conversationId, memberUserId, action, requestedBy],
    );
  }

  /** Pending room intents for the caller's agency, oldest first — drained by the
   *  agency device, which broadcasts the corresponding rekey. */
  async listRoomIntents(orgUserId: string): Promise<DispatchRoomIntent[]> {
    return this.db.q<DispatchRoomIntent>(
      `SELECT i.id, i.booking_id, i.conversation_id, i.member_user_id, i.action, i.created_at,
              b.client_id,
              c.title AS conversation_title
         FROM public.dispatch_room_intents i
         JOIN public.lite_bookings b ON b.id = i.booking_id
         LEFT JOIN public.conversations c ON c.id = i.conversation_id
        WHERE i.org_user_id = $1 AND i.state = 'pending'
        ORDER BY i.created_at ASC`,
      [orgUserId],
    );
  }

  /**
   * Agency device acks it has broadcast the rekey for an intent. Race-safe + IDOR-safe:
   * the conditional UPDATE fuses exactly-once (`state='pending'`) with the org-scope
   * authorization (`org_user_id=$2`) in one statement, so a second ack — or a cross-org
   * caller — matches 0 rows → an ambiguous 404 (never leaks whether the intent exists).
   */
  async ackRoomIntent(orgUserId: string, intentId: string): Promise<{ok: true}> {
    const row = await this.db.qOne<{id: string}>(
      `UPDATE public.dispatch_room_intents
          SET state = 'done', settled_at = NOW()
        WHERE id = $1 AND state = 'pending' AND org_user_id = $2
        RETURNING id`,
      [intentId, orgUserId],
    );
    if (!row) throw new NotFoundException('intent_not_found_or_not_org');
    return {ok: true};
  }
}
