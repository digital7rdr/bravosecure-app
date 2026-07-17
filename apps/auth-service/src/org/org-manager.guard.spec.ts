import {ExecutionContext, ForbiddenException} from '@nestjs/common';
import {OrgManagerGuard, assertOrgScope} from './org-manager.guard';

const mockDb = {q: jest.fn(), qOne: jest.fn()};

function ctxWith(user: unknown): {ctx: ExecutionContext; req: any} {
  const req: any = {user};
  const ctx = {
    switchToHttp: () => ({getRequest: () => req}),
  } as unknown as ExecutionContext;
  return {ctx, req};
}

describe('OrgManagerGuard', () => {
  let guard: OrgManagerGuard;

  beforeEach(() => {
    jest.resetAllMocks();
    guard = new OrgManagerGuard(mockDb as any);
  });

  it('rejects an unauthenticated request', async () => {
    const {ctx} = ctxWith(undefined);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admits a company agent as its own org and stamps req.orgManager (unscoped)', async () => {
    mockDb.qOne.mockResolvedValueOnce({user_id: 'org-1'}); // company agent lookup
    const {ctx, req} = ctxWith({sub: 'org-1'});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager).toEqual({user_id: 'org-1', org_user_id: 'org-1', department: null});
  });

  it('admits a delegated manager and resolves their org from org_members', async () => {
    mockDb.qOne
      .mockResolvedValueOnce(null) // not a company agent
      .mockResolvedValueOnce({org_user_id: 'org-7'}); // manager row (no dept scope)
    const {ctx, req} = ctxWith({sub: 'mgr-2'});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager).toEqual({user_id: 'mgr-2', org_user_id: 'org-7', department: null});
  });

  it('carries a department-scoped manager\'s scope on the context (PDF p.9/p.16)', async () => {
    mockDb.qOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({org_user_id: 'org-7', department: 'Operations'});
    const {ctx, req} = ctxWith({sub: 'mgr-3'});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager).toEqual({user_id: 'mgr-3', org_user_id: 'org-7', department: 'Operations'});
  });

  it('rejects a plain CPO (member but not manager / not company)', async () => {
    mockDb.qOne
      .mockResolvedValueOnce(null) // not a company agent
      .mockResolvedValueOnce(null); // no active manager row
    const {ctx} = ctxWith({sub: 'cpo-9'});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('D4-c: the company path requires status = ACTIVE (a suspended company is excluded)', async () => {
    mockDb.qOne
      .mockResolvedValueOnce(null) // no ACTIVE company row (suspended)
      .mockResolvedValueOnce(null); // not a manager either
    const {ctx} = ctxWith({sub: 'org-suspended'});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(String(mockDb.qOne.mock.calls[0][0])).toMatch(/type = 'company' AND status = 'ACTIVE'/);
  });
});

describe('OrgManagerGuard — M1A Path 3 (enterprise-tier individual)', () => {
  let guard: OrgManagerGuard;

  beforeEach(() => {
    jest.resetAllMocks();
    guard = new OrgManagerGuard(mockDb as any);
  });

  it('admits an ACTIVE enterprise-tier individual as manager of their own single-tenant org', async () => {
    mockDb.qOne
      .mockResolvedValueOnce(null) // not a company agent
      .mockResolvedValueOnce(null) // not a delegated manager
      .mockResolvedValueOnce({subscription_tier: 'enterprise', pro_active_until: null});
    const {ctx, req} = ctxWith({sub: 'ent-1'});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.orgManager).toEqual({user_id: 'ent-1', org_user_id: 'ent-1', department: null});
  });

  it('rejects a LAPSED enterprise tier (RS-19)', async () => {
    mockDb.qOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        subscription_tier: 'enterprise',
        pro_active_until: new Date(Date.now() - 1000),
      });
    const {ctx} = ctxWith({sub: 'ent-lapsed'});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a pro-tier individual (enterprise features are enterprise-only)', async () => {
    mockDb.qOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({subscription_tier: 'pro', pro_active_until: null});
    const {ctx} = ctxWith({sub: 'pro-1'});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('provider paths win FIRST — a company agent never falls through to the tier read (rule 7)', async () => {
    mockDb.qOne.mockResolvedValueOnce({user_id: 'org-1'});
    const {ctx} = ctxWith({sub: 'org-1'});
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(mockDb.qOne).toHaveBeenCalledTimes(1);
  });
});

describe('assertOrgScope', () => {
  it('passes when the manager acts on their own org', () => {
    expect(() =>
      assertOrgScope({user_id: 'm', org_user_id: 'org-1', department: null}, 'org-1'),
    ).not.toThrow();
  });

  it('throws a scope violation when acting on a different org', () => {
    expect(() =>
      assertOrgScope({user_id: 'm', org_user_id: 'org-1', department: null}, 'org-2'),
    ).toThrow(/org_scope_violation/);
  });
});
