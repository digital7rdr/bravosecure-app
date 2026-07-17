import {useAuthStore} from '@store/authStore';
import {deriveEntitlements} from '@store/entitlements';

/**
 * M1A (founder) — an Enterprise-tier individual runs the department
 * workspace for their EMPLOYEES; the "CPO" wording belongs to the
 * service-provider tenant, whose screens keep it exactly as today
 * (rule 7: provider untouched). Read at render time — the audience only
 * changes with the signed-in account.
 */
export function deptMemberNoun(plural = false): string {
  const e = deriveEntitlements(useAuthStore.getState().user);
  const enterpriseIndividual = e.isEnterprise && !e.isOrgAffiliated;
  if (enterpriseIndividual) {return plural ? 'Employees' : 'Employee';}
  return plural ? 'CPOs' : 'CPO';
}
