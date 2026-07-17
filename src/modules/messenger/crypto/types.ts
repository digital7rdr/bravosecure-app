/**
 * Wire-format and domain types for the Signal Protocol layer.
 * Internal libsignal types stay behind this boundary.
 */

export type Base64 = string;
export type UserId = string;
export type DeviceId = number;

/**
 * A user/device pair identifies a Signal session endpoint.
 * Matches libsignal's SignalProtocolAddress.toString() form: `${userId}.${deviceId}`.
 */
export interface SessionAddress {
  userId: UserId;
  deviceId: DeviceId;
}

/**
 * Long-lived identity key for a user. Created once at install time and
 * attested via the signed pre-key. Fingerprint shown in safety-number UI.
 */
export interface IdentityKeyPair {
  publicKey: Base64;
  privateKey: Base64;
}

/**
 * Signed pre-key: medium-lived, rotated on a schedule. Signature is made
 * by the identity key so peers can verify authenticity before X3DH.
 */
export interface SignedPreKey {
  keyId: number;
  publicKey: Base64;
  privateKey: Base64;
  signature: Base64;
  createdAt: number;
}

/**
 * One-time pre-key: consumed on first use during X3DH. The server pool
 * should be replenished when it drops below a threshold.
 */
export interface OneTimePreKey {
  keyId: number;
  publicKey: Base64;
  privateKey: Base64;
}

/**
 * Public bundle a peer fetches from the server to start a new session.
 * Never contains private material. `preKey` is optional — if the server
 * has exhausted one-time keys, X3DH falls back to signed-pre-key only.
 */
export interface PreKeyBundle {
  registrationId: number;
  address: SessionAddress;
  identityKey: Base64;
  signedPreKey: {
    keyId: number;
    publicKey: Base64;
    signature: Base64;
  };
  preKey?: {
    keyId: number;
    publicKey: Base64;
  };
}

/**
 * libsignal distinguishes the first message in a session (carries the
 * X3DH handshake payload) from all subsequent ratchet messages.
 */
export enum CiphertextType {
  PreKeyWhisper = 3,
  Whisper = 1,
}

/**
 * Output of SessionCipher.encrypt — this is what gets wrapped in the
 * sealed-sender envelope and pushed to the relay service.
 */
export interface Ciphertext {
  type: CiphertextType;
  body: Base64;
}

/**
 * Sealed-sender envelope: the relay sees only the recipient address and
 * an opaque ciphertext. Sender identity is encrypted inside.
 * Matches the Signal Sealed Sender v2 shape we'll serialize to the gateway.
 */
export interface SealedEnvelope {
  recipient: SessionAddress;
  ciphertext: Ciphertext;
  timestamp: number;
  /** Server-assigned UUID for ACK + dwell tracking. Set by relay on ingest. */
  envelopeId?: string;
}

export enum IdentityDirection {
  Sending = 1,
  Receiving = 2,
}

/**
 * Storage contract the Signal session layer requires. Implemented by
 * SqlCipherProtocolStore (prod) and InMemoryProtocolStore (tests).
 * Keys are intentionally kept as ArrayBuffer at this boundary because
 * libsignal-protocol-typescript expects them in that form.
 */
export interface CryptoStore {
  getIdentityKeyPair(): Promise<{ pubKey: ArrayBuffer; privKey: ArrayBuffer }>;
  getLocalRegistrationId(): Promise<number>;

  isTrustedIdentity(
    identifier: string,
    identityKey: ArrayBuffer,
    direction: IdentityDirection
  ): Promise<boolean>;
  saveIdentity(identifier: string, identityKey: ArrayBuffer): Promise<boolean>;
  loadIdentityKey(identifier: string): Promise<ArrayBuffer | undefined>;

  loadPreKey(keyId: number): Promise<{ pubKey: ArrayBuffer; privKey: ArrayBuffer } | undefined>;
  storePreKey(keyId: number, keyPair: { pubKey: ArrayBuffer; privKey: ArrayBuffer }): Promise<void>;
  removePreKey(keyId: number): Promise<void>;

  loadSignedPreKey(
    keyId: number
  ): Promise<{ pubKey: ArrayBuffer; privKey: ArrayBuffer; signature?: ArrayBuffer } | undefined>;
  storeSignedPreKey(
    keyId: number,
    keyPair: { pubKey: ArrayBuffer; privKey: ArrayBuffer },
    signature?: ArrayBuffer
  ): Promise<void>;
  removeSignedPreKey(keyId: number): Promise<void>;
  /** Audit P0-I1 — see package mirror in `packages/messenger-core/src/crypto/types.ts`. */
  listSignedPreKeys?(): Promise<Array<{keyId: number; createdAt: number}>>;

  loadSession(identifier: string): Promise<string | undefined>;
  storeSession(identifier: string, record: string): Promise<void>;
  removeSession(identifier: string): Promise<void>;
  removeAllSessions(identifier: string): Promise<void>;
  /** Audit P1 — optional session iterator used by the ratchet-snapshot backup. */
  listSessions?(): Promise<Array<{identifier: string; record: string}>>;
}
