/**
 * M1A §2 — the approved tier matrix, single client-side source of truth.
 * Rendered IN FULL wherever a tier is described (never "all Lite features +"
 * shorthand). Founder naming: Lite / Bravo Pro / Enterprise.
 */
export const TIER_LABELS = {
  lite: 'Lite',
  pro: 'Bravo Pro',
  enterprise: 'Enterprise',
} as const;

export const LITE_FEATURES = [
  'Messenger',
  'Group Chats',
  'Voice and Video Calls (up to 10 people)',
  'Secure Phone Vault',
  'News',
  'Cloud Backup',
  'Encryption AES-256',
];

export const PRO_FEATURES = [
  ...LITE_FEATURES,
  'Secure Cloud Vault (100MB free)',
  'Encryption SM-512',
];

export const ENTERPRISE_FEATURES = [
  ...PRO_FEATURES,
  'Department Channels',
  'Employee Attendance Tracking',
  'Incident Reporting',
];

export const TIER_FEATURES = {
  lite: LITE_FEATURES,
  pro: PRO_FEATURES,
  enterprise: ENTERPRISE_FEATURES,
} as const;
