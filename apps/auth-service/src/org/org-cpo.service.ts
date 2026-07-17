import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {PasswordService} from '../common/services/password.service';
import {DepartmentService} from '../department/department.service';
import {AuthService} from '../auth/auth.service';
import {OrgAuditService} from './org-audit.service';
import {resolveAccountKind} from '../auth/account-kind';
import type {CreateManagedCpoDto, OrgMemberRole} from './dto/org.dto';

// Seed sets mirrored from AgentService.create() so a managed CPO lands in the
// SAME ops review console as a self-registered one. Kept in sync deliberately;
// if AgentService's seed changes, change here too.
const KYC_KINDS = ['gov_id', 'proof_address', 'sia_licence', 'police'] as const;
const REVIEW_STEPS = ['submit', 'docs', 'kyc', 'ops', 'partner'] as const;
const DEPLOYMENT_CHECKS = ['dress', 'vehicle', 'equip', 'briefing'] as const;
const DOC_SEED: {slot: string; required: boolean; title: string}[] = [
  {slot: 'sia',       required: true,  title: 'Security License / CPO Profile'},
  {slot: 'passport',  required: true,  title: 'Passport / National ID'},
  {slot: 'insurance', required: true,  title: 'Professional Indemnity Insurance'},
  {slot: 'dbs',       required: true,  title: 'Police Clearance / DBS Enhanced'},
  {slot: 'firstaid',  required: false, title: 'First Aid Certificate'},
  {slot: 'cv',        required: false, title: 'Professional CV / Résumé'},
];

export interface RosterMember {
  member_user_id: string;
  display_name: string | null;
  email: string | null;
  call_sign: string | null;
  // 'employee' (M1A rule 16) rides alongside the provider roles; the
  // promote/demote DTO deliberately stays cpo|manager only.
  member_role: OrgMemberRole | 'employee';
  status: string;
  agent_status: string | null;
  missions_completed: number;
  created_at: Date;
  // LM-A4/F11 — authoritative availability signals for the assign sheet + roster.
  on_duty: boolean;
  on_mission: boolean;
  armed_authorized: boolean;
}

@Injectable()
export class OrgCpoService {
  private readonly log = new Logger(OrgCpoService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly password: PasswordService,
    private readonly department: DepartmentService,
    private readonly auth: AuthService,
    private readonly audit: OrgAuditService,
  ) {}

  // Add a member to (or remove from) every channel the org owns. Enqueues a
  // rekey intent per channel via DepartmentService — the org account is the
  // channel admin, so it is authorized. Best-effort: chat sync must not break
  // roster mutations.
  private async syncMemberToOrgChannels(
    orgUserId: string, memberUserId: string, action: 'add' | 'remove', role?: 'admin' | 'viewer',
  ): Promise<void> {
    // For an add, resolve the member's org role when the caller didn't pass it
    // (e.g. reinstatement) so a manager rejoins EVERY channel while a CPO is
    // confined to OPEN (standard/read_only) channels — a normal CPO must never
    // be auto-seeded into a restricted/incident managers-only channel (Step 18).
    let channelRole: 'admin' | 'viewer' = role ?? 'viewer';
    let memberRole: string | undefined;
    if (action === 'add') {
      const m = await this.db.qOne<{member_role: string}>(
        `SELECT member_role FROM org_members WHERE org_user_id = $1 AND member_user_id = $2`,
        [orgUserId, memberUserId],
      );
      memberRole = m?.member_role;
      if (role === undefined) {
        channelRole = memberRole === 'manager' ? 'admin' : 'viewer';
      }
    }
    const cpoAdd = action === 'add' && channelRole !== 'admin';

    const channels = await this.db.q<{id: string}>(
      cpoAdd
        // Mirror department.service seedChannelMembers' managers-only rule
        // (access='restricted' OR channel_type='incident') so a normal CPO is
        // never auto-joined into a managers-only channel — incl. an incident
        // channel left at the default 'standard' access.
        ? `SELECT id FROM public.department_channels
             WHERE org_id = $1 AND archived_at IS NULL
               AND access IN ('standard', 'read_only')
               AND channel_type <> 'incident'`
        : `SELECT id FROM public.department_channels
             WHERE org_id = $1 AND archived_at IS NULL`,
      [orgUserId],
    );
    for (const ch of channels) {
      try {
        if (action === 'add') {
          // Label mirrors the ORG role: providers' CPOs read "CPO" exactly as
          // before (rule 7); enterprise-workspace employees read "Employee".
          const label = channelRole === 'admin' ? 'Manager'
            : memberRole === 'employee' ? 'Employee' : 'CPO';
          await this.department.addMember(orgUserId, ch.id, memberUserId, channelRole, label);
        } else {
          await this.department.removeMember(orgUserId, ch.id, memberUserId);
        }
      } catch (e) {
        this.log.warn(`channel ${action} failed for ${memberUserId} on ${ch.id}: ${(e as Error).message}`);
      }
    }
  }

