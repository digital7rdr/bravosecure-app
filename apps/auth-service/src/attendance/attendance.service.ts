import {BadRequestException, Injectable, NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';

// Closed sets shared by the schema CHECK constraints (20260629000000) and the
// service derivation logic, so a typo can't drift between SQL and TS.
export type AttendanceStatus =
  | 'present' | 'late' | 'absent' | 'early_checkout'
  | 'leave' | 'sick_leave' | 'off_duty' | 'pending_review';
export type ReviewStatus = 'none' | 'pending' | 'approved' | 'rejected';
export type ReviewReason =
  | 'face_mismatch' | 'out_of_radius' | 'permission_denied' | 'offline' | 'camera_unavailable'
  // Member-raised dispute (PDF p.8) — routes the record back into the manager queue.
  | 'disputed';

export interface ShiftSession {
  id: string;
  org_user_id: string;
  cpo_user_id: string;
  status: 'open' | 'closed' | 'edited';
  clock_in_at: string;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_in_accuracy_m: number | null;
  clock_out_at: string | null;
  clock_out_lat: number | null;
  clock_out_lng: number | null;
  edited_by: string | null;
  edited_at: string | null;
  edit_reason: string | null;
  created_at: string;
  // Dept Chat v2 additive columns (20260629000000). NULL on legacy rows.
  shift_id: string | null;
  face_verified: boolean | null;        // presence-check result only — no biometrics
  face_meta: Record<string, unknown> | null;
  within_radius: boolean | null;
  distance_m: number | null;
  attendance_status: AttendanceStatus | null;
  review_status: ReviewStatus;
  review_reason: ReviewReason | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  admin_notes: string | null;
  // Member's dispute note (20260702000000) — write-once by the disputing member.
  dispute_note: string | null;
}

// An expected duty window + geofence centre + radius (cpo_shifts, 20260629000000).
export interface Shift {
  id: string;
  org_user_id: string;
  department: string | null;
  site_label: string | null;
  site_lat: number | null;
  site_lng: number | null;
  approved_radius_m: number;
  start_at: string;
  end_at: string;
  created_by: string;
  archived_at: string | null;
  created_at: string;
}

// Verified check-in inputs (Step 5). Structurally satisfied by ClockInDto.
export interface ClockInInput {
  lat?: number;
  lng?: number;
  accuracy_m?: number;
  shift_id?: string;
  face_ok?: boolean;
  // D6-e — the camera/face step couldn't run (permission denied, no camera). Distinct from
  // face_ok===false (a genuine presence-check failure) so the manager queue can tell them apart.
  face_unavailable?: boolean;
  face_meta?: Record<string, unknown>;
  offline?: boolean;
}

interface CheckInVerdict {
  within_radius: boolean | null;
  distance_m: number | null;
  attendance_status: AttendanceStatus;
  review_status: ReviewStatus;
  review_reason: ReviewReason | null;
}

// Verified check-out inputs (PDF p.5 requires face + location on check-out too).
// Structurally satisfied by ClockOutDto.
export interface ClockOutInput {
  lat?: number;
  lng?: number;
  accuracy_m?: number;
  face_ok?: boolean;
  face_unavailable?: boolean;
}

interface CheckOutVerdict {
  within_radius: boolean | null;
  distance_m: number | null;
  // null = clean checkout; set = flag the session Pending Review with this reason.
  review_reason: ReviewReason | null;
}

// Late if clock-in is more than this past the shift start; early-checkout if
// clock-out is more than this before the shift end. (v1 fixed grace — PDF p.6.)
const GRACE_MS = 10 * 60 * 1000;

/** Great-circle distance in metres (radius check is server-authoritative). */
function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 🛑 Defence-in-depth for the biometric stop-condition. face_meta is audit
 * metadata only (model/version tag, confidence bucket, timestamp). This strips
 * anything that isn't a scalar — so a client cannot smuggle raw frames or a
 * face descriptor (which would be arrays/objects) into the JSONB column. Keys
 * are capped and string values truncated to keep the row small.
 */
export function sanitizeFaceMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta || typeof meta !== 'object') return {};
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [k, v] of Object.entries(meta)) {
    if (kept >= 12) break;
    if (typeof v === 'string') { out[k] = v.slice(0, 120); kept++; }
    else if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; kept++; }
    // arrays/objects (where biometric bytes would live) are dropped on purpose.
  }
  return out;
}

/**
 * Server-authoritative check-in verdict (pure → unit-testable). A failed face
 * check, denied/absent location, out-of-radius position, or offline submission
 * becomes Pending Review with a reason — never a silent Absent (PDF p.17).
 */
