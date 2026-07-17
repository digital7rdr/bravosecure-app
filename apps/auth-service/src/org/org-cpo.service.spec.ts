import {Test, TestingModule} from '@nestjs/testing';
import {ConflictException, ForbiddenException} from '@nestjs/common';
import {OrgCpoService} from './org-cpo.service';
import {DatabaseService} from '../database/database.service';
import {PasswordService} from '../common/services/password.service';
import {DepartmentService} from '../department/department.service';
import {AuthService} from '../auth/auth.service';
import {OrgAuditService} from './org-audit.service';

const mockDb = {
  q: jest.fn(),
  qOne: jest.fn(),
  withTransaction: jest.fn(),
};
const mockPw = {hash: jest.fn(), verify: jest.fn()};
const mockDept = {addMember: jest.fn(), removeMember: jest.fn(), updateMemberRole: jest.fn()};
const mockAuth = {revokeAllUserSessions: jest.fn()};
const mockOrgAudit = {log: jest.fn()};

describe('OrgCpoService', () => {
  let service: OrgCpoService;
  const ORG = 'org-user-1';

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPw.hash.mockResolvedValue('$argon2id$mock');
    // Channel sync reads the org's channels; default to none so existing tests
    // exercise just the roster mutation. mockDb.q default is set per-test.
    mockDept.addMember.mockResolvedValue({ok: true});
    mockDept.removeMember.mockResolvedValue({ok: true});
    mockDept.updateMemberRole.mockResolvedValue({ok: true});
    mockOrgAudit.log.mockResolvedValue(undefined);
    // Default: org owns no channels, so post-commit channel sync is a no-op.
    mockDb.q.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrgCpoService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: PasswordService, useValue: mockPw},
        {provide: DepartmentService, useValue: mockDept},
        {provide: AuthService, useValue: mockAuth},
        {provide: OrgAuditService, useValue: mockOrgAudit},
      ],
    }).compile();
    service = module.get(OrgCpoService);
  });

  const dto = {
    display_name: 'Jane CPO',
    email: 'jane@example.com',
    phone_e164: '+15555550111',
    temp_password: 'temp-pass-1',
    call_sign: 'CPO-91',
  };

  describe('addEmployee (M1A rule 16)', () => {
    it('rejects a service-provider agent (agent cannot be an employee)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({id: 'u-prov', display_name: 'Prov', email: 'p@x.io'}) // target found
        .mockResolvedValueOnce({user_role: 'individual', agent_type: 'company', agent_status: 'ACTIVE',
          managed_by_org_id: null, member_role: null, member_status: null, org_user_id: null,
          org_name: null, password_set_at: new Date()}); // ACCOUNT_KIND_SQL → company agent
      await expect(service.addEmployee(ORG, 'p@x.io')).rejects.toThrow(/provider_account_cannot_be_employee/);
      // never inserted
      expect(mockDb.q).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO org_members'), expect.anything());
    });

    it('rejects a managed CPO of another org', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({id: 'u-cpo', display_name: 'Cpo', email: 'c@x.io'})
        .mockResolvedValueOnce({user_role: 'individual', agent_type: 'cpo', agent_status: 'ACTIVE',
          managed_by_org_id: 'other-org', member_role: 'cpo', member_status: 'active', org_user_id: 'other-org',
          org_name: 'Other', password_set_at: new Date()});
      await expect(service.addEmployee(ORG, 'c@x.io')).rejects.toThrow(/provider_account_cannot_be_employee/);
    });

    it('enrolls a plain individual as an active employee', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({id: 'u-ind', display_name: 'Ivy', email: 'i@x.io'}) // target
        .mockResolvedValueOnce(null)   // ACCOUNT_KIND_SQL → individual (no rows)
        .mockResolvedValueOnce(null);  // no existing membership
      // listRoster (db.q) returns the freshly-enrolled row.
      mockDb.q.mockImplementation((sql: string) =>
        /FROM org_members om/.test(sql)
          ? Promise.resolve([{member_user_id: 'u-ind', display_name: 'Ivy', email: 'i@x.io',
              call_sign: null, member_role: 'employee', status: 'active', agent_status: null,
              missions_completed: 0, created_at: new Date(), on_duty: false, on_mission: false, armed_authorized: false}])
          : Promise.resolve([]));
      const row = await service.addEmployee(ORG, 'i@x.io', 'actor-1');
      expect(row.member_role).toBe('employee');
      const insertCall = mockDb.q.mock.calls.find(c => /INSERT INTO org_members/.test(c[0] as string));
      expect(insertCall?.[1]).toEqual([ORG, 'u-ind', 'actor-1']);
    });
  });

  describe('createManagedCpo', () => {
    it('rejects when a user with that email/phone already exists', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'existing'}); // dup pre-check
      await expect(service.createManagedCpo(ORG, dto)).rejects.toBeInstanceOf(ConflictException);
      expect(mockDb.withTransaction).not.toHaveBeenCalled();
    });

    it('creates users + agents + org_members atomically in one transaction', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // no dup

      // tx mock: first qOne inside tx returns the new user id.
      const txQ = jest.fn().mockResolvedValue([]);
      const txQOne = jest.fn().mockResolvedValue({id: 'new-cpo-1'});
      mockDb.withTransaction.mockImplementation(async (fn: any) => fn({q: txQ, qOne: txQOne}));

      const out = await service.createManagedCpo(ORG, dto);

      // Password was hashed before the tx (never store plaintext).
      expect(mockPw.hash).toHaveBeenCalledWith('temp-pass-1');

      // Exactly one users insert, one agents insert, one org_members insert.
      const sqls = txQ.mock.calls.map((c) => String(c[0]));
      const agentInsert = sqls.find((s) => /INSERT INTO agents/i.test(s));
      const memberInsert = sqls.find((s) => /INSERT INTO org_members/i.test(s));
      expect(agentInsert).toMatch(/managed_by_org_id/);
      expect(agentInsert).toMatch(/'cpo'/);
      expect(agentInsert).toMatch(/'DOCS_PENDING'/);
      expect(memberInsert).toBeDefined();

      // org_members bound to the SUPPLIED org and the NEW cpo user.
      const memberCall = txQ.mock.calls.find((c) => /INSERT INTO org_members/i.test(String(c[0])));
      expect(memberCall?.[1]).toEqual(
        expect.arrayContaining([ORG, 'new-cpo-1']),
      );

      expect(out).toMatchObject({
        member_user_id: 'new-cpo-1',
        member_role: 'cpo',
        status: 'active',
        agent_status: 'DOCS_PENDING',
      });
    });

    it('Step 23 — translates a 23505 unique race (concurrent same-email) into a clean 409', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // soft pre-check passes (race window)
      // The txn loses the race and hits users.email (citext UNIQUE) / one-active-agency.
      mockDb.withTransaction.mockRejectedValueOnce({code: '23505', constraint: 'users_email_key'});
      await expect(service.createManagedCpo(ORG, dto)).rejects.toBeInstanceOf(ConflictException);
    });

    it('Step 23 — a non-unique txn error is NOT masked as a conflict', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      mockDb.withTransaction.mockRejectedValueOnce(new Error('connection reset'));
      await expect(service.createManagedCpo(ORG, dto)).rejects.toThrow('connection reset');
    });

    it('defaults member_role to cpo when omitted', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      const txQ = jest.fn().mockResolvedValue([]);
      const txQOne = jest.fn().mockResolvedValue({id: 'new-cpo-2'});
      mockDb.withTransaction.mockImplementation(async (fn: any) => fn({q: txQ, qOne: txQOne}));

      const {member_role: _omit, ...noRole} = {...dto, member_role: undefined};
      const out = await service.createManagedCpo(ORG, noRole as any);
      expect(out.member_role).toBe('cpo');
    });
  });

  describe('applyAsOrg', () => {
    it('rejects a CPO that is not an active member of the org (tenant isolation)', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // member lookup → not found
      await expect(
        service.applyAsOrg(ORG, 'job-1', {cpoUserId: 'not-mine', dressPledge: 'Black suit'}),
      ).rejects.toThrow('cpo_not_active_member_of_org');
    });

    it('rejects a too-short dress pledge before any DB read', async () => {
      await expect(
        service.applyAsOrg(ORG, 'job-1', {cpoUserId: 'cpo-1', dressPledge: 'ok'}),
      ).rejects.toThrow('dress_pledge_required');
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    it('writes org as applicant and the named CPO as the deployed officer', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({call_sign: 'CPO-7', status: 'ACTIVE'})         // member ok
        .mockResolvedValueOnce({status: 'PUBLISHED'})                          // job open
        .mockResolvedValueOnce({id: 'app-1', status: 'PENDING', assigned_cpo_user_id: 'cpo-1'}); // upsert

      const out = await service.applyAsOrg(ORG, 'job-1', {cpoUserId: 'cpo-1', dressPledge: 'Black suit + tie'});
      expect(out).toMatchObject({id: 'app-1', assigned_cpo_user_id: 'cpo-1'});

      const upsertCall = mockDb.qOne.mock.calls.find(c => /INSERT INTO job_applications/i.test(String(c[0])));
      // params: [jobId, orgUserId, callSign, pledge, cpoUserId]
      expect(upsertCall?.[1][0]).toBe('job-1');
      expect(upsertCall?.[1][1]).toBe(ORG);       // agent_id = applicant_org = org
      expect(upsertCall?.[1][4]).toBe('cpo-1');   // assigned_cpo_user_id = officer
      expect(String(upsertCall?.[0])).toMatch(/applicant_org_id/);
      expect(String(upsertCall?.[0])).toMatch(/assigned_cpo_user_id/);
    });

    it('refuses to deploy a CPO whose agent record is not yet approved', async () => {
      mockDb.qOne.mockResolvedValueOnce({call_sign: 'CPO-7', status: 'DOCS_PENDING'});
      await expect(
        service.applyAsOrg(ORG, 'job-1', {cpoUserId: 'cpo-1', dressPledge: 'Black suit'}),
      ).rejects.toThrow('cpo_not_approved_for_deployment');
    });
  });

  describe('setMemberStatus', () => {
    it('scopes the update to the org + member and throws when no row matched', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(
        service.setMemberStatus(ORG, 'not-mine', 'suspended'),
      ).rejects.toThrow('member_not_found_in_org');

      const [sql, params] = mockDb.qOne.mock.calls[0];
      expect(String(sql)).toMatch(/UPDATE org_members/i);
      expect(params).toEqual([ORG, 'not-mine', 'suspended']);
    });

    it('removes a suspended CPO from every org channel (triggers rekey intent)', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});     // status update ok
      mockDb.q.mockResolvedValueOnce([{id: 'ch-1'}, {id: 'ch-2'}]); // org owns 2 channels
      await service.setMemberStatus(ORG, 'cpo-1', 'suspended');
      expect(mockDept.removeMember).toHaveBeenCalledTimes(2);
      expect(mockDept.removeMember).toHaveBeenCalledWith(ORG, 'ch-1', 'cpo-1');
      expect(mockDept.addMember).not.toHaveBeenCalled();
    });

    it('re-adds a reinstated CPO to every org channel', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      mockDb.q.mockResolvedValueOnce([{id: 'ch-1'}]);
      await service.setMemberStatus(ORG, 'cpo-1', 'active');
      expect(mockDept.addMember).toHaveBeenCalledWith(ORG, 'ch-1', 'cpo-1', 'viewer', 'CPO');
      expect(mockDept.removeMember).not.toHaveBeenCalled();
    });

    // A normal CPO must NEVER be auto-joined into a managers-only channel — the
    // add-path SELECT must exclude restricted access AND incident channels (an
    // incident channel left at default 'standard' access is still managers-only).
    it('CPO add path excludes restricted access and incident channels', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG}); // status update; member_role lookup → undefined → viewer
      mockDb.q.mockResolvedValueOnce([]);                    // channels select (none)
      await service.setMemberStatus(ORG, 'cpo-1', 'active');
      const sel = mockDb.q.mock.calls.find(c => /FROM public\.department_channels/i.test(String(c[0])));
      expect(String(sel?.[0])).toMatch(/access IN \('standard', 'read_only'\)/);
      expect(String(sel?.[0])).toMatch(/channel_type <> 'incident'/);
    });

    // RS-01 — suspend/remove must instantly kill the CPO's live sessions so an
    // unexpired access token can't ride into /agents/* or the messenger relay.
    it('revokes all sessions of a suspended CPO', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      mockDb.q.mockResolvedValueOnce([]); // no channels
      await service.setMemberStatus(ORG, 'cpo-1', 'suspended');
      expect(mockAuth.revokeAllUserSessions).toHaveBeenCalledWith('cpo-1');
    });

    it('revokes all sessions of a removed CPO', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      mockDb.q.mockResolvedValueOnce([]);
      await service.setMemberStatus(ORG, 'cpo-1', 'removed');
      expect(mockAuth.revokeAllUserSessions).toHaveBeenCalledWith('cpo-1');
    });

    it('does NOT revoke sessions when reinstating (active)', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      mockDb.q.mockResolvedValueOnce([]);
      await service.setMemberStatus(ORG, 'cpo-1', 'active');
      expect(mockAuth.revokeAllUserSessions).not.toHaveBeenCalled();
    });
  });

  describe('setMemberRole (RS-10 · cpo ⇄ manager)', () => {
    it('rejects a non-owner actor (delegated managers cannot mint managers)', async () => {
      await expect(
        service.setMemberRole(ORG, 'cpo-1', 'manager', 'manager-user-9'),
      ).rejects.toThrow('only_org_owner_can_change_roles');
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    it('throws when the member is not in the caller org', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(
        service.setMemberRole(ORG, 'not-mine', 'manager', ORG),
      ).rejects.toThrow('member_not_found_in_org');
    });

    it('refuses to change the role of a suspended/removed member', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'cpo', status: 'suspended'});
      await expect(
        service.setMemberRole(ORG, 'cpo-1', 'manager', ORG),
      ).rejects.toThrow('member_not_active');
    });

    it('is idempotent: same role → no update, no audit, no channel churn', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'cpo', status: 'active'});
      const out = await service.setMemberRole(ORG, 'cpo-1', 'cpo', ORG);
      expect(out).toEqual({member_role: 'cpo'});
      expect(mockDb.q).not.toHaveBeenCalled();
      expect(mockOrgAudit.log).not.toHaveBeenCalled();
    });

    it('promote: flips member_role, audits member.role, seeds channel admin everywhere', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'cpo', status: 'active'});
      mockDb.q
        .mockResolvedValueOnce([]) // UPDATE org_members
        .mockResolvedValueOnce([{id: 'ch-open'}, {id: 'ch-restricted'}]); // ALL channels (admin add)

      const out = await service.setMemberRole(ORG, 'cpo-1', 'manager', ORG);
      expect(out).toEqual({member_role: 'manager'});

      const update = mockDb.q.mock.calls.find(c => /UPDATE org_members SET member_role/i.test(String(c[0])));
      expect(update?.[1]).toEqual([ORG, 'cpo-1', 'manager']);

      expect(mockOrgAudit.log).toHaveBeenCalledWith(ORG, ORG, 'member.role', expect.objectContaining({
        targetId: 'cpo-1',
        metadata: {from: 'cpo', to: 'manager'},
      }));

      // Promotion joins EVERY channel (incl. restricted) as channel admin.
      expect(mockDept.addMember).toHaveBeenCalledTimes(2);
      expect(mockDept.addMember).toHaveBeenCalledWith(ORG, 'ch-restricted', 'cpo-1', 'admin', 'Manager');
      expect(mockDept.removeMember).not.toHaveBeenCalled();
    });

    it('demote: removes from restricted/incident channels (rekey seam) and downgrades open channels to viewer', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'manager', status: 'active'});
      mockDb.q
        .mockResolvedValueOnce([]) // UPDATE org_members
        .mockResolvedValueOnce([
          {id: 'ch-open', managers_only: false},
          {id: 'ch-restricted', managers_only: true},
          {id: 'ch-incident', managers_only: true},
        ]); // demote sweep select

      await service.setMemberRole(ORG, 'mgr-1', 'cpo', ORG);

      // Restricted/incident: hard remove → dept enqueues remove+rekey intents.
      expect(mockDept.removeMember).toHaveBeenCalledWith(ORG, 'ch-restricted', 'mgr-1');
      expect(mockDept.removeMember).toHaveBeenCalledWith(ORG, 'ch-incident', 'mgr-1');
      // Open: keeps membership (and key), drops posting rights to viewer.
      expect(mockDept.updateMemberRole).toHaveBeenCalledWith(ORG, 'ch-open', 'mgr-1', 'viewer', 'CPO');
      expect(mockDept.addMember).not.toHaveBeenCalled();

      expect(mockOrgAudit.log).toHaveBeenCalledWith(ORG, ORG, 'member.role', expect.objectContaining({
        metadata: {from: 'manager', to: 'cpo'},
      }));
    });

    it('demote sweep is best-effort: one channel failing does not abort the rest', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_role: 'manager', status: 'active'});
      mockDb.q
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {id: 'ch-a', managers_only: true},
          {id: 'ch-b', managers_only: true},
        ]);
      mockDept.removeMember
        .mockRejectedValueOnce(new Error('member_not_found'))
        .mockResolvedValueOnce({ok: true});

      const out = await service.setMemberRole(ORG, 'mgr-1', 'cpo', ORG);
      expect(out).toEqual({member_role: 'cpo'});
      expect(mockDept.removeMember).toHaveBeenCalledTimes(2);
    });
  });

  describe('member.* audit (RS-11)', () => {
    it('setMemberStatus writes a member.status org_audit row with the acting manager', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      mockDb.q.mockResolvedValueOnce([]);
      await service.setMemberStatus(ORG, 'cpo-1', 'suspended', 'manager-user-2');
      expect(mockOrgAudit.log).toHaveBeenCalledWith(ORG, 'manager-user-2', 'member.status', expect.objectContaining({
        targetId: 'cpo-1',
        metadata: {status: 'suspended'},
      }));
    });

    it('createManagedCpo writes a member.add org_audit row', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      const txQ = jest.fn().mockResolvedValue([]);
      const txQOne = jest.fn().mockResolvedValue({id: 'new-cpo-7'});
      mockDb.withTransaction.mockImplementation(async (fn: any) => fn({q: txQ, qOne: txQOne}));

      await service.createManagedCpo(ORG, dto, 'manager-user-2');
      expect(mockOrgAudit.log).toHaveBeenCalledWith(ORG, 'manager-user-2', 'member.add', expect.objectContaining({
        targetId: 'new-cpo-7',
        metadata: {member_role: 'cpo'},
      }));
    });

    it('audit failure never breaks the roster mutation (best-effort)', async () => {
      mockOrgAudit.log.mockRejectedValue(new Error('audit db down'));
      mockDb.qOne.mockResolvedValueOnce({org_user_id: ORG});
      mockDb.q.mockResolvedValueOnce([]);
      await expect(service.setMemberStatus(ORG, 'cpo-1', 'active')).resolves.toBeUndefined();
    });
  });

  describe('getCapacity (Step 20)', () => {
    it('computes free = total − busy − reserved (never negative) + surfaces on-duty/active', async () => {
      mockDb.qOne.mockResolvedValueOnce({total: '6', busy: '2', reserved: '1', on_duty: '3', active: '2'});
      const cap = await service.getCapacity(ORG);
      expect(cap).toEqual({guards_total: 6, guards_free: 3, guards_on_duty: 3, active_missions: 2});
    });

    it('clamps free to 0 when reservations exceed roster', async () => {
      mockDb.qOne.mockResolvedValueOnce({total: '2', busy: '1', reserved: '5', on_duty: '0', active: '1'});
      const cap = await service.getCapacity(ORG);
      expect(cap.guards_free).toBe(0);
      expect(cap.guards_total).toBe(2);
    });

    it('defaults to zeros when the agency has no roster row', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      const cap = await service.getCapacity(ORG);
      expect(cap).toEqual({guards_total: 0, guards_free: 0, guards_on_duty: 0, active_missions: 0});
    });
  });

  describe('listMemberMissionHistory (MISSION-HISTORY · IDOR gate)', () => {
    it('throws ForbiddenException when the member is not in the caller org', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // org_members membership gate misses
      await expect(service.listMemberMissionHistory(ORG, 'outsider-cpo'))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(mockDb.q).not.toHaveBeenCalled(); // never reaches the history query
    });

    it('returns the org-scoped history (tenancy predicate present) when the member belongs to the org', async () => {
      mockDb.qOne.mockResolvedValueOnce({ok: 1}); // gate passes
      mockDb.q.mockResolvedValueOnce([
        {mission_id: 'm1', booking_id: 'b1', short_code: 'MSN-1', status: 'COMPLETED',
         role: 'LEAD', is_lead: true, started_at: null, ended_at: null,
         route_distance_m: 1000, route_duration_s: 600,
         pickup_address: 'A', dropoff_address: 'B', region_label: 'AE', paid_credits: '250'},
      ]);
      const res = await service.listMemberMissionHistory(ORG, 'cpo-1');
      expect(res).toHaveLength(1);
      expect(res[0].paid_credits).toBe(250); // Number-coerced
      const sql = (mockDb.q.mock.calls.find((c: unknown[]) => /FROM mission_crew mc/.test(c[0] as string)) ?? [''])[0] as string;
      expect(sql).toMatch(/assigned_provider_user_id = \$1/);
    });
  });

  describe('listRoster (MISSION-HISTORY · completed count)', () => {
    it('surfaces missions_completed per member', async () => {
      mockDb.q.mockResolvedValueOnce([
        {member_user_id: 'cpo-1', display_name: 'A', email: null, call_sign: 'A1',
         member_role: 'cpo', status: 'active', agent_status: 'APPROVED',
         missions_completed: 4, created_at: new Date()},
      ]);
      const res = await service.listRoster(ORG);
      expect(res[0].missions_completed).toBe(4);
    });
  });
});