  // ─── M1A rule 16 — enroll an EXISTING user as an org EMPLOYEE ────────
  // The messenger-workspace membership (dept channels / attendance / incident
  // reporting) for Enterprise individuals and provider back-office staff.
  // STRICTLY additive to the provider CPO machinery: no sub-account is
  // minted, deriveAccountKind ignores 'employee' (the member keeps their own
  // app shell), and every mission/crew query filters member_role='cpo', so
  // an employee can never be deployed. Providers' CPO flows are untouched.
  async addEmployee(orgUserId: string, emailOrPhone: string, actorId?: string): Promise<RosterMember> {
    const needle = emailOrPhone.trim();
    const target = await this.db.qOne<{id: string; display_name: string | null; email: string | null}>(
      `SELECT id, display_name, email FROM public.users
        WHERE (LOWER(email) = LOWER($1) OR phone_e164 = $1) AND deleted_at IS NULL`,
      [needle],
    );
    if (!target) throw new NotFoundException('user_not_found');
    if (target.id === orgUserId) throw new BadRequestException('cannot_enroll_yourself');

    // An employee must be a PLAIN INDIVIDUAL. A service-provider agent (its own
    // company / managed CPO / agency manager) already lives in a provider org
    // with its own app shell and roster — enrolling it as an employee would
    // collide two org identities. resolveAccountKind is the same discriminator
    // §35A routes on, so this rejects exactly the accounts that aren't clients.
    const {account_kind} = await resolveAccountKind(this.db, target.id);
    if (account_kind !== 'individual') {
      throw new BadRequestException('provider_account_cannot_be_employee');
    }

    const existing = await this.db.qOne<{member_role: string; status: string}>(
      `SELECT member_role, status FROM org_members
        WHERE org_user_id = $1 AND member_user_id = $2`,
      [orgUserId, target.id],
    );
    if (existing?.status === 'active') {
      throw new BadRequestException('already_a_member');
    }
    if (existing) {
      // Re-enroll a removed/suspended row — as an employee ONLY when it was
      // one; a provider's suspended CPO must be reinstated via the roster
      // (status endpoint), not silently re-typed by the employee flow.
      if (existing.member_role !== 'employee') {
        throw new BadRequestException('member_exists_use_roster_status');
      }
      await this.db.q(
        `UPDATE org_members SET status = 'active'
          WHERE org_user_id = $1 AND member_user_id = $2`,
        [orgUserId, target.id],
      );
    } else {
      await this.db.q(
        `INSERT INTO org_members (org_user_id, member_user_id, member_role, status, invited_by)
         VALUES ($1, $2, 'employee', 'active', $3)`,
        [orgUserId, target.id, actorId ?? orgUserId],
      );
    }

    await this.audit.log(orgUserId, actorId ?? orgUserId, 'member.add', {
      targetKind: 'user', targetId: target.id,
      metadata: {member_role: 'employee', via: 'employee_enroll'},
    }).catch(() => undefined);

    // Seed the new employee into the org's OPEN auto-membership channels the
    // same way managed CPOs are (viewer role; never restricted/incident
    // channels). Best-effort; channel rekey is eventually consistent.
    await this.syncMemberToOrgChannels(orgUserId, target.id, 'add', 'viewer').catch(e =>
      this.log.warn(`employee channel seed failed for ${target.id}: ${(e as Error).message}`),
    );

    const roster = await this.listRoster(orgUserId);
    const row = roster.find(r => r.member_user_id === target.id);
    if (!row) throw new NotFoundException('member_not_found_after_enroll');
    return row;
  }

