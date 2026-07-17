import {create} from 'zustand';
import {immer} from 'zustand/middleware/immer';
import {persist, createJSONStorage} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {Buffer} from '@craftzdog/react-native-buffer';

/**
 * Local vault UX state.
 *
 * Audit fixes #34–#37:
 *
 *   #34 — constant-time PIN comparison via XOR-fold.
 *   #35 — Argon2id PIN hashing + lockout schedule (5/10/15 attempts →
 *         30s / 5m / 1h windows). The counter persists in AsyncStorage
 *         so a restart can't reset the lockout.
 *   #36 — biometric unlock is opt-IN. setupPin no longer auto-enables
 *         biometric; the setup screen must call setBiometricEnabled
 *         explicitly after the user grants permission.
 *   #37 — clock-rollback resistance: the unlock check compares both
 *         Date.now() AND a monotonic source. If either reports
 *         expiry, the vault locks. Prevents a user (or attacker)
 *         from extending the unlock window by rolling back system
 *         clock.
 *
 * Design note — file-level AES-256-CBC keys are still generated per-file
 * at upload time and travel inside the sealed envelope. The PIN is a
 * local UX gate; brute-force resistance now lives in the Argon2id +
 * lockout layer instead of the previous SHA-256 (which was trivially
 * brute-forceable on a 6-digit PIN at billions of guesses per second
 * with a stolen pinHash).
 */

import argon2 from 'react-native-argon2';

export interface VaultFile {
  /** Server object key (`vault/<uuid>`) — what download-url is minted against. */
  objectKey: string;
  /**
   * B-86 — dedup handle back to the source (`msg:<messageId>` for chat
   * attachments, `local:<ts>` for direct uploads). Legacy rows minted
   * before the real pipeline used `msg:<id>` AS the objectKey, so
   * lookups match either field (see vaultOps.findVaultRow).
   */
  sourceKey?: string;
  keyB64:    string;  // AES-256 key (stays on device)
  ivB64:     string;  // AES-256 IV  (stays on device)
  name:      string;
  size:      number;
  mimeType:  string;
  createdAt: number;
}

interface VaultState {
  /**
   * Argon2id-encoded PIN hash including salt + parameters (PHC string
   * format, e.g. "$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>"). Null
   * until the user sets a PIN. Audit fix #35 — PHC format means the
   * salt and parameters travel WITH the hash so we don't need a
   * second column to disambiguate.
   */
  pinHash: string | null;
  /**
   * Audit fix #36 — biometric unlock is opt-in. Defaults to false;
   * the setup screen must explicitly call setBiometricEnabled(true)
   * after the user grants permission.
   */
  biometricEnabled: boolean;
  /** Epoch ms until which the vault stays unlocked. `null` = locked. */
  unlockedUntil: number | null;
  /**
   * Audit fix #37 — monotonic counterpart to `unlockedUntil`. We
   * stamp `performance.now()` (or a JS uptime ms) at unlock and bump
   * the deadline accordingly; isUnlocked checks BOTH wall-clock and
   * monotonic. A clock rollback only moves wall-clock backwards;
   * monotonic keeps advancing, so the vault still locks.
   */
  unlockedUntilMonotonic: number | null;
  /** Local file index — metadata only, ciphertext lives on S3. */
  files: VaultFile[];
  /**
   * Audit fix #35 — brute-force protection counters. Persisted so
   * a restart can't reset.
   */
  failedAttempts: number;
  /** Epoch ms after which verifyPin will accept attempts again. */
  lockoutUntil: number | null;
}

