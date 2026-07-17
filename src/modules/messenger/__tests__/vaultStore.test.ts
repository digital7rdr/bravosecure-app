/**
 * Unit tests for the local vault UX store.
 *
 * Round 3 / vault-test-refactor: this suite was rewritten to match the
 * Round 1 vault hardening:
 *   - setupPin / verifyPin / changePin are now async (Argon2id KDF lives
 *     behind a Promise) → every call site uses await
 *   - verifyPin returns a discriminated union {ok: true} | {ok: false,
 *     reason, …} so caller can surface lockout state
 *   - biometric is opt-in only — setupPin no longer flips it on by
 *     default (Audit fix #36)
 *   - pinHash is now a PHC-formatted Argon2id string ($argon2id$v=19$
 *     m=…,t=…,p=…$salt$hash) — not a 64-char SHA-256 hex
 *
 * Argon2 itself is mocked (see __mocks__/react-native-argon2.ts);
 * sha256(salt || pin) is the deterministic stand-in. The tests assert
 * the round-trip (setupPin → verifyPin matches; wrong pin doesn't),
 * not the cryptographic strength of the KDF (which is exercised by
 * the native build).
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
    },
  };
});

// react-native-quick-crypto is a native module; shim createHash onto
// Node's built-in crypto for unit tests. Production code path is unchanged.
jest.mock('react-native-quick-crypto', () => {
  const nodeCrypto = jest.requireActual('node:crypto');
  return {
    __esModule: true,
    createHash: nodeCrypto.createHash,
    install:    () => {},
    createHmac: nodeCrypto.createHmac,
  };
});

import {useVaultStore, type VaultFile} from '../vault/vaultStore';

function tick(ms: number) {
  jest.setSystemTime(Date.now() + ms);
}

const file = (objectKey: string, overrides: Partial<VaultFile> = {}): VaultFile => ({
  objectKey,
  keyB64:    'k',
  ivB64:     'v',
  name:      `${objectKey}.bin`,
  size:      128,
  mimeType:  'application/octet-stream',
  createdAt: Date.now(),
  ...overrides,
});

describe('vaultStore — local PIN/biometric unlock gate', () => {
  beforeEach(() => {
    // Fake-timer scope is `setTimeout/setInterval/Date` only — leave
    // queueMicrotask / Promise.resolve real so `await` resolves
    // naturally inside the tests.
    jest.useFakeTimers({doNotFake: ['queueMicrotask', 'setImmediate']});
    jest.setSystemTime(new Date('2026-04-21T00:00:00Z'));
    useVaultStore.getState().reset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('setup + verify', () => {
    it('starts with no PIN and locked', () => {
      const s = useVaultStore.getState();
      expect(s.hasPin()).toBe(false);
      expect(s.isUnlocked()).toBe(false);
      expect(s.biometricEnabled).toBe(false);
    });

    it('setupPin stores a PHC-formatted Argon2id hash and leaves biometric OFF', async () => {
      await useVaultStore.getState().setupPin('123456');

      const s = useVaultStore.getState();
      expect(s.hasPin()).toBe(true);
      // Audit fix #36 — biometric must NOT auto-enable on setup. The
      // Setup screen flips it on after explicit consent.
      expect(s.biometricEnabled).toBe(false);
      expect(s.isUnlocked()).toBe(true);
      // PHC string format: `$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>`.
      expect(s.pinHash).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[a-f0-9]+$/);
      expect(s.pinHash).not.toContain('123456');
    });

    it('verifyPin returns ok=false (wrong) when no PIN has been set', async () => {
      const result = await useVaultStore.getState().verifyPin('anything');
      expect(result.ok).toBe(false);
    });

    it('verifyPin matches the exact PIN and rejects others', async () => {
      const {setupPin, verifyPin, lock} = useVaultStore.getState();
      await setupPin('654321');
      lock();

      expect((await verifyPin('654320')).ok).toBe(false);
      expect((await verifyPin('')).ok).toBe(false);
      expect((await verifyPin('654321')).ok).toBe(true);
    });

    it('verifyPin on success opens the unlock window', async () => {
      const {setupPin, verifyPin, lock, isUnlocked} = useVaultStore.getState();
      await setupPin('111111');
      lock();

      expect(isUnlocked()).toBe(false);
      expect((await verifyPin('111111')).ok).toBe(true);
      expect(useVaultStore.getState().isUnlocked()).toBe(true);
    });

    it('verifyPin on failure does NOT open the unlock window', async () => {
      const {setupPin, verifyPin, lock, isUnlocked} = useVaultStore.getState();
      await setupPin('111111');
      lock();

      await verifyPin('000000');
      expect(isUnlocked()).toBe(false);
    });
  });

  describe('unlock window lifecycle', () => {
    it('stays unlocked for the full 5-minute window', async () => {
      await useVaultStore.getState().setupPin('123456');
      tick(4 * 60 * 1000); // 4 minutes in
      expect(useVaultStore.getState().isUnlocked()).toBe(true);
    });

    it('auto-relocks after 5 minutes of idle', async () => {
      await useVaultStore.getState().setupPin('123456');
      tick(5 * 60 * 1000 + 1);
      expect(useVaultStore.getState().isUnlocked()).toBe(false);
    });

    it('biometric unlock extends the window without verifying the PIN', async () => {
      const {setupPin, lock, unlockWithBiometric, isUnlocked} = useVaultStore.getState();
      await setupPin('123456');
      lock();
      expect(isUnlocked()).toBe(false);

      unlockWithBiometric();
      expect(useVaultStore.getState().isUnlocked()).toBe(true);
    });

    it('manual lock() closes the window immediately', async () => {
      const {setupPin, lock} = useVaultStore.getState();
      await setupPin('123456');
      lock();
      expect(useVaultStore.getState().isUnlocked()).toBe(false);
      expect(useVaultStore.getState().unlockedUntil).toBeNull();
    });
  });

  describe('changePin', () => {
    it('replaces the stored hash and keeps the vault unlocked', async () => {
      const {setupPin, changePin, verifyPin, lock} = useVaultStore.getState();
      await setupPin('111111');
      const before = useVaultStore.getState().pinHash;

      await changePin('999999');
      const after = useVaultStore.getState().pinHash;
      expect(after).not.toBe(before);

      lock();
      expect((await verifyPin('111111')).ok).toBe(false);
      expect((await verifyPin('999999')).ok).toBe(true);
    });
  });

  describe('file index', () => {
    it('prepends new files and dedupes by objectKey', () => {
      const {addFile} = useVaultStore.getState();
      addFile(file('a'));
      addFile(file('b'));
      addFile(file('a')); // duplicate — ignored
      expect(useVaultStore.getState().files.map(f => f.objectKey)).toEqual(['b', 'a']);
    });

    it('removeFile drops the matching entry only', () => {
      const {addFile, removeFile} = useVaultStore.getState();
      addFile(file('a'));
      addFile(file('b'));
      addFile(file('c'));
      removeFile('b');
      expect(useVaultStore.getState().files.map(f => f.objectKey)).toEqual(['c', 'a']);
    });
  });

  describe('reset', () => {
    it('wipes PIN, biometric flag, unlock window, and files', async () => {
      const s = useVaultStore.getState();
      await s.setupPin('123456');
      s.addFile(file('a'));

      s.reset();

      const after = useVaultStore.getState();
      expect(after.pinHash).toBeNull();
      expect(after.biometricEnabled).toBe(false);
      expect(after.unlockedUntil).toBeNull();
      expect(after.files).toEqual([]);
    });
  });
});