export function deriveCheckIn(shift: Shift, input: ClockInInput, now: Date): CheckInVerdict {
  const hasCoords = input.lat != null && input.lng != null;
  let within: boolean | null = null;
  let distance: number | null = null;
  if (hasCoords && shift.site_lat != null && shift.site_lng != null) {
    distance = Math.round(haversineM(input.lat!, input.lng!, shift.site_lat, shift.site_lng));
    within = distance <= shift.approved_radius_m;
  }

  const pending = (reason: ReviewReason): CheckInVerdict => ({
    within_radius: within,
    distance_m: distance,
    attendance_status: 'pending_review',
    review_status: 'pending',
    review_reason: reason,
  });

  if (input.offline) return pending('offline');
  if (!hasCoords) return pending('permission_denied');
  // D6-e — camera unavailable/denied is a distinct reason from a genuine face mismatch.
  if (input.face_unavailable) return pending('camera_unavailable');
  if (input.face_ok === false) return pending('face_mismatch');
  if (within === false) return pending('out_of_radius');

  const lateThreshold = new Date(shift.start_at).getTime() + GRACE_MS;
  return {
    within_radius: within,
    distance_m: distance,
    attendance_status: now.getTime() > lateThreshold ? 'late' : 'present',
    review_status: 'none',
    review_reason: null,
  };
}

/**
 * Server-authoritative check-OUT verdict (pure → unit-testable). Mirrors
 * deriveCheckIn's ordered checks: missing coords → out of radius → face. A
 * failure flags the session Pending Review — the captured check-in stays
 * untouched and the manager decides (PDF p.5/p.6).
 *
 * Back-compat: a legacy client that sends only lat/lng (no face fields) is not
 * face-flagged — same semantics as deriveCheckIn where `face_ok === undefined`
 * passes through. The face result is client-asserted either way.
 */