interface VaultActions {
  /** First-time setup. Hashes the PIN and seeds defaults. */
  setupPin: (pin: string) => Promise<void>;
  /**
   * Local PIN check. Returns a discriminated union so the UI can
   * surface lockout state and remaining attempts:
   *   {ok: true}                          — match, unlock window extended
   *   {ok: false, reason, msUntilRetry?}  — denied; reason is 'wrong'
   *                                          or 'lockout'
   */
  verifyPin: (pin: string) => Promise<VerifyResult>;
  /** Biometric path — caller is responsible for actually running LocalAuth. */
  unlockWithBiometric: () => void;
  /** Fast read for gating the lock screen. */
  isUnlocked: () => boolean;
  /** Whether a PIN has ever been set (drives first-time-vs-returning routing). */
  hasPin: () => boolean;
  /** Manual lock — e.g. user taps "lock vault" or app goes to background. */
  lock: () => void;
  /** Change the PIN (only valid after `verifyPin(current)` passed). */
  changePin: (nextPin: string) => Promise<void>;
  /** Toggle the biometric-on-subsequent-unlock preference. */
  setBiometricEnabled: (enabled: boolean) => void;
  /** Add an uploaded file to the local index. */
  addFile: (f: VaultFile) => void;
  /** Remove from local index (server side requires a separate delete call). */
  removeFile: (objectKey: string) => void;
  /** Wipe EVERYTHING — PIN, files, unlock state. Used by "Forgot PIN" flow. */
  reset: () => void;
  /** Reads the lockout / attempt state for the UI. */
  getAttemptStatus: () => {failedAttempts: number; msUntilRetry: number};
}

export type VerifyResult =
  | {ok: true}
  | {ok: false; reason: 'wrong'; remainingAttemptsBeforeLockout: number}
  | {ok: false; reason: 'lockout'; msUntilRetry: number};

/** Vault stays unlocked for 5 min of idle — matches the action-token TTL. */
const UNLOCK_WINDOW_MS = 5 * 60 * 1000;

/**
 * Audit fix #35 — lockout schedule. Tiers picked to defeat realistic
 * brute force on a 4–8 digit PIN: even with a stolen device, an
 * attacker burns 30s / 5m / 1h between guess windows.
 */
const LOCKOUT_TIERS: Array<{atFailures: number; durationMs: number}> = [
  {atFailures: 5,  durationMs: 30_000},          // 30 s
  {atFailures: 10, durationMs: 5  * 60_000},     // 5 min
  {atFailures: 15, durationMs: 60 * 60_000},     // 1 h
];

const initialState: VaultState = {
  pinHash:                null,
  biometricEnabled:       false,    // Audit fix #36 — opt-in
  unlockedUntil:          null,
  unlockedUntilMonotonic: null,
  files:                  [],
  failedAttempts:         0,
  lockoutUntil:           null,
};

/**
 * Audit fix #35 — Argon2id is now the PIN hash. Parameters chosen for
 * mobile: 64 MiB memory, 3 iterations, 1 thread. Tunable per device
 * if we hit perf issues; ~300 ms on a mid-range Android.
 */
async function hashPin(pin: string, salt?: string): Promise<string> {
  // react-native-argon2 takes a string salt; we generate 16 bytes of
  // entropy at setup time and re-use it on each verify (the salt is
  // embedded in the encoded hash output by argon2 native, so we only
  // need to pass it on first hash).
  const useSalt = salt ?? bufToHex(randomBytes(16));
  const result = await argon2(pin, useSalt, {
    iterations:  3,
    memory:      64 * 1024,   // 64 MiB
    parallelism: 1,
    hashLength:  32,
    mode:        'argon2id',
  });
  // The library returns `{rawHash, encoded}` at runtime even though
  // the typings only declare a few fields; reach through `unknown`
  // to grab the encoded PHC string we persist.
  return (result as unknown as {encoded: string}).encoded;
}

/**
 * Audit fix #34 — constant-time string comparison via XOR-fold.
 * The previous `===` short-circuited on the first byte difference,
 * leaking PIN-prefix info via timing. The fold compares EVERY byte
 * even after a mismatch, then checks whether the accumulator stayed
 * zero.
 */
