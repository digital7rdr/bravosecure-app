import {ForbiddenException, type ExecutionContext} from '@nestjs/common';
import {ACCOUNT_KIND_SQL, deriveAccountKind, resolveAccountKind, type AccountKindRow} from './account-kind';
import {CpoSessionGuard} from '../common/guards/cpo-session.guard';
import type {DatabaseService} from '../database/database.service';

const row = (over: Partial<AccountKindRow> = {}): AccountKindRow => ({
  user_role: 'individual',
  agent_type: null,
  agent_status: null,
  managed_by_org_id: null,
  member_role: null,
  member_status: null,
  org_user_id: null,
  org_name: null,
  password_set_at: new Date(),
  ...over,
});

describe('account-kind discriminator (Step 4)', () => {
  describe('deriveAccountKind precedence', () => {
    it('managed CPO (agents.type=cpo + managed_by_org_id) → cpo', () => {
      const r = deriveAccountKind(row({
        agent_type: 'cpo', managed_by_org_id: 'org-1', org_name: 'Acme',
        member_role: 'cpo', member_status: 'active', org_user_id: 'org-1',
      }));
      expect(r.account_kind).toBe('cpo');
      expect(r.org).toEqual({id: 'org-1', name: 'Acme'});
      expect(r.membership_status).toBe('active');
    });

    it('active cpo org_member with no agents row → cpo', () => {
      const r = deriveAccountKind(row({member_role: 'cpo', member_status: 'active', org_user_id: 'org-2', org_name: 'Beta'}));
      expect(r.account_kind).toBe('cpo');
      expect(r.org).toEqual({id: 'org-2', name: 'Beta'});
    });

    it('company agent → agency (its own active org, org=null)', () => {
      const r = deriveAccountKind(row({agent_type: 'company'}));
      expect(r.account_kind).toBe('agency');
      expect(r.membership_status).toBe('active');
      expect(r.org).toBeNull();
    });

    it('active manager org_member → agency', () => {
      const r = deriveAccountKind(row({member_role: 'manager', member_status: 'active', org_user_id: 'org-3', org_name: 'Gamma'}));
      expect(r.account_kind).toBe('agency');
      expect(r.org).toEqual({id: 'org-3', name: 'Gamma'});
    });

    it('plain client → individual', () => {
      expect(deriveAccountKind(row()).account_kind).toBe('individual');
    });

    it('a SUSPENDED managed CPO still resolves to cpo (so the guard can eject it)', () => {
      const r = deriveAccountKind(row({agent_type: 'cpo', managed_by_org_id: 'o', member_role: 'cpo', member_status: 'suspended'}));
      expect(r.account_kind).toBe('cpo');
      expect(r.membership_status).toBe('suspended');
    });

    it('must_set_password is true for a cpo with NULL password_set_at, false once set', () => {
      expect(deriveAccountKind(row({agent_type: 'cpo', managed_by_org_id: 'o', password_set_at: null})).must_set_password).toBe(true);
      expect(deriveAccountKind(row({agent_type: 'cpo', managed_by_org_id: 'o', password_set_at: new Date()})).must_set_password).toBe(false);
    });

    it('must_set_password is false for non-cpo even with NULL password_set_at', () => {
      expect(deriveAccountKind(row({agent_type: 'company', password_set_at: null})).must_set_password).toBe(false);
      expect(deriveAccountKind(row({password_set_at: null})).must_set_password).toBe(false);
    });

    it('cpo_needs_onboarding is true for a not-yet-active managed CPO, false once ACTIVE/APPROVED', () => {
      const cpo = (status: string | null) => row({agent_type: 'cpo', managed_by_org_id: 'o', member_role: 'cpo', member_status: 'active', agent_status: status});
      expect(deriveAccountKind(cpo('DOCS_PENDING')).cpo_needs_onboarding).toBe(true);
      expect(deriveAccountKind(cpo('SUBMITTED')).cpo_needs_onboarding).toBe(true);
      expect(deriveAccountKind(cpo('UNDER_REVIEW')).cpo_needs_onboarding).toBe(true);
      expect(deriveAccountKind(cpo('ACTIVE')).cpo_needs_onboarding).toBe(false);
      expect(deriveAccountKind(cpo('APPROVED')).cpo_needs_onboarding).toBe(false);
      expect(deriveAccountKind(cpo(null)).cpo_needs_onboarding).toBe(false); // unknown → don't trap
    });

    it('cpo_needs_onboarding is false for a non-cpo regardless of agent_status', () => {
      expect(deriveAccountKind(row({agent_type: 'company', agent_status: 'DOCS_PENDING'})).cpo_needs_onboarding).toBe(false);
      expect(deriveAccountKind(row({agent_status: 'DOCS_PENDING'})).cpo_needs_onboarding).toBe(false);
    });
  });

  describe('resolveAccountKind (single query)', () => {
    it('runs ACCOUNT_KIND_SQL with the userId and derives from the row', async () => {
      const db = {qOne: jest.fn().mockResolvedValue(row({agent_type: 'cpo', managed_by_org_id: 'o', member_role: 'cpo', member_status: 'active'}))};
      const r = await resolveAccountKind(db as unknown as DatabaseService, 'u1');
      expect(db.qOne).toHaveBeenCalledWith(expect.stringContaining('FROM public.users u'), ['u1']);
      expect(r.account_kind).toBe('cpo');
    });

    it('returns individual + safe defaults when the user row is missing', async () => {
      const db = {qOne: jest.fn().mockResolvedValue(null)};
      const r = await resolveAccountKind(db as unknown as DatabaseService, 'missing');
      expect(r).toEqual({account_kind: 'individual', org: null, must_set_password: false, membership_status: null, cpo_needs_onboarding: false});
    });
  });

  describe('ACCOUNT_KIND_SQL (membership tiebreak)', () => {
    it("prefers the agent's own managing-org membership so a revoked CPO can't escape via another org", () => {
      // A managed CPO suspended in org A but an active manager of org B must read
      // the org-A (suspended) membership, not org B's active one — verified at the
      // DB level; this locks the ORDER BY so a future edit can't drop it.
      expect(ACCOUNT_KIND_SQL).toContain('(org_user_id = a.managed_by_org_id) DESC');
      expect(ACCOUNT_KIND_SQL).toMatch(/ORDER BY[\s\S]*LIMIT 1/);
    });
  });

  describe('CpoSessionGuard', () => {
    const ctxFor = (sub: string | null) => ({
      switchToHttp: () => ({getRequest: () => ({user: sub ? {sub} : undefined})}),
    } as unknown as ExecutionContext);

    const guardWith = (rowVal: AccountKindRow | null) =>
      new CpoSessionGuard({qOne: jest.fn().mockResolvedValue(rowVal)} as unknown as DatabaseService);

    it('throws agency_access_ended for a suspended CPO', async () => {
      const g = guardWith(row({agent_type: 'cpo', managed_by_org_id: 'o', member_role: 'cpo', member_status: 'suspended'}));
      await expect(g.canActivate(ctxFor('cpo-1'))).rejects.toThrow(ForbiddenException);
      await expect(g.canActivate(ctxFor('cpo-1'))).rejects.toThrow('agency_access_ended');
    });

    it('throws for a removed CPO', async () => {
      const g = guardWith(row({agent_type: 'cpo', managed_by_org_id: 'o', member_role: 'cpo', member_status: 'removed'}));
      await expect(g.canActivate(ctxFor('cpo-2'))).rejects.toThrow(ForbiddenException);
    });

    it('passes an active CPO', async () => {
      const g = guardWith(row({agent_type: 'cpo', managed_by_org_id: 'o', member_role: 'cpo', member_status: 'active'}));
      await expect(g.canActivate(ctxFor('cpo-3'))).resolves.toBe(true);
    });

    it('is a no-op for an agency caller (company agent)', async () => {
      const g = guardWith(row({agent_type: 'company'}));
      await expect(g.canActivate(ctxFor('agency-1'))).resolves.toBe(true);
    });

    it('is a no-op for an individual caller', async () => {
      const g = guardWith(row());
      await expect(g.canActivate(ctxFor('client-1'))).resolves.toBe(true);
    });

    it('rejects an unauthenticated request', async () => {
      const g = guardWith(null);
      await expect(g.canActivate(ctxFor(null))).rejects.toThrow(ForbiddenException);
    });
  });
});
