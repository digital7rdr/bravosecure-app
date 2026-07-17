/**
 * frameCryptorOrchestrator — mobile group-call E2E media encryption via
 * libwebrtc's native FrameCryptor (io.getstream:stream-webrtc-android).
 *
 * Why this exists
 * ---------------
 * The platform-agnostic `GroupCallEncryption` (messenger-core) runs the
 * SFrame cipher in JS over the `RTCRtpScriptTransform` /
 * `createEncodedStreams` encoded-frame API. Stock react-native-webrtc
 * 124.x on Android does NOT expose that API, so that path always refuses
 * (logcat: "SFrame unavailable on this build"). The architecture
 * amendment (docs/ARCHITECTURE_AMENDMENT_SFRAME.md) mandates the native
 * FrameCryptor instead, exposed via the BravoFrameCryptor Kotlin module
 * and bridged by frameCryptorTransport.ts.
 *
 * This orchestrator wires that native path into the same lifecycle the
 * hook expects from GroupCallEncryption:
 *   - one key provider per call
 *   - per-(participantTag, epoch) AES-256 key derived on-device from the
 *     group master key (deriveParticipantKey — proven by
 *     frameCryptorKeys.test.ts) and pushed via setKey
 *   - attachSender / attachReceiver return a detacher (disposeCryptor)
 *   - rekey on member add/remove advances the epoch → re-derive + setKey
 *
 * Refusal contract (UNCHANGED from the old path): if the native module
 * is unavailable the orchestrator cannot be constructed (ensureAvailable
 * throws) and the caller MUST refuse to start the call. There is NEVER a
 * silent fallback to plaintext-on-SFU.
 *
 * SECURITY NOTE: the AES-256-GCM cipher runs natively inside libwebrtc.
 * This TS layer only derives + pushes keys and attaches cryptors. That
 * the native cryptor actually encrypts media end-to-end can only be
 * verified on a real device with a multi-party call (see the migration
 * checklist). Key derivation is unit-tested; native encryption is not.
 */
import {
  isAvailable as frameCryptorAvailable,
  createKeyProvider,
  setKey,
  attachSender,
  attachReceiver,
  setCryptorEnabled,
  disposeCryptor,
  disposeKeyProvider,
  getPeerConnectionNumericId,
} from './frameCryptorTransport';
import {
  deriveParticipantKey,
  epochToKeyIndex,
} from '@bravo/messenger-core';

export type MediaKind = 'audio' | 'video';

export interface FrameCryptorKeySource {
  /** Current master key + epoch, or null if the group isn't known. */
  current(conversationId: string): {masterKeyB64: string; epoch: number} | null;
  /** Subscribe to (masterKeyB64, epoch) changes. Returns unsubscribe. */
  subscribe(
    conversationId: string,
    listener: (next: {masterKeyB64: string; epoch: number}) => void,
  ): () => void;
}

export interface FrameCryptorOrchestratorOptions {
  conversationId: string;
  /** Local participant's SFU-assigned tag. */
  selfTag: string;
  keySource: FrameCryptorKeySource;
}

/** True iff the native FrameCryptor path can run on this platform/build. */
export function frameCryptorOrchestratorAvailable(): boolean {
  return frameCryptorAvailable();
}

export class FrameCryptorOrchestrator {
  private readonly conversationId: string;
  private readonly selfTag: string;
  private readonly keySource: FrameCryptorKeySource;

  private keyProviderId: string | null = null;
  private epoch = 0;
  // participantTag -> highest key index we've pushed (so we don't re-push
  // an identical (tag, epoch) needlessly).
  private pushedIndex = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(opts: FrameCryptorOrchestratorOptions) {
    if (!frameCryptorAvailable()) {
      // Mirror frameCryptorTransport.ensureAvailable — fail closed.
      throw new Error(
        'FrameCryptorOrchestrator: native FrameCryptor unavailable — refusing to start unencrypted group call',
      );
    }
    this.conversationId = opts.conversationId;
    this.selfTag = opts.selfTag;
    this.keySource = opts.keySource;
  }

  /**
   * Create the native key provider and push the local participant's key
   * for the current epoch. MUST be awaited before any attach* call.
   */
  async init(): Promise<void> {
    if (this.keyProviderId) {return;}
    const cur = this.keySource.current(this.conversationId);
    if (!cur) {
      throw new Error('FrameCryptorOrchestrator: no group master key — refusing to start');
    }
    this.epoch = cur.epoch;
    this.keyProviderId = await createKeyProvider();
    // Push the local key up front so our own outbound frames have a key.
    await this.pushKey(this.selfTag, cur.masterKeyB64, cur.epoch);

    // React to master-key / epoch rotation (member add/remove). On every
    // change we advance the epoch and re-push every known participant's
    // key so removed members' keys stop decrypting new frames.
    this.unsubscribe = this.keySource.subscribe(this.conversationId, (next) => {
      void this.rotate(next.masterKeyB64, next.epoch).catch((e) => {
        console.warn('[bravo.groupcall.fc] rekey failed:', (e as Error).message);
      });
    });
  }