function constantTimeEqStr(a: string, b: string): boolean {
  if (a.length !== b.length) {return false;}
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function bufToHex(u: Uint8Array): string {
  let out = '';
  for (let i = 0; i < u.length; i++) {out += u[i].toString(16).padStart(2, '0');}
  return out;
}

/**
 * Extract the salt from a PHC-encoded argon2 string so we can re-hash
 * on verify with the same parameters. Returns null if the string
 * isn't in the expected shape.
 */
function saltFromPhc(encoded: string): string | null {
  // $argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>
  const parts = encoded.split('$');
  if (parts.length < 6) {return null;}
  return parts[4];
}

/**
 * Audit fix #37 — monotonic time source. `performance.now()` is
 * monotonic per spec; on RN it falls back to Date.now() when the
 * Performance API isn't installed, in which case we degrade
 * gracefully (the wall-clock check is the safety net).
 */
function monotonicNow(): number {
  const p = (globalThis as unknown as {performance?: {now?: () => number}}).performance;
  return typeof p?.now === 'function' ? p.now() : Date.now();
}

/**
 * Audit fix #35 — compute the lockout duration that applies after
 * `failures` failed attempts. Returns 0 below the first tier.
 */
function lockoutDurationFor(failures: number): number {
  let dur = 0;
  for (const tier of LOCKOUT_TIERS) {
    if (failures >= tier.atFailures) {dur = tier.durationMs;}
  }
  return dur;
}

export const useVaultStore = create<VaultState & VaultActions>()(
  persist(
    immer((set, get) => ({
      ...initialState,

      setupPin: async (pin: string) => {
        const pinHash = await hashPin(pin);
        const now = Date.now();
        set(s => {
          s.pinHash = pinHash;
          // Audit fix #36 — do NOT auto-enable biometric. Setup screen
          // must call setBiometricEnabled(true) after explicit consent.
          s.biometricEnabled = false;
          s.unlockedUntil = now + UNLOCK_WINDOW_MS;
          s.unlockedUntilMonotonic = monotonicNow() + UNLOCK_WINDOW_MS;
          s.failedAttempts = 0;
          s.lockoutUntil = null;
        });
      },

      verifyPin: async (pin: string): Promise<VerifyResult> => {
        const state = get();
        if (!state.pinHash) {return {ok: false, reason: 'wrong', remainingAttemptsBeforeLockout: 0};}

        // Audit fix #35 — lockout gate.
        if (state.lockoutUntil && state.lockoutUntil > Date.now()) {
          return {ok: false, reason: 'lockout', msUntilRetry: state.lockoutUntil - Date.now()};
        }

        // Re-hash the candidate with the stored salt so the comparison
        // is between two identically-derived hashes.
        const salt = saltFromPhc(state.pinHash);
        if (!salt) {
          // Stored hash is malformed (legacy SHA-256 string from a
          // pre-fix install). Force a fresh setup — the user has to
          // re-enter their PIN on the next launch.
          set(s => { s.pinHash = null; });
          return {ok: false, reason: 'wrong', remainingAttemptsBeforeLockout: 0};
        }

        let candidate: string;
        try {
          candidate = await hashPin(pin, salt);
        } catch {
          return {ok: false, reason: 'wrong', remainingAttemptsBeforeLockout: 0};
        }

        // Audit fix #34 — constant-time compare.
        const ok = constantTimeEqStr(state.pinHash, candidate);

        if (ok) {
          set(s => {
            s.unlockedUntil = Date.now() + UNLOCK_WINDOW_MS;
            s.unlockedUntilMonotonic = monotonicNow() + UNLOCK_WINDOW_MS;
            s.failedAttempts = 0;
            s.lockoutUntil = null;
          });
          return {ok: true};
        }

        // Increment counter; apply lockout if we just hit a tier.
        let nextFails = 0;
        let lockoutMs = 0;
        set(s => {
          s.failedAttempts += 1;
          nextFails = s.failedAttempts;
          lockoutMs = lockoutDurationFor(s.failedAttempts);
          if (lockoutMs > 0) {
            s.lockoutUntil = Date.now() + lockoutMs;
          }
        });
        if (lockoutMs > 0) {
          return {ok: false, reason: 'lockout', msUntilRetry: lockoutMs};
        }
        // Find the next tier to compute remaining attempts before lockout.
        const nextTier = LOCKOUT_TIERS.find(t => nextFails < t.atFailures);
        return {
          ok: false,
          reason: 'wrong',
          remainingAttemptsBeforeLockout: nextTier ? nextTier.atFailures - nextFails : 0,
        };
      },

      unlockWithBiometric: () => set(s => {
        s.unlockedUntil = Date.now() + UNLOCK_WINDOW_MS;
        s.unlockedUntilMonotonic = monotonicNow() + UNLOCK_WINDOW_MS;
        s.failedAttempts = 0;
        s.lockoutUntil = null;
      }),

      /**
       * Audit fix #37 — locked when EITHER source says expired. Wall
       * clock alone could be rolled back to extend the window; the
       * monotonic source can't be moved backwards by the user. We
       * AND the two checks (both must report still-unlocked) to be
       * conservative.
       */
      isUnlocked: () => {
        const s = get();
        const wallOk = s.unlockedUntil !== null && s.unlockedUntil > Date.now();
        const monoOk = s.unlockedUntilMonotonic !== null
          && s.unlockedUntilMonotonic > monotonicNow();
        return wallOk && monoOk;
      },

      hasPin: () => get().pinHash !== null,

      lock: () => set(s => {
        s.unlockedUntil = null;
        s.unlockedUntilMonotonic = null;
      }),

      changePin: async (nextPin: string) => {
        const pinHash = await hashPin(nextPin);
        set(s => {
          s.pinHash = pinHash;
          s.unlockedUntil = Date.now() + UNLOCK_WINDOW_MS;
          s.unlockedUntilMonotonic = monotonicNow() + UNLOCK_WINDOW_MS;
          s.failedAttempts = 0;
          s.lockoutUntil = null;
        });
      },

      setBiometricEnabled: (enabled: boolean) => set(s => { s.biometricEnabled = enabled; }),

      addFile: (f: VaultFile) => set(s => {
        // Audit M-02/S1 — defense in depth: a row without real key
        // material is a pretend-encrypted entry; refuse it no matter
        // which caller regressed. vaultOps validates before calling.
        if (!f.keyB64 || !f.ivB64 || !f.objectKey) {
          console.warn('[vault] addFile refused a row without key material (M-02)');
          return;
        }
        if (s.files.some(x => x.objectKey === f.objectKey
            || (f.sourceKey && (x.sourceKey === f.sourceKey || x.objectKey === f.sourceKey)))) {return;}
        s.files.unshift(f);
      }),

      removeFile: (objectKey: string) => set(s => {
        s.files = s.files.filter(f => f.objectKey !== objectKey);
      }),

      reset: () => set(() => ({...initialState})),

      getAttemptStatus: () => {
        const s = get();
        const msUntilRetry = s.lockoutUntil ? Math.max(0, s.lockoutUntil - Date.now()) : 0;
        return {failedAttempts: s.failedAttempts, msUntilRetry};
      },
    })),
    {
      name: 'bravo-vault-v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: s => ({
        pinHash:          s.pinHash,
        biometricEnabled: s.biometricEnabled,
        files:            s.files,
        // unlockedUntil / unlockedUntilMonotonic are intentionally NOT
        // persisted — app restart = relock.
        // Audit fix #35 — failedAttempts + lockoutUntil ARE persisted
        // so a restart can't reset the lockout counter.
        failedAttempts:   s.failedAttempts,
        lockoutUntil:     s.lockoutUntil,
      }),
    },
  ),
);
// Suppress an unused-Buffer lint when this file rebuilds — Buffer is
// kept around for future hex helpers without forcing an import-or-die.
void Buffer;
