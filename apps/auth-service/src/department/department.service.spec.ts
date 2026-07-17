import {Test, TestingModule} from '@nestjs/testing';
import {ForbiddenException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import {DepartmentService} from './department.service';

const mockDb = {q: jest.fn(), qOne: jest.fn()};
const mockAudit = {log: jest.fn()};

describe('DepartmentService', () => {
  let svc: DepartmentService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DepartmentService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: OrgAuditService, useValue: mockAudit},
      ],
    }).compile();
    svc = module.get(DepartmentService);
  });

  describe('listMembers', () => {
    it('returns the roster + my_role for a member', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'admin'});
      mockDb.q.mockResolvedValueOnce([
        {user_id: 'u1', role: 'admin', role_label: 'CPO', display_name: 'Lead'},
      ]);
      const res = await svc.listMembers('u1', 'c1');
      expect(res.my_role).toBe('admin');
      expect(res.members).toHaveLength(1);
    });

    it('rejects a non-member', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.listMembers('stranger', 'c1')).rejects.toThrow('not_a_channel_member');
    });
  });

  describe('registerGroup', () => {
    it('lets an admin link the messenger group', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})   // memberRole
        .mockResolvedValueOnce({id: 'c1'});        // update returns row
      const res = await svc.registerGroup('u-admin', 'c1', 'grp_abc');
      expect(res).toEqual({ok: true, group_conversation_id: 'grp_abc', adopted: false});
    });

    it('forbids a viewer from registering the group', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'viewer'});
      await expect(svc.registerGroup('u-viewer', 'c1', 'grp_abc'))
        .rejects.toThrow('only_admin_can_register_group');
    });

    it('rejects an empty group id', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'admin'});
      await expect(svc.registerGroup('u-admin', 'c1', ''))
        .rejects.toThrow(ForbiddenException);
    });
  });

  // ─── Phase 3 — org workspace + membership/rekey seam ─────────────────
  describe('seedOrgWorkspace', () => {
    it('is idempotent — skips when the org already has channels', async () => {
      mockDb.qOne.mockResolvedValueOnce({n: 3}); // existing channel count
      const res = await svc.seedOrgWorkspace('org-1');
      expect(res.created).toBe(0);
      // No channel inserts attempted.
      expect(mockDb.q.mock.calls.find(c => /INSERT INTO public.department_channels/i.test(String(c[0])))).toBeUndefined();
    });

    it('creates the default channels with the org as admin and CPOs as viewers', async () => {
      mockDb.qOne.mockResolvedValueOnce({n: 0});            // no existing
      mockDb.q.mockResolvedValueOnce([                       // active org_members
        {member_user_id: 'cpo-1', member_role: 'cpo'},
        {member_user_id: 'mgr-1', member_role: 'manager'},
      ]);
      // Each channel insert returns an id (4 default channels incl. Announcements).
      mockDb.qOne
        .mockResolvedValueOnce({id: 'ch-board'})
        .mockResolvedValueOnce({id: 'ch-ops'})
        .mockResolvedValueOnce({id: 'ch-intel'})
        .mockResolvedValueOnce({id: 'ch-roster'});

      const res = await svc.seedOrgWorkspace('org-1');
      expect(res.created).toBe(4);

      // The org itself was inserted as admin on each channel.
      const adminInserts = mockDb.q.mock.calls.filter(c =>
        /INSERT INTO public.department_channel_members/i.test(String(c[0])) && c[1]?.[2] === 'admin');
      expect(adminInserts.length).toBe(4);
      // The manager joins as admin, the cpo as viewer.
      const memberRoles = mockDb.q.mock.calls
        .filter(c => /department_channel_members/i.test(String(c[0])) && c[1]?.length === 4)
        .map(c => c[1]?.[2]);
      expect(memberRoles).toContain('viewer');
      expect(memberRoles).toContain('admin');
    });

    it('seeds a board/read_only Announcements channel so the Home announcement card has a source', async () => {
      mockDb.qOne.mockResolvedValueOnce({n: 0});
      mockDb.q.mockResolvedValueOnce([{member_user_id: 'cpo-1', member_role: 'cpo'}]);
      mockDb.qOne
        .mockResolvedValueOnce({id: 'ch-board'})
        .mockResolvedValueOnce({id: 'ch-ops'})
        .mockResolvedValueOnce({id: 'ch-intel'})
        .mockResolvedValueOnce({id: 'ch-roster'});
      await svc.seedOrgWorkspace('org-1');
      const boardInsert = mockDb.qOne.mock.calls.find(c =>
        /INSERT INTO public.department_channels/i.test(String(c[0])) && c[1]?.[1] === 'Announcements');
      expect(boardInsert).toBeDefined();
      expect(boardInsert![1]).toEqual(expect.arrayContaining(['board', 'read_only']));
      // read_only is NOT managers-only: the CPO is still seeded (as viewer).
      const cpoSeed = mockDb.q.mock.calls.find(c =>
        /department_channel_members/i.test(String(c[0])) && c[1]?.[0] === 'ch-board' && c[1]?.[1] === 'cpo-1');
      expect(cpoSeed).toBeDefined();
      expect(cpoSeed![1]?.[2]).toBe('viewer');
    });
  });

  describe('removeMember (rekey seam)', () => {
    it('admin-only, refuses self-removal, deletes the row, and enqueues a remove intent', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})       // memberRole(admin)
        .mockResolvedValueOnce({user_id: 'cpo-9'});   // DELETE ... RETURNING
      await svc.removeMember('admin-1', 'ch-1', 'cpo-9');

      const intentInsert = mockDb.q.mock.calls.find(c =>
        /INSERT INTO public.channel_membership_intents/i.test(String(c[0])));
      expect(intentInsert).toBeDefined();
      expect(intentInsert?.[1]).toEqual(['ch-1', 'cpo-9', 'remove', 'admin-1']);
    });

    it('refuses self-removal', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'admin'});
      await expect(svc.removeMember('admin-1', 'ch-1', 'admin-1')).rejects.toThrow('cannot_remove_self');
    });

    it('rejects a non-admin', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'viewer'});
      await expect(svc.removeMember('viewer-1', 'ch-1', 'cpo-9')).rejects.toThrow('only_admin_can_manage_members');
    });
  });

  describe('addMember (rekey seam)', () => {
    it('upserts the member and enqueues an add intent', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})    // memberRole(admin)
        .mockResolvedValueOnce({org_id: 'org-1'})  // channel org lookup
        .mockResolvedValueOnce({ok: 1});           // target is an active org member
      await svc.addMember('admin-1', 'ch-1', 'cpo-2', 'viewer', 'CPO');
      const intentInsert = mockDb.q.mock.calls.find(c =>
        /INSERT INTO public.channel_membership_intents/i.test(String(c[0])));
      expect(intentInsert?.[1]).toEqual(['ch-1', 'cpo-2', 'add', 'admin-1']);
    });

    it('rejects a target who is not an active member of the channel org (tenant scope, audit D4-a)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})    // caller is channel admin
        .mockResolvedValueOnce({org_id: 'org-1'})  // channel org
        .mockResolvedValueOnce(null);              // target NOT an active org member
      await expect(svc.addMember('admin-1', 'ch-1', 'stranger', 'viewer'))
        .rejects.toThrow('member_not_in_org');
      const intentInsert = mockDb.q.mock.calls.find(c =>
        /channel_membership_intents/i.test(String(c[0])));
      expect(intentInsert).toBeUndefined();
    });

    it('allows adding the org account itself (no org_members lookup needed)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})    // caller is admin
        .mockResolvedValueOnce({org_id: 'org-1'}); // channel org === target id
      await svc.addMember('admin-1', 'ch-1', 'org-1', 'admin', 'Owner');
      const intentInsert = mockDb.q.mock.calls.find(c =>
        /channel_membership_intents/i.test(String(c[0])));
      expect(intentInsert?.[1]).toEqual(['ch-1', 'org-1', 'add', 'admin-1']);
    });
  });

  // ─── Step 18 — manager channel management ────────────────────────────
  describe('createChannel', () => {
    it('seeds the org as admin + CPOs as viewers on a standard channel and audits', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'ch-new'});       // INSERT channel
      mockDb.q.mockResolvedValueOnce([                          // activeOrgMembers
        {member_user_id: 'cpo-1', member_role: 'cpo'},
        {member_user_id: 'mgr-1', member_role: 'manager'},
      ]);
      const res = await svc.createChannel('org-1', 'mgr-1', {name: 'Ops', channel_type: 'department', access: 'standard'});
      expect(res.id).toBe('ch-new');
      const cpoInsert = mockDb.q.mock.calls.find(c =>
        /department_channel_members/i.test(String(c[0])) && c[1]?.[1] === 'cpo-1');
      expect(cpoInsert?.[1]?.[2]).toBe('viewer');
      expect(mockAudit.log).toHaveBeenCalledWith(
        'org-1', 'mgr-1', 'channel.create', expect.objectContaining({targetId: 'ch-new'}),
      );
    });

    it('excludes CPOs from a restricted/incident channel (managers-only seed)', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'ch-inc'});
      mockDb.q.mockResolvedValueOnce([
        {member_user_id: 'cpo-1', member_role: 'cpo'},
        {member_user_id: 'mgr-1', member_role: 'manager'},
      ]);
      await svc.createChannel('org-1', 'mgr-1', {name: 'Incident Queue', channel_type: 'incident', access: 'restricted'});
      const cpoInsert = mockDb.q.mock.calls.find(c =>
        /department_channel_members/i.test(String(c[0])) && c[1]?.[1] === 'cpo-1');
      expect(cpoInsert).toBeUndefined();
      const mgrInsert = mockDb.q.mock.calls.find(c =>
        /department_channel_members/i.test(String(c[0])) && c[1]?.[1] === 'mgr-1');
      expect(mgrInsert?.[1]?.[2]).toBe('admin');
    });
  });

  describe('configureChannel', () => {
    it('rejects a channel from another org (tenant scope)', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_id: 'other-org', access: 'standard'});
      await expect(svc.configureChannel('org-1', 'mgr-1', 'ch-x', {name: 'x'}))
        .rejects.toThrow('org_scope_violation');
    });

    it('tightening to restricted removes CPO viewers via the rekey path', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_id: 'org-1', access: 'standard', channel_type: 'department'}) // assertManagesChannel
        .mockResolvedValueOnce({role: 'admin'})                        // removeMember memberRole
        .mockResolvedValueOnce({user_id: 'cpo-1'});                    // removeMember DELETE
      mockDb.q.mockResolvedValueOnce([{user_id: 'cpo-1'}]);            // viewers to remove
      await svc.configureChannel('org-1', 'mgr-1', 'ch-1', {access: 'restricted'});
      const removeIntent = mockDb.q.mock.calls.find(c =>
        /channel_membership_intents/i.test(String(c[0])) && c[1]?.[2] === 'remove');
      expect(removeIntent).toBeDefined();
    });

    it('aborts the access flip (no bare-flip) when a CPO removal fails', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_id: 'org-1', access: 'standard', channel_type: 'department'}) // assertManagesChannel
        .mockResolvedValueOnce({role: 'admin'})                        // removeMember memberRole
        .mockRejectedValueOnce(new Error('db down'));                  // removeMember DELETE throws
      mockDb.q.mockResolvedValueOnce([{user_id: 'cpo-1'}]);            // viewers to remove
      await expect(svc.configureChannel('org-1', 'mgr-1', 'ch-1', {access: 'restricted'}))
        .rejects.toThrow('channel_tighten_incomplete');
      // The column flip must NOT have run while a CPO is still un-rekeyed.
      const updateCall = mockDb.q.mock.calls.find(c => /UPDATE public\.department_channels/i.test(String(c[0])));
      expect(updateCall).toBeUndefined();
    });

    it('D7-b: loosening back to standard re-seeds CPO viewers via the add+rekey path', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({org_id: 'org-1', access: 'restricted', channel_type: 'department'}) // assertManagesChannel
        .mockResolvedValueOnce({role: 'admin'})    // addMember memberRole
        .mockResolvedValueOnce({org_id: 'org-1'})  // addMember channel lookup
        .mockResolvedValueOnce({ok: 1});           // addMember org-member check
      mockDb.q.mockResolvedValueOnce([{member_user_id: 'cpo-1', member_role: 'cpo'}]); // activeOrgMembers
      await svc.configureChannel('org-1', 'mgr-1', 'ch-1', {access: 'standard'});
      const addIntent = mockDb.q.mock.calls.find(c =>
        /channel_membership_intents/i.test(String(c[0])) && c[1]?.[2] === 'add');
      expect(addIntent).toBeDefined(); // the rekeyed-out CPO is re-added with an add+rekey intent
    });

    it('D7-c: an empty department clears it via the sentinel CASE', async () => {
      mockDb.qOne.mockResolvedValueOnce({org_id: 'org-1', access: 'standard', channel_type: 'department'});
      await svc.configureChannel('org-1', 'mgr-1', 'ch-1', {department: ''});
      const upd = mockDb.q.mock.calls.find(c => /UPDATE public\.department_channels/i.test(String(c[0])));
      expect(upd).toBeDefined();
      expect(String(upd![0])).toMatch(/department\s+=\s+CASE WHEN \$3::text IS NULL/);
      expect((upd![1] as unknown[])[2]).toBe(''); // '' passes through to the clear branch
    });
  });

  describe('updateMemberRole', () => {
    it('admin promotes a viewer to post access', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})       // caller is admin
        .mockResolvedValueOnce({user_id: 'cpo-1'});   // UPDATE ... RETURNING
      const res = await svc.updateMemberRole('admin-1', 'ch-1', 'cpo-1', 'admin');
      expect(res).toEqual({ok: true});
    });
    it('rejects a non-admin', async () => {
      mockDb.qOne.mockResolvedValueOnce({role: 'viewer'});
      await expect(svc.updateMemberRole('viewer-1', 'ch-1', 'cpo-1', 'admin'))
        .rejects.toThrow('only_admin_can_manage_members');
    });
    it('rejects an unknown member', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({role: 'admin'})
        .mockResolvedValueOnce(null);                 // UPDATE returns nothing
      await expect(svc.updateMemberRole('admin-1', 'ch-1', 'ghost', 'viewer'))
        .rejects.toThrow('member_not_found');
    });
  });

  describe('deleteChannel (creator-only)', () => {
    it('lets the creator delete', async () => {
      mockDb.qOne.mockResolvedValueOnce({created_by: 'owner-1', org_id: 'org-1'});
      const res = await svc.deleteChannel('owner-1', 'ch-1');
      expect(res).toEqual({ok: true});
      expect(mockDb.q.mock.calls.find(c => /DELETE FROM public\.department_channels/i.test(String(c[0])))).toBeDefined();
    });
    it('forbids a non-creator', async () => {
      mockDb.qOne.mockResolvedValueOnce({created_by: 'someone-else', org_id: 'org-1'});
      await expect(svc.deleteChannel('intruder', 'ch-1')).rejects.toThrow('only_creator_can_delete');
    });
  });

  describe('resetGroup (owner-only recovery)', () => {
    it('lets the owner clear the group linkage for re-provisioning', async () => {
      mockDb.qOne.mockResolvedValueOnce({created_by: 'owner-1', org_id: 'org-1'});
      const res = await svc.resetGroup('owner-1', 'ch-1');
      expect(res).toEqual({ok: true});
      expect(mockDb.q.mock.calls.find(c =>
        /UPDATE public\.department_channels SET group_conversation_id = NULL/i.test(String(c[0])))).toBeDefined();
    });
    it('forbids a non-owner', async () => {
      mockDb.qOne.mockResolvedValueOnce({created_by: 'owner-1', org_id: 'org-1'});
      await expect(svc.resetGroup('cpo-9', 'ch-1')).rejects.toThrow('only_owner_can_reset');
    });
  });
});