  private async pushKey(participantTag: string, masterKeyB64: string, epoch: number): Promise<void> {
    if (!this.keyProviderId || this.disposed) {return;}
    const idx = epochToKeyIndex(epoch);
    if (this.pushedIndex.get(participantTag) === idx) {return;}
    const keyB64 = await deriveParticipantKey(masterKeyB64, epoch, participantTag);
    await setKey(this.keyProviderId, participantTag, idx, keyB64);
    this.pushedIndex.set(participantTag, idx);
  }

  private async rotate(masterKeyB64: string, epoch: number): Promise<void> {
    if (this.disposed) {return;}
    this.epoch = epoch;
    // Re-derive for every participant we currently hold a key for.
    const tags = Array.from(this.pushedIndex.keys());
    // Reset the dedupe map so pushKey re-derives at the new index.
    this.pushedIndex.clear();
    // Audit GC-07 (2026-07-02): push each participant's new key
    // INDEPENDENTLY. A single failing setKey used to throw out of this loop,
    // leaving every not-yet-rotated participant with NO key at the new index
    // (pushedIndex was already cleared) → their media became permanently
    // undecryptable (black/silent tiles) after a mid-call rekey (member
    // add/remove), with no retry. Per-tag try/catch keeps the rest advancing;
    // failed tags get one retry.
    const failed: string[] = [];
    for (const tag of tags) {
      try { await this.pushKey(tag, masterKeyB64, epoch); }
      catch (e) { failed.push(tag); console.warn(`[bravo.groupcall.fc] rekey push failed tag=${tag.slice(0, 6)}:`, (e as Error).message); }
    }
    for (const tag of failed) {
      if (this.disposed) {return;}
      try { await this.pushKey(tag, masterKeyB64, epoch); }
      catch (e) { console.warn(`[bravo.groupcall.fc] rekey retry failed tag=${tag.slice(0, 6)}:`, (e as Error).message); }
    }
  }

  /**
   * Ensure a remote participant's key is loaded before we attach a
   * decrypt cryptor for their stream. Idempotent.
   */
  async ensureParticipantKey(participantTag: string): Promise<void> {
    const cur = this.keySource.current(this.conversationId);
    if (!cur) {throw new Error('FrameCryptorOrchestrator: master key vanished mid-call');}
    await this.pushKey(participantTag, cur.masterKeyB64, cur.epoch);
  }

  /**
   * Attach an encrypt cryptor to a local producer's RtpSender.
   * Returns a detacher. `pc` is the send transport's underlying
   * RTCPeerConnection (mediasoup: transport.handler._pc).
   */
  async attachSenderCryptor(
    rtpSender: {id: string},
    pc: unknown,
    kind: MediaKind,
  ): Promise<() => void> {
    if (!this.keyProviderId) {throw new Error('FrameCryptorOrchestrator.init() not called');}
    const pcId = getPeerConnectionNumericId(pc);
    if (pcId === null) {throw new Error('FrameCryptorOrchestrator: could not resolve sender PC id');}
    const cryptorId = await attachSender(this.keyProviderId, rtpSender, pcId, this.selfTag);
    await setCryptorEnabled(cryptorId, true);
    void kind; // kind kept for parity/logging; native keys are per-participant, not per-kind
    return () => { void disposeCryptor(cryptorId); };
  }

  /**
   * Attach a decrypt cryptor to a remote consumer's RtpReceiver.
   * Returns a detacher.
   */
  async attachReceiverCryptor(
    rtpReceiver: {id: string},
    pc: unknown,
    participantTag: string,
  ): Promise<() => void> {
    if (!this.keyProviderId) {throw new Error('FrameCryptorOrchestrator.init() not called');}
    await this.ensureParticipantKey(participantTag);
    const pcId = getPeerConnectionNumericId(pc);
    if (pcId === null) {throw new Error('FrameCryptorOrchestrator: could not resolve receiver PC id');}
    const cryptorId = await attachReceiver(this.keyProviderId, rtpReceiver, pcId, participantTag);
    await setCryptorEnabled(cryptorId, true);
    return () => { void disposeCryptor(cryptorId); };
  }

  dispose(): void {
    if (this.disposed) {return;}
    this.disposed = true;
    try { this.unsubscribe?.(); } catch { /* ignore */ }
    this.unsubscribe = null;
    if (this.keyProviderId) {
      const id = this.keyProviderId;
      this.keyProviderId = null;
      void disposeKeyProvider(id);
    }
    this.pushedIndex.clear();
  }
}
