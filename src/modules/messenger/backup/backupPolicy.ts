/**
 * Audit P0-B1 — single source of truth for backup-password policy.
 *
 * The MIN length was raised from 6 to 10 chars to clear Signal's
 * documented floor for user-chosen recovery passwords. The OWASP 2024
 * password-storage cheat sheet treats <10 chars as "trivially crackable
 * offline" once the KDF params are exposed (and the server stores them
 * opaquely with the bundle, so any compromise leaks them).
 *
 * Both BackupSetupScreen and BackupRestoreScreen consume this constant
 * — never hard-code the literal in either screen.
 */
export const MIN_BACKUP_PASSWORD_CHARS = 10;
