import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {effectiveTierOf} from '../common/guards/tier.guard';
import type {AccessClaims} from '../auth/jwt.service';

/**
 * OrgManagerGuard — authorizes a caller as a MANAGER of a service-provider org.
 *
 * A service provider is the `company` agent's users.id (the single tenant key,
 * the same id department_channels.org_id references). A manager is either:
 *   - that org user itself (the company account), or
 *   - an org_members row with member_role='manager', status='active'.
 *
 * Modeled on AdminGuard (ops/admin.guard.ts): it RE-READS the DB rather than
 * trusting any claim baked into the JWT, so a stale token can't fabricate org
 * ownership. The JWT shape is intentionally NOT changed (auth-token security
 * stop-condition) — org identity is always derived here from org_members.
 *
 * Apply AFTER JwtAuthGuard so `req.user` is populated. Attaches the resolved
 * manager context to `req.orgManager`.
 *
 * NOTE: this is a DIFFERENT trust tier from admin_users (HQ ops staff). A
 * provider manager must never reach ops-only routes, so do not conflate the two.
 */
export interface OrgManagerContext {
  // The user id of the calling manager.
  user_id: string;
  // The org (service provider) this manager governs. For the company account
  // itself this equals user_id; for a delegated manager it's their org.
  org_user_id: string;
  // Department scope (PDF p.9/p.16): NULL = whole org (company account or an
  // unscoped manager); set = a delegated manager who only sees that
  // department's attendance + incidents. Services apply it as a forced filter.
  department: string | null;
}

@Injectable()
export class OrgManagerGuard implements CanActivate {
  constructor(private readonly db: DatabaseService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      user?: AccessClaims;
      orgManager?: OrgManagerContext;
    }>();

    const claims = req.user;
    if (!claims) throw new ForbiddenException('Not authenticated');

    // Path 1: the caller is itself an ACTIVE `company` agent — it is its own org.
    // D4-c — a suspended/deactivated company (status <> 'ACTIVE') must lose manager access.
    const asOrg = await this.db.qOne<{user_id: string}>(
      `SELECT user_id FROM agents WHERE user_id = $1 AND type = 'company' AND status = 'ACTIVE'`,
      [claims.sub],
    );
    if (asOrg) {
      req.orgManager = {user_id: claims.sub, org_user_id: claims.sub, department: null};
      return true;
    }

    // Path 2: the caller is a delegated manager of some org.
    const asManager = await this.db.qOne<{org_user_id: string; department: string | null}>(
      `SELECT org_user_id, department
         FROM org_members
        WHERE member_user_id = $1
          AND member_role = 'manager'
          AND status = 'active'`,
      [claims.sub],
    );
    if (asManager) {
      req.orgManager = {
        user_id: claims.sub,
        org_user_id: asManager.org_user_id,
        department: asManager.department ?? null,
      };
      return true;
    }

    // Path 3 (M1A) — an ACTIVE Enterprise-tier individual manages their OWN
    // single-tenant org (org_user_id = self; exactly the shape
    // department_channels.org_id was designed for). Lapse-aware read, re-read
    // per request like every other path; provider paths above are untouched.
    const tierRow = await this.db.qOne<{subscription_tier: string; pro_active_until: Date | null}>(
      `SELECT subscription_tier, pro_active_until FROM public.users
        WHERE id = $1 AND deleted_at IS NULL`,
      [claims.sub],
    );
    if (effectiveTierOf(tierRow) === 'enterprise') {
      req.orgManager = {user_id: claims.sub, org_user_id: claims.sub, department: null};
      return true;
    }

    throw new ForbiddenException('org_manager_access_required');
  }
}

/**
 * Tenant-isolation guard rail. Throws if a manager tries to act on an org that
 * is not their own. Mirrors assertRegionScope (ops/admin.guard.ts) — call at the
 * service layer right after resolving the target org from a request param.
 */
export function assertOrgScope(manager: OrgManagerContext, targetOrgId: string): void {
  if (manager.org_user_id !== targetOrgId) {
    throw new ForbiddenException(
      `org_scope_violation:${manager.org_user_id}!=${targetOrgId}`,
    );
  }
}
