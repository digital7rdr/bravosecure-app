/**
 * Findings 13 + 15 — the three backup screens (BackupSetupScreen,
 * BackupRestoreScreen, RestoreProgressOverlay) each hard-coded the same
 * base palette. This is the single source for the shared tokens so a
 * future retheme touches ONE place instead of three. Each screen still
 * spreads in its own screen-specific accents (e.g. the overlay's brighter
 * `ok`/`glow`) so this extraction is a pure de-duplication with no visual
 * change.
 */
export const BACKUP_BASE = {
  bg:    '#04101F',
  surf2: '#162F54',
  bd:    '#244C82',
  bd2:   '#1C3B66',
  tx1:   '#FFFFFF',
  tx2:   '#B8C7E0',
  tx3:   '#7E8AA6',
  warn:  '#FFC107',
  err:   '#FF3B3B',
  act:   '#1E88FF',
} as const;
