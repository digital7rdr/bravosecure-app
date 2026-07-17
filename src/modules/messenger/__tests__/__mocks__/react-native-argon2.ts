/**
 * Jest mock for `react-native-argon2`.
 *
 * The real library shells out to a native Android/iOS Argon2id
 * implementation; under Jest we only have Node, so we substitute a
 * deterministic stub that produces PHC-formatted output. The stub
 * uses sha256(salt || pin) as the "hash" field — NOT a real KDF, but
 * deterministic enough for the vault-store unit tests to verify the
 * setupPin → verifyPin round-trip without invoking native code.
 *
 * Round 3 / vault-test-refactor item: this mock is the "1-2 hour fix"
 * called out in docs/planning/REMAINING_TODO.md. The vaultStore tests assert that
 * setupPin produces a pinHash, verifyPin returns ok=true on the right
 * pin, and ok=false (with reason='wrong') on the wrong one — none of
 * which need a real Argon2 implementation.
 *
 * Signature mirrors the runtime library's positional form:
 *   argon2(password: string, salt: string, options?: Argon2Options)
 */
import {createHash} from 'node:crypto';

interface Argon2Options {
  iterations?: number;
  memory?: number;
  parallelism?: number;
  hashLength?: number;
  mode?: 'argon2i' | 'argon2d' | 'argon2id';
}

interface Argon2Result {
  rawHash: string;
  encoded: string;
}

export default async function argon2(
  password: string,
  salt: string,
  options?: Argon2Options,
): Promise<Argon2Result> {
  const iter = options?.iterations ?? 3;
  const mem  = options?.memory ?? 65536;
  const par  = options?.parallelism ?? 1;
  // Deterministic stand-in: sha256(salt || password). Not a KDF, just
  // produces a stable bytes-of-hash field for round-trip verification.
  const h = createHash('sha256').update(salt + password).digest('hex');
  const encoded = `$argon2id$v=19$m=${mem},t=${iter},p=${par}$${salt}$${h}`;
  return {rawHash: h, encoded};
}
