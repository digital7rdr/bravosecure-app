/**
 * B-91 M1 R2 — the ONE place feature entitlements are derived on the client.
 *
 * The spec's tier language (Lite / Pro / Enterprise) maps onto what the
 * server actually knows today:
 *   - Lite/Pro  → `users.subscription_tier` ('lite' | 'pro', TierGuard-backed).
 *   - Enterprise → the ORG capability set (service-provider company account,
 *     agency kind, or an active org member) — the server enforces this via
 *     DeptChatAccessGuard, so the client mirror below can never widen access,
 *     only decide what to RENDER (locked card vs live entry).
 *
 * When a real `messenger_tier` field ships (INDEX Q1), only this file and
 * the server guards change — screens keep calling `useEntitlements()`.
 */
import {useAuthStore} from '@store/authStore';
import {effectiveTier} from '@utils/tier';
import type {PackageTier} from '@appTypes/index';

export interface Entitlements {
  /** Raw stored tier ('lite' | 'pro' | 'enterprise'). Prefer `effective`. */
  tier: string;
  /** Lapse-aware tier (RS-19): a paid tier only while its window is live. */
  effective: PackageTier;
  /** Org-backed workforce account (provider company / agency / active member). */
  isOrgAffiliated: boolean;
  /** Enterprise capability set: paid enterprise tier OR org tenancy. */
  isEnterprise: boolean;
  hasDeptChannels: boolean;
  /** Secure Cloud Vault (paid cloud storage) — Pro and Enterprise (M1A matrix). */
  hasCloudVault: boolean;
  /** SM-512 marketing label (Pro+). Copy-only — no crypto changes with tier. */
  hasSM512Label: boolean;
}

export function deriveEntitlements(user: ReturnType<typeof useAuthStore.getState>['user']): Entitlements {
  const tier = user?.subscription_tier ?? 'lite';
  const effective = effectiveTier(user);
  // Mirrors DeptChatAccessGuard — org tenancy, not a client-purchasable flag.
  // Display-only; the server is the real gate.
  const isOrgAffiliated = !!user && (
    user.role === 'service_provider' || user.account_kind === 'agency' ||
    ((user.account_kind === 'cpo' || !!user.org) && user.membership_status === 'active')
  );
  // M1A — the paid Enterprise tier ALSO unlocks the enterprise feature set
  // for individuals. Org-OR-tier, never double-gate: org accounts keep every
  // path they have today regardless of subscription_tier.
  const isEnterprise = isOrgAffiliated || effective === 'enterprise';
  return {
    tier,
    effective,
    isOrgAffiliated,
    isEnterprise,
    hasDeptChannels: isEnterprise,
    hasCloudVault: effective !== 'lite' || isOrgAffiliated,
    hasSM512Label: effective !== 'lite' || isOrgAffiliated,
  };
}

export function useEntitlements(): Entitlements {
  const user = useAuthStore(s => s.user);
  return deriveEntitlements(user);
}

/**
 * Spec p.8 upgrade prompt (exact copy). Uses the branded Alert host (B-88).
 * With the M1A billing flow live, "View Enterprise" routes into the Pricing
 * page / paywall when the caller passes `onViewPlans`; the descriptive
 * fallback remains for call-sites without navigation access.
 */
export function showEnterpriseUpgradePrompt(opts?: {onViewPlans?: () => void}): void {
  const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
  Alert.alert(
    'Upgrade to Enterprise',
    'Department Channels are available on Enterprise. Upgrade to organise your team into controlled departmental channels.',
    [
      {
        text: 'View Enterprise',
        onPress: opts?.onViewPlans ?? (() => {
          Alert.alert(
            'Enterprise',
            'Enterprise includes Department Channels, Employee Attendance Tracking and Incident Reporting, on top of everything in Bravo Pro. Upgrade any time from Settings → Pricing.',
          );
        }),
      },
      {text: 'Not Now', style: 'cancel'},
    ],
  );
}

/**
 * M1A rule 12 — generic locked-feature ask for a matrix row the account's
 * tier lacks (first user: Secure Cloud Vault on Lite). Branded dialog via
 * the B-88 host; `onViewPlans` routes to Settings → Pricing / the paywall.
 */
export function showTierUpgradePrompt(
  feature: 'cloud-vault',
  opts?: {onViewPlans?: () => void},
): void {
  const {Alert} = require('@utils/alert') as typeof import('@utils/alert');
  const copy = {
    'cloud-vault': {
      title: 'Upgrade to unlock your Cloud Vault',
      message:
        'Secure Cloud Vault (100MB free) is available on Bravo Pro and Enterprise. Upgrade to store files in your encrypted cloud vault.',
    },
  }[feature];
  Alert.alert(copy.title, copy.message, [
    ...(opts?.onViewPlans ? [{text: 'View Plans', onPress: opts.onViewPlans}] : []),
    {text: 'Not Now', style: 'cancel' as const},
  ]);
}
