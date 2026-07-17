import {Test, TestingModule} from '@nestjs/testing';
import {ConfigService} from '@nestjs/config';
import {BadRequestException, NotFoundException} from '@nestjs/common';
import {
  AttendanceService, deriveCheckIn, deriveCheckOut, sanitizeFaceMeta, type Shift,
} from './attendance.service';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';

const tx = {q: jest.fn(), qOne: jest.fn()};
const mockDb = {
  q: jest.fn(),
  qOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
};
const mockAudit = {log: jest.fn()};
// Toggled per-test; default OFF so the legacy /attendance/* path is exercised
// exactly as before (Step 1/5 regression guarantee).
let flagOn = false;
const mockConfig = {
  get: jest.fn((key: string) => (key === 'featureFlags.deptChatV2' ? flagOn : undefined)),
};

const shiftFixture = (over: Partial<Shift> = {}): Shift => ({
  id: 'sh1', org_user_id: 'org-9', department: null, site_label: null,
  site_lat: 25.2, site_lng: 55.3, approved_radius_m: 150,
  start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z',
  created_by: 'mgr-1', archived_at: null, created_at: '2026-06-22T08:00:00Z',
  ...over,
});

describe('AttendanceService', () => {
  let svc: AttendanceService;

  beforeEach(async () => {
    jest.resetAllMocks();
    flagOn = false;
    mockDb.q.mockResolvedValue([]);
    mockDb.withTransaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    mockConfig.get.mockImplementation((key: string) =>
      key === 'featureFlags.deptChatV2' ? flagOn : undefined,
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: ConfigService, useValue: mockConfig},
        {provide: OrgAuditService, useValue: mockAudit},
      ],
    }).compile();
    svc = module.get(AttendanceService);
  });

  // ─── Legacy path (flag OFF) — must remain byte-for-byte unchanged ──────
  describe('clockIn (legacy, flag off)', () => {
    it('rejects a second clock-in while a shift is already open', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'open-1'});
      await expect(svc.clockIn('cpo-1', {lat: 25, lng: 55})).rejects.toThrow('shift_already_open');
    });

    it('resolves the owning org for a managed CPO and opens a geotagged shift', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)                   // no open shift
        .mockResolvedValueOnce({org_user_id: 'org-9'}) // org_members lookup
        .mockResolvedValueOnce({id: 's1', org_user_id: 'org-9', cpo_user_id: 'cpo-1', status: 'open'});
      const out = await svc.clockIn('cpo-1', {lat: 25.2, lng: 55.3, accuracy_m: 8});
      expect(out.org_user_id).toBe('org-9');
      const insert = mockDb.qOne.mock.calls.find(c => /INSERT INTO cpo_shift_sessions/i.test(String(c[0])));
      expect(insert?.[1]).toEqual(['org-9', 'cpo-1', 25.2, 55.3, 8]);
    });

    it('falls back to self-as-org for a CPO with no org membership', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({id: 's1', org_user_id: 'cpo-solo', cpo_user_id: 'cpo-solo', status: 'open'});
      const out = await svc.clockIn('cpo-solo', {});
      expect(out.org_user_id).toBe('cpo-solo');
    });
  });

  describe('clockOut', () => {
    it('closes the open shift; throws when there is none', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.clockOut('cpo-1', {})).rejects.toThrow('no_open_shift');
    });
  });

  describe('editShift', () => {
    it('is scoped to the org and audits the edit', async () => {
      tx.qOne
        .mockResolvedValueOnce({id: 's1', status: 'closed', clock_in_at: 'a', clock_out_at: null}) // before
        .mockResolvedValueOnce({id: 's1', status: 'edited', edit_reason: 'forgot clock-out'});     // update
      const out = await svc.editShift('org-9', 'mgr-1', 's1', {
        clock_out_at: '2026-06-11T10:00:00Z', edit_reason: 'forgot clock-out',
      });
      expect(out.status).toBe('edited');
      const updateCall = tx.qOne.mock.calls.find(c => /UPDATE cpo_shift_sessions/i.test(String(c[0])));
      const [sql, params] = updateCall!;
      expect(String(sql)).toMatch(/WHERE id = \$1 AND org_user_id = \$2/);
      expect(params[0]).toBe('s1');
      expect(params[1]).toBe('org-9');
      expect(params[2]).toBe('mgr-1');
    });

    it('D6-a: only a clock_out_at edit closes the shift (status preserved otherwise)', async () => {
      tx.qOne
        .mockResolvedValueOnce({id: 's1', status: 'open', clock_in_at: 'a', clock_out_at: null})
        .mockResolvedValueOnce({id: 's1', status: 'open'});
      await svc.editShift('org-9', 'mgr-1', 's1', {clock_in_at: '2026-06-11T08:00:00Z', edit_reason: 'fix start'});
      const updateCall = tx.qOne.mock.calls.find(c => /UPDATE cpo_shift_sessions/i.test(String(c[0])));
      // The status only flips to 'edited' when a clock_out_at ($5) is supplied; else it keeps
      // the existing status (so an open shift stays clock-out-able and the open-guard holds).
      expect(String(updateCall![0])).toMatch(/status\s*=\s*CASE WHEN \$5::timestamptz IS NOT NULL THEN 'edited' ELSE status END/);
    });

    it('throws when the shift is not in the org', async () => {
      tx.qOne.mockResolvedValueOnce(null);
      await expect(
        svc.editShift('org-9', 'mgr-1', 'not-mine', {edit_reason: 'x'}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('orgShifts', () => {
    it('filters by a single CPO when requested', async () => {
      mockDb.q.mockResolvedValueOnce([{id: 's1'}]);
      await svc.orgShifts('org-9', {cpoUserId: 'cpo-1'});
      const [sql, params] = mockDb.q.mock.calls[0];
      expect(String(sql)).toMatch(/cpo_user_id = \$2/);
      expect(params.slice(0, 2)).toEqual(['org-9', 'cpo-1']);
    });
  });

  // ─── Dept Chat v2 · verified check-in derivation (Step 5, pure) ────────
  describe('deriveCheckIn', () => {
    const NEAR = {lat: 25.2001, lng: 55.3001}; // ~15 m from the site centre
    const onTime = new Date('2026-06-22T09:05:00Z'); // within the 10-min grace
    const late = new Date('2026-06-22T09:20:00Z');    // past the grace

    it('in-radius + on-time + face_ok → present', () => {
      const v = deriveCheckIn(shiftFixture(), {...NEAR, face_ok: true}, onTime);
      expect(v.attendance_status).toBe('present');
      expect(v.review_status).toBe('none');
      expect(v.within_radius).toBe(true);
    });

    it('in-radius + face_ok but past grace → late (not pending)', () => {
      const v = deriveCheckIn(shiftFixture(), {...NEAR, face_ok: true}, late);
      expect(v.attendance_status).toBe('late');
      expect(v.review_status).toBe('none');
    });

    it('denied/absent location → pending_review + permission_denied (NOT absent)', () => {
      const v = deriveCheckIn(shiftFixture(), {face_ok: true}, onTime);
      expect(v.attendance_status).toBe('pending_review');
      expect(v.review_reason).toBe('permission_denied');
    });

    it('out-of-radius → pending_review + out_of_radius', () => {
      const v = deriveCheckIn(shiftFixture(), {lat: 25.5, lng: 55.6, face_ok: true}, onTime);
      expect(v.attendance_status).toBe('pending_review');
      expect(v.review_reason).toBe('out_of_radius');
      expect(v.within_radius).toBe(false);
    });

    it('face check failed → pending_review + face_mismatch', () => {
      const v = deriveCheckIn(shiftFixture(), {...NEAR, face_ok: false}, onTime);
      expect(v.attendance_status).toBe('pending_review');
      expect(v.review_reason).toBe('face_mismatch');
    });

    it('D6-e: camera unavailable → pending_review + camera_unavailable (distinct from a mismatch)', () => {
      const v = deriveCheckIn(shiftFixture(), {...NEAR, face_unavailable: true, face_ok: false}, onTime);
      expect(v.attendance_status).toBe('pending_review');
      expect(v.review_reason).toBe('camera_unavailable');
    });

    it('D6-e wiring: ClockInDto keeps face_unavailable through the whitelist ValidationPipe', async () => {
      const {ValidationPipe} = await import('@nestjs/common');
      const {ClockInDto} = await import('./dto/attendance.dto');
      const pipe = new ValidationPipe({whitelist: true, transform: true});
      const out = (await pipe.transform(
        {face_ok: false, face_unavailable: true},
        {type: 'body', metatype: ClockInDto},
      )) as Record<string, unknown>;
      // If the DTO doesn't declare the field, whitelist:true strips it and the
      // server can never derive camera_unavailable — the D6-e reason goes dead.
      expect(out.face_unavailable).toBe(true);
    });

    it('offline submission → pending_review + offline (short-circuits)', () => {
      const v = deriveCheckIn(shiftFixture(), {...NEAR, face_ok: true, offline: true}, onTime);
      expect(v.attendance_status).toBe('pending_review');
      expect(v.review_reason).toBe('offline');
    });

    it('no geofence on the shift → radius not evaluated, falls through to present', () => {
      const v = deriveCheckIn(shiftFixture({site_lat: null, site_lng: null}), {...NEAR, face_ok: true}, onTime);
      expect(v.within_radius).toBeNull();
      expect(v.attendance_status).toBe('present');
    });
  });

  // ─── Dept Chat v2 · clockIn (flag ON) ─────────────────────────────────
  describe('clockIn (verified, flag on)', () => {
    beforeEach(() => { flagOn = true; });

    it('blocks check-in when no shift is assigned today', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)                   // no open shift
        .mockResolvedValueOnce({org_user_id: 'org-9'}) // resolveOrg
        .mockResolvedValueOnce(null);                  // myTodayShift → none
      await expect(svc.clockIn('cpo-1', {lat: 25.2, lng: 55.3, face_ok: true}))
        .rejects.toThrow('no_active_shift_assigned');
    });

    it('records the derived status + verification result against the shift', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({org_user_id: 'org-9'})
        .mockResolvedValueOnce(shiftFixture())
        .mockResolvedValueOnce({id: 'sess1', org_user_id: 'org-9', attendance_status: 'pending_review'});
      await svc.clockIn('cpo-1', {face_ok: true}); // no coords → permission_denied
      const insert = mockDb.qOne.mock.calls.find(c => /INSERT INTO cpo_shift_sessions[\s\S]*shift_id/i.test(String(c[0])));
      expect(insert).toBeDefined();
      const params = insert![1] as unknown[];
      expect(params).toContain('pending_review'); // attendance_status
      expect(params).toContain('permission_denied'); // review_reason
    });
  });

  // ─── Spec p.5 — check-OUT verification (face + location, mirrors check-in) ──
  describe('deriveCheckOut', () => {
    const NEAR = {lat: 25.2001, lng: 55.3001};

    it('clean checkout (coords in radius + face ok) → no review flag', () => {
      const v = deriveCheckOut(shiftFixture(), {...NEAR, face_ok: true});
      expect(v.review_reason).toBeNull();
      expect(v.within_radius).toBe(true);
    });

    it('missing coords → permission_denied', () => {
      expect(deriveCheckOut(shiftFixture(), {face_ok: true}).review_reason).toBe('permission_denied');
    });

    it('camera unavailable → camera_unavailable (distinct from mismatch)', () => {
      expect(deriveCheckOut(shiftFixture(), {...NEAR, face_unavailable: true, face_ok: false}).review_reason)
        .toBe('camera_unavailable');
    });

    it('face failed → face_mismatch', () => {
      expect(deriveCheckOut(shiftFixture(), {...NEAR, face_ok: false}).review_reason).toBe('face_mismatch');
    });

    it('out of radius → out_of_radius', () => {
      const v = deriveCheckOut(shiftFixture(), {lat: 25.5, lng: 55.6, face_ok: true});
      expect(v.review_reason).toBe('out_of_radius');
      expect(v.within_radius).toBe(false);
    });

    it('legacy client (no face fields) is not face-flagged', () => {
      expect(deriveCheckOut(shiftFixture(), NEAR).review_reason).toBeNull();
    });

    it('no geofence on the shift → radius not evaluated', () => {
      const v = deriveCheckOut(shiftFixture({site_lat: null, site_lng: null}), {...NEAR, face_ok: true});
      expect(v.within_radius).toBeNull();
      expect(v.review_reason).toBeNull();
    });
  });

  describe('clockOut (verified, flag on)', () => {
    beforeEach(() => { flagOn = true; });

    it('flags the session Pending Review when checkout verification fails', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({ // close UPDATE
          id: 'sess1', shift_id: 'sh1', clock_out_at: '2026-06-22T16:59:00Z',
          attendance_status: 'present', review_status: 'none',
        })
        .mockResolvedValueOnce(shiftFixture()) // shift
        .mockResolvedValueOnce({id: 'sess1', review_status: 'pending', review_reason: 'face_mismatch'}); // flag UPDATE
      const out = await svc.clockOut('cpo-1', {lat: 25.2001, lng: 55.3001, face_ok: false});
      expect(out.review_status).toBe('pending');
      const flag = mockDb.qOne.mock.calls.find(c => /review_status\s*=\s*'pending'/i.test(String(c[0])));
      expect(flag).toBeDefined();
      expect(flag![1]).toContain('face_mismatch');
    });

    it('clean verified checkout does not flag (early-checkout logic still applies)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({
          id: 'sess1', shift_id: 'sh1', clock_out_at: '2026-06-22T16:59:00Z',
          attendance_status: 'present', review_status: 'none',
        })
        .mockResolvedValueOnce(shiftFixture());
      const out = await svc.clockOut('cpo-1', {lat: 25.2001, lng: 55.3001, face_ok: true});
      expect(out.review_status).toBe('none');
      const flag = mockDb.qOne.mock.calls.find(c => /review_status\s*=\s*'pending'/i.test(String(c[0])));
      expect(flag).toBeUndefined();
    });
  });

  // ─── Spec p.8 — member dispute route ──────────────────────────────────
  describe('disputeSession', () => {
    beforeEach(() => { flagOn = true; });

    it('flags own reviewed record back to pending with reason=disputed + note, audited', async () => {
      tx.qOne
        .mockResolvedValueOnce({ // SELECT FOR UPDATE (own row)
          id: 'sess1', org_user_id: 'org-9', cpo_user_id: 'cpo-1',
          review_status: 'rejected', attendance_status: 'absent',
        })
        .mockResolvedValueOnce({id: 'sess1', review_status: 'pending', review_reason: 'disputed'});
      const out = await svc.disputeSession('cpo-1', 'sess1', 'I was on site, GPS was off');
      expect(out.review_status).toBe('pending');
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'cpo-1', 'attendance.dispute', expect.objectContaining({targetId: 'sess1'}),
      );
    });

    it("rejects another member's session", async () => {
      tx.qOne.mockResolvedValueOnce(null); // scoped SELECT misses
      await expect(svc.disputeSession('cpo-1', 'not-mine', 'x')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects when already pending review', async () => {
      tx.qOne.mockResolvedValueOnce({
        id: 'sess1', org_user_id: 'org-9', cpo_user_id: 'cpo-1', review_status: 'pending',
      });
      await expect(svc.disputeSession('cpo-1', 'sess1', 'x')).rejects.toThrow('already_pending_review');
    });
  });

  // ─── Spec p.9 — edit preserves original capture (audit before/after) ──
  describe('editShift (audited, original preserved)', () => {
    it('writes an org_audit_log row carrying the ORIGINAL clock times', async () => {
      tx.qOne
        .mockResolvedValueOnce({ // SELECT FOR UPDATE (before)
          id: 'sess1', org_user_id: 'org-9', status: 'closed',
          clock_in_at: '2026-06-22T08:00:00Z', clock_out_at: '2026-06-22T17:00:00Z',
        })
        .mockResolvedValueOnce({id: 'sess1', status: 'edited'}); // UPDATE
      await svc.editShift('org-9', 'mgr-1', 'sess1', {
        clock_out_at: '2026-06-22T18:00:00Z', edit_reason: 'forgot to clock out',
      });
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.shift.edit',
        expect.objectContaining({
          targetId: 'sess1',
          metadata: expect.objectContaining({
            before: {clock_in_at: '2026-06-22T08:00:00Z', clock_out_at: '2026-06-22T17:00:00Z'},
          }),
        }),
      );
    });
  });

  // ─── Shift update/archive + create/assign audit ───────────────────────
  describe('shift lifecycle audit + update/archive', () => {
    it('createShift writes an audit row', async () => {
      mockDb.qOne.mockResolvedValueOnce(shiftFixture());
      await svc.createShift('org-9', 'mgr-1', {start_at: '2026-06-22T09:00:00Z', end_at: '2026-06-22T17:00:00Z'});
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.shift.create', expect.objectContaining({targetId: 'sh1'}),
      );
    });

    it('assignCpos writes an audit row', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'sh1'});
      mockDb.q
        .mockResolvedValueOnce([{member_user_id: 'cpo-a'}])
        .mockResolvedValueOnce([]);
      await svc.assignCpos('org-9', 'sh1', ['cpo-a'], 'mgr-1');
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.shift.assign', expect.objectContaining({targetId: 'sh1'}),
      );
    });

    it('updateShift patches an owned, non-archived shift and audits before/after', async () => {
      tx.qOne
        .mockResolvedValueOnce(shiftFixture()) // SELECT FOR UPDATE
        .mockResolvedValueOnce(shiftFixture({site_label: 'North Gate'})); // UPDATE
      const out = await svc.updateShift('org-9', 'mgr-1', 'sh1', {site_label: 'North Gate'});
      expect(out.site_label).toBe('North Gate');
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.shift.update', expect.objectContaining({targetId: 'sh1'}),
      );
    });

    it('archiveShift sets archived_at and audits', async () => {
      mockDb.qOne.mockResolvedValueOnce(shiftFixture({archived_at: '2026-07-02T00:00:00Z'}));
      const out = await svc.archiveShift('org-9', 'mgr-1', 'sh1');
      expect(out.archived_at).not.toBeNull();
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.shift.archive', expect.objectContaining({targetId: 'sh1'}),
      );
    });

    it('updateShift throws when the shift is not in the org', async () => {
      tx.qOne.mockResolvedValueOnce(null);
      await expect(svc.updateShift('org-9', 'mgr-1', 'nope', {site_label: 'x'}))
        .rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── Spec p.9/p.10 — department/shift filters ─────────────────────────
  describe('department/shift filters', () => {
    it('orgSummary forwards department + shift filters into the query', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      mockDb.qOne.mockResolvedValueOnce({n: '0'});
      await svc.orgSummary('org-9', {department: 'Operations', shiftId: 'sh1'});
      const [sql, params] = mockDb.q.mock.calls[0];
      expect(String(sql)).toMatch(/cpo_shifts/i);
      expect(params).toContain('Operations');
      expect(params).toContain('sh1');
    });

    it('pendingQueue forwards the department filter', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      await svc.pendingQueue('org-9', {department: 'Operations'});
      const [sql, params] = mockDb.q.mock.calls[0];
      expect(String(sql)).toMatch(/cpo_shifts/i);
      expect(params).toContain('Operations');
    });

    it('exportSessions filters by department and records ALL filters in the audit metadata', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      await svc.exportSessions('org-9', 'mgr-1', {department: 'Operations', shiftId: 'sh1', cpoUserId: 'cpo-a'});
      const [sql, params] = mockDb.q.mock.calls[0];
      expect(String(sql)).toMatch(/sh\.department/i);
      expect(params).toContain('Operations');
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.export',
        expect.objectContaining({
          metadata: expect.objectContaining({department: 'Operations', shift_id: 'sh1', cpo_user_id: 'cpo-a'}),
        }),
      );
    });
  });

  // ─── Dept Chat v2 · shift CRUD + assignment (Step 4) ──────────────────
  describe('assignCpos', () => {
    it('rejects a CPO that is not an active member of this org', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'sh1'});     // shift belongs to org
      mockDb.q.mockResolvedValueOnce([{member_user_id: 'cpo-a'}]); // only 1 of 2 active
      await expect(svc.assignCpos('org-9', 'sh1', ['cpo-a', 'cpo-foreign']))
        .rejects.toThrow('cpo_not_active_member_of_org');
    });

    it('throws when the shift is not in the org', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.assignCpos('org-9', 'nope', ['cpo-a']))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('inserts assignments when all CPOs are active members', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'sh1'});
      mockDb.q
        .mockResolvedValueOnce([{member_user_id: 'cpo-a'}, {member_user_id: 'cpo-b'}]) // active check
        .mockResolvedValueOnce([]); // insert
      const out = await svc.assignCpos('org-9', 'sh1', ['cpo-a', 'cpo-b']);
      expect(out.assigned).toBe(2);
      const insert = mockDb.q.mock.calls.find(c => /INSERT INTO cpo_shift_assignments/i.test(String(c[0])));
      expect(insert).toBeDefined();
    });
  });

  describe('myTodayShift', () => {
    it('queries the covering/soonest shift for the CPO', async () => {
      mockDb.qOne.mockResolvedValueOnce(shiftFixture());
      const out = await svc.myTodayShift('cpo-1');
      expect(out?.id).toBe('sh1');
      const [sql, params] = mockDb.qOne.mock.calls[0];
      expect(String(sql)).toMatch(/cpo_shift_assignments/);
      expect(String(sql)).toMatch(/archived_at IS NULL/);
      expect(params[0]).toBe('cpo-1');
    });
  });

  // ─── 🛑 biometric stop-condition: face_meta sanitizer ─────────────────
  describe('sanitizeFaceMeta', () => {
    it('keeps scalar audit metadata but DROPS arrays/objects (no biometric bytes)', () => {
      const out = sanitizeFaceMeta({
        model: 'facecheck', version: 2, confidenceBucket: 'high', live: true,
        frames: [1, 2, 3], descriptor: {x: 1}, // <- would-be biometric payloads
      });
      expect(out).toEqual({model: 'facecheck', version: 2, confidenceBucket: 'high', live: true});
      expect(out).not.toHaveProperty('frames');
      expect(out).not.toHaveProperty('descriptor');
    });

    it('returns {} for missing/invalid meta', () => {
      expect(sanitizeFaceMeta(undefined)).toEqual({});
    });
  });

  // ─── Dept Chat v2 · review workflow (Step 6) ──────────────────────────
  describe('reviewSession', () => {
    const pendingRow = {
      id: 'sess1', org_user_id: 'org-9', review_status: 'pending',
      attendance_status: 'pending_review', shift_id: 'sh1', clock_in_at: '2026-06-22T09:05:00Z',
    };

    it('approve flips review + derives final status, audits, and NEVER touches the capture', async () => {
      tx.qOne
        .mockResolvedValueOnce(pendingRow)                          // SELECT FOR UPDATE
        .mockResolvedValueOnce({start_at: '2026-06-22T09:00:00Z'})  // shift window
        .mockResolvedValueOnce({id: 'sess1', review_status: 'approved', attendance_status: 'present'}); // UPDATE
      const out = await svc.reviewSession('org-9', 'mgr-1', 'sess1', 'approve');
      expect(out.review_status).toBe('approved');
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.review.approve', expect.objectContaining({targetId: 'sess1'}),
      );
      const updateCall = tx.qOne.mock.calls.find(c => /UPDATE cpo_shift_sessions/i.test(String(c[0])));
      expect(updateCall).toBeDefined();
      expect(String(updateCall![0])).not.toMatch(/clock_in/); // captured geotag/time immutable
    });

    it('D6-b: reject drives attendance_status to terminal absent (leaves the pending bucket)', async () => {
      tx.qOne
        .mockResolvedValueOnce(pendingRow)
        .mockResolvedValueOnce({id: 'sess1', review_status: 'rejected', attendance_status: 'absent'});
      const out = await svc.reviewSession('org-9', 'mgr-1', 'sess1', 'reject', 'insufficient evidence');
      expect(out.review_status).toBe('rejected');
      const updateCall = tx.qOne.mock.calls.find(c => /UPDATE cpo_shift_sessions/i.test(String(c[0])));
      expect((updateCall![1] as unknown[])[3]).toBe('absent'); // attendance_status param
      expect(mockAudit.log).toHaveBeenCalledWith('org-9', 'mgr-1', 'attendance.review.reject', expect.anything());
    });

    it('throws when the record is not pending', async () => {
      tx.qOne.mockResolvedValueOnce({id: 'sess1', org_user_id: 'org-9', review_status: 'none'});
      await expect(svc.reviewSession('org-9', 'mgr-1', 'sess1', 'approve')).rejects.toThrow('not_pending_review');
    });

    it('throws when the session is not in the org', async () => {
      tx.qOne.mockResolvedValueOnce(null);
      await expect(svc.reviewSession('org-9', 'mgr-1', 'nope', 'approve')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setDayStatus', () => {
    it('D6-f: replaces any prior day-status marker for the same CPO+date (upsert via delete)', async () => {
      mockDb.qOne.mockResolvedValueOnce({ok: 1}); // active org member
      tx.qOne.mockResolvedValueOnce({id: 'marker1', attendance_status: 'leave'}); // INSERT
      await svc.setDayStatus('org-9', 'mgr-1', {cpoUserId: 'cpo-1', status: 'leave', date: '2026-06-22'});
      const del = tx.q.mock.calls.find(c => /DELETE FROM cpo_shift_sessions/i.test(String(c[0])));
      expect(del).toBeDefined();
      expect(String(del![0])).toMatch(/shift_id IS NULL/);
      expect(String(del![0])).toMatch(/attendance_status IN \('leave','sick_leave','off_duty','absent'\)/);
      expect(tx.qOne.mock.calls.some(c => /INSERT INTO cpo_shift_sessions/i.test(String(c[0])))).toBe(true);
      expect(mockAudit.log).toHaveBeenCalledWith('org-9', 'mgr-1', 'attendance.day_status', expect.anything());
    });

    it('rejects a CPO that is not an active member of the org', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // not a member
      await expect(svc.setDayStatus('org-9', 'mgr-1', {cpoUserId: 'foreign', status: 'leave'}))
        .rejects.toThrow('cpo_not_active_member_of_org');
    });
  });

  // ─── Dept Chat v2 · admin view + export (Step 7) ──────────────────────
  describe('orgSummary', () => {
    it('aggregates counts + a separate pending-review tally', async () => {
      mockDb.q.mockResolvedValueOnce([
        {attendance_status: 'present', n: '5'},
        {attendance_status: 'late', n: '2'},
      ]);
      mockDb.qOne.mockResolvedValueOnce({n: '3'});
      const out = await svc.orgSummary('org-9');
      expect(out.counts.present).toBe(5);
      expect(out.total).toBe(7);
      expect(out.pendingReview).toBe(3);
    });
  });

  describe('exportSessions', () => {
    it('emits biometric-free CSV and writes an audit row before returning', async () => {
      mockDb.q.mockResolvedValueOnce([
        {cpo_user_id: 'cpo-1', display_name: 'Alex', department: 'Ops', site_label: 'HQ',
         clock_in_at: '2026-06-22T09:00:00Z', clock_out_at: null, attendance_status: 'present',
         face_verified: true, within_radius: true, admin_notes: null},
      ]);
      const out = await svc.exportSessions('org-9', 'mgr-1', {});
      expect(out.contentType).toMatch(/text\/csv/);
      expect(out.body).toMatch(/Alex/);
      expect(out.body).not.toMatch(/face_meta/i); // no biometric metadata
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'attendance.export',
        expect.objectContaining({metadata: expect.objectContaining({format: 'csv'})}),
      );
    });
  });
});
