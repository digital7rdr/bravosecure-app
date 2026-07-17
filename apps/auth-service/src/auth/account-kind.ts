import type {DatabaseService} from '../database/database.service';

/**
 * Server-authoritative role discriminator (§35A). Bravo is one binary, three
 * app experiences; the experience is chosen at login from the server's
 * authenticated identity, NEVER from a client-chosen flag and NEVER from a JWT
 * claim. Both AuthService.getMe and CpoSessionGuard resolve it here so there is
 * a single source of truth, re-read from the DB every request.
 */
export type AccountKind = 'individual' | 'agency' | 'cpo';

export interface AccountKindRow {
  user_role: string;
  agent_type: string | null;
  agent_status: string | null;
  managed_by_org_id: string | null;
  member_role: string | null;
  member_status: string | null;
  org_user_id: string | null;
  org_name: string | null;
  password_set_at: Date | null;
}

export interface AccountKindResult {
  account_kind: AccountKind;
  org: {id: string; name: string} | null;
  must_set_password: boolean;
  membership_status: string | null;
  // True when the user is a CPO whose agent record hasn't cleared onboarding yet
  // (docs not uploaded / submitted / still under review). Drives the client's
  // post-auth switch to the document-upload flow instead of the CPO home — a
  // managed CPO is seeded DOCS_PENDING and must submit a compliance pack first.
  cpo_needs_onboarding: boolean;
}

// Agent statuses that mean "ready to work" — anything else for a CPO means the
// onboarding pack (docs → submit → ops review) is still outstanding.
const CPO_READY_STATUSES = new Set(['ACTIVE', 'APPROVED']);

// Why: a user can belong to more than one org (e.g. an active cpo of org A and
// a manager of org B), which would fan the org_members LEFT JOIN into multiple
// rows and make the discriminator non-deterministic. The LATERAL ... LIMIT 1
// collapses it to the single most-relevant membership — active first, then cpo
// over manager — so the precedence below always sees one membership row.
export const ACCOUNT_KIND_SQL = `
  SELECT
    u.role              AS user_role,
    a.type              AS agent_type,
    a.status            AS agent_status,
    a.managed_by_org_id AS managed_by_org_id,
    om.member_role      AS member_role,
    om.status           AS member_status,
    om.org_user_id      AS org_user_id,
    org.display_name    AS org_name,
    u.password_set_at   AS password_set_at
  FROM public.users u
  LEFT JOIN agents a ON a.user_id = u.id
  LEFT JOIN LATERAL (
    SELECT member_role, status, org_user_id
      FROM org_members
     WHERE member_user_id = u.id
     -- managed-CPO revocation: prefer the membership tying the user to their own
     -- managing org (a.managed_by_org_id) so membership_status reflects THAT org
     -- — else a CPO suspended in org A but an active manager of org B would read
     -- 'active' and slip past CpoSessionGuard. Then active-first, then cpo.
     ORDER BY (org_user_id = a.managed_by_org_id) DESC, (status = 'active') DESC, (member_role = 'cpo') DESC
     LIMIT 1
  ) om ON true
  LEFT JOIN public.users org ON org.id = COALESCE(a.managed_by_org_id, om.org_user_id)
  WHERE u.id = $1 AND u.deleted_at IS NULL
`;

/**
 * Pure precedence logic (§35A discriminator). A SUSPENDED/REMOVED managed CPO
 * still resolves to `cpo` via its agents row — so CpoSessionGuard can catch and
 * eject it — rather than silently downgrading to `individual` (which would let
 * a revoked guard slip past the guard).
 */
export function deriveAccountKind(row: AccountKindRow): AccountKindResult {
  const isManagedCpoAgent = row.agent_type === 'cpo' && row.managed_by_org_id !== null;
  const isActiveCpoMember = row.member_role === 'cpo' && row.member_status === 'active';
  const isCompanyAgent    = row.agent_type === 'company';
  const isActiveManager   = row.member_role === 'manager' && row.member_status === 'active';

  let account_kind: AccountKind;
  if (isManagedCpoAgent || isActiveCpoMember) {
    account_kind = 'cpo';
  } else if (isCompanyAgent || isActiveManager) {
    account_kind = 'agency';
  } else {
    account_kind = 'individual';
  }

  const orgId = row.managed_by_org_id ?? row.org_user_id;
  const org = orgId ? {id: orgId, name: row.org_name ?? ''} : null;

  return {
    account_kind,
    org,
    must_set_password: account_kind === 'cpo' && row.password_set_at === null,
    // A company agent has no org_members row; it is its own active org.
    membership_status: row.member_status ?? (isCompanyAgent ? 'active' : null),
    cpo_needs_onboarding:
      account_kind === 'cpo' &&
      row.agent_status !== null &&
      !CPO_READY_STATUSES.has(row.agent_status),
  };
}

/** Re-reads the discriminator from the DB. Safe default for an unknown / soft-
 *  deleted user (no elevated access, no forced reset) — such sessions are
 *  already JTI-revoked by changePassword/deleteSession. */
export async function resolveAccountKind(
  db: Pick<DatabaseService, 'qOne'>,
  userId: string,
): Promise<AccountKindResult> {
  const row = await db.qOne<AccountKindRow>(ACCOUNT_KIND_SQL, [userId]);
  if (!row) {
    return {account_kind: 'individual', org: null, must_set_password: false, membership_status: null, cpo_needs_onboarding: false};
  }
  return deriveAccountKind(row);
}

/**
 * Whether the user is a MANAGER of any service-provider org — the canonical rule
 * OrgManagerGuard enforces: a `company` agent (its own org) OR an active
 * `org_members.member_role='manager'` row. This is computed SEPARATELY from
 * resolveAccountKind because ACCOUNT_KIND_SQL collapses multi-org membership to a
 * single cpo-preferred row — so a user who is an active CPO of org A AND an active
 * manager of org B reads account_kind='cpo' yet IS an org manager. The mobile app
 * routes its Departmental manager surfaces off this flag (via /auth/me) so the UI
 * matches what OrgManagerGuard authorizes, without changing the cpo precedence.
 */
export async function resolveIsOrgManager(
  db: Pick<DatabaseService, 'qOne'>,
  userId: string,
): Promise<boolean> {
  const row = await db.qOne<{is_company: boolean; is_manager: boolean; is_enterprise: boolean}>(
    `SELECT
       EXISTS(SELECT 1 FROM agents WHERE user_id = $1 AND type = 'company') AS is_company,
       EXISTS(SELECT 1 FROM org_members WHERE member_user_id = $1 AND member_role = 'manager' AND status = 'active') AS is_manager,
       -- M1A rule 16 — an ACTIVE Enterprise-tier individual manages their own
       -- single-tenant org (org id = self). Lapse-aware: RS-19 semantics,
       -- NULL expiry = permanent comp grant (RS-17). Mirrors OrgManagerGuard
       -- Path 3 so the mobile manager surfaces match what the guard admits.
       EXISTS(SELECT 1 FROM public.users
               WHERE id = $1 AND deleted_at IS NULL
                 AND subscription_tier = 'enterprise'
                 AND (pro_active_until IS NULL OR pro_active_until > NOW())) AS is_enterprise`,
    [userId],
  );
  return !!(row && (row.is_company || row.is_manager || row.is_enterprise));
}
