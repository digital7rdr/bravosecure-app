/**
 * Audit P0-8 — `resolveExpectedSenderIdentity` resolves the trusted
 * identity key for an inbound envelope sender before the cert verify.
 *
 * Three branches under test:
 *   1. local trust row present → return base64 of stored key
 *   2. local missing, bundle fetch succeeds → return bundle.identityKey
 *      (authority-attested via P0-I2 inside `KeysHttpClient`)
 *   3. local missing, bundle fetch throws → return undefined so the
 *      caller falls back to a signature-only cert verify (legacy
 *      availability path)
 *
 * Stubs CryptoStore and KeysHttpClient minimally; no network, no
 * libsignal in the loop.
 */

import {resolveExpectedSenderIdentity} from '../crypto/expectedSenderIdentity';
import {toBase64, type CryptoStore, type KeysHttpClient, type SessionAddress} from '@bravo/messenger-core';

function makeKey(seed: number): ArrayBuffer {
  const u8 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {u8[i] = (seed + i) & 0xff;}
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

function makeStore(seedByAddr: Record<string, number>): CryptoStore {
  const map = new Map<string, ArrayBuffer>();
  for (const [addr, seed] of Object.entries(seedByAddr)) {
    map.set(addr, makeKey(seed));
  }
  return {
    async loadIdentityKey(addr: string) { return map.get(addr); },
    // Other methods are not exercised by the helper; provide no-op
    // stubs typed via `as unknown as CryptoStore` so we don't have to
    // implement the full surface.
  } as unknown as CryptoStore;
}

function makeKeysOk(identityKeyB64: string): KeysHttpClient {
  return {
    async fetchPeerBundleWithPoolSize() {
      return {
        bundle: {
          registrationId: 1,
          address: {userId: 'whatever', deviceId: 1},
          identityKey: identityKeyB64,
          signedPreKey: {keyId: 1, publicKey: 'x', signature: 'y'},
        },
        poolSize: 50,
      };
    },
  } as unknown as KeysHttpClient;
}

function makeKeysThrow(err: Error): KeysHttpClient {
  return {
    async fetchPeerBundleWithPoolSize() { throw err; },
  } as unknown as KeysHttpClient;
}

describe('audit P0-8 — resolveExpectedSenderIdentity', () => {
  const peer: SessionAddress = {userId: 'alice', deviceId: 1};
  const addrKey = 'alice.1';

  it('returns the locally-stored identity when present (fast path, no fetch)', async () => {
    const store = makeStore({[addrKey]: 7});
    const expected = toBase64(makeKey(7));
    // Use a keys client that would throw if called — proves the local
    // branch short-circuits and never touches the network.
    const keys = makeKeysThrow(new Error('should not be called'));
    const got = await resolveExpectedSenderIdentity(peer, store, keys);
    expect(got).toBe(expected);
  });

  it('returns the authority-signed bundle identity on cold contact (local missing)', async () => {
    const store = makeStore({}); // no local row
    const bundleIdentity = toBase64(makeKey(99));
    const keys = makeKeysOk(bundleIdentity);
    const got = await resolveExpectedSenderIdentity(peer, store, keys);
    expect(got).toBe(bundleIdentity);
  });

  it('returns undefined when local missing AND bundle fetch throws (dual failure)', async () => {
    const store = makeStore({});
    const keys = makeKeysThrow(new Error('keys-service unreachable'));
    const got = await resolveExpectedSenderIdentity(peer, store, keys);
    expect(got).toBeUndefined();
  });

  it('returns undefined when local missing AND bundle fetch throws a KeysHttpError(495) (P0-I2 attack path)', async () => {
    // Models the case where the keys-service tried to substitute and
    // the authority signature failed: KeysHttpClient throws 495 and
    // the helper returns undefined. Caller then drops the cert
    // continuity check, but the cert SIGNATURE itself still runs in
    // verifySenderCert — so a forged cert from a substituted bundle
    // still fails at the next layer.
    const store = makeStore({});
    const httpErr = new Error('bundle_authority_sig_invalid: tampered');
    (httpErr as Error & {status?: number}).status = 495;
    const keys = makeKeysThrow(httpErr);
    const got = await resolveExpectedSenderIdentity(peer, store, keys);
    expect(got).toBeUndefined();
  });

  it('isolates resolution per address — peer-A lookup does not return peer-B key', async () => {
    const store = makeStore({
      'alice.1': 1,
      'bob.1':   2,
    });
    const keys = makeKeysThrow(new Error('should not be called'));
    const alice = await resolveExpectedSenderIdentity({userId: 'alice', deviceId: 1}, store, keys);
    const bob   = await resolveExpectedSenderIdentity({userId: 'bob',   deviceId: 1}, store, keys);
    expect(alice).toBe(toBase64(makeKey(1)));
    expect(bob).toBe(toBase64(makeKey(2)));
    expect(alice).not.toBe(bob);
  });

  it('treats different deviceIds for the same userId as distinct addresses', async () => {
    const store = makeStore({
      'alice.1': 1,
      'alice.2': 5,
    });
    const keys = makeKeysThrow(new Error('should not be called'));
    const dev1 = await resolveExpectedSenderIdentity({userId: 'alice', deviceId: 1}, store, keys);
    const dev2 = await resolveExpectedSenderIdentity({userId: 'alice', deviceId: 2}, store, keys);
    expect(dev1).toBe(toBase64(makeKey(1)));
    expect(dev2).toBe(toBase64(makeKey(5)));
    expect(dev1).not.toBe(dev2);
  });
});
