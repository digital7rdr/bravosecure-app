import type {AccountKind, UserRole} from '@appTypes/index';

/**
 * §35A §B — the post-auth root switch, as a PURE function so it can be unit-tested
 * exhaustively (account_kind × must_set_password × membership_status × legacy role).
 *
 * THE RULE: route off the SERVER-authenticated `account_kind`, never a client-chosen
 * flag (the lesson from the pendingProvider stuck-register bug). `pendingProvider` and
 * the legacy role strings survive ONLY as the agency self-signup fallback — the window
 * before the server flips a fresh provider's account_kind to 'agency'.
 */
export type AuthedRoute =
  | 'access-ended'    // CPO whose agency membership is suspended/removed
  | 'cpo-activation'  // CPO first login (must set password)
  | 'cpo-onboarding'  // CPO whose compliance pack isn't submitted/approved yet
  | 'cpo'             // active CPO → CpoNavigator
  | 'agency'          // agency operator → AgentNavigator
  | 'client';         // individual → client tabs

export interface RouteSignals {
  accountKind?: AccountKind;
  mustSetPassword?: boolean;
  membershipStatus?: string | null;
  /** Server flag: a CPO whose agent record hasn't cleared onboarding (docs/review). */
  cpoNeedsOnboarding?: boolean;
  /** Legacy `users.role` — only consulted for the agency fallback. */
  legacyRole?: UserRole;
  /** In-memory agency self-signup bridge (pendingProvider) — agency fallback only. */
  pendingProvider?: boolean;
}

export function resolveAuthedRoute(sig: RouteSignals): AuthedRoute {
  const {accountKind, mustSetPassword, membershipStatus, cpoNeedsOnboarding, legacyRole, pendingProvider} = sig;

  // CPO is the most restrictive door, and the server account_kind is authoritative.
  if (accountKind === 'cpo') {
    // A suspended/removed CPO must never reach the CPO home (covers boot/login as an
    // already-revoked guard; mid-session revocation is handled by recheckMembership).
    // membership_status is 'active'|'suspended'|'removed'|null/undefined — a truthy
    // non-'active' value is a revocation; null/undefined is treated as active.
    if (membershipStatus && membershipStatus !== 'active') {return 'access-ended';}
    if (mustSetPassword) {return 'cpo-activation';}
    // A managed CPO is seeded DOCS_PENDING with a compliance pack to upload; send them to
    // the onboarding flow (docs → submit → ops review) until their agent record is ACTIVE.
    // Ordered AFTER must_set_password so a brand-new CPO sets their password first.
    if (cpoNeedsOnboarding) {return 'cpo-onboarding';}
    return 'cpo';
  }

  // Agency: the server discriminator OR — only as the self-signup fallback — the legacy
  // role strings / pendingProvider bridge (an account_kind not yet flipped server-side).
  if (
    accountKind === 'agency' ||
    legacyRole === 'agent' ||
    legacyRole === 'service_provider' ||
    pendingProvider === true
  ) {
    return 'agency';
  }

  return 'client';
}