export function deriveCheckOut(shift: Shift, input: ClockOutInput): CheckOutVerdict {
  const hasCoords = input.lat != null && input.lng != null;
  let within: boolean | null = null;
  let distance: number | null = null;
  if (hasCoords && shift.site_lat != null && shift.site_lng != null) {
    distance = Math.round(haversineM(input.lat!, input.lng!, shift.site_lat, shift.site_lng));
    within = distance <= shift.approved_radius_m;
  }

  let reason: ReviewReason | null = null;
  if (!hasCoords) reason = 'permission_denied';
  else if (input.face_unavailable) reason = 'camera_unavailable';
  else if (input.face_ok === false) reason = 'face_mismatch';
  else if (within === false) reason = 'out_of_radius';

  return {within_radius: within, distance_m: distance, review_reason: reason};
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly audit: OrgAuditService,
  ) {}

  private get deptChatV2(): boolean {
    return this.config.get<boolean>('featureFlags.deptChatV2') === true;
  }

  // ─── CPO self clock-in/out ───────────────────────────────────────────
  //
  // The owning org is resolved from org_members (managed CPO). A self-
  // registered agent with no org is its own org (so the row is still valid
  // and the CPO can track their own attendance).
  private async resolveOrg(cpoUserId: string): Promise<string> {
    const row = await this.db.qOne<{org_user_id: string}>(
      `SELECT org_user_id FROM org_members
        WHERE member_user_id = $1 AND status = 'active'
        ORDER BY created_at ASC LIMIT 1`,
      [cpoUserId],
    );
    return row?.org_user_id ?? cpoUserId;
  }

  async clockIn(cpoUserId: string, input: ClockInInput): Promise<ShiftSession> {
    // The partial unique index (status='open') is the real guard against two
    // open shifts; check first for a friendly error instead of a 23505.
    const open = await this.db.qOne<{id: string}>(
      `SELECT id FROM cpo_shift_sessions WHERE cpo_user_id = $1 AND status = 'open'`,
      [cpoUserId],
    );
    if (open) throw new BadRequestException('shift_already_open');

    const orgUserId = await this.resolveOrg(cpoUserId);

    // Legacy path (flag OFF): bare geotagged clock-in, byte-for-byte unchanged.
    if (!this.deptChatV2) {
      const row = await this.db.qOne<ShiftSession>(
        `INSERT INTO cpo_shift_sessions
           (org_user_id, cpo_user_id, status, clock_in_lat, clock_in_lng, clock_in_accuracy_m)
         VALUES ($1, $2, 'open', $3, $4, $5)
         RETURNING *`,
        [orgUserId, cpoUserId, input.lat ?? null, input.lng ?? null, input.accuracy_m ?? null],
      );
      if (!row) throw new BadRequestException('clock_in_failed');
      return row;
    }

    // Verified path (flag ON): a check-in must be against an assigned shift.
    const shift = await this.myTodayShift(cpoUserId);
    if (!shift) throw new BadRequestException('no_active_shift_assigned');

    const verdict = deriveCheckIn(shift, input, new Date());
    const row = await this.db.qOne<ShiftSession>(
      `INSERT INTO cpo_shift_sessions
         (org_user_id, cpo_user_id, status, shift_id,
          clock_in_lat, clock_in_lng, clock_in_accuracy_m,
          face_verified, face_meta, within_radius, distance_m,
          attendance_status, review_status, review_reason)
       VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
       RETURNING *`,
      [orgUserId, cpoUserId, shift.id,
       input.lat ?? null, input.lng ?? null, input.accuracy_m ?? null,
       input.face_ok ?? null, JSON.stringify(sanitizeFaceMeta(input.face_meta)),
       verdict.within_radius, verdict.distance_m,
       verdict.attendance_status, verdict.review_status, verdict.review_reason],
    );
    if (!row) throw new BadRequestException('clock_in_failed');
    return row;
  }

  async clockOut(cpoUserId: string, input: ClockOutInput): Promise<ShiftSession> {
    const row = await this.db.qOne<ShiftSession>(
      `UPDATE cpo_shift_sessions
          SET status = 'closed', clock_out_at = NOW(),
              clock_out_lat = $2, clock_out_lng = $3
        WHERE cpo_user_id = $1 AND status = 'open'
        RETURNING *`,
      [cpoUserId, input.lat ?? null, input.lng ?? null],
    );
    if (!row) throw new BadRequestException('no_open_shift');

    // v2 (Step 5): an early clock-out on a clean check-in (present/late) flips
    // the status to early_checkout; a failed check-out verification (face /
    // location / radius, PDF p.5) flags the session Pending Review. A row
    // already pending is never re-flagged, and the captured geotag/time stay
    // immutable — only status/review columns move.
    if (this.deptChatV2 && row.shift_id && row.clock_out_at) {
      const shift = await this.db.qOne<Shift>(
        `SELECT * FROM cpo_shifts WHERE id = $1`, [row.shift_id],
      );
      if (!shift) return row;

      let current = row;
      if ((current.attendance_status === 'present' || current.attendance_status === 'late')) {
        const earlyThreshold = new Date(shift.end_at).getTime() - GRACE_MS;
        if (new Date(row.clock_out_at).getTime() < earlyThreshold) {
          const updated = await this.db.qOne<ShiftSession>(
            `UPDATE cpo_shift_sessions SET attendance_status = 'early_checkout'
              WHERE id = $1 RETURNING *`,
            [row.id],
          );
          current = updated ?? current;
        }
      }

      const verdict = deriveCheckOut(shift, input);
      if (verdict.review_reason && current.review_status !== 'pending') {
        const flagged = await this.db.qOne<ShiftSession>(
          `UPDATE cpo_shift_sessions
              SET review_status = 'pending', review_reason = $2,
                  attendance_status = 'pending_review'
            WHERE id = $1 RETURNING *`,
          [current.id, verdict.review_reason],
        );
        return flagged ?? current;
      }
      return current;
    }
    return row;
  }

  /** The CPO's own recent shifts (newest first). */
  async myShifts(cpoUserId: string, limit = 50): Promise<ShiftSession[]> {
    return this.db.q<ShiftSession>(
      `SELECT * FROM cpo_shift_sessions
        WHERE cpo_user_id = $1
        ORDER BY clock_in_at DESC
        LIMIT $2`,
      [cpoUserId, Math.min(limit, 200)],
    );
  }

  // ─── Provider view / edit (org-scoped) ───────────────────────────────

  /** All shifts across the org's roster (optionally one CPO), newest first. */
  async orgShifts(orgUserId: string, opts?: {cpoUserId?: string; limit?: number}): Promise<ShiftSession[]> {
    if (opts?.cpoUserId) {
      return this.db.q<ShiftSession>(
        `SELECT * FROM cpo_shift_sessions
          WHERE org_user_id = $1 AND cpo_user_id = $2
          ORDER BY clock_in_at DESC LIMIT $3`,
        [orgUserId, opts.cpoUserId, Math.min(opts.limit ?? 100, 500)],
      );
    }
    return this.db.q<ShiftSession>(
      `SELECT * FROM cpo_shift_sessions
        WHERE org_user_id = $1
        ORDER BY clock_in_at DESC LIMIT $2`,
      [orgUserId, Math.min(opts?.limit ?? 100, 500)],
    );
  }

  /**
   * Provider edits a shift (e.g. correct a forgotten clock-out). Scoped to the
   * org that owns the row, audited via edited_by/edited_at/edit_reason.
   *
   * D6-a — only a clock_out_at edit closes the shift (status → 'edited'). Editing an
   * OPEN shift's clock-in time alone preserves 'open' so the CPO can still clock out
   * (clockOut matches status='open') and the open-shift unique guard keeps blocking a
   * second clock-in. Previously this always flipped to 'edited', orphaning open shifts.
   */
  async editShift(
    orgUserId: string, editorUserId: string, shiftId: string,
    patch: {clock_in_at?: string; clock_out_at?: string; edit_reason: string},
  ): Promise<ShiftSession> {
    // PDF p.9 "manual edits must keep original captured data": the pre-edit clock
    // times are preserved in the org_audit_log row (before/after), so a manual
    // time correction never destroys the original capture. FOR UPDATE keeps the
    // before-snapshot and the write atomic.
    return this.db.withTransaction(async (tx) => {
      const before = await tx.qOne<ShiftSession>(
        `SELECT * FROM cpo_shift_sessions WHERE id = $1 AND org_user_id = $2 FOR UPDATE`,
        [shiftId, orgUserId],
      );
      if (!before) throw new NotFoundException('shift_not_found_in_org');

      const row = await tx.qOne<ShiftSession>(
        `UPDATE cpo_shift_sessions
            SET clock_in_at  = COALESCE($4::timestamptz, clock_in_at),
                clock_out_at = COALESCE($5::timestamptz, clock_out_at),
                status       = CASE WHEN $5::timestamptz IS NOT NULL THEN 'edited' ELSE status END,
                edited_by    = $3,
                edited_at    = NOW(),
                edit_reason  = $6
          WHERE id = $1 AND org_user_id = $2
          RETURNING *`,
        [shiftId, orgUserId, editorUserId,
         patch.clock_in_at ?? null, patch.clock_out_at ?? null, patch.edit_reason],
      );
      if (!row) throw new NotFoundException('shift_not_found_in_org');

      await this.audit.log(orgUserId, editorUserId, 'attendance.shift.edit', {
        targetKind: 'shift_session', targetId: shiftId,
        metadata: {
          before: {clock_in_at: before.clock_in_at, clock_out_at: before.clock_out_at},
          after: {clock_in_at: patch.clock_in_at ?? null, clock_out_at: patch.clock_out_at ?? null},
          reason: patch.edit_reason,
        },
        tx,
      });
      return row;
    });
  }

  // ─── Dept Chat v2 · shift CRUD + assignment (Step 4) ──────────────────

  /** Manager creates an expected duty window + geofence centre + radius. */
  async createShift(
    orgUserId: string, createdBy: string,
    dto: {
      department?: string; site_label?: string; site_lat?: number; site_lng?: number;
      approved_radius_m?: number; start_at: string; end_at: string;
    },
  ): Promise<Shift> {
    const row = await this.db.qOne<Shift>(
      `INSERT INTO cpo_shifts
         (org_user_id, department, site_label, site_lat, site_lng,
          approved_radius_m, start_at, end_at, created_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 150), $7, $8, $9)
       RETURNING *`,
      [orgUserId, dto.department ?? null, dto.site_label ?? null,
       dto.site_lat ?? null, dto.site_lng ?? null, dto.approved_radius_m ?? null,
       dto.start_at, dto.end_at, createdBy],
    );
    if (!row) throw new BadRequestException('shift_create_failed');
    await this.audit.log(orgUserId, createdBy, 'attendance.shift.create', {
      targetKind: 'shift', targetId: row.id,
      metadata: {department: dto.department ?? null, site_label: dto.site_label ?? null,
        start_at: dto.start_at, end_at: dto.end_at},
    });
    return row;
  }

  /**
   * Assign CPOs to a shift. Tenant-isolated: the shift must belong to this org
   * AND every CPO must be an ACTIVE org_members row of this org (mirrors the
   * applyAsOrg cpo_not_active_member_of_org check) — a cross-org id is rejected.
   */
  async assignCpos(
    orgUserId: string, shiftId: string, cpoUserIds: string[], actorUserId?: string,
  ): Promise<{assigned: number}> {
    const shift = await this.db.qOne<{id: string}>(
      `SELECT id FROM cpo_shifts WHERE id = $1 AND org_user_id = $2 AND archived_at IS NULL`,
      [shiftId, orgUserId],
    );
    if (!shift) throw new NotFoundException('shift_not_found_in_org');

    const ids = Array.from(new Set(cpoUserIds));
    const active = await this.db.q<{member_user_id: string}>(
      `SELECT member_user_id FROM org_members
        WHERE org_user_id = $1 AND status = 'active' AND member_user_id = ANY($2::uuid[])`,
      [orgUserId, ids],
    );
    if (active.length !== ids.length) {
      throw new BadRequestException('cpo_not_active_member_of_org');
    }

    await this.db.q(
      `INSERT INTO cpo_shift_assignments (shift_id, cpo_user_id)
         SELECT $1, x FROM unnest($2::uuid[]) AS x
       ON CONFLICT DO NOTHING`,
      [shiftId, ids],
    );
    if (actorUserId) {
      await this.audit.log(orgUserId, actorUserId, 'attendance.shift.assign', {
        targetKind: 'shift', targetId: shiftId, metadata: {count: ids.length},
      });
    }
    return {assigned: ids.length};
  }

  /** Manager patches a shift's window/site/geofence. Audited with before/after. */
  async updateShift(
    orgUserId: string, editorUserId: string, shiftId: string,
    dto: {
      department?: string; site_label?: string; site_lat?: number; site_lng?: number;
      approved_radius_m?: number; start_at?: string; end_at?: string;
    },
  ): Promise<Shift> {
    return this.db.withTransaction(async (tx) => {
      const before = await tx.qOne<Shift>(
        `SELECT * FROM cpo_shifts WHERE id = $1 AND org_user_id = $2 AND archived_at IS NULL FOR UPDATE`,
        [shiftId, orgUserId],
      );
      if (!before) throw new NotFoundException('shift_not_found_in_org');

      const row = await tx.qOne<Shift>(
        `UPDATE cpo_shifts
            SET department        = COALESCE($3, department),
                site_label        = COALESCE($4, site_label),
                site_lat          = COALESCE($5, site_lat),
                site_lng          = COALESCE($6, site_lng),
                approved_radius_m = COALESCE($7, approved_radius_m),
                start_at          = COALESCE($8::timestamptz, start_at),
                end_at            = COALESCE($9::timestamptz, end_at)
          WHERE id = $1 AND org_user_id = $2
          RETURNING *`,
        [shiftId, orgUserId, dto.department ?? null, dto.site_label ?? null,
         dto.site_lat ?? null, dto.site_lng ?? null, dto.approved_radius_m ?? null,
         dto.start_at ?? null, dto.end_at ?? null],
      );
      if (!row) throw new NotFoundException('shift_not_found_in_org');

      await this.audit.log(orgUserId, editorUserId, 'attendance.shift.update', {
        targetKind: 'shift', targetId: shiftId,
        metadata: {
          before: {start_at: before.start_at, end_at: before.end_at,
            department: before.department, site_label: before.site_label},
          after: dto as Record<string, unknown>,
        },
        tx,
      });
      return row;
    });
  }

  /** Manager archives (soft-deletes) a shift. Assigned CPOs simply lose the
   *  "today's shift" (myTodayShift/listOrgShifts already filter archived). */
  async archiveShift(orgUserId: string, editorUserId: string, shiftId: string): Promise<Shift> {
    const row = await this.db.qOne<Shift>(
      `UPDATE cpo_shifts SET archived_at = COALESCE(archived_at, NOW())
        WHERE id = $1 AND org_user_id = $2
        RETURNING *`,
      [shiftId, orgUserId],
    );
    if (!row) throw new NotFoundException('shift_not_found_in_org');
    await this.audit.log(orgUserId, editorUserId, 'attendance.shift.archive', {
      targetKind: 'shift', targetId: shiftId,
    });
    return row;
  }

  /** Org's active (non-archived) shifts with an assigned-CPO count, newest first. */
  async listOrgShifts(
    orgUserId: string, opts?: {limit?: number},
  ): Promise<Array<Shift & {assigned_count: number}>> {
    return this.db.q<Shift & {assigned_count: number}>(
      `SELECT s.*, COUNT(a.cpo_user_id)::int AS assigned_count
         FROM cpo_shifts s
         LEFT JOIN cpo_shift_assignments a ON a.shift_id = s.id
        WHERE s.org_user_id = $1 AND s.archived_at IS NULL
        GROUP BY s.id
        ORDER BY s.start_at DESC
        LIMIT $2`,
      [orgUserId, Math.min(opts?.limit ?? 100, 500)],
    );
  }

  /**
   * The CPO's shift for "now": the assignment whose window currently covers now,
   * else the soonest one starting today. Returns null when none — the UI shows
   * the "No active shift assigned" block state and check-in is disabled.
   */
  async myTodayShift(cpoUserId: string): Promise<Shift | null> {
    return this.db.qOne<Shift>(
      `SELECT s.* FROM cpo_shift_assignments a
         JOIN cpo_shifts s ON s.id = a.shift_id AND s.archived_at IS NULL
        WHERE a.cpo_user_id = $1
          AND s.end_at >= NOW()
          -- D6-d — bound by a forward lead window relative to NOW (tz-independent) instead of
          -- date_trunc('day', NOW()), which evaluated "today" in the server's UTC tz and
          -- mis-gated check-in at the day boundary for non-UTC orgs. A shift is checkable
          -- while it's active OR starts within the next 12h.
          AND s.start_at <= NOW() + INTERVAL '12 hours'
        ORDER BY (s.start_at <= NOW() AND s.end_at >= NOW()) DESC, s.start_at ASC
        LIMIT 1`,
      [cpoUserId],
    );
  }

  // ─── Dept Chat v2 · review workflow (Step 6) ──────────────────────────

  /**
   * Manager clears a Pending Review record. Approve derives the final status
   * (present/late) from the shift window and vouches the check-in; reject leaves
   * it flagged. Only the review columns + derived status change — the captured
   * geotag/time stay IMMUTABLE (PDF p.7,9). Audited either way.
   */
  async reviewSession(
    orgUserId: string, editorUserId: string, sessionId: string,
    decision: 'approve' | 'reject', notes?: string,
  ): Promise<ShiftSession> {
    return this.db.withTransaction(async (tx) => {
      const row = await tx.qOne<ShiftSession>(
        `SELECT * FROM cpo_shift_sessions WHERE id = $1 AND org_user_id = $2 FOR UPDATE`,
        [sessionId, orgUserId],
      );
      if (!row) throw new NotFoundException('session_not_found_in_org');
      if (row.review_status !== 'pending') throw new BadRequestException('not_pending_review');

      // On approve, vouch presence and derive present/late from the shift window.
      let finalStatus: AttendanceStatus = row.attendance_status ?? 'pending_review';
      if (decision === 'approve') {
        finalStatus = 'present';
        if (row.shift_id && row.clock_in_at) {
          const shift = await tx.qOne<{start_at: string}>(
            `SELECT start_at FROM cpo_shifts WHERE id = $1`, [row.shift_id],
          );
          if (shift) {
            const lateThreshold = new Date(shift.start_at).getTime() + GRACE_MS;
            finalStatus = new Date(row.clock_in_at).getTime() > lateThreshold ? 'late' : 'present';
          }
        }
      }

      const reviewStatus: ReviewStatus = decision === 'approve' ? 'approved' : 'rejected';
      const updated = await tx.qOne<ShiftSession>(
        `UPDATE cpo_shift_sessions
            SET review_status = $3, attendance_status = $4,
                reviewed_by = $5, reviewed_at = NOW(), admin_notes = $6
          WHERE id = $1 AND org_user_id = $2
          RETURNING *`,
        // D6-b — reject drives attendance_status to a TERMINAL 'absent' (the manager did not
        // vouch the check-in), so it leaves the pending_review bucket in reporting; approve
        // writes the derived present/late.
        [sessionId, orgUserId, reviewStatus,
         decision === 'approve' ? finalStatus : 'absent',
         editorUserId, notes ?? null],
      );
      await this.audit.log(orgUserId, editorUserId, `attendance.review.${decision}`, {
        targetKind: 'shift_session', targetId: sessionId, metadata: {decision}, tx,
      });
      if (!updated) throw new BadRequestException('review_failed');
      return updated;
    });
  }

  /**
   * Manager sets a non-check-in day status (leave / sick_leave / off_duty /
   * absent) by writing a marker session row. CPO must be an active org member.
   */
  async setDayStatus(
    orgUserId: string, editorUserId: string,
    dto: {cpoUserId: string; status: 'leave' | 'sick_leave' | 'off_duty' | 'absent'; date?: string; notes?: string},
  ): Promise<ShiftSession> {
    const member = await this.db.qOne<{ok: number}>(
      `SELECT 1 AS ok FROM org_members
        WHERE org_user_id = $1 AND member_user_id = $2 AND status = 'active'`,
      [orgUserId, dto.cpoUserId],
    );
    if (!member && dto.cpoUserId !== orgUserId) {
      throw new BadRequestException('cpo_not_active_member_of_org');
    }
    const when = dto.date ?? new Date().toISOString();
    return this.db.withTransaction(async (tx) => {
      // D6-f — one day-status marker per CPO per day. Remove any prior marker for this date
      // first so re-marking (e.g. leave → sick_leave) REPLACES it instead of stacking
      // duplicate rows (no per-day unique index exists; this is the upsert).
      await tx.q(
        `DELETE FROM cpo_shift_sessions
          WHERE org_user_id = $1 AND cpo_user_id = $2
            AND shift_id IS NULL
            AND attendance_status IN ('leave','sick_leave','off_duty','absent')
            AND clock_in_at::date = $3::date`,
        [orgUserId, dto.cpoUserId, when],
      );
      const row = await tx.qOne<ShiftSession>(
        `INSERT INTO cpo_shift_sessions
           (org_user_id, cpo_user_id, status, clock_in_at, clock_out_at,
            attendance_status, review_status, reviewed_by, reviewed_at, admin_notes)
         VALUES ($1, $2, 'closed', $3, $3, $4, 'approved', $5, NOW(), $6)
         RETURNING *`,
        [orgUserId, dto.cpoUserId, when, dto.status, editorUserId, dto.notes ?? null],
      );
      if (!row) throw new BadRequestException('day_status_failed');
      await this.audit.log(orgUserId, editorUserId, 'attendance.day_status', {
        targetKind: 'shift_session', targetId: row.id, metadata: {status: dto.status}, tx,
      });
      return row;
    });
  }

  // ─── Dept Chat v2 · member dispute route (PDF p.8) ─────────────────────

  /**
   * A CPO disputes their OWN record — flags it back into the manager Pending
   * Review queue with reason 'disputed' + a short note. The captured data and
   * the manager's prior review columns stay intact except review_status/reason;
   * the manager clears it via the normal reviewSession flow.
   */
  async disputeSession(cpoUserId: string, sessionId: string, note: string): Promise<ShiftSession> {
    return this.db.withTransaction(async (tx) => {
      const row = await tx.qOne<ShiftSession>(
        `SELECT * FROM cpo_shift_sessions
          WHERE id = $1 AND cpo_user_id = $2 FOR UPDATE`,
        [sessionId, cpoUserId],
      );
      if (!row) throw new NotFoundException('session_not_found');
      if (row.review_status === 'pending') throw new BadRequestException('already_pending_review');
      if (row.status === 'open') throw new BadRequestException('shift_still_open');

      const updated = await tx.qOne<ShiftSession>(
        `UPDATE cpo_shift_sessions
            SET review_status = 'pending', review_reason = 'disputed',
                dispute_note = $2
          WHERE id = $1 RETURNING *`,
        [sessionId, note.slice(0, 500)],
      );
      if (!updated) throw new BadRequestException('dispute_failed');
      await this.audit.log(row.org_user_id, cpoUserId, 'attendance.dispute', {
        targetKind: 'shift_session', targetId: sessionId, tx,
      });
      return updated;
    });
  }

  // ─── Dept Chat v2 · admin view + export (Step 7) ──────────────────────

  /** Present/Late/Absent… counts + pending-review count for the org in a range.
   *  department/shiftId filter via the session's shift (PDF p.9). */
  async orgSummary(
    orgUserId: string,
    filters?: {from?: string; to?: string; cpoUserId?: string; department?: string; shiftId?: string},
  ): Promise<{counts: Record<string, number>; total: number; pendingReview: number}> {
    const rows = await this.db.q<{attendance_status: string | null; n: string}>(
      `SELECT ses.attendance_status, COUNT(*)::text AS n
         FROM cpo_shift_sessions ses
         LEFT JOIN cpo_shifts sh ON sh.id = ses.shift_id
        WHERE ses.org_user_id = $1
          AND ($2::timestamptz IS NULL OR ses.clock_in_at >= $2)
          AND ($3::timestamptz IS NULL OR ses.clock_in_at <= $3)
          AND ($4::uuid IS NULL OR ses.cpo_user_id = $4)
          AND ($5::text IS NULL OR sh.department = $5)
          AND ($6::uuid IS NULL OR ses.shift_id = $6)
        GROUP BY ses.attendance_status`,
      [orgUserId, filters?.from ?? null, filters?.to ?? null, filters?.cpoUserId ?? null,
       filters?.department ?? null, filters?.shiftId ?? null],
    );
    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const key = r.attendance_status ?? 'unspecified';
      counts[key] = Number(r.n);
      total += Number(r.n);
    }
    const pending = await this.db.qOne<{n: string}>(
      `SELECT COUNT(*)::text AS n
         FROM cpo_shift_sessions ses
         LEFT JOIN cpo_shifts sh ON sh.id = ses.shift_id
        WHERE ses.org_user_id = $1 AND ses.review_status = 'pending'
          AND ($2::text IS NULL OR sh.department = $2)`,
      [orgUserId, filters?.department ?? null],
    );
    return {counts, total, pendingReview: Number(pending?.n ?? 0)};
  }

  /** The Pending Review queue (flagged rows + their reason), newest first. */
  async pendingQueue(orgUserId: string, filters?: {department?: string}): Promise<ShiftSession[]> {
    return this.db.q<ShiftSession>(
      `SELECT ses.* FROM cpo_shift_sessions ses
         LEFT JOIN cpo_shifts sh ON sh.id = ses.shift_id
        WHERE ses.org_user_id = $1 AND ses.review_status = 'pending'
          AND ($2::text IS NULL OR sh.department = $2)
        ORDER BY ses.clock_in_at DESC LIMIT 200`,
      [orgUserId, filters?.department ?? null],
    );
  }

  /**
   * Controlled CSV export (PDF is rendered client-side on the ops-console). 🛑
   * Columns exclude any biometric data — only the face_verified RESULT boolean +
   * radius result are exported, never face_meta. Writes an audit row BEFORE
   * returning (action='attendance.export'); metadata carries no PII.
   */
  async exportSessions(
    orgUserId: string, editorUserId: string,
    filters?: {from?: string; to?: string; cpoUserId?: string; department?: string; shiftId?: string},
  ): Promise<{filename: string; contentType: string; body: string}> {
    const rows = await this.db.q<{
      cpo_user_id: string; display_name: string | null; department: string | null;
      site_label: string | null; clock_in_at: string; clock_out_at: string | null;
      attendance_status: string | null; face_verified: boolean | null;
      within_radius: boolean | null; admin_notes: string | null;
    }>(
      `SELECT ses.cpo_user_id, u.display_name, sh.department, sh.site_label,
              ses.clock_in_at, ses.clock_out_at, ses.attendance_status,
              ses.face_verified, ses.within_radius, ses.admin_notes
         FROM cpo_shift_sessions ses
         LEFT JOIN users u ON u.id = ses.cpo_user_id
         LEFT JOIN cpo_shifts sh ON sh.id = ses.shift_id
        WHERE ses.org_user_id = $1
          AND ($2::timestamptz IS NULL OR ses.clock_in_at >= $2)
          AND ($3::timestamptz IS NULL OR ses.clock_in_at <= $3)
          AND ($4::uuid IS NULL OR ses.cpo_user_id = $4)
          AND ($5::text IS NULL OR sh.department = $5)
          AND ($6::uuid IS NULL OR ses.shift_id = $6)
        ORDER BY ses.clock_in_at DESC
        LIMIT 5000`,
      [orgUserId, filters?.from ?? null, filters?.to ?? null, filters?.cpoUserId ?? null,
       filters?.department ?? null, filters?.shiftId ?? null],
    );

    const header = ['Member', 'Member ID', 'Department', 'Site', 'Check-in', 'Check-out',
      'Status', 'Face verified', 'In radius', 'Admin notes'];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push([
        r.display_name ?? '', r.cpo_user_id, r.department ?? '', r.site_label ?? '',
        r.clock_in_at ?? '', r.clock_out_at ?? '', r.attendance_status ?? '',
        r.face_verified === null ? '' : r.face_verified ? 'yes' : 'no',
        r.within_radius === null ? '' : r.within_radius ? 'yes' : 'no',
        r.admin_notes ?? '',
      ].map(csvCell).join(','));
    }

    await this.audit.log(orgUserId, editorUserId, 'attendance.export', {
      metadata: {
        from: filters?.from ?? null, to: filters?.to ?? null,
        cpo_user_id: filters?.cpoUserId ?? null, department: filters?.department ?? null,
        shift_id: filters?.shiftId ?? null, format: 'csv', count: rows.length,
      },
    });

    return {
      filename: `attendance-${new Date().toISOString().slice(0, 10)}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: lines.join('\r\n'),
    };
  }
}

/** CSV-escape a single cell (quote-wrap; double embedded quotes). */
function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return `"${s.replace(/"/g, '""')}"`;
}