  // ─── Create a managed CPO sub-account (one transaction) ──────────────
  // Inserts: users (login) + agents (type='cpo', managed_by_org_id=org,
  // status='DOCS_PENDING') + the agent seed rows + org_members. The CPO is a
  // real user that logs in via the normal auth flow; authorization as "belongs
  // to org X" is derived from org_members, never from the token.
  async createManagedCpo(orgUserId: string, dto: CreateManagedCpoDto, actorId?: string): Promise<RosterMember> {
    const existing = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.users
        WHERE (email = $1 OR phone_e164 = $2) AND deleted_at IS NULL`,
      [dto.email, dto.phone_e164],
    );
    if (existing) {
      throw new ConflictException('user_already_exists');
    }

    const pwHash = await this.password.hash(dto.temp_password);
    const role = dto.member_role ?? 'cpo';

    let result;
    try {
      result = await this.runCreateManagedCpoTxn(orgUserId, dto, pwHash, role);
    } catch (e) {
      // Step 23 — the soft SELECT above is a courtesy check, not a lock: two agencies
      // racing the same email both pass it, then collide on users.email (citext UNIQUE)
      // or org_members_one_active_agency. Catch the 23505 and surface the same clean
      // 409 instead of leaking a raw constraint error / a half-applied state.
      if ((e as {code?: string}).code === '23505') {
        throw new ConflictException('user_already_exists');
      }
      throw e;
    }

    // RS-11 — first member.* action in org_audit_log: who added whom, with what
    // role. Best-effort: the roster insert already committed.
    await this.audit.log(orgUserId, actorId ?? orgUserId, 'member.add', {
      targetKind: 'user', targetId: result.member_user_id,
      metadata: {member_role: role},
    }).catch(() => {});

    // Post-commit: add the new CPO to the org's existing chat channels (if any
    // have been seeded). The admin device will rekey-on-add via the intent.
    await this.syncMemberToOrgChannels(
      orgUserId, result.member_user_id, 'add', role === 'manager' ? 'admin' : 'viewer',
    );
    return result;
  }

  private async runCreateManagedCpoTxn(
    orgUserId: string, dto: CreateManagedCpoDto, pwHash: string, role: 'cpo' | 'manager',
  ): Promise<RosterMember> {
    return this.db.withTransaction(async (tx) => {
      // Why: the INSERT deliberately omits password_set_at — leaving it NULL
      // marks the managed CPO as still on the agency-issued temp password
      // (must_set_password=true) until they complete POST /auth/me/password.
      const inserted = await tx.qOne<{id: string}>(
        `INSERT INTO public.users
           (id, email, phone_e164, display_name, role, subscription_tier,
            password_hash, kyc_status)
         VALUES (gen_random_uuid(), $1, $2, $3, 'agent', 'lite', $4, 'pending')
         RETURNING id`,
        [dto.email, dto.phone_e164, dto.display_name, pwHash],
      );
      if (!inserted) throw new BadRequestException('failed_to_create_user');
      const cpoUserId = inserted.id;

      // agents row — owned by the org, skips the self-serve profile wizard
      // (the org supplies identity), starts at DOCS_PENDING for ops review.
      await tx.q(
        `INSERT INTO agents (user_id, type, status, display_name, call_sign, managed_by_org_id)
         VALUES ($1, 'cpo', 'DOCS_PENDING', $2, $3, $4)`,
        [cpoUserId, dto.display_name, dto.call_sign ?? null, orgUserId],
      );
      // Inherit the ORG's coverage (countries + services). A managed CPO never
      // walks the coverage wizard, and mirrorAgentToPool refuses to mirror an
      // agent with no coverage country — without this they'd stay invisible to
      // the dispatch picker forever.
      await tx.q(
        `INSERT INTO agent_profiles (user_id, coverage)
         VALUES ($1, COALESCE(
           (SELECT op.coverage FROM agent_profiles op WHERE op.user_id = $2),
           '{"countries": [], "services": []}'::jsonb
         ))
         ON CONFLICT DO NOTHING`,
        [cpoUserId, orgUserId],
      );

      for (const kind of KYC_KINDS) {
        await tx.q(
          `INSERT INTO agent_kyc_checks (user_id, kind, state)
           VALUES ($1, $2, 'queued') ON CONFLICT DO NOTHING`,
          [cpoUserId, kind],
        );
      }
      for (const d of DOC_SEED) {
        await tx.q(
          `INSERT INTO agent_documents (user_id, slot, required, title, state)
           VALUES ($1, $2, $3, $4, 'upload') ON CONFLICT (user_id, slot) DO NOTHING`,
          [cpoUserId, d.slot, d.required, d.title],
        );
      }
      for (const step of REVIEW_STEPS) {
        await tx.q(
          `INSERT INTO agent_review_pipeline (user_id, step, state)
           VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING`,
          [cpoUserId, step],
        );
      }
      for (const key of DEPLOYMENT_CHECKS) {
        await tx.q(
          `INSERT INTO agent_deployment_checks (user_id, check_key, state)
           VALUES ($1, $2, 'pending') ON CONFLICT DO NOTHING`,
          [cpoUserId, key],
        );
      }

      await tx.q(
        `INSERT INTO org_members
           (org_user_id, member_user_id, member_role, call_sign, status, invited_by)
         VALUES ($1, $2, $3, $4, 'active', $1)`,
        [orgUserId, cpoUserId, role, dto.call_sign ?? null],
      );

      await tx.q(
        `INSERT INTO agent_audit (user_id, from_status, to_status, actor_id, actor_role, metadata)
         VALUES ($1, NULL, 'DOCS_PENDING', $2, 'OPS', $3::jsonb)`,
        [cpoUserId, orgUserId, JSON.stringify({reason: 'managed_cpo_created', org: orgUserId})],
      );

      return {
        member_user_id: cpoUserId,
        display_name: dto.display_name,
        email: dto.email,
        call_sign: dto.call_sign ?? null,
        member_role: role,
        status: 'active',
        agent_status: 'DOCS_PENDING',
        missions_completed: 0,
        created_at: new Date(),
        // LM-A4/F11 — a freshly-minted account is off-duty, unassigned, unarmed.
        on_duty: false,
        on_mission: false,
        armed_authorized: false,
      };
    });
  }

  // ─── Roster read ────────────────────────────────────────────────────
  // LM-A4/F11 — the assign sheet previously guessed availability from the org's
  // OWN active missions only, so a guard who was off-duty, on ANOTHER org's
  // mission, or without an armed authorization showed as pickable and only the
  // server 409 revealed the truth. Surface the authoritative signals per row:
  // on_duty (agents), active_mission (any org, via the active-unique semantics),
  // armed_authorized (valid regional authorization).
  async listRoster(orgUserId: string): Promise<RosterMember[]> {
    return this.db.q<RosterMember>(
      `SELECT om.member_user_id, u.display_name, u.email, om.call_sign,
              om.member_role, om.status, a.status AS agent_status,
              COALESCE(mc_cnt.completed, 0)::int AS missions_completed,
              om.created_at,
              COALESCE(a.on_duty, FALSE) AS on_duty,
              EXISTS (
                SELECT 1 FROM mission_crew mc2
                  JOIN missions m2 ON m2.id = mc2.mission_id
                 WHERE mc2.agent_id = om.member_user_id AND mc2.status <> 'off'
                   AND m2.status NOT IN ('COMPLETED', 'ABORTED')
              ) AS on_mission,
              EXISTS (
                SELECT 1 FROM armed_authorizations aa
                 WHERE aa.cpo_user_id = om.member_user_id
                   AND aa.authorized AND (aa.expires_at IS NULL OR aa.expires_at > NOW())
              ) AS armed_authorized
         FROM org_members om
         JOIN public.users u ON u.id = om.member_user_id
         LEFT JOIN agents a ON a.user_id = om.member_user_id
         LEFT JOIN (
           SELECT mc.agent_id, count(DISTINCT mc.mission_id) AS completed
             FROM mission_crew mc
             JOIN missions m ON m.id = mc.mission_id AND m.status = 'COMPLETED'
             JOIN lite_bookings b ON b.id = m.booking_id
            WHERE b.assigned_provider_user_id = $1
            GROUP BY mc.agent_id
         ) mc_cnt ON mc_cnt.agent_id = om.member_user_id
        WHERE om.org_user_id = $1
        ORDER BY om.created_at DESC`,
      [orgUserId],
    );
  }

  /**
   * MISSION-HISTORY (#3) — a roster CPO's completed/aborted-mission call-log,
   * ORG-SCOPED so a manager only ever sees missions THEIR agency owned. The
   * org_members membership check is the IDOR gate; `b.assigned_provider_user_id = $1`
   * keeps every returned row inside this org. Mirrors AgentService.getMyMissionHistory
   * but adds the tenancy predicate (and omits deduction detail — finance gate).
   */
  async listMemberMissionHistory(orgUserId: string, memberUserId: string, limit = 50): Promise<Array<{
    mission_id: string; booking_id: string; short_code: string; status: string;
    role: string; is_lead: boolean; started_at: string | null; ended_at: string | null;
    route_distance_m: number | null; route_duration_s: number | null;
    pickup_address: string; dropoff_address: string | null; region_label: string | null;
    paid_credits: number | null;
  }>> {
    const ok = await this.db.qOne<{ok: number}>(
      `SELECT 1 AS ok FROM org_members WHERE org_user_id = $1 AND member_user_id = $2`,
      [orgUserId, memberUserId],
    );
    if (!ok) {throw new ForbiddenException('not_your_org_member');}
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const rows = await this.db.q<{
      mission_id: string; booking_id: string; short_code: string; status: string;
      role: string; is_lead: boolean; started_at: string | null; ended_at: string | null;
      route_distance_m: number | null; route_duration_s: number | null;
      pickup_address: string; dropoff_address: string | null; region_label: string | null;
      paid_credits: number | null;
    }>(
      `SELECT m.id AS mission_id, m.booking_id, m.short_code, m.status,
              mc.role, mc.is_lead, m.started_at, m.ended_at,
              m.route_distance_m, m.route_duration_s,
              b.pickup_address, b.dropoff_address, b.region_label,
              mp.paid_credits
         FROM mission_crew mc
         JOIN missions m       ON m.id = mc.mission_id
         JOIN lite_bookings b  ON b.id = m.booking_id
         LEFT JOIN mission_payouts mp
                ON mp.mission_id = m.id AND mp.agent_user_id = mc.agent_id
        WHERE mc.agent_id = $2
          AND b.assigned_provider_user_id = $1
          AND m.status IN ('COMPLETED','ABORTED')
        ORDER BY m.ended_at DESC NULLS LAST, m.started_at DESC
        LIMIT $3`,
      [orgUserId, memberUserId, safeLimit],
    );
    return rows.map(r => ({
      mission_id: r.mission_id, booking_id: r.booking_id, short_code: r.short_code,
      status: r.status, role: r.role, is_lead: r.is_lead,
      started_at: r.started_at, ended_at: r.ended_at,
      route_distance_m: r.route_distance_m, route_duration_s: r.route_duration_s,
      pickup_address: r.pickup_address, dropoff_address: r.dropoff_address,
      region_label: r.region_label,
      paid_credits: r.paid_credits === null ? null : Number(r.paid_credits),
    }));
  }

  /**
   * Step 20 — capacity summary for the agency dashboard "X of Y guards free" strip.
   * free = active roster CPOs − CPOs on a non-terminal mission − seats reserved by
   * accepted-but-not-yet-crewed (CONFIRMED, no mission) bookings. Mirrors the
   * has_free_cpo_capacity() SQL fn (Step 6) so the strip and the matchmaker agree.
   */
  async getCapacity(orgUserId: string): Promise<{
    guards_total: number; guards_free: number; guards_on_duty: number; active_missions: number;
  }> {
    const row = await this.db.qOne<{total: string; busy: string; reserved: string; on_duty: string; active: string}>(
      `SELECT
         (SELECT count(*) FROM org_members om
           WHERE om.org_user_id = $1 AND om.member_role = 'cpo' AND om.status = 'active')::text AS total,
         COALESCE((SELECT count(DISTINCT mc.agent_id)
            FROM mission_crew mc
            JOIN missions m ON m.id = mc.mission_id
            JOIN lite_bookings b ON b.id = m.booking_id
           WHERE b.assigned_provider_user_id = $1 AND m.status NOT IN ('COMPLETED','ABORTED')), 0)::text AS busy,
         COALESCE((SELECT sum(b.cpo_count)
            FROM lite_bookings b
           WHERE b.assigned_provider_user_id = $1 AND b.status = 'CONFIRMED'
             AND NOT EXISTS (SELECT 1 FROM missions m WHERE m.booking_id = b.id)), 0)::text AS reserved,
         COALESCE((SELECT count(*)
            FROM org_members om JOIN agents a ON a.user_id = om.member_user_id
           WHERE om.org_user_id = $1 AND om.member_role = 'cpo' AND om.status = 'active' AND a.on_duty), 0)::text AS on_duty,
         COALESCE((SELECT count(*)
            FROM missions m JOIN lite_bookings b ON b.id = m.booking_id
           WHERE b.assigned_provider_user_id = $1 AND m.status NOT IN ('COMPLETED','ABORTED')), 0)::text AS active`,
      [orgUserId],
    );
    const total = Number(row?.total ?? 0);
    const free = total - Number(row?.busy ?? 0) - Number(row?.reserved ?? 0);
    return {
      guards_total: total,
      guards_free: Math.max(0, free),
      guards_on_duty: Number(row?.on_duty ?? 0),
      active_missions: Number(row?.active ?? 0),
    };
  }

  // ─── Apply to a job AS THE ORG, naming a deployed CPO ───────────────
  // The org is the applicant + payee (agent_id = applicant_org_id = org);
  // the named CPO is the deployed officer (assigned_cpo_user_id). One
  // application per org per job via the UNIQUE(job_id, agent_id) constraint.
  async applyAsOrg(
    orgUserId: string, jobId: string,
    args: {cpoUserId: string; dressPledge: string},
  ): Promise<{id: string; status: string; assigned_cpo_user_id: string}> {
    const pledge = (args.dressPledge ?? '').trim();
    if (pledge.length < 4) throw new BadRequestException('dress_pledge_required');

    // The named CPO must be an ACTIVE member of THIS org (tenant isolation +
    // can't deploy a suspended/removed officer).
    const member = await this.db.qOne<{call_sign: string | null; status: string}>(
      `SELECT om.call_sign, a.status
         FROM org_members om
         LEFT JOIN agents a ON a.user_id = om.member_user_id
        WHERE om.org_user_id = $1 AND om.member_user_id = $2 AND om.status = 'active'`,
      [orgUserId, args.cpoUserId],
    );
    if (!member) throw new BadRequestException('cpo_not_active_member_of_org');
    if (member.status !== 'ACTIVE' && member.status !== 'APPROVED') {
      throw new BadRequestException('cpo_not_approved_for_deployment');
    }

    const job = await this.db.qOne<{status: string}>(
      `SELECT status FROM jobs WHERE id = $1`, [jobId],
    );
    if (!job) throw new BadRequestException('job_not_found');
    if (job.status !== 'PUBLISHED') throw new BadRequestException('job_not_open');

    const callSign = member.call_sign?.trim() || `ORG-${orgUserId.slice(0, 4).toUpperCase()}`;

    const row = await this.db.qOne<{id: string; status: string; assigned_cpo_user_id: string}>(
      `INSERT INTO job_applications
         (job_id, agent_id, agent_call_sign, status, dress_pledge, dress_pledged_at,
          applicant_org_id, assigned_cpo_user_id)
       VALUES ($1, $2, $3, 'PENDING', $4, NOW(), $2, $5)
       ON CONFLICT (job_id, agent_id) DO UPDATE
         SET dress_pledge         = EXCLUDED.dress_pledge,
             dress_pledged_at     = EXCLUDED.dress_pledged_at,
             assigned_cpo_user_id = EXCLUDED.assigned_cpo_user_id,
             agent_call_sign      = EXCLUDED.agent_call_sign
       RETURNING id, status, assigned_cpo_user_id`,
      [jobId, orgUserId, callSign, pledge, args.cpoUserId],
    );
    if (!row) throw new BadRequestException('apply_failed');
    return row;
  }

  // ─── Suspend / reinstate / remove a roster member ───────────────────
  async setMemberStatus(
    orgUserId: string, memberUserId: string,
    status: 'active' | 'suspended' | 'removed',
    actorId?: string,
  ): Promise<void> {
    const row = await this.db.qOne<{org_user_id: string}>(
      `UPDATE org_members SET status = $3
        WHERE org_user_id = $1 AND member_user_id = $2
        RETURNING org_user_id`,
      [orgUserId, memberUserId, status],
    );
    if (!row) throw new BadRequestException('member_not_found_in_org');

    // RS-11 — roster status changes were previously unaudited.
    await this.audit.log(orgUserId, actorId ?? orgUserId, 'member.status', {
      targetKind: 'user', targetId: memberUserId,
      metadata: {status},
    }).catch(() => {});

    // Suspending or removing a CPO must pull them from the org's chat channels
    // AND trigger the remove+rekey (security stop-condition: a removed member
    // keeps the old master key until the rekey broadcasts). Reinstating re-adds.
    if (status === 'suspended' || status === 'removed') {
      // RS-01 — eject the CPO's live sessions the same way DC-04 admin-suspend
      // does (Redis JTI revoke + auth_devices + push revoke), so a suspended/
      // removed CPO can't ride an unexpired access token into /agents/* or the
      // messenger relay. CpoSessionGuard re-reads the DB per request as the
      // second line of defence; this closes the JTI-only surfaces.
      await this.auth.revokeAllUserSessions(memberUserId);
      await this.syncMemberToOrgChannels(orgUserId, memberUserId, 'remove');
    } else if (status === 'active') {
      await this.syncMemberToOrgChannels(orgUserId, memberUserId, 'add');
    }
  }

  // ─── Promote / demote a roster member (RS-10: cpo ⇄ manager) ────────
  // OWNER-only (the company account itself, not a delegated manager): a
  // manager being able to mint or unmake other managers is the exact
  // privilege-escalation seam the role audit flagged. The channel side-effects
  // are the whole point — a raw member_role flip would silently leave the
  // member's channel access (and group keys) wrong:
  //   promote: join every channel (incl. restricted/incident) as channel
  //            admin — key distribution happens via the existing add intents;
  //   demote:  REMOVE from restricted/incident channels (remove+rekey intents
  //            revoke the group key — the security-critical direction) and
  //            downgrade open-channel role to viewer (metadata-only, they
  //            legitimately keep those keys).
  async setMemberRole(
    orgUserId: string, memberUserId: string, newRole: OrgMemberRole, actorId: string,
  ): Promise<{member_role: OrgMemberRole}> {
    if (actorId !== orgUserId) {
      throw new ForbiddenException('only_org_owner_can_change_roles');
    }
    const member = await this.db.qOne<{member_role: OrgMemberRole; status: string}>(
      `SELECT member_role, status FROM org_members
        WHERE org_user_id = $1 AND member_user_id = $2`,
      [orgUserId, memberUserId],
    );
    if (!member) throw new BadRequestException('member_not_found_in_org');
    if (member.status !== 'active') throw new BadRequestException('member_not_active');
    if (member.member_role === newRole) return {member_role: newRole};

    await this.db.q(
      `UPDATE org_members SET member_role = $3
        WHERE org_user_id = $1 AND member_user_id = $2`,
      [orgUserId, memberUserId, newRole],
    );

    await this.audit.log(orgUserId, actorId, 'member.role', {
      targetKind: 'user', targetId: memberUserId,
      metadata: {from: member.member_role, to: newRole},
    }).catch(() => {});

    if (newRole === 'manager') {
      // Upserts channel admin on ALL org channels + enqueues add intents.
      // Channels the member already belongs to ack idempotently on drain.
      await this.syncMemberToOrgChannels(orgUserId, memberUserId, 'add', 'admin');
    } else {
      await this.demoteMemberChannels(orgUserId, memberUserId);
    }
    return {member_role: newRole};
  }

  // Demotion channel sweep. Best-effort per channel (mirrors
  // syncMemberToOrgChannels): a single channel failure must not abort the
  // roster change — the remaining channels still get their intents.
  private async demoteMemberChannels(orgUserId: string, memberUserId: string): Promise<void> {
    const channels = await this.db.q<{id: string; managers_only: boolean}>(
      `SELECT id,
              (access = 'restricted' OR channel_type = 'incident') AS managers_only
         FROM public.department_channels
        WHERE org_id = $1 AND archived_at IS NULL`,
      [orgUserId],
    );
    for (const ch of channels) {
      try {
        if (ch.managers_only) {
          await this.department.removeMember(orgUserId, ch.id, memberUserId);
        } else {
          await this.department.updateMemberRole(orgUserId, ch.id, memberUserId, 'viewer', 'CPO');
        }
      } catch (e) {
        // not_a_channel_member / member_not_found are fine — nothing to demote.
        this.log.warn(`demote sweep failed for ${memberUserId} on ${ch.id}: ${(e as Error).message}`);
      }
    }
  }
}
