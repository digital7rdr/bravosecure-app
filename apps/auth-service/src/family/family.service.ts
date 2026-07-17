import {BadRequestException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';

export interface FamilyMemberDto {
  id:           string;
  memberId:     string | null;
  name:         string;        // display name or the invited phone
  status:       'pending' | 'active' | 'revoked' | 'declined';
  spendLimit:   number | null;
  spent:        number;
  invitedAt:    string;
  acceptedAt:   string | null;
}

export interface FamilyInviteDto {
  id:         string;
  holderId:   string;
  holderName: string;
  invitedAt:  string;
}

const MAX_ACTIVE_MEMBERS = 4;

/**
 * Family hierarchy + shared credits.
 *
 * A holder invites members (by phone). Accepted members' bookings are
 * charged to the HOLDER's wallet — `resolvePayer()` is the single hook the
 * booking flow uses to redirect the debit. A per-member `spend_limit` caps
 * how much of the holder's credits a member may consume.
 */
@Injectable()
export class FamilyService {
  private readonly log = new Logger(FamilyService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Holder invites a phone. If it maps to a registered user, bind member_id; else pending-by-phone. */
  async invite(holderId: string, phoneE164: string, spendLimit?: number | null): Promise<{id: string; status: string}> {
    const phone = phoneE164.trim();
    if (!/^\+\d{6,15}$/.test(phone)) {throw new BadRequestException('invalid_phone');}

    // Resolve the phone to a user (if registered).
    const target = await this.db.qOne<{id: string; phone_e164: string | null}>(
      `SELECT id, phone_e164 FROM public.users WHERE phone_e164 = $1`,
      [phone],
    );
    if (target && target.id === holderId) {throw new BadRequestException('cannot_invite_self');}

    // Enforce max active members.
    const active = await this.db.qOne<{n: number}>(
      `SELECT COUNT(*)::int AS n FROM public.family_members WHERE holder_id = $1 AND status = 'active'`,
      [holderId],
    );
    if ((active?.n ?? 0) >= MAX_ACTIVE_MEMBERS) {throw new BadRequestException('family_full');}

    // If that user is already active in ANOTHER family, refuse.
    if (target) {
      const elsewhere = await this.db.qOne<{id: string}>(
        `SELECT id FROM public.family_members WHERE member_id = $1 AND status = 'active' AND holder_id <> $2`,
        [target.id, holderId],
      );
      if (elsewhere) {throw new BadRequestException('member_in_another_family');}
    }

    const row = await this.db.qOne<{id: string}>(
      `INSERT INTO public.family_members (holder_id, member_id, invite_phone, status, spend_limit_credits)
       VALUES ($1, $2, $3, 'pending', $4)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [holderId, target?.id ?? null, target ? null : phone, normalizeLimit(spendLimit)],
    );
    if (!row) {
      // Conflict = a pending invite for this holder+phone already exists.
      throw new BadRequestException('invite_already_pending');
    }
    return {id: row.id, status: 'pending'};
  }

  async listMembers(holderId: string): Promise<FamilyMemberDto[]> {
    const rows = await this.db.q<{
      id: string; member_id: string | null; invite_phone: string | null;
      status: string; spend_limit_credits: number | null; spent_credits: number;
      invited_at: Date; accepted_at: Date | null; display_name: string | null;
    }>(
      `SELECT fm.id, fm.member_id, fm.invite_phone, fm.status, fm.spend_limit_credits,
              fm.spent_credits, fm.invited_at, fm.accepted_at, u.display_name
         FROM public.family_members fm
         LEFT JOIN public.users u ON u.id = fm.member_id
        WHERE fm.holder_id = $1 AND fm.status IN ('pending','active')
        ORDER BY fm.invited_at DESC`,
      [holderId],
    );
    return rows.map(r => ({
      id: r.id,
      memberId: r.member_id,
      name: r.display_name ?? r.invite_phone ?? 'Invited member',
      status: r.status as FamilyMemberDto['status'],
      spendLimit: r.spend_limit_credits,
      spent: r.spent_credits,
      invitedAt: r.invited_at.toISOString(),
      acceptedAt: r.accepted_at?.toISOString() ?? null,
    }));
  }

  /** Invites awaiting THIS user's accept (by member_id or by their phone). */
  async invitesFor(userId: string): Promise<FamilyInviteDto[]> {
    const rows = await this.db.q<{id: string; holder_id: string; invited_at: Date; holder_name: string | null}>(
      `SELECT fm.id, fm.holder_id, fm.invited_at, h.display_name AS holder_name
         FROM public.family_members fm
         JOIN public.users h ON h.id = fm.holder_id
        WHERE fm.status = 'pending'
          AND (fm.member_id = $1
               OR fm.invite_phone = (SELECT phone_e164 FROM public.users WHERE id = $1))
        ORDER BY fm.invited_at DESC`,
      [userId],
    );
    return rows.map(r => ({
      id: r.id, holderId: r.holder_id, holderName: r.holder_name ?? 'A Bravo user',
      invitedAt: r.invited_at.toISOString(),
    }));
  }

  async accept(userId: string, inviteId: string): Promise<{ok: true}> {
    // Bind this user, but only if not already active elsewhere.
    const inElsewhere = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.family_members WHERE member_id = $1 AND status = 'active'`,
      [userId],
    );
    if (inElsewhere) {throw new BadRequestException('already_in_a_family');}

    const updated = await this.db.qOne<{id: string}>(
      `UPDATE public.family_members
          SET status = 'active', member_id = $1, accepted_at = NOW(), invite_phone = NULL
        WHERE id = $2 AND status = 'pending'
          AND (member_id = $1 OR invite_phone = (SELECT phone_e164 FROM public.users WHERE id = $1))
        RETURNING id`,
      [userId, inviteId],
    );
    if (!updated) {throw new NotFoundException('invite_not_found');}
    return {ok: true};
  }

  async decline(userId: string, inviteId: string): Promise<{ok: true}> {
    await this.db.q(
      `UPDATE public.family_members SET status = 'declined'
        WHERE id = $1 AND status = 'pending'
          AND (member_id = $2 OR invite_phone = (SELECT phone_e164 FROM public.users WHERE id = $2))`,
      [inviteId, userId],
    );
    return {ok: true};
  }

  async revoke(holderId: string, memberRowId: string): Promise<{ok: true}> {
    await this.db.q(
      `UPDATE public.family_members SET status = 'revoked' WHERE id = $1 AND holder_id = $2`,
      [memberRowId, holderId],
    );
    return {ok: true};
  }

  async setSpendLimit(holderId: string, memberRowId: string, limit: number | null): Promise<{ok: true}> {
    await this.db.q(
      `UPDATE public.family_members SET spend_limit_credits = $3 WHERE id = $1 AND holder_id = $2`,
      [memberRowId, holderId, normalizeLimit(limit)],
    );
    return {ok: true};
  }

  /** The family this user is an active member of (for their own UI). */
  async myMembership(userId: string): Promise<{holderId: string; holderName: string; spendLimit: number | null; spent: number} | null> {
    const row = await this.db.qOne<{holder_id: string; holder_name: string | null; spend_limit_credits: number | null; spent_credits: number}>(
      `SELECT fm.holder_id, h.display_name AS holder_name, fm.spend_limit_credits, fm.spent_credits
         FROM public.family_members fm
         JOIN public.users h ON h.id = fm.holder_id
        WHERE fm.member_id = $1 AND fm.status = 'active'`,
      [userId],
    );
    return row ? {holderId: row.holder_id, holderName: row.holder_name ?? 'Family', spendLimit: row.spend_limit_credits, spent: row.spent_credits} : null;
  }

  /**
   * BILLING HOOK — who pays for `userId`'s booking. Active family member →
   * the holder; everyone else → themselves (identity). Also returns the
   * active member-row so the caller can enforce the cap + bump `spent`.
   */
  async resolvePayer(userId: string): Promise<{payerId: string; familyRowId: string | null; spendLimit: number | null; spent: number}> {
    const row = await this.db.qOne<{id: string; holder_id: string; spend_limit_credits: number | null; spent_credits: number}>(
      `SELECT id, holder_id, spend_limit_credits, spent_credits
         FROM public.family_members WHERE member_id = $1 AND status = 'active'`,
      [userId],
    );
    if (!row) {return {payerId: userId, familyRowId: null, spendLimit: null, spent: 0};}
    return {payerId: row.holder_id, familyRowId: row.id, spendLimit: row.spend_limit_credits, spent: row.spent_credits};
  }

  /**
   * Credit-usage breakdown for the holder — a Claude-token-style view:
   * total family spend, per-member spend (+ cap + share %), and the recent
   * family-charged transactions from the wallet ledger.
   */
  async usage(holderId: string): Promise<{
    totalSpent: number;
    members: Array<{id: string; name: string; spent: number; spendLimit: number | null; sharePct: number}>;
    recent: Array<{name: string; credits: number; at: string; bookingId: string | null}>;
  }> {
    const members = await this.db.q<{
      id: string; member_id: string | null; invite_phone: string | null;
      spent_credits: number; spend_limit_credits: number | null; display_name: string | null;
    }>(
      `SELECT fm.id, fm.member_id, fm.invite_phone, fm.spent_credits, fm.spend_limit_credits, u.display_name
         FROM public.family_members fm
         LEFT JOIN public.users u ON u.id = fm.member_id
        WHERE fm.holder_id = $1 AND fm.status = 'active'`,
      [holderId],
    );
    const totalSpent = members.reduce((n, m) => n + (m.spent_credits || 0), 0);
    const memberOut = members.map(m => ({
      id: m.id,
      name: m.display_name ?? m.invite_phone ?? 'Member',
      spent: m.spent_credits,
      spendLimit: m.spend_limit_credits,
      sharePct: totalSpent > 0 ? Math.round((m.spent_credits / totalSpent) * 100) : 0,
    }));

    // Recent family-charged ledger rows on the holder's wallet. The booking
    // debit description tags family charges ('(family member)').
    const recent = await this.db.q<{amount_credits: number; created_at: Date; booking_id: string | null; description: string}>(
      `SELECT amount_credits, created_at, booking_id, description
         FROM wallet_transactions
        WHERE user_id = $1 AND type = 'payment' AND description LIKE '%(family member)%'
        ORDER BY created_at DESC LIMIT 20`,
      [holderId],
    );
    return {
      totalSpent,
      members: memberOut,
      recent: recent.map(r => ({
        name: 'Family member',
        credits: Math.abs(r.amount_credits),
        at: r.created_at.toISOString(),
        bookingId: r.booking_id,
      })),
    };
  }

  /** After a successful family-charged debit, bump the member's running spend. */
  async recordSpend(familyRowId: string, credits: number): Promise<void> {
    await this.db.q(
      `UPDATE public.family_members SET spent_credits = spent_credits + $2 WHERE id = $1`,
      [familyRowId, credits],
    );
  }

  /**
   * When a phone registers, attach any pending-by-phone invites to the new
   * user id (so they show up on that user's invites list). Called from the
   * registration flow.
   */
  async linkPendingInvitesByPhone(userId: string, phoneE164: string): Promise<void> {
    await this.db.q(
      `UPDATE public.family_members SET member_id = $1
        WHERE invite_phone = $2 AND status = 'pending' AND member_id IS NULL`,
      [userId, phoneE164],
    );
  }
}

function normalizeLimit(v: number | null | undefined): number | null {
  if (v === null || v === undefined) {return null;}
  if (!Number.isFinite(v) || v < 0) {return null;}
  return Math.floor(v);
}
