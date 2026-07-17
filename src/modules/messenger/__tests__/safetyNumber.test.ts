import {computeSafetyNumber} from '../crypto/safetyNumber';

// 5200 awaited SHA-256 iterations per call: each test does up to 2
// calls, and slow WebCrypto microtask scheduling on some hosts pushes
// past Jest's default 30 s. The work itself is fixed-size and
// deterministic — raising the cap doesn't mask a regression.
jest.setTimeout(60_000);

const keyA = new Uint8Array(32);
const keyB = new Uint8Array(32);
for (let i = 0; i < 32; i++) {
  keyA[i] = i;
  keyB[i] = 255 - i;
}

describe('computeSafetyNumber', () => {
  it('returns 12 groups of 5 digits separated by spaces', async () => {
    const code = await computeSafetyNumber(keyA, keyB);
    const groups = code.split(' ');
    expect(groups).toHaveLength(12);
    for (const g of groups) {
      expect(g).toMatch(/^\d{5}$/);
    }
  });

  it('is order-independent: both peers compute the same code', async () => {
    const fromA = await computeSafetyNumber(keyA, keyB);
    const fromB = await computeSafetyNumber(keyB, keyA);
    expect(fromA).toBe(fromB);
  });

  it('changes when either identity key changes', async () => {
    const baseline = await computeSafetyNumber(keyA, keyB);
    const altA = new Uint8Array(keyA);
    altA[0] ^= 1;
    const altCode = await computeSafetyNumber(altA, keyB);
    expect(altCode).not.toBe(baseline);
  });

  it('accepts ArrayBuffer and Uint8Array interchangeably', async () => {
    const codeU8 = await computeSafetyNumber(keyA, keyB);
    const codeAb = await computeSafetyNumber(
      keyA.buffer.slice(keyA.byteOffset, keyA.byteOffset + keyA.byteLength),
      keyB.buffer.slice(keyB.byteOffset, keyB.byteOffset + keyB.byteLength),
    );
    expect(codeU8).toBe(codeAb);
  });
});
