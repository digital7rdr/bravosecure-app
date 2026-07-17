import {Test, TestingModule} from '@nestjs/testing';
import {ForbiddenException, NotFoundException} from '@nestjs/common';
import {IncidentService} from './incident.service';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';

const tx = {q: jest.fn(), qOne: jest.fn()};
const mockDb = {
  q: jest.fn(),
  qOne: jest.fn(),
  withTransaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
};
const mockAudit = {log: jest.fn()};
const mockPush = {incidentSubmitted: jest.fn(), incidentStatusChanged: jest.fn()};
// A delegated manager (user ≠ org) vs the company admin (user === org).
const MANAGER = {user_id: 'mgr-1', org_user_id: 'org-9', department: null};
const COMPANY = {user_id: 'org-9', org_user_id: 'org-9', department: null};

describe('IncidentService', () => {
  let svc: IncidentService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockDb.q.mockResolvedValue([]);
    mockDb.withTransaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IncidentService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: OrgAuditService, useValue: mockAudit},
        {provide: BookingPushBridge, useValue: mockPush},
      ],
    }).compile();
    svc = module.get(IncidentService);
  });

  describe('submit', () => {
    it('resolves the org, stamps a ref from the sequence, and writes the submitted event', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_user_id: 'org-9'}); // resolveOrg
      tx.qOne.mockResolvedValueOnce({id: 'inc1', ref: 'INC-2026-00001', status: 'submitted', severity: 'high'});
      tx.q.mockResolvedValueOnce([]); // event insert

      const out = await svc.submit('user-1', {category: 'security_concern', severity: 'high', description: 'gate breach'});
      expect(out).toEqual({id: 'inc1', ref: 'INC-2026-00001', status: 'submitted', severity: 'high'});

      const [reportSql, reportParams] = tx.qOne.mock.calls[0];
      expect(String(reportSql)).toMatch(/incident_ref_seq/);          // ref stamped from the sequence
      expect(String(reportSql)).toMatch(/INSERT INTO incident_reports/i);
      expect(reportParams[0]).toBe('org-9');                          // org resolved
      expect(reportParams[1]).toBe('user-1');                         // submitter

      const evt = tx.q.mock.calls.find(c => /incident_events/i.test(String(c[0])));
      expect(evt).toBeDefined();
      expect(String(evt![0])).toMatch(/'submitted'/);                 // initial transition
      // Manager(s) alerted metadata-only (the org account + active managers).
      expect(mockPush.incidentSubmitted).toHaveBeenCalledWith(['org-9'], 'INC-2026-00001', 'high');
    });

    it('falls back to self-as-org when the submitter has no org membership', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // resolveOrg → none
      tx.qOne.mockResolvedValueOnce({id: 'inc2', ref: 'INC-2026-00002', status: 'submitted', severity: 'low'});
      tx.q.mockResolvedValueOnce([]);
      await svc.submit('solo-1', {category: 'other', severity: 'low', description: 'note'});
      expect(tx.qOne.mock.calls[0][1][0]).toBe('solo-1'); // org_user_id = self
    });

    it('writes an org_audit_log row on submission (like every other lifecycle action)', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_user_id: 'org-9'});
      tx.qOne.mockResolvedValueOnce({id: 'inc1', ref: 'INC-2026-00001', status: 'submitted', severity: 'high'});
      tx.q.mockResolvedValueOnce([]);
      await svc.submit('user-1', {category: 'security_concern', severity: 'high', description: 'gate breach'});
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'user-1', 'incident.submit',
        expect.objectContaining({
          targetId: 'inc1',
          metadata: expect.objectContaining({category: 'security_concern', severity: 'high'}),
        }),
      );
      // The narrative must never land in the audit metadata.
      const call = mockAudit.log.mock.calls.find(c => c[2] === 'incident.submit');
      expect(JSON.stringify(call![3])).not.toMatch(/gate breach/);
    });

    it('routes the alert to the department\'s managers (dept-scoped or org-wide, never another dept)', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_user_id: 'org-9'});
      tx.qOne.mockResolvedValueOnce({id: 'inc1', ref: 'INC-2026-00001', status: 'submitted', severity: 'high'});
      tx.q.mockResolvedValueOnce([]);
      mockDb.q.mockResolvedValueOnce([{member_user_id: 'mgr-ops'}]); // resolveOrgManagers
      await svc.submit('user-1', {
        category: 'safety_issue', severity: 'high', description: 'x', department: 'Operations',
      });
      const mgrQuery = mockDb.q.mock.calls.find(c => /FROM org_members/i.test(String(c[0])));
      expect(mgrQuery).toBeDefined();
      expect(String(mgrQuery![0])).toMatch(/department IS NULL OR department = \$2/);
      expect(mgrQuery![1]).toContain('Operations');
    });
  });

  describe('mine', () => {
    it('lists only the submitter’s own incidents, newest first', async () => {
      mockDb.q.mockResolvedValueOnce([{id: 'inc1'}]);
      await svc.mine('user-1');
      const [sql, params] = mockDb.q.mock.calls[0];
      expect(String(sql)).toMatch(/submitter_id = \$1/);
      expect(String(sql)).toMatch(/ORDER BY created_at DESC/i);
      expect(params[0]).toBe('user-1');
    });
  });

  // ─── Manager queue + lifecycle (Step 9) ───────────────────────────────
  describe('queue', () => {
    it('sorts Critical/High first via a severity CASE rank', async () => {
      mockDb.q.mockResolvedValueOnce([{id: 'a'}]);
      await svc.queue('org-9', {severity: 'high'});
      const [sql, params] = mockDb.q.mock.calls[0];
      expect(String(sql)).toMatch(/CASE severity/);
      expect(String(sql)).toMatch(/'critical' THEN 0/);
      expect(params[0]).toBe('org-9');
    });

    it('supports date + department filters (PDF p.14)', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      await svc.queue('org-9', {from: '2026-06-01', to: '2026-06-30', department: 'Operations'});
      const [sql, params] = mockDb.q.mock.calls[0];
      expect(String(sql)).toMatch(/created_at >= /);
      expect(String(sql)).toMatch(/created_at <= /);
      expect(String(sql)).toMatch(/department = /);
      expect(params).toEqual(expect.arrayContaining(['2026-06-01', '2026-06-30', 'Operations']));
    });
  });

  describe('department-scoped manager (PDF p.9/p.16)', () => {
    const SCOPED = {user_id: 'mgr-ops', org_user_id: 'org-9', department: 'Operations'};

    it('detail is blocked outside the manager\'s department', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // dept-scoped SELECT misses
      await expect(svc.detail('org-9', 'inc1', SCOPED.department)).rejects.toBeInstanceOf(NotFoundException);
      const [sql, params] = mockDb.qOne.mock.calls[0];
      expect(String(sql)).toMatch(/department = \$3/);
      expect(params).toContain('Operations');
    });
  });

  describe('updateStatus', () => {
    it('allows a legal transition, writes an event + audit, leaves the report narrative untouched', async () => {
      tx.qOne.mockResolvedValueOnce({status: 'submitted', submitter_id: 'sub-1', ref: 'INC-1'}); // SELECT FOR UPDATE
      const out = await svc.updateStatus('org-9', MANAGER, 'inc1', 'received');
      expect(out.status).toBe('received');
      expect(mockPush.incidentStatusChanged).toHaveBeenCalledWith('sub-1', 'INC-1', 'received');
      const evt = tx.q.mock.calls.find(c => /INSERT INTO incident_events/i.test(String(c[0])));
      expect(evt).toBeDefined();
      const upd = tx.q.mock.calls.find(c => /UPDATE incident_reports/i.test(String(c[0])));
      // Only status/updated_at change — never category/severity/description/location.
      expect(String(upd![0])).not.toMatch(/description|category|severity|location/);
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'incident.status', expect.objectContaining({metadata: {from: 'submitted', to: 'received'}}),
      );
    });

    it('rejects an illegal hop (submitted → closed)', async () => {
      tx.qOne.mockResolvedValueOnce({status: 'submitted'});
      await expect(svc.updateStatus('org-9', MANAGER, 'inc1', 'closed')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('reopen (closed → under_review) is blocked for a delegated manager', async () => {
      tx.qOne.mockResolvedValueOnce({status: 'closed'});
      await expect(svc.updateStatus('org-9', MANAGER, 'inc1', 'under_review')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('reopen is allowed for the company admin', async () => {
      tx.qOne.mockResolvedValueOnce({status: 'closed'});
      const out = await svc.updateStatus('org-9', COMPANY, 'inc1', 'under_review');
      expect(out.status).toBe('under_review');
    });
  });

  describe('assign (D7-a)', () => {
    it('records the assignment on the timeline + updates assigned_to (active incident)', async () => {
      tx.qOne.mockResolvedValueOnce({status: 'under_review'}); // SELECT status FOR UPDATE
      const out = await svc.assign('org-9', COMPANY, 'inc1', 'org-9');
      expect(out).toEqual({id: 'inc1', assigned_to: 'org-9'});
      const upd = tx.q.mock.calls.find(c => /UPDATE incident_reports SET assigned_to/i.test(String(c[0])));
      expect(upd).toBeDefined();
      const evt = tx.q.mock.calls.find(c => /INSERT INTO incident_events/i.test(String(c[0])));
      expect(evt).toBeDefined(); // assignment now appears in detail()'s timeline
      expect(mockAudit.log).toHaveBeenCalledWith('org-9', 'org-9', 'incident.assign', expect.anything());
    });

    it('rejects assignment on a terminal (closed/resolved) incident', async () => {
      tx.qOne.mockResolvedValueOnce({status: 'closed'});
      await expect(svc.assign('org-9', COMPANY, 'inc1', 'org-9')).rejects.toThrow('incident_not_assignable');
    });

    it('rejects an assignee who is not an active manager', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // org_members manager check fails
      await expect(svc.assign('org-9', MANAGER, 'inc1', 'stranger')).rejects.toThrow('assignee_must_be_manager');
    });
  });

  describe('addNote', () => {
    it('appends an internal note and never logs the note text', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'inc1'}); // exists
      await svc.addNote('org-9', MANAGER, 'inc1', 'secret manager note', true);
      const ins = mockDb.q.mock.calls.find(c => /INSERT INTO incident_events/i.test(String(c[0])));
      expect(ins).toBeDefined();
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-9', 'mgr-1', 'incident.note', expect.objectContaining({metadata: {internal: true}}),
      );
      // The note body must NOT appear in the audit metadata.
      const auditCall = mockAudit.log.mock.calls.find(c => c[2] === 'incident.note');
      expect(JSON.stringify(auditCall![3])).not.toMatch(/secret manager note/);
    });
  });

  // ─── Evidence attachments (Step 10) ───────────────────────────────────
  describe('attach / listAttachments', () => {
    it('lets the submitter attach an opaque storage_key to their own incident', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({submitter_id: 'user-1'}) // SELECT submitter_id
        .mockResolvedValueOnce({id: 'att1'});            // INSERT RETURNING
      const out = await svc.attach('user-1', 'inc1', 'vault/obj-abc');
      expect(out).toEqual({id: 'att1'});
      const ins = mockDb.qOne.mock.calls.find(c => /INSERT INTO incident_attachments/i.test(String(c[0])));
      expect(ins![1]).toEqual(['inc1', 'vault/obj-abc', 'user-1']); // opaque key only, no plaintext URL
    });

    it('rejects a non-submitter attaching', async () => {
      mockDb.qOne.mockResolvedValueOnce({submitter_id: 'someone-else'});
      await expect(svc.attach('user-1', 'inc1', 'k')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a manager of the owning org list evidence', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_user_id: 'org-9', submitter_id: 'user-1'}) // incident
        .mockResolvedValueOnce({ok: 1});                                       // isOrgManager
      mockDb.q.mockResolvedValueOnce([{id: 'att1', storage_key: 'vault/obj-abc'}]);
      const out = await svc.listAttachments('mgr-1', 'inc1');
      expect(out[0].storage_key).toBe('vault/obj-abc');
    });

    it('blocks a manager of another org (403)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_user_id: 'org-9', submitter_id: 'user-1'}) // incident
        .mockResolvedValueOnce(null);                                          // not a manager
      await expect(svc.listAttachments('outsider', 'inc1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── Evidence key delivery (Step 10 · E2) ─────────────────────────────
  describe('evidenceRecipients', () => {
    it('returns org managers + the submitter (deduped) for the submitter', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_user_id: 'org-9', submitter_id: 'user-1'}); // submitter → skips manager check
      mockDb.q.mockResolvedValueOnce([{member_user_id: 'mgr-1'}]);                        // resolveOrgManagers
      const out = await svc.evidenceRecipients('user-1', 'inc1');
      expect(out).toEqual(expect.arrayContaining(['org-9', 'mgr-1', 'user-1']));
      expect(new Set(out).size).toBe(out.length); // deduped
    });

    it('blocks an outsider (not submitter, not manager) — 403', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_user_id: 'org-9', submitter_id: 'user-1'})
        .mockResolvedValueOnce(null); // isOrgManager → no
      await expect(svc.evidenceRecipients('outsider', 'inc1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('storeAttachmentKeys', () => {
    it('lets the uploader store opaque sealed blobs (idempotent upsert)', async () => {
      mockDb.qOne.mockResolvedValueOnce({created_by: 'user-1'}); // attachment ownership
      const out = await svc.storeAttachmentKeys('user-1', 'inc1', 'att1', [
        {recipient_user_id: 'mgr-1', device_id: 1, sealed_key: 'SEALED-BLOB'},
        {recipient_user_id: 'user-1', device_id: 2, sealed_key: 'SEALED-SELF'},
      ]);
      expect(out).toEqual({stored: 2});
      const ins = mockDb.q.mock.calls.filter(c => /INSERT INTO incident_attachment_keys/i.test(String(c[0])));
      expect(ins).toHaveLength(2);
      expect(String(ins[0][0])).toMatch(/ON CONFLICT[\s\S]*DO UPDATE/i); // idempotent
      expect(ins[0][1]).toEqual(['att1', 'mgr-1', 1, 'SEALED-BLOB']); // opaque ciphertext stored as-is
    });

    it('rejects a non-uploader storing keys — 403', async () => {
      mockDb.qOne.mockResolvedValueOnce({created_by: 'someone-else'});
      await expect(
        svc.storeAttachmentKeys('user-1', 'inc1', 'att1', [{recipient_user_id: 'm', device_id: 1, sealed_key: 'x'}]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s when the attachment is not on that incident', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.storeAttachmentKeys('user-1', 'inc1', 'bad', [])).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getMyAttachmentKey', () => {
    it('returns the caller’s own sealed blob for this device', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_user_id: 'org-9', submitter_id: 'user-1'}) // submitter
        .mockResolvedValueOnce({sealed_key: 'SEALED-BLOB'});
      const out = await svc.getMyAttachmentKey('user-1', 2, 'inc1', 'att1');
      expect(out).toEqual({sealed_key: 'SEALED-BLOB'});
      const sel = mockDb.qOne.mock.calls.find(c => /FROM incident_attachment_keys/i.test(String(c[0])));
      expect(sel![1]).toEqual(['att1', 'user-1', 2]); // scoped to caller + device
    });

    it('404s when this device has no sealed blob (added/rotated after seal)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_user_id: 'org-9', submitter_id: 'user-1'})
        .mockResolvedValueOnce(null); // no row for this device
      await expect(svc.getMyAttachmentKey('user-1', 9, 'inc1', 'att1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('blocks a manager of another org — 403', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_user_id: 'org-9', submitter_id: 'user-1'})
        .mockResolvedValueOnce(null); // isOrgManager → no
      await expect(svc.getMyAttachmentKey('outsider', 1, 'inc1', 'att1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
