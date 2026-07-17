/**
 * useGroupCall — mediasoup-client SFU group call with WhatsApp-style
 * ringing, end-to-end identity binding, and host-only moderation.
 *
 * Lifecycle (matches the server sfu.* protocol verbatim):
 *
 *   1. POST /sfu/rooms (with conversationId)         → opaque roomId
 *      (server reuses the existing room if one is live for this convo)
 *   2. WS  sfu.ring (on outgoing only)               → fans rings to recipients
 *   3. WS  sfu.join {roomId}                          → routerRtpCaps,
 *                                                       send + recv transport params,
 *                                                       participantTag, isHost,
 *                                                       existingProducers
 *   4. Device.load({routerRtpCapabilities})
 *   5. Device.createSendTransport(sendParams)         → relay-only ICE
 *      .on('connect',  ...) → sfu.transport.connect
 *      .on('produce',  ...) → sfu.produce
 *   6. Device.createRecvTransport(recvParams)         → same connect plumbing
 *   7. Broadcast `groupCallPresence` envelope to every other group
 *      member so they can map our opaque participantTag to our display
 *      name. SFU never sees the mapping.
 *   8. produce(local audio + (video if isVideo)) → server fans `sfu.new-producer`
 *   9. for each existing + new producer:
 *        WS sfu.consume → consumerId, rtpParameters
 *        recvTransport.consume → MediaStream tile
 *        WS sfu.consumer.resume → media starts flowing
 *  10. Listen for sfu.muted / sfu.kicked → flip state / leave
 *  11. WS sfu.leave on hangup; clear identity registry.
 *
 * Security:
 *   - DTLS-SRTP terminates between client and the SFU's WebRtcTransport
 *   - Media is SRTP-encrypted on the wire — the SFU forwards SRTP
 *     packets without decrypting
 *   - participantTag is opaque (server-issued randomUUID) — the SFU
 *     access log never sees userIds
 *   - Identity (tag → displayName) ships through the existing E2E
 *     pairwise Signal sessions, never through the SFU
 */
import {useEffect, useRef, useState, useCallback} from 'react';
import type { types as MediasoupTypes} from 'mediasoup-client';
import {Device} from 'mediasoup-client';
type Transport = MediasoupTypes.Transport;
type Producer  = MediasoupTypes.Producer;
type Consumer  = MediasoupTypes.Consumer;

/**
 * Audit BS-LEAK — minimize→restore mediasoup-handle holder.
 *
 * The boot hook owns the live mediasoup objects (Device, send/recv
 * Transports, Producers, Consumers, SFrame detachers, GroupCallEncryption)
 * inside its useRef closures. On minimize, keepAlive skips the unmount
 * teardown so the call keeps running — but the boot hook instance is then
 * gone, and its refs become unreachable. The RESTORED hook gets FRESH,
 * empty refs; the registry-sync effect re-binds `leave` to the restored
 * hook's leaveInternal, whose refs are null — so ending the call after a
 * restore closed NOTHING and leaked every transport/producer/consumer +
 * the camera/mic until process death.
 *
 * Fix: stash the live handles here (module-level, keyed by roomId) at the
 * end of boot, and rehydrate the restored hook's refs from this holder on
 * the adopt path. The holder is cleared by leaveInternal on real teardown
 * and by the logout reset, so it never outlives the call.
 *
 * It deliberately holds the SAME ref-container objects (the Maps/arrays),
 * not copies, so a producer consumed AFTER stash (via the original
 * handler, during the minimize window) is still visible to the restored
 * hook's teardown.
 */
interface LiveSfuHandles {
  device:               Device | null;
  sendTx:               Transport | null;
  recvTx:               Transport | null;
  transport:            TransportClient | null;
  producers:            Producer[];
  consumersByPid:       Map<string, Consumer>;
  consumerCleanups:     Map<string, Array<() => void>>;
  sframeDetachers:      Array<() => void>;
  groupEncryption:      FrameCryptorOrchestrator | null;
  participantTag:       string | null;
  // Audit F6 — the CURRENT registered SFU frame-handler's cleanup fn, stashed
  // at module scope so the restore/adopt path (a fresh hook instance whose own
  // cleanupSubRef is null) can GENUINELY release the prior handler before
  // registering its own. Without this the release was a no-op and every
  // minimize→restore leaked another handler (memory + double-consume).
  handlerCleanup?:      (() => void) | null;
  // Audit L14 — the boot IIFE's rejoin fn + the room token, stashed so the
  // restore/adopt path can re-arm ws.onReconnect→rejoin recovery (the adopt
  // path had none, so a WS drop after a minimize→restore zombied the call).
  rejoinRoom?:          ((joined: SfuJoinedResp) => Promise<void>) | null;
  roomToken?:           string;
}
const liveSfuHandlesByRoom = new Map<string, LiveSfuHandles>();

/**
 * Audit GC-06 (2026-07-02): mediasoup starts shipping RTP the moment
 * `produce()` resolves, but the SFrame sender cryptor can only attach to the
 * RtpSender AFTER produce returns it — leaving a brief window where real
 * frames reach the SFU unencrypted at the SFrame layer (still DTLS-SRTP on
 * the wire, but the SFU could see plaintext media). Blank the track
 * (enabled=false → black frames / silence) for the produce→attach window so
 * nothing meaningful leaves the device before the cryptor is live. Restores
 * the prior enabled state even on throw.
 */
async function withTrackBlanked<T>(track: unknown, fn: () => Promise<T>): Promise<T> {
  const t = track as {enabled?: boolean} | null | undefined;
  const wasEnabled = t?.enabled === true;
  if (t && wasEnabled) {t.enabled = false;}
  try { return await fn(); }
  finally { if (t && wasEnabled) {t.enabled = true;} }
}

/** Logout reset — drop any stashed handles so they don't pin a prior user's transports. */
export function clearAllLiveSfuHandles(): void {
  liveSfuHandlesByRoom.clear();
}
import type { MediaStreamTrack} from 'react-native-webrtc';
import {MediaStream, mediaDevices} from 'react-native-webrtc';
import {getLocalMedia, recoverGroupCamera} from './peerConnectionFactory';
// SFU rooms + TURN credentials are served by the messenger-service
// (NOT auth-service). Hitting MSG_BASE_URL gave 404 in staging because
// auth.94-136-184-52.sslip.io has no /sfu/* or /webrtc/* routes — the
// SFU + TURN controllers are mounted on relay.94-136-184-52.sslip.io.
import {MSG_BASE_URL} from '@utils/constants';
// BS-GC-ICE — release-visible diagnostics. `console.*` is NOT routed to
// logcat on a release Hermes build, so group-call media failures were
// invisible in field logs. crashLog writes a Crashlytics breadcrumb
// (PII-redacted) so the selected ICE candidate pair + TURN result show up
// in the Firebase console for a device whose media won't traverse.
import {log as crashLog} from '../../observability/crashlytics';
import {getLiveTransport} from '../runtime/transportRegistry';
import {registerSfuHandler} from './sfuDispatcher';
import {shouldSendRingCancel} from './ringCancelDecision';
import {isVideoForCall} from './groupCallMediaMode';
import {waitForGroupCallKey, armVideoEncryptorRetry} from './groupCallKeyWait';
import {attemptSfuRejoin} from './groupCallReconnect';
import {createEarlyProducerBuffer} from './groupCallProducerBuffer';
import type {EarlyProducerBuffer} from './groupCallProducerBuffer';
import {getMessengerRuntime} from '../runtime/runtime';
import {
  onGroupCallIdentities,
  recordGroupCallIdentity,
  getGroupCallIdentities,
  clearRoomIdentities,
} from './groupCallIdentityRegistry';
import {computeTilePrune, applyProducerPaused, applyProducerPausedFrame} from './groupCallLayout';
import {
  setActiveGroupCall, patchActiveGroupCall, getActiveGroupCall, endActiveGroupCall,
  onActiveGroupCallChange, seedRosterForRepublish,
} from '../runtime/groupCallRegistry';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';
import type {TransportClient} from '@bravo/messenger-core';
import {messengerStoreKeySource} from './messengerStoreKeySource';
// BS-GC-FC — group-call E2E media encryption now runs through the native
// FrameCryptor (io.getstream:stream-webrtc-android) rather than the JS
// encoded-transform path, which stock react-native-webrtc 124.x doesn't
// expose (that path always refused: "SFrame unavailable on this build").
// See docs/ARCHITECTURE_AMENDMENT_SFRAME.md and frameCryptorOrchestrator.ts.
import {
  FrameCryptorOrchestrator,
  frameCryptorOrchestratorAvailable,
} from './frameCryptorOrchestrator';

export type GroupCallState =
  | 'idle'
  | 'unavailable'   // SFU returned an error or transport missing
  | 'creating'
  | 'joining'
  | 'joined'
  | 'reconnecting'  // mediasoup transport disconnected, ICE restart in flight
  | 'left'
  | 'failed'
  | 'kicked'
  | 'ended-by-host' // Host left → server fired sfu.room.ended → we tore down
  | 'full';

export interface RemoteTile {
  participantTag: string;
  consumerId:     string;
  producerId:     string;
  kind:           'audio' | 'video';
  stream:         MediaStream;
  // Set when the remote producer pauses (peer toggles camera/mic off).
  // The track + streamURL stay valid (RTCView keeps the last frame on
  // screen), so we need this flag to switch the tile to its "Camera
  // off" placeholder instead of freezing on the last decoded frame.
  paused?:        boolean;
}

/**
 * Per-participant audio level snapshot, polled from the recv
 * transport's RTCStatsReport once every 500 ms. Drives the
 * "loudest speaker becomes hero" logic on page 1 of the group call
 * grid. Values are normalised 0..1.
 */
export interface AudioLevelMap {
  [participantTag: string]: number;
}

export interface GroupCallOptions {
  /** Pre-existing roomId (joining an existing call). Omit to create. */
  roomId?:        string;
  /** Conversation that owns this call — used for ring + history bubble. */
  conversationId: string;
  callType:       'voice' | 'video';
  /**
   * `outgoing` rings everyone (sfu.ring); `incoming` joins straight in
   * (the ring was already handled by IncomingGroupCallScreen).
   */
  direction:      'outgoing' | 'incoming';
  /** Group members to ring (all of them — server filters self). */
  recipientUserIds: string[];
  /** Display name to advertise to peers via the identity envelope. */
  ownDisplayName:  string;
  /** Caller-supplied label shown in recipients' incoming-call UI. */
  callerName:      string;
  /**
   * BS-CALL-ADHOC — host/owner userId of an ad-hoc ('Call') group. The
   * host files the call master key under `direct:<owner>` on every
   * recipient; the joiner must look it up under that SAME id rather than
   * its own asymmetric `conversationId` (the host's local thread key,
   * which resolves to a different user on the joiner's device). Present
   * only on the incoming path (threaded from the ring's `from.userId`).
   */
  hostUserId?:     string;
  /**
   * Audit P0-C2 / row #5 — per-recipient HMAC room-access token. Echo
   * in `sfu.join` so the gateway admits the join. Incoming direction
   * receives it from `sfu.ring.incoming`; outgoing direction (host)
   * gets a self-token from `POST /sfu/rooms` and uses it here.
   * Optional in the opts because dev configs without
   * `SFU_ROOM_TOKEN_SECRET` skip the gate.
   */
  roomToken?:      string;
}

export interface GroupCallHandle {
  state:         GroupCallState;
  roomId:        string | null;
  isHost:        boolean;
  selfTag:       string | null;
  localStream:   MediaStream | null;
  remoteTiles:   RemoteTile[];
  identityByTag: Record<string, {displayName: string; userId?: string}>;
  isMuted:       boolean;
  isVideoOff:    boolean;
  /** True when the local camera is the front (selfie) lens. Flipped by switchCamera. */
  isFrontCamera: boolean;
  /**
   * Live audio level per participantTag, normalised 0..1. Updated on
   * a 500 ms tick from the recv transport's RTCStatsReport. The UI
   * uses this to elevate the loudest speaker to the hero slot on
   * page 1 of the grid, matching the Google Meet / WhatsApp model.
   */
  audioLevels:   AudioLevelMap;
  /**
   * B-15 — participantTags whose live (non-paused) video consumer has
   * delivered 0 decoded frames for >3s. The UI shows a "Video unavailable"
   * overlay on these tiles so the user can tell a stalled/undecodable
   * stream apart from a peer who simply turned their camera off.
   */
  videoStalledTags: Record<string, boolean>;
  toggleMute:    () => void;
  toggleVideo:   () => Promise<void>;
  /**
   * Flip the local camera between front and back. Client-only: calls
   * `_switchCamera()` on the existing local video track, which the
   * react-native-webrtc camera capturer toggles in place — no track
   * replacement, no SDP renegotiation, no SFU/relay involvement, and
   * the SFrame-encrypted producer keeps streaming uninterrupted.
   * No-op (returns false) when there's no live video track.
   */
  switchCamera:  () => boolean;
  /**
   * Ring additional users into the live room (Invite button). The
   * underlying server endpoint is the same `sfu.ring` we use on
   * outgoing-direction boot; calling it again with new
   * recipientUserIds fans fresh push notifications without
   * disturbing anyone already in the room.
   */
  inviteUsers:   (userIds: string[]) => Promise<void>;
  /**
   * Re-ring previously-dialed recipients who haven't picked up after
   * the 30s window. Host-initiated only — there's no automatic retry.
   * Bumps `ringStartedAt` so the UI flips back to "Re-ringing".
   */
  reRing:        (userIds: string[]) => Promise<void>;
  /** Wall-clock when the most recent ring was issued (or null). */
  ringStartedAt: number | null;
  /** Recipients the host explicitly re-rang this session. */
  reRungUserIds: Set<string>;
  /** Outgoing dial list snapshot — drives the per-recipient status pills. */
  recipientUserIds: string[];
  /** Host-only — server enforces. */
  muteParticipant:  (tag: string) => Promise<void>;
  kickParticipant:  (tag: string) => Promise<void>;
  leave:         () => Promise<void>;
}

type SfuJoinedResp = {
  routerRtpCapabilities: unknown;
  sendTransport:         unknown;
  recvTransport:         unknown;
  participantTag:        string;
  isHost:                boolean;
  existingProducers:     Array<{producerId: string; participantTag: string; kind: 'audio' | 'video'}>;
};

export function useGroupCall(opts: GroupCallOptions): GroupCallHandle {
  // B-09 — a video call must acquire a video track at boot (step=2),
  // not boot audio-only and toggle later. isVideoForCall is the pure,
  // unit-pinned derivation; getLocalMedia({video: isVideo}) at step=2
  // requests the camera track up front.
  const isVideo = isVideoForCall(opts.callType);

  const [state, setState]                 = useState<GroupCallState>('idle');
  const [roomId, setRoomId]               = useState<string | null>(opts.roomId ?? null);
  const [isHost, setIsHost]               = useState(false);
  const [selfTag, setSelfTag]             = useState<string | null>(null);
  const [localStream, setLocalStream]     = useState<MediaStream | null>(null);
  const [remoteTiles, setRemoteTiles]     = useState<RemoteTile[]>([]);
  const [identityByTag, setIdentityByTag] = useState<Record<string, {displayName: string; userId?: string}>>({});
  const [isMuted, setIsMuted]             = useState(false);
  const [isVideoOff, setIsVideoOff]       = useState(false);
  // Local camera lens. getUserMedia below always acquires facingMode:'user'
  // (front), so the initial truth is `true`; switchCamera flips it.
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [audioLevels, setAudioLevels]     = useState<AudioLevelMap>({});
  // B-15 — per-tag video-stall flag. True when a tile has a live, NON-paused
  // video consumer that is delivering 0 decoded frames for >3s (decrypt
  // failure / SFU drop / encoder stall). Distinct from camera-off (peer
  // paused their producer) so the UI can say "Video unavailable" instead of
  // showing an indistinguishable black surface.
  const [videoStalledTags, setVideoStalledTags] = useState<Record<string, boolean>>({});
  // framesDecoded snapshot per tag from the previous stats tick + the
  // wall-clock when it last advanced. Lets the poller compute "no new frames
  // for >N ms" without re-rendering every tick.
  const videoFrameSnapRef = useRef<Map<string, {frames: number; lastAdvanceMs: number}>>(new Map());
  // Wall-clock when the most recent ring was issued. Drives the per-
  // recipient status pill in the UI: while now-ringStartedAt < 30s the
  // recipient shows 'Ringing'; after that 'No answer' until the host
  // taps Re-ring (which updates this stamp). null means no outgoing
  // ring is in flight.
  const [ringStartedAt, setRingStartedAt] = useState<number | null>(null);
  // Per-recipient indicator: did the host bump them with a re-ring this
  // session? Drives the "Re-ringing" pill (vs initial "Ringing").
  const [reRungUserIds, setReRungUserIds] = useState<Set<string>>(() => new Set());

  const audioTrackRef    = useRef<MediaStreamTrack | null>(null);
  const videoTrackRef    = useRef<MediaStreamTrack | null>(null);
  const deviceRef        = useRef<Device | null>(null);
  const sendTxRef        = useRef<Transport | null>(null);
  const recvTxRef        = useRef<Transport | null>(null);
  const producersRef     = useRef<Producer[]>([]);
  const consumersByPid   = useRef<Map<string, Consumer>>(new Map());
  // Fix #9: per-consumer cleanup callbacks. addEventListener('mute' /
  // 'unmute' / 'trackended') has NO removeEventListener counterpart in
  // RN-WebRTC's track API — once attached, the listener fires forever
  // and can dereference the captured setRemoteTiles closure long after
  // the hook unmounts (post-unmount setState warning + leaked memory).
  // We collect detachers per-consumerId so leaveInternal can run them
  // BEFORE closing the consumer. Keying on consumer.id matches the
  // map used for the consumer itself.
  const consumerCleanupsByPid = useRef<Map<string, Array<() => void>>>(new Map());
  const transportRef     = useRef<TransportClient | null>(null);
  const participantTagRef = useRef<string | null>(null);
  const cleanupSubRef    = useRef<(() => void) | null>(null);
  const cleanupIdentSub  = useRef<(() => void) | null>(null);
  const sentRingRef      = useRef(false);
  const callStartedAtRef = useRef<number | null>(null);
  const wasKickedRef     = useRef(false);
  /**
   * True when the SERVER told us the host left (`sfu.room.ended` frame).
   * leaveInternal uses this to skip the outbound `sfu.leave` round-trip
   * — the server has already closed our consumers/transports and
   * deleted the room from its state, so sending `sfu.leave` would
   * either error out (unknown participant) or pointlessly add latency
   * to our local teardown.
   */
  const wasHostEndedRef  = useRef(false);
  // Round 4: ref-mirrors so leaveInternal can decide whether to send
  // sfu.ring.cancel to outstanding ringing recipients (host-only,
  // and only while a ring is in flight). Without these the closure
  // reads stale snapshots of isHost / ringStartedAt and would either
  // skip the cancel or fire it after the ring already cleared.
  const isHostRef        = useRef(false);
  const ringStartedAtRef = useRef<number | null>(null);
  // Tracks userIds that have actually joined the room so leaveInternal
  // can compute "still ringing" = recipientUserIds − joined.
  const joinedUserIdsRef = useRef<Set<string>>(new Set());
  // Audit row #5 (C2) — host's roomToken captured at boot so the
  // leaveInternal → `sfu.ring.cancel` path can echo it. Without this
  // the gateway rejects with `room_token_required` once
  // SFU_ROOM_TOKEN_SECRET is set.
  const roomTokenRef     = useRef<string | undefined>(undefined);
  // Audit F7 — re-mint the room token for a rejoin when the original 30-min
  // token has expired (a call that ran longer than the TTL then hit a WS
  // reconnect). GET /sfu/rooms/by-conversation mints a fresh per-caller token.
  const remintRoomToken = useCallback(async (): Promise<string | undefined> => {
    try {
      const {fetchWithRefresh} = require('@/services/api') as typeof import('@/services/api');
      const res = await fetchWithRefresh(
        `${MSG_BASE_URL}/sfu/rooms/by-conversation/${encodeURIComponent(opts.conversationId)}`,
        {method: 'GET', headers: {'X-Signal-Device-Id': '1'}},
      );
      if (!res.ok) {return undefined;}
      const body = await res.json() as {roomToken?: string};
      const token = body.roomToken || undefined;
      if (token) {roomTokenRef.current = token;}
      return token;
    } catch { return undefined; }
  }, [opts.conversationId]);
  // Fix #13: roomId ref synced from React state. leaveInternal needs
  // the LATEST roomId (not the closure's snapshot from when the
  // useCallback last fired) — the useCallback's deps include roomId,
  // but every other code path that calls leaveInternal goes through
  // a ref captured at a different time and would otherwise race.
  // Mirror keeps the ref always-current.
  const roomIdRef = useRef<string | null>(null);
  // Fix #12: producerIds whose consume is currently in flight. A fast
  // sequence of sfu.new-producer frames for the same producerId (rare,
  // but happens when the server retries due to a transient peer
  // disconnect) used to fire two concurrent sfu.consume requests; the
  // second one would race the first's recv.consume and either crash
  // mediasoup ("consumer already created") or leave us with a phantom
  // consumer no one knows about.
  const inFlightConsumes = useRef<Set<string>>(new Set());
  // BS-MEDIA — producerIds we've successfully consumed (a tile is live).
  // The reconcile tick diffs the server's authoritative producer list
  // against this set and consumes any gap, recovering a missed
  // sfu.new-producer frame or a consume that exhausted its retries.
  // Cleared per-producer on tile teardown and wholesale on leave.
  const consumedProducerIdsRef = useRef<Set<string>>(new Set());
  // BS-MEDIA — latest reconcile closure, populated at the end of boot so
  // the periodic effect can call the freshest version (which captures
  // `rid` + the in-IIFE consumeProducer) without re-firing on identity.
  const reconcileProducersRef = useRef<(() => Promise<void>) | null>(null);
  // Latest rebuildVideoConsumer closure, called from the stats-poll freeze
  // watchdog (which can't take it as an effect dep without re-creating the
  // poller). Rebuilds a wedged remote video consumer with a FRESH decoder.
  const rebuildVideoConsumerRef = useRef<((tag: string) => void) | null>(null);
  // B-06 — buffers sfu.new-producer frames that land before the recv
  // pipeline is ready (handler now registers right after the roomId is
  // known, BEFORE sfu.join). Drained once recvTx + consumeProducer are
  // live; the 4 s reconcile stays a pure backstop. Populated in boot.
  const earlyProducerBufferRef = useRef<EarlyProducerBuffer | null>(null);
  // Fix #10: handle for the audio-level interval so leaveInternal can
  // clear it directly. The previous code only cleared in the effect's
  // cleanup, which doesn't fire until the React unmount commits — a
  // 500ms tick can land between leaveInternal closing recvTx and the
  // unmount and crash on a closed transport.
  const audioPollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Fix #7: ref to the latest leaveInternal so nested closures
  // (the resume-path SFU handler in particular) call the freshest
  // version without depending on the useCallback's identity.
  const leaveInternalRef = useRef<(() => Promise<void>) | null>(null);
  // B-07 — ref to the freshest toggleVideo so the one-shot
  // encryptor-arrival retry re-invokes the up-to-date closure (which
  // captures the current localStream), mirroring leaveInternalRef.
  const toggleVideoRef = useRef<(() => Promise<void>) | null>(null);
  // True from the moment leaveInternal starts running until the hook
  // unmounts. Async paths inside the hook (consumeProducer, producer
  // tx events, mediasoup `negotiationneeded` callbacks fired during
  // track removal) check this flag and bail instead of issuing a
  // fresh wsRequest against an already-closed transport. Without it,
  // ending a call while the engine is mid-renegotiation blocks the JS
  // thread on a Promise that will never resolve (sfu.connect ack never
  // arrives because we already sent sfu.leave) and the app freezes
  // until the OS kills the WS heartbeat. Repro: end a video call right
  // after a peer enables/disables their camera (which triggers a
  // negotiation cycle that's still in flight when the user taps End).
  const isLeavingRef     = useRef(false);

  // ── B-20 (group) — camera-loss recovery on resume ──────────────
  // Mirror facing + user-intended-off into refs so the once-bound resume
  // handler reads fresh values without re-subscribing AppState on every
  // toggle (mirrors useCall.ts).
  const isVideoOffRef = useRef(isVideoOff);
  useEffect(() => { isVideoOffRef.current = isVideoOff; }, [isVideoOff]);
  const isFrontCameraRef = useRef(isFrontCamera);
  useEffect(() => { isFrontCameraRef.current = isFrontCamera; }, [isFrontCamera]);
  const recoveringCameraRef = useRef(false);
  // Another app grabs the camera mid group-call; our capture track
  // ends/mutes and the mediasoup video producer keeps "sending" null
  // frames. On foreground, if we're in a video call whose local track has
  // died AND the user didn't intentionally turn the camera off, acquire a
  // fresh track and replaceTrack it onto the EXISTING video producer —
  // keeping the producer's RTPSender + SFrame transform, so recovered
  // frames stay encrypted (no SDP reneg; peers keep receiving). BlueStacks
  // reports the stolen track as 'live' so this is physical-device-only; it
  // is a safe no-op on a healthy track.
  useEffect(() => {
    const {AppState} = require('react-native') as typeof import('react-native');
    const sub = AppState.addEventListener('change', (next: string) => {
      if (next !== 'active') {return;}
      if (isVideoOffRef.current) {return;}            // user-intended off — respect it
      if (isLeavingRef.current) {return;}             // call tearing down
      const track = videoTrackRef.current;
      if (!track) {return;}                           // audio-only / camera never on
      const muted = (track as unknown as {muted?: boolean}).muted === true;
      const dead  = track.readyState === 'ended' || muted;
      if (!dead) {return;}                            // healthy track — nothing to do
      if (recoveringCameraRef.current) {return;}      // re-entrancy guard
      const vp = producersRef.current.find(
        p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'video'
          && !(p as unknown as {closed?: boolean}).closed,
      );
      if (!vp) {return;}                              // no live video producer
      recoveringCameraRef.current = true;
      void (async () => {
        try {
          const replaced = await recoverGroupCamera({
            producer:     vp as never,
            facing:       isFrontCameraRef.current ? 'user' : 'environment',
            currentTrack: track,
          });
          if (replaced) {
            videoTrackRef.current = replaced;
            const audio = audioTrackRef.current;
            const rebuilt = new MediaStream(audio ? [audio, replaced] : [replaced]);
            setLocalStream(rebuilt);
            try {
              patchActiveGroupCall({localStream: rebuilt, videoTrack: replaced});
            } catch { /* best-effort registry refresh */ }
            console.log('[useGroupCall.recoverCamera] re-acquired camera after resume');
          }
        } catch (e) {
          console.warn('[useGroupCall.recoverCamera] failed (camera may still be held):', (e as Error).message);
        } finally {
          recoveringCameraRef.current = false;
        }
      })();
    });
    return () => sub.remove();
  }, []);

  // S6 / P0-C1 — SFrame end-to-end encryption layered ON TOP of SRTP
  // so the SFU forwards ciphertext-inside-ciphertext and never sees
  // plaintext media. Lazy-initialised after sfu.joined fires (we need
  // the participantTag) and torn down on leave. `null` means either
  // the platform lacks encoded-transform support (capability probe
  // failed — we refuse to start the call) or the call hasn't joined
  // yet. The accumulated per-sender/receiver detach fns live in
  // sframeDetachersRef so leaveInternal can fire them before closing
  // mediasoup transports — otherwise the inflight TransformStream
  // pipeTo() races consumer.close() and crashes the native bridge.
  const groupEncryptionRef = useRef<FrameCryptorOrchestrator | null>(null);
  const sframeDetachersRef = useRef<Array<() => void>>([]);
  // B-07 — one-shot guard so a mid-call "turn camera on" tapped before the
  // SFrame encryptor lands arms at most ONE retry (repeat taps don't stack
  // store subscriptions). Cleared when the wait settles.
  const videoRetryArmedRef = useRef(false);
  // B-05 — current call state mirrored to a ref so the WS-reconnect
  // subscriber (registered once at boot) can read the LATEST state without
  // re-subscribing on every transition. Used to gate the rejoin: only a
  // 'joined'/'reconnecting' call is rejoined after a socket reopen.
  const stateRef = useRef<GroupCallState>(state);
  // B-05 — freshest rejoin closure, populated at the end of boot so the
  // reconnect subscriber can re-wire mediasoup (create transports, produce,
  // consume) against the NEW participantTag + transports the server mints
  // on a fresh sfu.join. Null until the call has fully joined once.
  const rejoinRoomRef = useRef<((joined: SfuJoinedResp) => Promise<void>) | null>(null);
  // B-05 — guards against overlapping rejoins (a flapping socket can fire
  // onReconnect repeatedly inside the 60s window).
  const rejoinInFlightRef = useRef(false);

  // Fix #13: keep the roomIdRef in lockstep with the React state.
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);
  // B-05 — mirror state for the reconnect subscriber's gate.
  useEffect(() => { stateRef.current = state; }, [state]);
  // Round 4: mirror isHost + ringStartedAt for leaveInternal's
  // sfu.ring.cancel decision. See refs above for full reasoning.
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);
  useEffect(() => { ringStartedAtRef.current = ringStartedAt; }, [ringStartedAt]);
  // Track userIds that have joined the room — drives the "still
  // ringing" set leaveInternal hands to sfu.ring.cancel. Pull from
  // identityByTag (server emits identity envelopes for every joined
  // peer including ourselves).
  useEffect(() => {
    const joined = new Set<string>();
    for (const id of Object.values(identityByTag)) {
      if (id.userId) {joined.add(id.userId);}
    }
    joinedUserIdsRef.current = joined;
  }, [identityByTag]);

  /**
   * Audit P1-C6 — auto-evict removed members from the live SFU room.
   *
   * Without this: `removeGroupMember` rotates the group master key
   * (P1-C5 closes via GroupCallEncryption.subscribe) but the kicked
   * user, still connected to the SFU, keeps receiving in-flight frames
   * encrypted under the OLD key. The new key never reaches them so
   * the frames decrypt to nothing useful — but the SFU's per-track
   * buffering means they get one tail of pre-rotation media for free.
   *
   * Subscribing to the local group state and firing `sfu.kick` for any
   * (tag → userId) that's no longer in `cur.members` closes the window
   * end-to-end: the SFU drops their consumers + transports immediately,
   * and the SFrame rotation takes effect for the remaining members.
   *
   * Host-only — the SFU's `sfu.kick` requires the host's tag. Non-host
   * clients can't kick anyone (server enforces too); this hook is a
   * no-op for non-hosts. Skipped when not joined (`state !== 'joined'`)
   * so a teardown-in-progress doesn't fire stale kicks.
   */
  useEffect(() => {
    if (!isHost || state !== 'joined' || !roomId) {return;}
    const conversationId = opts.conversationId;
    const ws = transportRef.current;
    if (!ws) {return;}
    return useMessengerStore.subscribe((s, prev) => {
      const cur  = s.groups[conversationId];
      const old  = prev.groups[conversationId];
      if (!cur || !old) {return;}
      // Compute which userIds were present before AND are gone now.
      const removed: string[] = [];
      for (const uid of Object.keys(old.members)) {
        if (!cur.members[uid]) {removed.push(uid);}
      }
      if (removed.length === 0) {return;}
      // Translate userId → participantTag via the live identity map.
      // A removed member who was never in the call has no tag — skip
      // (the SFU has no consumer to drop anyway). The identity map is
      // captured fresh inside the closure since identityByTag is a
      // dependency below.
      for (const uid of removed) {
        const entry = Object.entries(identityByTag).find(([, v]) => v.userId === uid);
        if (!entry) {continue;}
        const [tag] = entry;
        console.log(`[bravo.groupcall.auto-evict] kicking removed member uid=${uid.slice(0,8)} tag=${tag.slice(0,8)}`);
        wsRequest<{ok: true}>(ws, 'sfu.kick', {roomId, targetTag: tag})
          .catch(e => console.warn('[bravo.groupcall.auto-evict] kick failed:', (e as Error).message));
      }
    });
  }, [isHost, state, roomId, opts.conversationId, identityByTag]);

  // ── Boot ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    // B-05 — unsubscribe handle for the WS-reconnect rejoin listener,
    // wired once the live transport is in hand and torn down in cleanup.
    let offReconnect: (() => void) | null = null;

    // Resume path: if the registry already holds a live call for this
    // room, adopt its refs instead of starting fresh — covers the
    // floating-overlay → restore navigation. Without this branch,
    // remounting GroupCallScreen would build a second mediasoup pipeline,
    // re-acquire camera/mic, and the original call would still be running
    // invisibly.
    const existing = getActiveGroupCall();
    // If the registry holds an OLD room (different ids, or we're
    // creating a fresh room and the registry has anything stale)
    // wipe it now. Otherwise the floating overlay would briefly show
    // the previous call while the new one boots, and any leftover
    // dispatcher subscriptions could fire on the new room's frames.
    // Fix #8: capture the prior call's leave fn BEFORE we null the
    // registry. The stale-room teardown is awaited inside the boot's
    // async IIFE below — useEffect cleanup must stay synchronous, so
    // we can't await here. The IIFE blocks on staleLeavePromise
    // before issuing sfu.join, which guarantees the prior
    // sendTransport / recvTransport are closed by the time we ask the
    // SFU for fresh ones (otherwise sfu.join can fail with
    // "transport_id_in_use" or we end up with two transports in the
    // peer connection layer fighting for the same ICE candidates).
    // Fix #8 + BS-RECONNECT-MIN: decide whether the registry's call is
    // genuinely adoptable. The mediasoup transports aren't on the registry
    // shape, so read the STASHED handles for their REAL connectionState — a
    // WS reconnect WHILE MINIMIZED leaves them disconnected/failed/closed
    // (the server dropped us with no mounted hook to rejoin), and adopting
    // them yields a ZOMBIE call: tiles render, no media flows, and nothing
    // ever recovers. A dead-transport restore must fall through to a fresh,
    // fully-wired boot instead.
    const transportsAlive = (() => {
      if (!existing) {return false;}
      const stash = opts.roomId ? liveSfuHandlesByRoom.get(opts.roomId) : undefined;
      const sTx = stash?.sendTx as {connectionState?: string; closed?: boolean} | undefined;
      const rTx = stash?.recvTx as {connectionState?: string; closed?: boolean} | undefined;
      const txOk = (t?: {connectionState?: string; closed?: boolean}): boolean =>
        !!t && !t.closed
        && t.connectionState !== 'disconnected'
        && t.connectionState !== 'failed'
        && t.connectionState !== 'closed';
      const audioReady = existing.audioTrack ? (existing.audioTrack as unknown as {readyState?: string}).readyState !== 'ended' : true;
      const videoReady = existing.videoTrack ? (existing.videoTrack as unknown as {readyState?: string}).readyState !== 'ended' : true;
      // No stash (shouldn't happen on a genuine resume) — keep the prior
      // permissive track-only check so the common adopt fast-path isn't
      // regressed.
      if (!stash) {return audioReady && videoReady;}
      return audioReady && videoReady && txOk(sTx) && txOk(rTx);
    })();
    let staleLeavePromise: Promise<void> | null = null;
    // Tear the registry's call down when it's a DIFFERENT room OR the SAME
    // room with dead transports (reconnect-while-minimized). Either way we
    // must NOT adopt it; the staleLeavePromise blocks the fresh boot's
    // sfu.join until the old transports are closed (avoids transport_id_in_use).
    if (existing && (existing.roomId !== opts.roomId || !transportsAlive)) {
      console.log(`[bravo.groupcall.boot] clearing un-adoptable registry old=${existing.roomId} new=${opts.roomId ?? 'fresh'} transportsAlive=${transportsAlive}`);
      const oldLeave = existing.leave;
      setActiveGroupCall(null);
      if (oldLeave) {
        staleLeavePromise = oldLeave().catch((e) => {
          console.warn('[bravo.groupcall.boot] stale-room leave failed:', (e as Error).message);
        });
      }
    }
    if (existing && opts.roomId && existing.roomId === opts.roomId && transportsAlive) {
      setRoomId(existing.roomId);
      setIsHost(existing.isHost);
      setSelfTag(existing.selfTag);
      setLocalStream(existing.localStream);
      setRemoteTiles(existing.remoteTiles);
      setIdentityByTag(existing.identityByTag);
      setIsMuted(existing.isMuted);
      setIsVideoOff(existing.isVideoOff);
      setState(existing.state);
      audioTrackRef.current = existing.audioTrack;
      videoTrackRef.current = existing.videoTrack;
      // Audit GC-05 — restore the call-start timestamp so ending the call from
      // a restored hook still appends a "Group call · N min" history bubble
      // (leaveInternal gates the bubble on callStartedAtRef, which only the
      // boot IIFE set — so a minimize→restore→hang-up produced no record).
      callStartedAtRef.current = existing.joinedAtMs ?? Date.now();
      // Audit BS-LEAK — rehydrate the live mediasoup handles into THIS
      // hook's refs. Without this, the restored hook's refs are empty,
      // the registry-sync effect re-binds `leave` to this hook's
      // leaveInternal, and ending the call closes nothing — leaking
      // every transport/producer/consumer + the camera/mic. Adopting the
      // SAME container objects means teardown sees producers/consumers
      // that arrived during the minimize window too.
      const stash = liveSfuHandlesByRoom.get(opts.roomId);
      if (stash) {
        deviceRef.current             = stash.device;
        sendTxRef.current             = stash.sendTx;
        recvTxRef.current             = stash.recvTx;
        transportRef.current          = stash.transport;
        producersRef.current          = stash.producers;
        consumersByPid.current        = stash.consumersByPid;
        consumerCleanupsByPid.current = stash.consumerCleanups;
        sframeDetachersRef.current    = stash.sframeDetachers;
        groupEncryptionRef.current    = stash.groupEncryption;
        participantTagRef.current     = stash.participantTag;
        // Audit L14 — adopt the boot rejoin fn + room token so THIS instance's
        // reconnect handler (armed below) can actually recover the call.
        rejoinRoomRef.current         = stash.rejoinRoom ?? null;
        if (stash.roomToken) {roomTokenRef.current = stash.roomToken;}
      } else {
        console.warn('[bravo.groupcall.resume] no stashed mediasoup handles for room — teardown may leak; falling back to surface-only adopt');
      }
      patchActiveGroupCall({isMinimized: false, keepAlive: false});
      // Fix #7: re-register an SFU frame handler bound to THIS hook's
      // state setters. The original handler (registered by the prior
      // hook instance) captured stale setRemoteTiles / setIdentityByTag
      // closures — frames arriving after the user minimizes + restores
      // would update the OLD (unmounted) tree, never reaching the
      // visible UI. Replace with a fresh handler that mutates via
      // patchActiveGroupCall + this hook's setters; also trigger a
      // ref-driven consume for any new producers that arrive on resume.
      // NB: the registry warning from Fix #24 is expected here and is
      // the desired behaviour — we WANT the prior handler gone.
      try {
        // F6 minimize-leaks-sfu-handler — release the PRIOR boot's frame
        // handler BEFORE registering this one. The minimize keepAlive
        // early-return deliberately kept it alive (so producer events still
        // arrived while minimized), but on restore we overwrite cleanupSubRef
        // with the new handler below; without releasing the old one first it
        // stays registered (registerSfuHandler appends, it does not replace)
        // and keeps consuming frames into the now-unmounted tree — so a peer
        // who joins or switches audio→video after a restore can be routed into
        // the invisible prior handler and never get a tile. Each minimize→
        // restore cycle leaked another handler.
        // Audit F6 — release the PRIOR boot's handler via the module-scoped
        // stash (this fresh instance's own cleanupSubRef is null, so the old
        // `cleanupSubRef.current?.()` released nothing and handlers leaked).
        try { stash?.handlerCleanup?.(); } catch { /* ignore */ }
        try { cleanupSubRef.current?.(); } catch { /* ignore */ }
        cleanupSubRef.current = null;
        const cleanup = registerSfuHandler(opts.roomId, (frame) => {
          // We don't have the full mediasoup state on resume (the
          // previous boot owns deviceRef/recvTxRef in its closures),
          // so for resume we proxy a subset: participant.left removes
          // the tile from this hook's state; new-producer / kicked /
          // muted update React state. The actual mediasoup consume of
          // a NEW producer arriving on resume is out of scope for this
          // fix and would need a re-architecture (see audit Fix #7
          // notes — moving the handler into a separate fn callable
          // from both paths). For minimize→restore, the new-producer
          // window is narrow because we still get those events
          // through the original handler at the moment they're sent.
          if (frame.event === 'sfu.participant.left') {
            // BS-027 — same teardown as the primary handler. Resume
            // path is hit after minimize→restore so the per-consumer
            // cleanups + native-track-stop matter just as much (more,
            // even — the tile has been live longer).
            const f = frame.data as {participantTag: string};
            const leavingTiles: typeof remoteTiles = [];
            setRemoteTiles(prev => {
              const next: typeof prev = [];
              for (const t of prev) {
                if (t.participantTag !== f.participantTag) { next.push(t); continue; }
                leavingTiles.push(t);
              }
              return next;
            });
            for (const t of leavingTiles) {
              const cleanups = consumerCleanupsByPid.current.get(t.consumerId);
              if (cleanups) {
                for (const cb of cleanups) { try { cb(); } catch { /* ignore */ } }
                consumerCleanupsByPid.current.delete(t.consumerId);
              }
              try {
                const tr = (t.stream as unknown as {getTracks?: () => Array<{stop?: () => void}>}).getTracks?.();
                if (Array.isArray(tr)) {
                  for (const x of tr) { try { x.stop?.(); } catch { /* ignore */ } }
                }
              } catch { /* ignore */ }
              const c = consumersByPid.current.get(t.consumerId);
              if (c) { try { c.close(); } catch { /* ignore */ } consumersByPid.current.delete(t.consumerId); }
              inFlightConsumes.current.delete(t.producerId);
              // BS-MEDIA — drop from consumed set so a rejoin re-consumes.
              consumedProducerIdsRef.current.delete(t.producerId);
            }
            setIdentityByTag(prev => {
              if (!(f.participantTag in prev)) {return prev;}
              const next = {...prev};
              delete next[f.participantTag];
              return next;
            });
          } else if (frame.event === 'sfu.producer-paused' || frame.event === 'sfu.producer-resumed') {
            // Audit GC-03 — the restore handler MUST process camera-toggle
            // frames too (pure React state, no mediasoup needed). Without this
            // a peer turning their camera off/on after a minimize→restore
            // never updated the visible tile (stuck on frozen frame or, for
            // resume, stuck on the avatar for the rest of the call). Mirrors
            // the primary handler.
            const f = frame.data as {producerId: string; participantTag?: string; kind?: 'audio' | 'video'};
            const isPaused = frame.event === 'sfu.producer-paused';
            setRemoteTiles(prev => {
              const {tiles: next} = applyProducerPausedFrame(prev, f, isPaused);
              if (next !== prev) {patchActiveGroupCall({remoteTiles: next});}
              return next;
            });
          } else if (frame.event === 'sfu.muted') {
            const t = audioTrackRef.current;
            if (t) { t.enabled = false; setIsMuted(true); }
            // Audit GC-08 — persist so a subsequent restore rehydrates the
            // muted state (adopt seeds isMuted from the registry).
            patchActiveGroupCall({isMuted: true});
          } else if (frame.event === 'sfu.unmuted') {
            // Audit SFU-08 — host un-muted us (restore-path handler).
            const t = audioTrackRef.current;
            if (t) { t.enabled = true; }
            setIsMuted(false);
            patchActiveGroupCall({isMuted: false});
          } else if (frame.event === 'sfu.kicked') {
            wasKickedRef.current = true;
            setState('kicked');
            void (async () => {
              try { await leaveInternalRef.current?.(); } catch { /* ignore */ }
            })();
          } else if (frame.event === 'sfu.room.ended') {
            // Host ended the call for everyone — same path as the
            // primary handler. Server has already torn us down on its
            // side; we just need to clean up local refs. Finding #8(c):
            // reason:'worker_died' rides this same frame; teardown is
            // identical, we just log the reason. Graceful for any string.
            const endReason = (frame as unknown as {data?: {reason?: string}}).data?.reason;
            console.log(`[bravo.groupcall.frame] room.ended (restore) reason=${endReason ?? 'host-left'} — tearing down`);
            wasHostEndedRef.current = true;
            void (async () => {
              try { await leaveInternalRef.current?.(); } catch { /* ignore */ }
            })();
          }
        });
        cleanupSubRef.current = cleanup;
        // Audit F6 — keep the stash pointing at the CURRENTLY-registered
        // handler so the NEXT restore releases this one, not a stale fn.
        if (stash) {stash.handlerCleanup = cleanup;}
      } catch (e) {
        console.warn('[bravo.groupcall.resume] re-register sfu handler failed:', (e as Error).message);
      }
      // BS-RESUME-RECONCILE — arm the self-contained re-consume so the 4s
      // reconcile tick (which runs because we just setState(existing.state)
      // → 'joined') picks up any producer that appeared while we were
      // minimized (a new joiner / a peer enabling video). Fire once now too
      // so the recovery doesn't wait up to 4s.
      reconcileProducersRef.current = consumeMissingAfterRestore;
      void consumeMissingAfterRestore();
      // Audit L14 (2026-07-02): re-arm the WS-reconnect→rejoin recovery. The
      // boot IIFE arms this, but the adopt/restore path had NONE — so a WS drop
      // after a minimize→restore left the call zombied (tiles freeze, no media)
      // with no automatic recovery. Uses the adopted rejoinRoom (from the
      // stash). Defensive: if the rejoin fn is missing it no-ops (falls back to
      // the prior no-recovery behaviour); the boot path is untouched so the
      // common non-minimized reconnect is unaffected. The returned cleanup
      // removes the listener on the next unmount (no leak).
      let offReconnectRestore: (() => void) | null = null;
      const wsRestore = transportRef.current;
      if (wsRestore && rejoinRoomRef.current) {
        offReconnectRestore = wsRestore.onReconnect(() => {
          if (cancelled || isLeavingRef.current) {return;}
          const rid = roomIdRef.current;
          if (rid === null || rejoinInFlightRef.current) {return;}
          const rejoin = rejoinRoomRef.current;
          if (!rejoin) {return;}
          rejoinInFlightRef.current = true;
          void attemptSfuRejoin<SfuJoinedResp['existingProducers']>({
            ws:        wsRestore,
            roomId:    rid,
            roomToken: roomTokenRef.current,
            state:     stateRef.current,
            isLeaving: isLeavingRef.current,
            log:       (line) => console.log(line),
            request:   wsRequest,
            onJoined:  (joined) => rejoin(joined as SfuJoinedResp),
            remintToken: remintRoomToken,   // F7
          })
            .then((outcome) => {
              if (outcome === 'failed' && !cancelled && !isLeavingRef.current) {setState('failed');}
            })
            .finally(() => { rejoinInFlightRef.current = false; });
        });
      }
      return () => { try { offReconnectRestore?.(); } catch { /* ignore */ } };
    }

    // B-13 — late-joiner tile race. When this device joins a room that
    // already has ≥2 producers, the step=9 consume loop is SERIAL and each
    // consumer's setRemoteTiles fired its OWN React re-render. The first
    // re-render lands the instant `recvTx` flips to 'connected' — when only
    // 1 remote tile exists — and GroupCallScreen's retainedRef froze the
    // layout to 2 positions (1 remote + self). Tiles 2..N arrived ~700ms
    // later into a layout with no slots → user permanently saw 2 tiles.
    // Fix: during the initial step=9 burst, the loop calls consumeProducer
    // with batch=true so each tile is COLLECTED into this buffer instead of
    // firing its own setRemoteTiles; the loop then flushes them in a SINGLE
    // update so the layout computes once at the final count. Every OTHER
    // caller (live sfu.new-producer — a mid-call audio→video switch — and the
    // reconcile tick) passes batch=false and updates per-tile immediately.
    // The batch mode is an explicit per-call argument, NOT a shared flag, so
    // it can never leak into the live path (the regression that swallowed
    // mid-call video tiles).
    const pendingTileBatch: RemoteTile[] = [];
    void (async () => {
      // Fix #8: await the stale-room teardown FIRST so the SFU has
      // actually freed the prior client's transport ids before we
      // request fresh ones via sfu.join. Cap to ~3s so a hung leave
      // doesn't permanently block a fresh call (server-side cleanup
      // will kick in via the ws-disconnect path).
      if (staleLeavePromise) {
        await Promise.race([
          staleLeavePromise,
          new Promise<void>(r => setTimeout(r, 3000)),
        ]);
      }
      const ws = getLiveTransport();
      if (!ws) {
        console.warn('[bravo.groupcall.boot] FAIL — no live WS transport, cannot start');
        setState('unavailable'); return;
      }
      transportRef.current = ws;
      // B-05 — when the WS reopens after the server's P0-6 revoked-socket
      // sweep + the TransportClient refresh path, the SFU room/transports
      // were torn down server-side. An ICE restart over the fresh socket
      // (the old recovery path) would ack_timeout and end in 'failed'. We
      // RE-JOIN the room instead, inside the SFU's 60s zombie-room grace
      // window. The group key is unchanged so the SFrame layer is reused.
      offReconnect = ws.onReconnect(() => {
        if (cancelled || isLeavingRef.current) {return;}
        const rid = roomIdRef.current;
        if (rid === null) {return;}
        if (rejoinInFlightRef.current) {return;}
        const rejoin = rejoinRoomRef.current;
        if (!rejoin) {return;}
        rejoinInFlightRef.current = true;
        void attemptSfuRejoin<SfuJoinedResp['existingProducers']>({
          ws,
          roomId:    rid,
          roomToken: roomTokenRef.current,
          state:     stateRef.current,
          isLeaving: isLeavingRef.current,
          log:       (line) => console.log(line),
          request:   wsRequest,
          onJoined:  (joined) => rejoin(joined as SfuJoinedResp),
          remintToken: remintRoomToken,   // F7
        })
          .then((outcome) => {
            if (outcome === 'failed' && !cancelled && !isLeavingRef.current) {
              setState('failed');
            }
          })
          .finally(() => { rejoinInFlightRef.current = false; });
      });
      console.log(`[bravo.groupcall.boot] start direction=${opts.direction} callType=${opts.callType} convo=${opts.conversationId} recipients=${opts.recipientUserIds.length}`);

      try {
        // 0. Fetch TURN credentials in parallel with room setup. Symmetric
        // NAT clients depend on relay; iceTransportPolicy: 'relay' below
        // forces relay-only on the *client* transport (mediasoup's
        // WebRtcTransport on the server side has its own ICE).
        const turnPromise = fetchTurnCredentials();
        console.log('[bravo.groupcall.boot] step=0 fetching TURN credentials');

        // 1. Create or join. The server's createRoom is idempotent per
        // conversationId — passing a fresh conversationId guarantees the
        // 2nd member tapping "call" lands in the same room as the 1st.
        //
        // Audit row #5 — `roomToken` is the HMAC echo the gateway needs
        // on `sfu.join`. Outgoing path: read `hostRoomToken` from the
        // POST /sfu/rooms response. Incoming path: it was carried via
        // ring → IncomingGroupCallScreen → opts.roomToken.
        let rid = opts.roomId ?? null;
        // P1-BR-1 — normalise an empty-string roomId to null. `?? null` only
        // catches null/undefined, so a '' from a malformed notification
        // payload would slip through as a falsy rid and hit the create path.
        if (rid !== null && rid.trim() === '') {rid = null;}
        let roomToken: string | undefined = opts.roomToken;
        // P1-BR-1 — an INCOMING group call MUST carry a roomId: it joins the
        // host's EXISTING room. A missing/empty id here (dropped from the
        // ring/notification payload) must FAIL, never fall through to
        // POST /sfu/rooms — that would silently mint a brand-new empty room
        // the host is not in, and even a correct-but-tokenless sfu.join is
        // rejected `room_token_required` in production. Only the outgoing
        // (host) path legitimately has no roomId.
        if (opts.direction === 'incoming' && !rid) {
          console.warn('[bravo.groupcall.boot] incoming call has no roomId — refusing to create a new room (P1-BR-1)');
          setState('unavailable');
          return;
        }
        if (!rid) {
          console.log('[bravo.groupcall.boot] step=1 creating room (no existing roomId)');
          setState('creating');
          // fetchWithRefresh attaches the access token AND auto-refreshes
          // on 401 (same code path as the axios interceptor). Without it,
          // a stale token here would 401 the room create even though the
          // user's session is still recoverable via /auth/refresh —
          // observed live as `boot failed: sfu_rooms_401` after a long
          // foreground gap.
          const {fetchWithRefresh} = require('@/services/api') as typeof import('@/services/api');
          const res = await fetchWithRefresh(`${MSG_BASE_URL}/sfu/rooms`, {
            method: 'POST',
            headers: {
              'Content-Type':       'application/json',
              'X-Signal-Device-Id': '1',
            },
            body: JSON.stringify({conversationId: opts.conversationId}),
          });
          if (!res.ok) {throw new Error(`sfu_rooms_${res.status}`);}
          const body = await res.json() as {roomId: string; hostRoomToken?: string};
          rid = body.roomId;
          if (body.hostRoomToken) {roomToken = body.hostRoomToken;}
          console.log(`[bravo.groupcall.boot] step=1 room created roomId=${rid}`);
        } else {
          console.log(`[bravo.groupcall.boot] step=1 joining existing room roomId=${rid}`);
        }
        if (cancelled) {return;}
        setRoomId(rid);
        // Audit row #5 (C2) — capture the host/joiner token in a ref so
        // leaveInternal's `sfu.ring.cancel` (host) can echo it. The
        // decline path reads its token from route params directly.
        roomTokenRef.current = roomToken;

        // B-06 — early producer buffer. New-producer frames that arrive
        // before the recv pipeline (recvTx + consumeProducer) is live are
        // queued and drained on connect; afterwards they consume inline.
        // `consumeProducer` is a hoisted function declaration further down
        // in this IIFE, so referencing it from these closures is safe even
        // though source-order puts its body after this point.
        const earlyProducerBuffer = createEarlyProducerBuffer(
          () => !!recvTxRef.current && !!groupEncryptionRef.current && !cancelled && !isLeavingRef.current,
          (p) => { void consumeProducer(p.producerId, p.participantTag, p.kind); },
        );
        earlyProducerBufferRef.current = earlyProducerBuffer;

        // 7. (moved up from after step 6) Subscribe to per-room SFU frames
        // (new producers, leaves, moderation pings) as soon as the roomId
        // is known — BEFORE sfu.join — so a peer that starts producing in
        // the join→recvTx window isn't dropped. Producer frames are routed
        // through `earlyProducerBuffer` and drained once the recv pipeline
        // is ready (after step 9); the 4 s reconcile stays a pure backstop.
        const cleanupSub = registerSfuHandler(rid, (frame) => {
          if (cancelled) {return;}
          if (frame.event === 'sfu.new-producer') {
            const f = frame.data as {producerId: string; participantTag: string; kind: 'audio' | 'video'};
            console.log(`[bravo.groupcall.frame] new-producer tag=${f.participantTag.slice(0,8)} kind=${f.kind} pid=${f.producerId.slice(0,8)}`);
            // B-06 — route through the early buffer. Before the recv pipeline
            // is ready (handler now registers BEFORE sfu.join) the event is
            // queued and drained on connect; afterwards it consumes inline.
            // consumeProducer dedups (consumedProducerIds + inFlightConsumes)
            // so an event seen both here and in step-9 existingProducers
            // can't double-consume.
            earlyProducerBufferRef.current?.accept({
              producerId: f.producerId, participantTag: f.participantTag, kind: f.kind,
            });
          } else if (frame.event === 'sfu.producer-paused' || frame.event === 'sfu.producer-resumed') {
            // Peer toggled their camera/mic. Authoritative — the server
            // paused/resumed its producer before fanning this out. Flips
            // the tile to its avatar placeholder (paused) or back to the
            // live plane (resumed) without waiting on the native track
            // 'mute' heuristic, which never fires when a disabled track
            // keeps emitting frames.
            const f = frame.data as {producerId: string; participantTag?: string; kind?: 'audio' | 'video'};
            const isPaused = frame.event === 'sfu.producer-paused';
            setRemoteTiles(prev => {
              // producerId-primary, (participantTag, kind)-fallback match. The
              // fallback is what stops a producerId drift from silently dropping
              // the camera-state flip and freezing the peer tile — see
              // applyProducerPausedFrame for the full why. Unit-tested there.
              const {tiles: next, matchedBy} = applyProducerPausedFrame(prev, f, isPaused);
              console.log(`[bravo.groupcall.frame] producer-${isPaused ? 'paused' : 'resumed'} pid=${f.producerId.slice(0,8)} tag=${(f.participantTag ?? '?').slice(0,6)} matchedBy=${matchedBy} videoPids=${prev.filter(t => t.kind === 'video').map(t => t.producerId.slice(0,8)).join(',')}`);
              if (next !== prev) {patchActiveGroupCall({remoteTiles: next});}
              return next;
            });
          } else if (frame.event === 'sfu.participant.joined') {
            const f = frame.data as {participantTag: string};
            console.log(`[bravo.groupcall.frame] participant.joined tag=${f.participantTag.slice(0,8)}`);
          } else if (frame.event === 'sfu.participant.left') {
            // BS-027 — when a peer leaves a 3+ participant group call,
            // their tile was freezing on the last decoded frame for the
            // remaining peers instead of dropping cleanly. The old impl
            // closed the consumer + filtered the tile out, but did NOT:
            //   1. Fire the per-consumer cleanups that flip the
            //      listenerCancelled flag (so trackended/mute callbacks
            //      registered on the just-closed consumer continued to
            //      fire setRemoteTiles/setIdentityByTag on stale state)
            //   2. Stop the underlying MediaStreamTrack (RN-WebRTC keeps
            //      the native handle alive after consumer.close, so the
            //      decoder buffer holds the last frame and any
            //      still-mounted RTCView keeps painting it)
            //   3. Mirror the new tile list to the registry — meaning
            //      the floating overlay's snapshot still showed the
            //      leaver's tile until the next remoteTiles change
            //   4. Clear the leaver's identityByTag entry, so the
            //      invite-candidates filter still excluded them as
            //      "joined" even though they had already left
            const f = frame.data as {participantTag: string};
            const leavingTiles: typeof remoteTiles = [];
            setRemoteTiles(prev => {
              const next: typeof prev = [];
              for (const t of prev) {
                if (t.participantTag !== f.participantTag) { next.push(t); continue; }
                leavingTiles.push(t);
              }
              return next;
            });
            for (const t of leavingTiles) {
              // Fire per-consumer cleanups (flips listenerCancelled).
              const cleanups = consumerCleanupsByPid.current.get(t.consumerId);
              if (cleanups) {
                for (const cb of cleanups) { try { cb(); } catch { /* ignore */ } }
                consumerCleanupsByPid.current.delete(t.consumerId);
              }
              // Stop the underlying track BEFORE closing the consumer.
              // Reverses the freeze: with the track stopped, RTCView's
              // last-frame buffer is invalidated and the next render
              // (the post-filter empty state) is genuinely empty.
              try {
                const tr = (t.stream as unknown as {getTracks?: () => Array<{stop?: () => void}>}).getTracks?.();
                if (Array.isArray(tr)) {
                  for (const x of tr) { try { x.stop?.(); } catch { /* ignore */ } }
                }
              } catch { /* ignore */ }
              const c = consumersByPid.current.get(t.consumerId);
              if (c) { try { c.close(); } catch { /* ignore */ } consumersByPid.current.delete(t.consumerId); }
              inFlightConsumes.current.delete(t.producerId);
              // BS-MEDIA — drop from consumed set so a rejoin re-consumes.
              consumedProducerIdsRef.current.delete(t.producerId);
            }
            // Drop the leaver from identityByTag too.
            setIdentityByTag(prev => {
              if (!(f.participantTag in prev)) {return prev;}
              const next = {...prev};
              delete next[f.participantTag];
              return next;
            });
          } else if (frame.event === 'sfu.muted') {
            // Host muted us — flip our audio track off + show indicator.
            const t = audioTrackRef.current;
            if (t) { t.enabled = false; setIsMuted(true); }
            // Audit GC-08 — persist so a minimize→restore rehydrates the
            // muted state from the registry (adopt seeds isMuted from it).
            patchActiveGroupCall({isMuted: true});
          } else if (frame.event === 'sfu.unmuted') {
            // Audit SFU-08 — host un-muted us. The server already unpaused our
            // producers; clear the UI muted state so the mic icon matches.
            const t = audioTrackRef.current;
            if (t) { t.enabled = true; }
            setIsMuted(false);
            patchActiveGroupCall({isMuted: false});
          } else if (frame.event === 'sfu.kicked') {
            // Host booted us — tear down hard. Set the ref BEFORE
            // calling leave so the bubble-emit branch sees we were
            // kicked (the React state setter is async and would lose
            // the race against the synchronous leaveInternal body).
            wasKickedRef.current = true;
            setState('kicked');
            void leaveInternal();
          } else if (frame.event === 'sfu.room.ended') {
            // Host ended the call for everyone (WhatsApp/Zoom-style
            // host-leaves-everyone-drops semantics). The server has
            // ALREADY closed our consumers/transports + deleted the
            // room — we just need to tear down the local session and
            // stop pretending we're in a call. Skip the WS sfu.leave
            // round-trip (server doesn't have us anymore) by setting
            // the ref so leaveInternal short-circuits the WS calls.
            //
            // Finding #8(c) — the frame can now carry reason:'worker_died'
            // (SFU worker crash) as well as the host-left case. The room is
            // gone server-side either way, so the teardown is identical; we
            // just log the reason so a crash is distinguishable in the
            // trace. This is an if/else, not an exhaustive switch, so an
            // unknown reason falls through to the same graceful teardown.
            const endReason = (frame as unknown as {data?: {reason?: string}}).data?.reason;
            console.log(`[bravo.groupcall.frame] room.ended reason=${endReason ?? 'host-left'} — tearing down`);
            wasHostEndedRef.current = true;
            void leaveInternal();
          }
        });
        cleanupSubRef.current = cleanupSub;
        console.log('[bravo.groupcall.boot] step=1b sfu frame handler registered (pre-join)');

        // 2. Acquire local media. Voice-only call still acquires mic;
        // video producer is added later so toggleVideo() can flip on
        // mid-call without renegotiation surprises.
        console.log(`[bravo.groupcall.boot] step=2 acquiring local media (video=${isVideo})`);
        const {stream, audioTrack, videoTrack} = await getLocalMedia({video: isVideo});
        if (cancelled) {
          // Stop tracks AND best-effort fire sfu.leave so the server-
          // side janitor (post-#15) can reap the room. Without this the
          // host-created room sits in `rooms.set(rid, …)` with zero
          // participants until process restart and `findRoomForConver-
          // sation` would hand it to the next caller as a zombie.
          stream.getTracks().forEach(t => t.stop());
          try {
            void wsRequest<{ok: boolean}>(ws, 'sfu.leave', {roomId: rid}).catch(() => undefined);
          } catch { /* ignore */ }
          return;
        }
        audioTrackRef.current = audioTrack;
        videoTrackRef.current = videoTrack;
        setLocalStream(stream);
        console.log(`[bravo.groupcall.boot] step=2 local media OK audio=${!!audioTrack} video=${!!videoTrack}`);

        // BS-MINIMIZE-RING — seed the floating-overlay registry NOW, while
        // the call is still connecting/ringing (before sfu.join), so pressing
        // back MINIMIZES it to a bubble instead of being stuck on the
        // "waiting…" screen (mirrors the 1:1 useCall early-seed). The 'joined'
        // publish below upgrades this entry (preserving any minimize the user
        // did while it rang); the boot-failed and leave paths clear it so the
        // bubble dismisses on timeout/no-answer.
        setActiveGroupCall({
          roomId:           rid,
          conversationId:   opts.conversationId,
          conversationName: opts.callerName,
          callType:         opts.callType,
          isHost:           opts.direction === 'outgoing',
          selfTag:          null,
          state:            'joining',
          localStream:      stream,
          remoteTiles:      [],
          identityByTag:    {},
          audioLevels:      {},
          audioTrack,
          videoTrack,
          isMuted:          false,
          isVideoOff:       false,
          isMinimized:      false,
          keepAlive:        false,
          leave:            leaveInternal,
          toggleMute:       toggleMuteInternal,
          toggleVideo,
          joinedAtMs:       null,
        });

        // 3. WS sfu.join — receive caps + transport params + isHost.
        // Audit row #5 — include the room-access token so the gateway
        // verifies us. Omitted on configs without the secret set.
        console.log(`[bravo.groupcall.boot] step=3 sfu.join roomId=${rid} hasToken=${!!roomToken}`);
        setState('joining');
        let joined: SfuJoinedResp;
        try {
          joined = await wsRequest<SfuJoinedResp>(ws, 'sfu.join', {roomId: rid, roomToken});
        } catch (e) {
          if ((e as Error).message?.includes('room_full')) {
            console.warn('[bravo.groupcall.boot] step=3 FAIL room_full');
            setState('full');
            return;
          }
          console.warn('[bravo.groupcall.boot] step=3 FAIL', (e as Error).message);
          throw e;
        }
        if (cancelled) {
          // Rapid leave-during-boot leak: user tapped End between media-
          // acquire and join-ack. Server has now built a full Participant
          // (sendTransport + recvTransport + Router slot) and registered
          // it in `sfuSocketTags`. If we just `return` here,
          // leaveInternal() runs but participantTagRef is still null AND
          // rid may be set (host case) — the `if (ws && rid)` guard
          // sends sfu.leave WITHOUT a participantTag, server's
          // handleSfuLeave then iterates ALL tags on the socket which is
          // a separate bug (see SFU server-side fix). The cleaner fix
          // here: fire a synchronous best-effort sfu.leave with the
          // freshly-issued tag. Server's leaveRoom is keyed by tag.
          try {
            void wsRequest<{ok: boolean}>(ws, 'sfu.leave', {roomId: rid}).catch(() => undefined);
          } catch { /* ignore — best effort */ }
          return;
        }
        participantTagRef.current = joined.participantTag;
        setSelfTag(joined.participantTag);
        setIsHost(joined.isHost);
        console.log(`[bravo.groupcall.boot] step=3 joined tag=${joined.participantTag.slice(0,8)} isHost=${joined.isHost} existingProducers=${joined.existingProducers.length}`);

        // S6 / P0-C1 — initialise SFrame encryption. Refuses to proceed
        // when the platform lacks encoded-transform support OR when the
        // group has no local master key. Either branch surfaces as a
        // 'failed' state — we do NOT silently fall back to plaintext
        // because the SFU would then have access to media bytes.
        if (!frameCryptorOrchestratorAvailable()) {
          console.warn('[bravo.groupcall.boot] step=3 FrameCryptor unavailable on this build — refusing to start unencrypted group call (S6)');
          if (!cancelled) {setState('failed');}
          try {
            void wsRequest<{ok: boolean}>(ws, 'sfu.leave', {roomId: rid}).catch(() => undefined);
          } catch { /* ignore */ }
          return;
        }
        try {
          // BS-CALL-ADHOC — ensure a group master key exists for this call.
          // For a real group chat opts.conversationId already has one (no-op).
          // For an ad-hoc/escalated call from a 1:1 (`direct:*`), the HOST
          // mints + distributes a fresh key to the ring recipients via the
          // proven sealed fan-out. Recipients receive it through the normal
          // incoming-envelope handler (admin/create). The returned id is
          // what we key the FrameCryptor off. Host-only: a recipient that
          // hasn't received the key yet will fail-closed below and retry as
          // the create envelope lands.
          // Host-only fallback id (reassigned from ensureCallGroupKey below);
          // the joiner resolves its key slot via resolveKeyId() instead.
          let keyConvoId = opts.conversationId;
          // BS-CALL-REALGROUP — the master key may live in EITHER of two
          // slots and the joiner can't tell which from the ring alone:
          //   • ad-hoc escalated 1:1 ('Call'): receive-side aliases it under
          //     `direct:<owner>` = `direct:<host>` (productionRuntime
          //     name==='Call' branch).
          //   • real named group: filed ONLY under the real `conversationId`
          //     (server UUID) — NO `direct:<host>` alias is ever created.
          // IncomingGroupCallScreen sets `hostUserId` UNCONDITIONALLY on every
          // incoming call, so keying off `direct:<host>` alone made real-group
          // joiners wait on an empty slot → 25 s timeout → "Call failed".
          // Resolve under whichever slot actually holds a key (real id first,
          // then the ad-hoc alias). This does NOT relax the gate: if NEITHER
          // slot has a key, resolveKeyId() is undefined → hasKey() false → we
          // still fail closed below (no key ⇒ no media, never plaintext).
          const directLookupId = opts.hostUserId ? `direct:${opts.hostUserId}` : undefined;
          const resolveKeyId = (): string | undefined => {
            const g = useMessengerStore.getState().groups;
            // B-10 (non-admin host of a REAL group): the host could NOT
            // resync the real master key (it isn't the group owner), so it
            // minted an ad-hoc 'Call' key and filed it under `direct:<host>`.
            // This device still holds the REAL group key under
            // `conversationId`, but that key does NOT match what the host
            // encrypted with — keying off it gives 0 decrypted frames. When
            // the ring's host is NOT this group's admin/owner, prefer the
            // ad-hoc `direct:<host>` slot so host and receiver agree on the
            // SAME per-call key. Admin-hosted calls fall through to the real
            // id below (the proven path).
            const groupOwner = g[opts.conversationId]?.owner;
            const hostIsAdmin =
              !opts.hostUserId || !groupOwner || groupOwner === opts.hostUserId;
            // B-13 — the force-the-ad-hoc-slot rule applies ONLY to an
            // ad-hoc ('direct:*') escalated call. There, a non-owner host
            // MINTS a fresh 'Call' key under `direct:<host>`, so keying off
            // the stale real key would give 0 frames (the B-10 mismatch).
            // But a non-owner host of a REAL named group CANNOT mint or
            // broadcast over a group it doesn't own (B-10/B-15 owner-poison
            // guard) — `ensureCallGroupKey` REUSES the real group's master
            // key under the real `conversationId`. So for a real group the
            // joiner must resolve that SAME real key it already holds as a
            // member; forcing the empty `direct:<host>` slot is exactly what
            // hung real-group joiners for 25 s ("Call failed"). Scope this
            // branch to ad-hoc ids so the two paths stay consistent.
            const isAdHocCall = opts.conversationId.startsWith('direct:');
            if (!hostIsAdmin && isAdHocCall && directLookupId) {
              // Ad-hoc non-owner host: the ONLY correct slot is the ad-hoc
              // `direct:<host>` key. Do NOT fall back to a stale real-group
              // key, and return undefined until the ad-hoc key lands so the
              // joiner stays in the benign wait window.
              return g[directLookupId]?.masterKeyB64 ? directLookupId : undefined;
            }
            if (g[opts.conversationId]?.masterKeyB64) {return opts.conversationId;}
            if (directLookupId && g[directLookupId]?.masterKeyB64) {return directLookupId;}
            return undefined;
          };
          // Display-only id for the wait log (prefers the ad-hoc slot it's
          // most likely in-flight to, falling back to the real convo).
          const keyLookupId = directLookupId ?? opts.conversationId;
          const hasKey = (): boolean => !!resolveKeyId();
          const rt = await getMessengerRuntime();
          if (joined.isHost && rt.ensureCallGroupKey) {
            // Host always calls ensureCallGroupKey — if a key already exists
            // it re-broadcasts it to all recipients so reinstalled/missed
            // devices (Techno self-minted K2, emulator never had a key) get
            // the correct key before they attempt FrameCryptor init.
            try {
              const res = await rt.ensureCallGroupKey({
                conversationId:   opts.conversationId,
                recipientUserIds: opts.recipientUserIds,
              });
              keyConvoId = res.keyConversationId;
              console.log('[bravo.groupcall.boot] step=3a call key ensured/resynced keyConvo=', keyConvoId.slice(0, 12));
            } catch (e) {
              // SELF-HEAL HOST PATH — the HOST of a REAL group it does NOT own
              // (e.g. a CPO/client hosting a call in an agency-owned mission
              // Ops Room) fail-closes here with 'missing real-group master
              // key' because ensureCallGroupKey refuses to mint over a group
              // owned by another user. The OLD behaviour abandoned the call
              // instantly — before the self-heal key-request could be
              // answered. Mirror the joiner: actively ask the owner to
              // re-share, then WAIT (benign window) for the key to land, then
              // key the cryptor off the real conversation. Still fail-closed:
              // if the window elapses with no key we re-throw (no key ⇒ no
              // media, never plaintext).
              const msg = (e as Error)?.message ?? '';
              if (hasKey() || !/missing real-group master key/.test(msg)) {
                throw e;
              }
              console.log('[bravo.groupcall.boot] step=3a host lacks real-group key — requesting re-share + waiting (self-heal)...');
              if (rt.requestGroupKeyResync) {
                void rt.requestGroupKeyResync(opts.conversationId).catch(() => { /* best-effort */ });
              }
              const hostWait = await waitForGroupCallKey({
                hasKey,
                subscribe:   (cb) => useMessengerStore.subscribe(() => cb()),
                isCancelled: () => cancelled,
              });
              if (hostWait === 'cancelled' || cancelled) {return;}
              if (hostWait === 'timeout' || !hasKey()) {
                throw e; // genuinely no key after the window — fail closed
              }
              keyConvoId = resolveKeyId() ?? opts.conversationId;
              console.log('[bravo.groupcall.boot] step=3a host recovered real-group key via self-heal keyConvo=', keyConvoId.slice(0, 12));
            }
          } else if (!joined.isHost && !hasKey()) {
            // BS-CALL-KEY-WAIT: joiner has no key yet — the host sent it via
            // sealed fan-out in ensureCallGroupKey, but it may be in-flight.
            //
            // BS-CALL-KEY-RECOVER: the key envelope and the sfu.ring are
            // SEPARATE frames on SEPARATE paths (sealed relay envelope vs WS
            // ring). A cold-wake joiner on cellular, or one whose envelope is
            // queued behind a backlog, can have the key land 10-20 s after it
            // accepts — well past the old 8 s ceiling, which then hard-FAILED
            // the whole call ("Call failed") even though the key was moments
            // away. We now stay in the benign 'joining' state (UI: "Joining…")
            // and resolve the INSTANT the key lands, any time inside a 25 s
            // window. This does NOT relax the gate: if the window elapses with
            // no key we still throw and fail closed (no key ⇒ no media,
            // never plaintext — per ARCHITECTURE_AMENDMENT_SFRAME §"fails
            // closed"). It only stops abandoning a call whose key is in-flight.
            //
            // The wait also breaks out early on teardown (`cancelled`) so a
            // user who hits End mid-wait isn't held for the full window.
            console.log('[bravo.groupcall.boot] step=3b waiting for group master key under', keyLookupId.slice(0, 18), '(in-flight from host)...');
            // Self-heal — don't just wait passively. A joiner that lost the
            // key (reinstall/logout) or missed the original fan-out actively
            // asks the owner to re-share it, so the key lands inside the wait
            // window instead of timing out into "Call failed". Fire-and-
            // forget + rate-limited; harmless when the host's resync already
            // covers it.
            if (rt.requestGroupKeyResync) {
              void rt.requestGroupKeyResync(opts.conversationId).catch(() => { /* best-effort */ });
            }
            const waitOutcome = await waitForGroupCallKey({
              hasKey,
              subscribe:   (cb) => useMessengerStore.subscribe(() => cb()),
              isCancelled: () => cancelled,
            });
            // Cancelled during the wait — bail without surfacing a failure
            // (the teardown path owns the state transition).
            if (waitOutcome === 'cancelled' || cancelled) {return;}
            // Fail closed: window elapsed with no key ⇒ no media, never
            // plaintext (ARCHITECTURE_AMENDMENT_SFRAME §"fails closed").
            if (waitOutcome === 'timeout' || !hasKey()) {
              throw new Error('FrameCryptorOrchestrator: no group master key — refusing to start');
            }
            console.log('[bravo.groupcall.boot] step=3b group master key arrived');
          }
          // Key the cryptor off the right slot for our role:
          //   • HOST: `keyConvoId` is the id ensureCallGroupKey actually
          //     keyed this call under — the real `conversationId` when we own
          //     the group (admin resync), or a fresh ad-hoc id when we don't
          //     (B-10: non-admin host). We MUST use it verbatim; resolveKeyId
          //     would pick the stale REAL group key for a non-admin-hosted
          //     real group and mismatch every receiver.
          //   • JOINER: resolveKeyId() picks the slot that matches the host
          //     (ad-hoc `direct:<host>` when the host isn't this group's
          //     admin, else the real convo id), falling back to keyConvoId.
          const keyConvoForCryptor = joined.isHost
            ? keyConvoId
            : (resolveKeyId() ?? keyConvoId);
          const enc = new FrameCryptorOrchestrator({
            conversationId: keyConvoForCryptor,
            selfTag:        joined.participantTag,
            keySource:      messengerStoreKeySource,
          });
          await enc.init();
          groupEncryptionRef.current = enc;
          // BS-GC-KEYDIAG — the old `epoch=current` log was useless for
          // diagnosing the TECNO-only "no remote A/V both directions"
          // (SFrame decrypt fails when this device's group master key
          // doesn't match the senders'). Log a SHA-256 FINGERPRINT of the
          // master key (one-way hash — never the key itself, per the
          // no-plaintext-key-material rule) + epoch + source convo, so a
          // capture from the broken device can be compared against a
          // working one: same fp+epoch ⇒ key is fine, cause is the native
          // cryptor/hardware; different fp/epoch ⇒ key desync (re-sync fix).
          try {
            const cur = useMessengerStore.getState().groups[keyConvoForCryptor];
            const mk = cur?.masterKeyB64 ?? '';
            let fp = 'none';
            if (mk) {
              const c = (globalThis as {crypto?: {subtle?: {digest?: (a: string, d: ArrayBuffer) => Promise<ArrayBuffer>}}}).crypto;
              if (c?.subtle?.digest) {
                const bytes = new TextEncoder().encode(mk);
                const dig = await c.subtle.digest('SHA-256', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
                fp = Array.from(new Uint8Array(dig)).slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('');
              }
            }
            crashLog(`[bravo.groupcall.keydiag] FrameCryptor ready selfTag=${joined.participantTag.slice(0,8)} keyConvo=${keyConvoForCryptor.slice(0,12)} epoch=${cur?.epoch ?? '?'} masterKeyFp=${fp}`);
          } catch { /* diagnostic only — never block the call */ }
        } catch (e) {
          console.warn('[bravo.groupcall.boot] step=3b FrameCryptor init failed — refusing:', (e as Error).message);
          if (!cancelled) {setState('failed');}
          try {
            void wsRequest<{ok: boolean}>(ws, 'sfu.leave', {roomId: rid}).catch(() => undefined);
          } catch { /* ignore */ }
          return;
        }

        // Self entry into the identity registry so OUR tile shows our
        // own name immediately even though we never receive our own
        // presence envelope.
        recordGroupCallIdentity(rid, joined.participantTag, opts.ownDisplayName);

        // Subscribe to identity updates from peers' presence envelopes.
        cleanupIdentSub.current = onGroupCallIdentities(rid, snap => {
          if (cancelled) {return;}
          setIdentityByTag(snap);
          patchActiveGroupCall({identityByTag: snap});
        });

        // 4. mediasoup-client Device.load
        // CRITICAL: must pass `handlerName: 'ReactNative106'` because
        // the auto-detect path inspects window.navigator.userAgent which
        // doesn't exist in RN — without this, `new Device()` throws
        // "device not supported" the moment we try to load the router
        // capabilities, surfacing as the "network error" group-call
        // blocker. The 106 suffix matches the WebRTC API level
        // react-native-webrtc 124.x exposes; mediasoup ships a single
        // RN handler against that surface.
        console.log('[useGroupCall] constructing mediasoup Device with handlerName=ReactNative106');
        const device = new Device({handlerName: 'ReactNative106'});
        await device.load({routerRtpCapabilities: joined.routerRtpCapabilities as never});
        console.log('[useGroupCall] Device loaded ok');
        deviceRef.current = device;

        // Resolve TURN before opening transports.
        const turnServers = await turnPromise;

        // 5. Send transport.
        // Why NOT relay-only here (unlike the 1:1 path in
        // peerConnection.ts): in 1:1 BOTH peers are relay-only and meet
        // inside coturn — peer↔peer NAT traversal genuinely needs the
        // relay. The SFU is the opposite topology: client↔server, where
        // the server is a PUBLIC endpoint advertising its own
        // (announcedIp) ICE candidates — there is no NAT to traverse to
        // reach it. Forcing the client relay-only there makes media
        // hairpin phone→coturn→SFU→coturn→phone, and coturn refuses the
        // SFU hop whenever the SFU's announcedIp is RFC1918 (our SSRF
        // denylist, docker-compose.yml). The pair then completes DTLS
        // (transport reaches 'connected') but carries ZERO RTP, starves,
        // and dies on idle — observed on physical Android Wi-Fi while
        // emulators (sharing the host LAN) worked. 'all' lets the client
        // reach the SFU directly; TURN stays in iceServers as the
        // fallback for genuinely UDP-blocked networks.
        const sendTx = device.createSendTransport({
          ...(joined.sendTransport as Record<string, unknown>),
          iceServers:           turnServers,
          iceTransportPolicy:   'all',
          iceCandidatePoolSize: 0,
        } as never);
        sendTxRef.current = sendTx;
        sendTx.on('connect', ({dtlsParameters}, cb, errb) => {
          // Bail if we're tearing down — the WS may already be closed
          // and the request would hang forever (freeze on call-end).
          if (isLeavingRef.current) { errb(new Error('leaving')); return; }
          wsRequest<{ok: true}>(ws, 'sfu.transport.connect', {
            roomId: rid!, transportId: sendTx.id, dtlsParameters,
          }).then(() => cb()).catch(e => errb(e as Error));
        });
        sendTx.on('produce', ({kind, rtpParameters}, cb, errb) => {
          if (isLeavingRef.current) { errb(new Error('leaving')); return; }
          wsRequest<{producerId: string}>(ws, 'sfu.produce', {
            roomId: rid!, transportId: sendTx.id, kind, rtpParameters,
          }).then(({producerId}) => cb({id: producerId})).catch(e => errb(e as Error));
        });

        // 6. Recv transport — same 'all' rationale as the send transport
        // above (direct-to-SFU primary, TURN fallback). The recv path is
        // where the no-media symptom showed first: recvTx reached
        // 'connected' but never decoded a frame (8 mute / 0 unmute) under
        // the old relay-only policy.
        const recvTx = device.createRecvTransport({
          ...(joined.recvTransport as Record<string, unknown>),
          iceServers:           turnServers,
          iceTransportPolicy:   'all',
          iceCandidatePoolSize: 0,
        } as never);
        recvTxRef.current = recvTx;
        recvTx.on('connect', ({dtlsParameters}, cb, errb) => {
          if (isLeavingRef.current) { errb(new Error('leaving')); return; }
          wsRequest<{ok: true}>(ws, 'sfu.transport.connect', {
            roomId: rid!, transportId: recvTx.id, dtlsParameters,
          }).then(() => cb()).catch(e => errb(e as Error));
        });

        // 6b. Weak-network recovery — attach `connectionstatechange`
        // listeners to BOTH transports so a Wi-Fi ↔ cellular handover
        // (or any blip that flips ICE to 'disconnected') triggers a
        // server-side `transport.restartIce()` round-trip instead of
        // dropping the whole call. Recovery budget mirrors the 1:1
        // path's 30s ceiling.
        //
        // On 'disconnected':
        //   • flip group state to 'reconnecting' for the overlay,
        //   • POST `sfu.transport.restartIce` and apply the returned
        //     iceParameters via mediasoup-client's `restartIce()`,
        //   • the engine re-gathers candidates against the existing
        //     TURN allocation; DTLS context, producers, and consumers
        //     all survive (mediasoup spec).
        // On 'connected' (during reconnecting): clear the budget and
        // restore 'joined'.
        // On 'failed' / budget expiry: setState('failed') and leave.
        const RECONNECT_BUDGET_MS = 30_000;
        let restartBudgetTimer: ReturnType<typeof setTimeout> | null = null;
        const sendRestartInFlight = {current: false};
        const recvRestartInFlight = {current: false};
        const clearBudget = (): void => {
          if (restartBudgetTimer) { clearTimeout(restartBudgetTimer); restartBudgetTimer = null; }
        };
        const startBudget = (): void => {
          clearBudget();
          restartBudgetTimer = setTimeout(() => {
            console.warn('[bravo.groupcall] reconnect budget exhausted — failing');
            if (!cancelled) {setState('failed');}
          }, RECONNECT_BUDGET_MS);
        };
        // B-14 — the SFU WebSocket idle-closes ~5s BEFORE ICE flips to
        // 'disconnected' (logs: `sfu.producers failed: transport not open`
        // precedes the ICE event). The OLD restart fired
        // `sfu.transport.restartIce` immediately — over the already-dead
        // socket — so it `ack_timeout`'d and the call stuck in 'failed'
        // forever with no recovery. socket.io auto-reconnects in the
        // background; we just have to WAIT for the WS to be open again
        // before sending the restart, and RETRY across the recovery budget
        // rather than one-shotting it.
        const wsIsOpen = (): boolean =>
          (ws as unknown as {state?: string}).state === 'connected';
        const waitForWsOpen = async (deadlineMs: number): Promise<boolean> => {
          while (Date.now() < deadlineMs) {
            if (cancelled || isLeavingRef.current) {return false;}
            if (wsIsOpen()) {return true;}
            await new Promise(r => setTimeout(r, 250));
          }
          return wsIsOpen();
        };
        const restartTransport = async (
          tx:        typeof sendTx,
          kind:      'send' | 'recv',
          inFlight:  {current: boolean},
        ): Promise<void> => {
          if (inFlight.current) {return;}
          if (cancelled || isLeavingRef.current) {return;}
          // B-05 — never restartIce over a known-dead WS. When the server's
          // P0-6 sweep dropped the socket, the restartIce wsRequest would
          // ack_timeout and the call would end in 'failed'. The reconnect →
          // rejoin path handles recovery once the socket reopens; here we
          // simply bail so we don't burn the reconnect budget on a doomed
          // round-trip.
          if (transportRef.current?.state !== 'connected') {
            console.log(`[bravo.groupcall] ${kind}Tx ice-restart skipped — WS not connected (state=${transportRef.current?.state ?? 'none'}); awaiting reconnect→rejoin`);
            return;
          }
          inFlight.current = true;
          // Retry within the same recovery budget. Each attempt first waits
          // for the WS to come back (so the restart command can actually be
          // delivered), then issues restartIce. We stop early once the
          // transport reports connected/completed again, on teardown, or
          // when the budget window elapses (the budget timer flips state to
          // 'failed' independently).
          const deadline = Date.now() + RECONNECT_BUDGET_MS;
          try {
            let attempt = 0;
            while (!cancelled && !isLeavingRef.current && Date.now() < deadline) {
              const txConn = (tx as unknown as {connectionState?: string}).connectionState;
              if (txConn === 'connected' || txConn === 'completed') {return;}
              attempt += 1;
              // Wait for the WS to reconnect before attempting the restart.
              const open = await waitForWsOpen(deadline);
              if (cancelled || isLeavingRef.current) {return;}
              if (!open) {
                console.warn(`[bravo.groupcall] ${kind}Tx ice-restart skipped attempt=${attempt} — WS still down`);
                continue;
              }
              try {
                console.log(`[bravo.groupcall] ${kind}Tx ice-restart begin attempt=${attempt}`);
                const resp = await wsRequest<{iceParameters: unknown}>(
                  ws,
                  'sfu.transport.restartIce',
                  {roomId: rid!, transportId: tx.id},
                );
                if (cancelled || isLeavingRef.current) {return;}
                await (tx as unknown as {restartIce: (p: {iceParameters: unknown}) => Promise<void>})
                  .restartIce({iceParameters: resp.iceParameters});
                console.log(`[bravo.groupcall] ${kind}Tx ice-restart applied attempt=${attempt}`);
                return;
              } catch (e) {
                console.warn(`[bravo.groupcall] ${kind}Tx ice-restart failed attempt=${attempt}: ${(e as Error).message}`);
                // Back off briefly, then re-evaluate WS + budget and retry.
                await new Promise(r => setTimeout(r, 1_000));
              }
            }
          } finally {
            inFlight.current = false;
          }
        };
        // BS-GC-ICE — dump the SELECTED ICE candidate pair when a transport
        // connects. This is the missing piece for "DTLS connected but 0 RTP"
        // field reports: it tells us whether media is going direct (host/
        // srflx to the SFU's announcedIp) or relayed (TURN), over UDP or
        // TCP — and which local/remote candidate types won. A pair that
        // selects e.g. relay/udp but still carries no media points at the
        // relay path; a host/udp pair that dies points at the device's
        // network dropping UDP to 40000-40100. Best-effort + Crashlytics so
        // it survives release builds where console.* isn't in logcat.
        const dumpSelectedPair = async (tx: typeof sendTx, kind: 'send' | 'recv'): Promise<void> => {
          try {
            // `RTCStatsReport` isn't in this project's lib types (RN), so
            // type the report by the only method we use — forEach — rather
            // than naming the global (which would add a tsc-baseline error).
            const report = await (tx as unknown as {
              getStats: () => Promise<{forEach: (cb: (s: Record<string, unknown>) => void) => void}>;
            }).getStats();
            const byId = new Map<string, Record<string, unknown>>();
            let pair: Record<string, unknown> | null = null;
            report.forEach((s: Record<string, unknown>) => {
              if (typeof s.id === 'string') {byId.set(s.id, s);}
              const t = s.type as string | undefined;
              if ((t === 'candidate-pair') && (s.selected === true || s.nominated === true || s.state === 'succeeded')) {
                // Prefer a nominated/selected pair; keep the last succeeded as fallback.
                if (!pair || s.selected === true || s.nominated === true) {pair = s;}
              }
            });
            if (!pair) { crashLog(`[bravo.groupcall.ice] ${kind}Tx connected but NO selected candidate-pair in stats`); return; }
            const p = pair as Record<string, unknown>;
            const loc = (typeof p.localCandidateId === 'string' ? byId.get(p.localCandidateId) : undefined) ?? {};
            const rem = (typeof p.remoteCandidateId === 'string' ? byId.get(p.remoteCandidateId) : undefined) ?? {};
            crashLog(
              `[bravo.groupcall.ice] ${kind}Tx pair` +
              ` local=${(loc.candidateType as string) ?? '?'}/${(loc.protocol as string) ?? '?'}` +
              ` remote=${(rem.candidateType as string) ?? '?'}/${(rem.protocol as string) ?? '?'}` +
              ` bytesSent=${(p.bytesSent as number) ?? 0} bytesRecv=${(p.bytesReceived as number) ?? 0}`,
            );
          } catch (e) {
            crashLog(`[bravo.groupcall.ice] ${kind}Tx getStats failed: ${(e as Error).message.slice(0, 50)}`);
          }
        };

        const onTxState = (kind: 'send' | 'recv', txState: string): void => {
          console.log(`[bravo.groupcall] ${kind}Tx connectionState=${txState}`);
          if (cancelled || isLeavingRef.current) {return;}
          // BS-GC-ICE-REFS — read the LIVE transports from the refs, not the
          // boot-time `sendTx`/`recvTx` consts. After a rejoinRoom (WS
          // reconnect) those consts are CLOSED and replaced by reSendTx/
          // reRecvTx; using them would restartIce a dead transport id (fails
          // until the budget flips to 'failed') and bothHealthy would read
          // the closed transports and never flip back to 'joined' (zombie
          // call). Fall back to the const before the refs are first set.
          const liveSend = sendTxRef.current ?? sendTx;
          const liveRecv = recvTxRef.current ?? recvTx;
          // BS-GC-ICE — on connect, snapshot the selected pair, and ~5s
          // later snapshot again so the byteSent/Recv delta reveals whether
          // RTP is actually flowing on the chosen pair (0 delta = the
          // "connected but no media" failure, now with the pair identified).
          if (txState === 'connected' || txState === 'completed') {
            const txRef = kind === 'send' ? liveSend : liveRecv;
            void dumpSelectedPair(txRef, kind);
            setTimeout(() => {
              if (!cancelled && !isLeavingRef.current) {
                void dumpSelectedPair(kind === 'send' ? (sendTxRef.current ?? liveSend) : (recvTxRef.current ?? liveRecv), kind);
              }
            }, 5000);
          }
          if (txState === 'disconnected') {
            setState(prev => (prev === 'joined' ? 'reconnecting' : prev));
            startBudget();
            if (kind === 'send') {
              if (liveSend) { void restartTransport(liveSend, 'send', sendRestartInFlight); }
            } else {
              if (liveRecv) { void restartTransport(liveRecv, 'recv', recvRestartInFlight); }
            }
          } else if (txState === 'connected' || txState === 'completed') {
            // Only flip back if BOTH transports are healthy and we
            // were in 'reconnecting'.
            const sendState = (liveSend as unknown as {connectionState?: string})?.connectionState;
            const recvState = (liveRecv as unknown as {connectionState?: string})?.connectionState;
            const bothHealthy =
              (sendState === 'connected' || sendState === 'completed') &&
              (recvState === 'connected' || recvState === 'completed');
            if (bothHealthy) {
              clearBudget();
              setState(prev => (prev === 'reconnecting' ? 'joined' : prev));
            }
          } else if (txState === 'failed') {
            clearBudget();
            if (!cancelled) {setState('failed');}
          }
        };
        // mediasoup-client emits 'connectionstatechange' with a state
        // string; we use a permissive cast since the on() typing is
        // overloaded and varies by mediasoup-client version.
        (sendTx as unknown as {on: (e: string, cb: (s: string) => void) => void})
          .on('connectionstatechange', (s) => onTxState('send', s));
        (recvTx as unknown as {on: (e: string, cb: (s: string) => void) => void})
          .on('connectionstatechange', (s) => onTxState('recv', s));

        // 7. (moved up) The per-room SFU frame handler is now registered
        // right after step 1, BEFORE sfu.join — see the
        // `registerSfuHandler(rid, …)` block above. Producer frames that
        // arrive in the join→recvTx window are buffered there and drained
        // below (B-06).

        // 8. Produce our local tracks.
        // Audio: pin to mono Opus @ 32 kbps with in-band FEC + DTX.
        // Without these knobs mediasoup negotiates Opus stereo @ 32–64
        // kbps with NO FEC — every lost packet then triggers a NACK
        // round-trip, the receiver's NetEq jitter buffer grows to
        // compensate, and the call gains 300+ ms of audible delay.
        // mediasoup-client maps these to the SDP fmtp on the producer;
        // the SFU's router codec config (sfuWorkerPool.ts) advertises
        // the same parameters so both sides agree.
        console.log('[bravo.groupcall.boot] step=8 producing local tracks');
        const enc = groupEncryptionRef.current;
        if (!enc) {throw new Error('SFrame encryption ref missing at produce time');}
        if (audioTrack) {
          // GC-06 — track blanked until the sender cryptor is attached.
          const p = await withTrackBlanked(audioTrack, async () => {
            const prod = await sendTx.produce({
              track: audioTrack as never,
              codecOptions: {
                opusStereo:            false,
                opusFec:               true,
                opusDtx:               true,
                opusMaxAverageBitrate: 32_000,
                opusPtime:             10,
              },
            } as never);
            producersRef.current.push(prod);
            // Attach SFrame encrypt transform to the underlying
            // RTPSender. mediasoup-client exposes it via .rtpSender on
            // its handler-specific Producer. If the platform doesn't
            // expose createEncodedStreams we throw — caller catches and
            // tears down the call (no plaintext send fallback).
            const rtpSender = (prod as unknown as {rtpSender?: {id: string}}).rtpSender;
            if (rtpSender) {
              try {
                const detach = await enc.attachSenderCryptor(
                  rtpSender,
                  (sendTx as unknown as {handler?: {_pc?: unknown}}).handler?._pc,
                  'audio',
                );
                sframeDetachersRef.current.push(detach);
                console.log('[bravo.groupcall.sframe] audio producer attached (FrameCryptor)');
              } catch (e) {
                console.warn('[bravo.groupcall.sframe] audio attach FAILED — refusing:', (e as Error).message);
                throw e;
              }
            }
            return prod;
          });
          console.log(`[bravo.groupcall.quality] audio producer up (mono, fec, dtx) id=${p.id.slice(0,8)}`);
        }
        // Video: use 3-layer simulcast so the SFU can drop to lower
        // layers per-receiver when bandwidth tanks. Each receiver gets
        // the highest layer their downlink can sustain — a slow
        // viewer sees 180p@15fps while a fast viewer sees 720p@30fps,
        // all from the same producer. Without simulcast, bad-link
        // viewers freeze the entire call. Tagged [bravo.groupcall.quality].
        // Re-read the CURRENT camera track from the ref: the user may have
        // toggled video OFF (track stopped → readyState 'ended') or ON (a
        // fresh local-preview track) DURING the connect/ring window.
        // Producing the STALE boot-time `videoTrack` after a toggle-off
        // throws "track ended" and FAILS THE ENTIRE CALL (the "call fails
        // when I toggle while ringing" bug). If video is off / the track
        // ended, skip video and start AUDIO-ONLY — the user can turn the
        // camera on later via toggleVideo (the no-producer ON path produces
        // it then). If video is on, produce whatever track is live now
        // (incl. a fresh one acquired by a toggle-ON local-preview).
        const liveVideoTrack = videoTrackRef.current;
        const liveVideoEnded = !liveVideoTrack
          || (liveVideoTrack as unknown as {readyState?: string}).readyState === 'ended';
        if (liveVideoTrack && !isVideoOffRef.current && !liveVideoEnded) {
          // GC-06 — track blanked until the sender cryptor is attached.
          const p = await withTrackBlanked(liveVideoTrack, async () => {
            const prod = await sendTx.produce({
              track: liveVideoTrack as never,
              encodings: [
                {rid: 'r0', maxBitrate:  150_000, scaleResolutionDownBy: 4, maxFramerate: 15},
                {rid: 'r1', maxBitrate:  500_000, scaleResolutionDownBy: 2, maxFramerate: 24},
                {rid: 'r2', maxBitrate: 1_200_000,                          maxFramerate: 30},
              ],
              // Attach SFrame encrypt transform AFTER produce returns.
              // See block below for the rationale + refusal contract.
              codecOptions: {
                // 200 (was 600): start low so TWCC measures the real
                // uplink capacity before we flood the modem queue with
                // 600 kbps of video. Same head-of-line-blocking fix
                // applied on the SFU side (initialBitrate 300k).
                videoGoogleStartBitrate: 200,
              },
            } as never);
            producersRef.current.push(prod);
            const rtpSender = (prod as unknown as {rtpSender?: {id: string}}).rtpSender;
            if (rtpSender) {
              try {
                const detach = await enc.attachSenderCryptor(
                  rtpSender,
                  (sendTx as unknown as {handler?: {_pc?: unknown}}).handler?._pc,
                  'video',
                );
                sframeDetachersRef.current.push(detach);
                console.log('[bravo.groupcall.sframe] video producer attached (FrameCryptor)');
              } catch (e) {
                console.warn('[bravo.groupcall.sframe] video attach FAILED — refusing:', (e as Error).message);
                throw e;
              }
            }
            return prod;
          });
          console.log(`[bravo.groupcall.quality] video producer up — 3-layer simulcast id=${p.id.slice(0,8)}`);
        }

        // 9. Consume everyone already in the room.
        // B-13 — batch the initial burst: collect tiles, flush once after
        // the loop so the layout computes at the FINAL count (not 1).
        console.log(`[bravo.groupcall.boot] step=9 consuming ${joined.existingProducers.length} existing producer(s)`);
        try {
          for (const ep of joined.existingProducers) {
            console.log(`[bravo.groupcall.boot] step=9 consume tag=${ep.participantTag.slice(0,8)} kind=${ep.kind}`);
            await consumeProducer(ep.producerId, ep.participantTag, ep.kind, /* batch */ true);
          }
        } finally {
          if (pendingTileBatch.length > 0 && !cancelled && !isLeavingRef.current) {
            const batch = pendingTileBatch.splice(0, pendingTileBatch.length);
            setRemoteTiles(prev => {
              // Dedup by consumerId in case a live new-producer frame already
              // added one of these mid-burst (the per-tile path can run for a
              // producer announced while we were still consuming).
              const have = new Set(prev.map(t => t.consumerId));
              const next = prev.concat(batch.filter(t => !have.has(t.consumerId)));
              patchActiveGroupCall({remoteTiles: next});
              return next;
            });
          }
        }

        // 9b. B-06 — recv pipeline (recvTx + consumeProducer + group key)
        // is now live, so drain any new-producer frames that arrived in the
        // join→recvTx window. Each forwards through consumeProducer, which
        // dedups against the producers we just consumed in step 9
        // (consumedProducerIds + inFlightConsumes) so there's no double
        // consume. From here `accept` consumes inline (isReady() true).
        if (earlyProducerBuffer.size() > 0) {
          console.log(`[bravo.groupcall.boot] step=9b draining ${earlyProducerBuffer.size()} early producer(s)`);
        }
        earlyProducerBuffer.drain();

        // 10. Identity broadcast — tell every other group member that
        // our SFU tag belongs to our display name. The SFU never sees
        // this; it travels through the existing E2E pairwise Signal
        // sessions. Best-effort: per-recipient failures are logged.
        try {
          const rt = await getMessengerRuntime();
          await rt.broadcastGroupCallPresence(opts.recipientUserIds, {
            roomId:         rid,
            participantTag: joined.participantTag,
            displayName:    opts.ownDisplayName,
            callType:       opts.callType,
          });
        } catch (e) {
          console.warn('[useGroupCall] presence broadcast failed:', (e as Error).message);
        }

        // 11. Outgoing direction → ring everyone in the group. Done AFTER
        // join so the room has a host (us) before recipients try to
        // join. sentRingRef guards against accidental re-rings on remount.
        if (opts.direction === 'outgoing' && !sentRingRef.current && opts.recipientUserIds.length > 0) {
          // Fix #11: only flip sentRingRef on SUCCESS. The previous
          // version set it before the wsRequest, so if the ring failed
          // (transient WS hiccup, peer_offline, anything) sentRingRef
          // was permanently true and a future state-transition retry
          // would silently no-op. Recipients would never get rung and
          // the host would stare at a "Ringing…" screen with nothing
          // happening. Set inside the try, AFTER the ack returns.
          try {
            await wsRequest<{ok: true}>(ws, 'sfu.ring', {
              roomId:           rid,
              conversationId:   opts.conversationId,
              callType:         opts.callType,
              callerName:       opts.callerName,
              recipientUserIds: opts.recipientUserIds,
            });
            sentRingRef.current = true;
            // Ring window starts now — UI shows "Ringing" status for
            // every dialed user until either their participantTag
            // shows up in identityByTag (answered) OR the 30s window
            // elapses (no-answer). After 30s we DON'T auto-re-ring;
            // the host explicitly taps "Re-ring" if they want to try
            // again. That's surfaced in the hook's `ringStatus` map.
            setRingStartedAt(Date.now());
          } catch (e) {
            console.warn('[useGroupCall] ring failed (sentRingRef stays false for retry):', (e as Error).message);
          }
        }

        // BS-MEDIA — `consumedProducerIdsRef.current` holds the producerIds
        // we've SUCCESSFULLY consumed (a tile is live for them). It drives
        // the reconcile diff so we don't re-consume what we already have,
        // and lets a permanent-failure producer fall through to the next
        // reconcile tick rather than being dropped forever. We read the ref
        // DIRECTLY at each use site below — NOT via a `const` captured here.
        // BS-GC-CRASH: a captured `const` declared at this point lived
        // AFTER step 9's existing-producer consume loop in source order, so
        // on a JOINER (host already producing) consumeProducer ran during
        // step 9 and touched the const inside its temporal dead zone →
        // "Cannot read property 'has' of undefined" / TDZ throw on the very
        // first consume. The host never hit it (empty existingProducers).
        // Reading the always-initialised ref directly removes the ordering
        // hazard entirely. Cleared per-producer on tile teardown.

        // BS-MEDIA — bounded retry around a single consume. Transient
        // failures (weak-link sfu.consume ack timeout, a recv.consume that
        // loses a race with ICE settling, an SFrame attach that throws
        // before the key epoch lands) used to drop the tile permanently:
        // the catch only logged, and no fresh sfu.new-producer frame ever
        // re-fires for an already-announced producer. We retry a few times
        // with backoff; anything still failing is left UN-consumed so the
        // reconcile tick retries it later.
        // `batch` is true ONLY for the step=9 existing-producer burst at boot
        // (B-13): those tiles are collected and flushed in one setRemoteTiles
        // after the loop. Every other caller — the live sfu.new-producer path
        // (a peer switching audio→video mid-call) and the reconcile tick —
        // MUST pass batch=false so the tile renders immediately. A shared
        // closure flag previously leaked the batch mode into the live path and
        // swallowed mid-call video tiles into a buffer that only drained once
        // at boot (the "switch to video doesn't show" regression).
        async function consumeProducer(producerId: string, participantTag: string, kind: 'audio' | 'video', batch = false): Promise<void> {
          // Fix #12: dedup concurrent consume attempts for the same
          // producerId. Two paths can race here: existingProducers
          // iteration on join + an sfu.new-producer frame for the same
          // producerId arriving in the gap. Mediasoup's recv.consume
          // would throw "consumer already exists" on the second call;
          // worse, the sfu.consume server side increments per-room
          // counters that get stuck.
          if (inFlightConsumes.current.has(producerId)) {
            console.log(`[useGroupCall] consume skipped (in flight) producerId=${producerId.slice(0,8)}`);
            return;
          }
          if (consumedProducerIdsRef.current.has(producerId)) {return;}
          inFlightConsumes.current.add(producerId);
          const MAX_ATTEMPTS = 3;
          try {
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
              if (cancelled || isLeavingRef.current) {return;}
              const ok = await attemptConsume(producerId, participantTag, kind, batch);
              if (ok) { consumedProducerIdsRef.current.add(producerId); return; }
              if (attempt < MAX_ATTEMPTS) {
                // Backoff 300ms, 600ms — short enough to recover before
                // the user notices a missing tile, long enough to let a
                // transient ICE/key blip clear.
                const delay = 300 * attempt;
                console.warn(`[useGroupCall] consume retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms producerId=${producerId.slice(0,8)}`);
                await new Promise<void>(r => setTimeout(r, delay));
              } else {
                console.warn(`[useGroupCall] consume gave up after ${MAX_ATTEMPTS} attempts producerId=${producerId.slice(0,8)} — reconcile will retry`);
              }
            }
          } finally {
            inFlightConsumes.current.delete(producerId);
          }
        }

        // Returns true on success, false on a (retryable) failure. Never
        // throws — the SFrame refuse-on-failure path closes its own
        // consumer and returns false so the retry loop can try again.
        async function attemptConsume(producerId: string, participantTag: string, _kind: 'audio' | 'video', batch = false): Promise<boolean> {
          // Function declaration breaks TS's narrowing on the captured
          // `ws`, so re-assert via the ref (which we set right after the
          // initial null check above).
          const wsLive = transportRef.current;
          if (!wsLive || !deviceRef.current || !recvTxRef.current) {
            return false;
          }
          // Fix #9: also bail if the hook is mid-leave — a late frame
          // could try to spin up a fresh consumer against a closed
          // recvTx and crash the bridge.
          if (isLeavingRef.current) {
            return false;
          }
          const dev = deviceRef.current;
          const recv = recvTxRef.current;
          // BS-MEDIA — track the consumer + whether the tile was fully
          // registered so a mid-way failure (e.g. sfu.consumer.resume
          // throws after recv.consume succeeded) can close the orphan
          // before the retry mints a fresh one. Without this, each retry
          // would leak a half-built consumer into consumersByPid.
          let consumer: Consumer | null = null;
          let tileRegistered = false;
          try {
            const consumed = await wsRequest<{
              consumerId: string; producerId: string; kind: 'audio' | 'video';
              rtpParameters: unknown; participantTag: string;
              producerPaused?: boolean;
            }>(wsLive, 'sfu.consume', {
              roomId: rid!, transportId: recv.id, producerId,
              rtpCapabilities: dev.rtpCapabilities,
            });

            // Re-check leaving — getStats / consume are slow on weak
            // links and the user can hit End between request and ack.
            if (isLeavingRef.current) { return false; }

            consumer = await recv.consume({
              id:            consumed.consumerId,
              producerId:    consumed.producerId,
              kind:          consumed.kind,
              rtpParameters: consumed.rtpParameters as never,
            });
            // Non-null alias so the downstream body keeps reading cleanly
            // (the outer `consumer` stays mutable for the catch's cleanup).
            const c = consumer;
            consumersByPid.current.set(c.id, c);

            // S6 / P0-C1 — attach SFrame decrypt transform to the
            // remote RTPReceiver. Refusal-on-failure: if the platform
            // doesn't expose the encoded-frame API we tear down the
            // consumer rather than render plaintext (the SFU is the
            // attacker in our threat model — it MUST NOT see media).
            const encRecv = groupEncryptionRef.current;
            const rtpReceiver = (c as unknown as {rtpReceiver?: {id: string}}).rtpReceiver;
            if (encRecv && rtpReceiver) {
              try {
                const detach = await encRecv.attachReceiverCryptor(
                  rtpReceiver,
                  (recv as unknown as {handler?: {_pc?: unknown}}).handler?._pc,
                  participantTag,
                );
                sframeDetachersRef.current.push(detach);
                console.log(`[bravo.groupcall.sframe] consumer attached (FrameCryptor) tag=${participantTag.slice(0,8)} kind=${consumed.kind}`);
              } catch (e) {
                console.warn('[bravo.groupcall.sframe] consumer attach FAILED — closing consumer:', (e as Error).message);
                try {c.close();} catch { /* ignore */ }
                consumersByPid.current.delete(c.id);
                consumer = null; // already closed — don't double-close in catch
                throw e;
              }
            }

            // Latency: cap NetEq jitter-buffer target at 150 ms on
            // audio receivers. Default adaptive target grows to 300+ ms
            // on weak networks → audible echo. Best-effort: not all
            // RN-WebRTC builds expose playoutDelayHint, so the try
            // simply ignores unsupported runtimes.
            if (consumed.kind === 'audio') {
              try {
                const receiver = (c as unknown as {rtpReceiver?: {playoutDelayHint?: number}}).rtpReceiver;
                if (receiver) { receiver.playoutDelayHint = 0.15; }
              } catch { /* ignore */ }
            }

            await wsRequest<{ok: true}>(wsLive, 'sfu.consumer.resume', {
              roomId: rid!, consumerId: c.id,
            });

            const ms = new MediaStream();
            ms.addTrack(c.track as unknown as MediaStreamTrack);
            const newTile: RemoteTile = {
              participantTag,
              consumerId:  c.id,
              producerId,
              kind:        consumed.kind,
              stream:      ms,
              // Late join: the peer's camera may already be off — start
              // on the avatar placeholder, not a frameless black plane.
              // Older servers omit the field → false (unchanged).
              paused:      consumed.producerPaused === true,
            };
            if (batch) {
              // B-13 — boot burst ONLY: defer the React update; the step=9
              // loop flushes the whole batch in one setRemoteTiles so the
              // layout sees the final tile count and never freezes at the
              // intermediate 1. The live new-producer path passes batch=false
              // so a mid-call audio→video switch renders its tile immediately
              // (regression fix: the old shared flag swallowed those tiles).
              pendingTileBatch.push(newTile);
            } else {
              setRemoteTiles(prev => {
                const next = prev.concat(newTile);
                patchActiveGroupCall({remoteTiles: next});
                return next;
              });
            }
            // Tile is live — from here a failure is NOT a retryable
            // partial; the consumer is fully wired and owned by the map.
            tileRegistered = true;

            // Fix #9: track listener cleanup. Each consumer accumulates
            // listeners (trackended, mute, unmute) that have no
            // standardized removeEventListener path on RN-WebRTC's
            // MediaStreamTrack. We capture each cb behind a `cancelled`
            // flag the cleanup array can flip — that way the listeners
            // remain attached but become inert post-leaveInternal.
            // This also closes the post-unmount setState window: if
            // mute fires after we've torn down, setRemoteTiles would
            // run on an unmounted hook and React would warn.
            let listenerCancelled = false;
            const cleanups: Array<() => void> = [
              () => { listenerCancelled = true; },
            ];

            c.on('trackended', () => {
              if (listenerCancelled) {return;}
              setRemoteTiles(prev => prev.filter(t => t.consumerId !== c.id));
              consumersByPid.current.delete(c.id);
              consumerCleanupsByPid.current.delete(c.id);
              // BS-MEDIA — drop from the consumed set so that if this exact
              // producer is re-announced later the reconcile can re-consume
              // it (the producerId is the consume key).
              consumedProducerIdsRef.current.delete(producerId);
            });

            // Camera-off (paused) state is owned SOLELY by the authoritative
            // sfu.producer-paused/-resumed frames (+ the consume snapshot and
            // the reconcile re-apply). We deliberately DO NOT flip `paused`
            // from the native track 'mute' event any more. On a flaky hardware
            // decoder, 'mute' ALSO fires on a mid-stream DECODE STALL (camera
            // still on) — which mislabelled the tile as camera-off and, fatally,
            // EXCLUDED it from the freeze watchdog (vUnpaused), so the stall
            // self-heal / consumer-rebuild never ran and the peer's video
            // stayed frozen (device-confirmed: Redmi tile stuck at `=223(off)`).
            // Letting a real stall surface as an unpaused-but-not-advancing tile
            // is exactly what lets the watchdog recover it. A genuine camera-off
            // arrives as a producer-paused frame within ~100ms (matchedBy=pid),
            // so the avatar swap is unaffected.
            consumerCleanupsByPid.current.set(c.id, cleanups);
            return true;
          } catch (e) {
            // Retryable — the outer consumeProducer loop decides whether
            // to try again or leave it for the reconcile tick. Note the
            // SFrame attach failure path above rethrows here AFTER it has
            // already closed its own consumer + removed it from the map,
            // so a retry starts clean.
            console.warn('[useGroupCall] consume attempt failed', producerId.slice(0,8), (e as Error).message);
            // BS-MEDIA — close any half-built consumer so the retry mints
            // a fresh one cleanly instead of leaking it into the map.
            if (consumer && !tileRegistered) {
              try { consumer.close(); } catch { /* ignore */ }
              consumersByPid.current.delete(consumer.id);
            }
            return false;
          }
        }

        // BS-MEDIA — reconcile against the SFU's authoritative producer
        // list. Recovers two failure modes the old code dropped silently:
        //   1. a missed `sfu.new-producer` frame (WS blip, or a frame that
        //      arrived during the minimize→restore handler swap), and
        //   2. a producer whose consume exhausted its retries.
        // We ask the server which producers we SHOULD have, subtract the
        // ones we already consumed (or have in flight), and consume the
        // gap. Idempotent and cheap — safe to run on a slow tick.
        // B-17 — per-producer "absent from the authoritative snapshot"
        // counter, persisted across reconcile ticks (same boot closure).
        // A tile is only pruned after the producer has been gone for
        // PRUNE_MISS_THRESHOLD consecutive SUCCESSFUL snapshots, so a
        // transient/partial fetch can never drop a valid tile.
        const tilePruneMisses = new Map<string, number>();
        const PRUNE_MISS_THRESHOLD = 3;
        async function reconcileProducers(): Promise<void> {
          if (cancelled || isLeavingRef.current) {return;}
          const wsLive = transportRef.current;
          if (!wsLive || !rid) {return;}
          let resp: {producers: Array<{producerId: string; participantTag: string; kind: 'audio' | 'video'; paused?: boolean}>};
          try {
            resp = await wsRequest<typeof resp>(wsLive, 'sfu.producers', {roomId: rid});
          } catch (e) {
            console.warn('[bravo.groupcall.reconcile] sfu.producers failed:', (e as Error).message);
            return;
          }
          if (cancelled || isLeavingRef.current) {return;}
          // B-17 — reconcile on TILES, not just on consumers. A producer can
          // be fully consumed (consumer attached, audio flowing) yet have NO
          // tile if the step=9 boot-batch flush lost it to a race — the
          // rotating-victim symptom where a non-host joiner shows 2/3 tiles
          // even though every consumer attached. The old filter only
          // re-consumed producers with no CONSUMER, so a consumed-but-tileless
          // producer was invisible forever (the reconcile saw it as "already
          // consumed" and skipped it). Split the work by what's actually
          // missing:
          //   • no tile AND no live consumer  → fresh consume.
          //   • no tile BUT a live consumer    → rebuild the tile from the
          //     existing consumer; re-consuming would throw "consumer already
          //     exists" and the SFrame transform is already attached to it.
          const haveTileFor = new Set(remoteTilesRef.current.map(t => t.producerId));
          const recovered: RemoteTile[] = [];
          const toConsume: typeof resp.producers = [];
          for (const p of resp.producers) {
            if (haveTileFor.has(p.producerId)) {continue;}
            if (inFlightConsumes.current.has(p.producerId)) {continue;}
            const live = Array.from(consumersByPid.current.values()).find(
              c => (c as unknown as {producerId?: string}).producerId === p.producerId,
            );
            const track = live ? (live.track as unknown as MediaStreamTrack | null) : null;
            if (live && !(live as unknown as {closed?: boolean}).closed && track) {
              const ms = new MediaStream();
              ms.addTrack(track);
              recovered.push({
                participantTag: p.participantTag,
                consumerId:     live.id,
                producerId:     p.producerId,
                kind:           p.kind,
                stream:         ms,
                paused:         p.paused === true,
              });
            } else {
              toConsume.push(p);
            }
          }
          // Authoritative pause sync. A missed sfu.producer-paused/
          // -resumed frame self-heals here on the next tick. CALL-24:
          // audio now rides the same server-side producer pause as
          // video (toggleMuteInternal emits it), so the snapshot is
          // authoritative for the remote mic-off glyph too — this only
          // touches REMOTE tiles, never the local mute badge.
          {
            const pauseSync = resp.producers.filter(p => p.paused !== undefined);
            if (pauseSync.length > 0) {
              setRemoteTiles(prev => {
                let next = prev;
                for (const p of pauseSync) {
                  next = applyProducerPaused(next, p.producerId, p.paused === true);
                }
                if (next !== prev) {patchActiveGroupCall({remoteTiles: next});}
                return next;
              });
            }
          }
          // Audit GC-01 — durably re-assert MY OWN camera pause state. If the
          // authoritative snapshot for my video producer disagrees with what I
          // intended (a lost pause/resume, or a reconnect that dropped my SFU
          // tag), re-emit so peers converge onto the right state. Fixes both
          // the reported video-toggle-not-syncing bug and the receiver churn
          // loop (GC-02) that a stuck-unpaused producer triggers.
          if (intendedVideoPausedRef.current !== null && !isLeavingRef.current) {
            const myVp = producersRef.current.find(
              p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'video'
                && !(p as unknown as {closed?: boolean}).closed,
            );
            const myPid = (myVp as unknown as {id?: string} | undefined)?.id;
            if (myPid) {
              const snap = resp.producers.find(p => p.producerId === myPid);
              if (snap?.paused !== undefined && snap.paused !== intendedVideoPausedRef.current) {
                const ev = intendedVideoPausedRef.current ? 'sfu.producer.pause' : 'sfu.producer.resume';
                console.log(`[bravo.groupcall.reassert] snapshot=${snap.paused} intended=${intendedVideoPausedRef.current} → ${ev}`);
                void wsRequest<{ok: true}>(wsLive, ev, {roomId: rid, producerId: myPid})
                  .catch(e => console.log(`[bravo.groupcall.reassert] ${ev} failed:`, (e as Error).message));
              }
            }
          }
          if (recovered.length > 0) {
            console.log(`[bravo.groupcall.reconcile] rebuilding ${recovered.length} orphaned tile(s)`);
            setRemoteTiles(prev => {
              const have = new Set(prev.map(t => t.consumerId));
              const next = prev.concat(recovered.filter(t => !have.has(t.consumerId)));
              patchActiveGroupCall({remoteTiles: next});
              return next;
            });
          }
          // B-17 — PRUNE phantom tiles. A boot-race room recreation (B-08)
          // or a producer that closed without a `sfu.participant.left` can
          // leave a stale tile behind, shown as an EXTRA BLANK cell next to
          // the real participants (the v1.0.48 "SH + FA + 1 blank" symptom).
          // The server's snapshot is authoritative: a producer that's still
          // producing is ALWAYS listed, so a tile whose producerId is absent
          // for several consecutive successful snapshots is genuinely gone.
          // Debounced so a one-off partial fetch can't drop a live tile.
          // B-17 — prune phantom + superseded (zombie-tag) tiles. The rule
          // lives in `computeTilePrune` (pure, unit-tested): a tag absent
          // from the snapshot whose userId is live under a DIFFERENT tag was
          // replaced by a reconnect→rejoin (B-05 WS churn) and drops THIS
          // tick; a plain-absent producer drops only after
          // PRUNE_MISS_THRESHOLD consecutive successful snapshots so a
          // partial fetch can't evict a live participant. Identity
          // (tag→userId) comes from the per-room registry, populated by each
          // peer's groupCallPresence envelope at (re)join.
          const {pruneConsumerIds, prunedProducerIds, nextMisses} = computeTilePrune({
            tiles:               remoteTilesRef.current,
            snapshot:            resp.producers,
            inFlightProducerIds: inFlightConsumes.current,
            identities:          getGroupCallIdentities(rid),
            prevMisses:          tilePruneMisses,
            threshold:           PRUNE_MISS_THRESHOLD,
          });
          tilePruneMisses.clear();
          for (const [pid, n] of nextMisses) {tilePruneMisses.set(pid, n);}
          for (const pid of prunedProducerIds) {
            // Allow a re-consume if the producer ever reappears.
            consumedProducerIdsRef.current.delete(pid);
          }
          if (pruneConsumerIds.size > 0) {
            console.log(`[bravo.groupcall.reconcile] pruning ${pruneConsumerIds.size} stale tile(s)`);
            for (const cid of pruneConsumerIds) {
              const c = consumersByPid.current.get(cid);
              if (c) {
                try { (c as unknown as {close?: () => void}).close?.(); } catch { /* already closed */ }
                consumersByPid.current.delete(cid);
              }
            }
            setRemoteTiles(prev => {
              const next = prev.filter(t => !pruneConsumerIds.has(t.consumerId));
              patchActiveGroupCall({remoteTiles: next});
              return next;
            });
          }
          if (toConsume.length === 0) {return;}
          console.log(`[bravo.groupcall.reconcile] consuming ${toConsume.length} missing producer(s)`);
          for (const p of toConsume) {
            await consumeProducer(p.producerId, p.participantTag, p.kind);
          }
        }
        reconcileProducersRef.current = reconcileProducers;

        // B-05 — re-wire mediasoup against the FRESH participantTag +
        // transports the server mints on a reconnect-driven sfu.join. The
        // group master key is unchanged (the original key gate already
        // passed), so we REUSE groupEncryptionRef — no re-gate, no
        // plaintext fallback (ARCHITECTURE_AMENDMENT_SFRAME §"fails
        // closed"). We close the dead transports/producers/consumers
        // first, then rebuild from the new join response and re-consume
        // its existingProducers. Does NOT touch the group key, refresh, or
        // any server state — purely a client-side re-entry into the SFU.
        // Arrow (not a function declaration) so it keeps the IIFE's
        // non-null narrowing of the captured `ws`.
        const rejoinRoom = async (rejoined: SfuJoinedResp): Promise<void> => {
          const dev = deviceRef.current;
          const recEnc = groupEncryptionRef.current;
          if (!dev || !recEnc) {throw new Error('rejoin: device/encryption missing');}
          participantTagRef.current = rejoined.participantTag;
          setSelfTag(rejoined.participantTag);
          setIsHost(rejoined.isHost);
          // Tear down the dead client-side mediasoup objects bound to the
          // pre-drop socket. SFrame detachers first (abort in-flight pipes
          // before transports close), then producers/consumers/transports.
          // Keep groupEncryptionRef alive — same key, re-attached below.
          for (const detach of sframeDetachersRef.current) { try {detach();} catch { /* ignore */ } }
          sframeDetachersRef.current = [];
          for (const cleanups of consumerCleanupsByPid.current.values()) {
            for (const cb of cleanups) { try { cb(); } catch { /* ignore */ } }
          }
          consumerCleanupsByPid.current.clear();
          for (const p of producersRef.current) { try { p.close(); } catch { /* ignore */ } }
          producersRef.current = [];
          for (const c of consumersByPid.current.values()) { try { c.close(); } catch { /* ignore */ } }
          consumersByPid.current.clear();
          inFlightConsumes.current.clear();
          consumedProducerIdsRef.current.clear();
          try { sendTxRef.current?.close(); } catch { /* ignore */ }
          try { recvTxRef.current?.close(); } catch { /* ignore */ }
          setRemoteTiles([]);
          patchActiveGroupCall({remoteTiles: []});

          const freshTurn = await fetchTurnCredentials();
          if (cancelled || isLeavingRef.current) {return;}

          const reSendTx = dev.createSendTransport({
            ...(rejoined.sendTransport as Record<string, unknown>),
            iceServers:           freshTurn,
            iceTransportPolicy:   'all',
            iceCandidatePoolSize: 0,
          } as never);
          sendTxRef.current = reSendTx;
          reSendTx.on('connect', ({dtlsParameters}, cb, errb) => {
            if (isLeavingRef.current) { errb(new Error('leaving')); return; }
            wsRequest<{ok: true}>(ws, 'sfu.transport.connect', {
              roomId: rid!, transportId: reSendTx.id, dtlsParameters,
            }).then(() => cb()).catch(e => errb(e as Error));
          });
          reSendTx.on('produce', ({kind, rtpParameters}, cb, errb) => {
            if (isLeavingRef.current) { errb(new Error('leaving')); return; }
            wsRequest<{producerId: string}>(ws, 'sfu.produce', {
              roomId: rid!, transportId: reSendTx.id, kind, rtpParameters,
            }).then(({producerId}) => cb({id: producerId})).catch(e => errb(e as Error));
          });

          const reRecvTx = dev.createRecvTransport({
            ...(rejoined.recvTransport as Record<string, unknown>),
            iceServers:           freshTurn,
            iceTransportPolicy:   'all',
            iceCandidatePoolSize: 0,
          } as never);
          recvTxRef.current = reRecvTx;
          reRecvTx.on('connect', ({dtlsParameters}, cb, errb) => {
            if (isLeavingRef.current) { errb(new Error('leaving')); return; }
            wsRequest<{ok: true}>(ws, 'sfu.transport.connect', {
              roomId: rid!, transportId: reRecvTx.id, dtlsParameters,
            }).then(() => cb()).catch(e => errb(e as Error));
          });
          (reSendTx as unknown as {on: (e: string, cb: (s: string) => void) => void})
            .on('connectionstatechange', (s) => onTxState('send', s));
          (reRecvTx as unknown as {on: (e: string, cb: (s: string) => void) => void})
            .on('connectionstatechange', (s) => onTxState('recv', s));

          // Re-produce the still-live local tracks (the camera/mic were
          // never released across the WS drop). SFrame re-attached via the
          // same encryptor; refuse (throw) on attach failure.
          const at = audioTrackRef.current;
          if (at && at.readyState !== 'ended') {
            // GC-06 — track blanked until the sender cryptor is attached.
            await withTrackBlanked(at, async () => {
              const p = await reSendTx.produce({
                track: at as never,
                codecOptions: {opusStereo: false, opusFec: true, opusDtx: true, opusMaxAverageBitrate: 32_000, opusPtime: 10},
              } as never);
              producersRef.current.push(p);
              const rtpSender = (p as unknown as {rtpSender?: {id: string}}).rtpSender;
              if (rtpSender) {
                const detach = await recEnc.attachSenderCryptor(rtpSender, (reSendTx as unknown as {handler?: {_pc?: unknown}}).handler?._pc, 'audio');
                sframeDetachersRef.current.push(detach);
              }
            });
          }
          const vt = videoTrackRef.current;
          if (vt && vt.readyState !== 'ended') {
            // GC-06 — track blanked until the sender cryptor is attached.
            await withTrackBlanked(vt, async () => {
              const p = await reSendTx.produce({
                track: vt as never,
                encodings: [
                  {rid: 'r0', maxBitrate:  150_000, scaleResolutionDownBy: 4, maxFramerate: 15},
                  {rid: 'r1', maxBitrate:  500_000, scaleResolutionDownBy: 2, maxFramerate: 24},
                  {rid: 'r2', maxBitrate: 1_200_000,                          maxFramerate: 30},
                ],
                codecOptions: {videoGoogleStartBitrate: 200},
              } as never);
              producersRef.current.push(p);
              const rtpSender = (p as unknown as {rtpSender?: {id: string}}).rtpSender;
              if (rtpSender) {
                const detach = await recEnc.attachSenderCryptor(rtpSender, (reSendTx as unknown as {handler?: {_pc?: unknown}}).handler?._pc, 'video');
                sframeDetachersRef.current.push(detach);
              }
            });
          }

          // Re-consume everyone already in the room (fresh consume keys
          // against the new recv transport).
          for (const ep of rejoined.existingProducers) {
            await consumeProducer(ep.producerId, ep.participantTag, ep.kind);
          }

          // Refresh the leak-stash with the new live handles.
          liveSfuHandlesByRoom.set(rid!, {
            device:           deviceRef.current,
            sendTx:           sendTxRef.current,
            recvTx:           recvTxRef.current,
            transport:        transportRef.current,
            producers:        producersRef.current,
            consumersByPid:   consumersByPid.current,
            consumerCleanups: consumerCleanupsByPid.current,
            sframeDetachers:  sframeDetachersRef.current,
            groupEncryption:  groupEncryptionRef.current,
            participantTag:   participantTagRef.current,
            handlerCleanup:   cleanupSubRef.current,  // F6
            rejoinRoom,                               // L14
            roomToken:        roomTokenRef.current,    // L14
          });
          if (cancelled || isLeavingRef.current) {return;}
          setState('joined');
        };
        rejoinRoomRef.current = rejoinRoom;

        if (cancelled) {return;}
        callStartedAtRef.current = Date.now();
        setState('joined');

        // Audit BS-LEAK — stash the live mediasoup handles so a
        // minimize→restore can rehydrate the restored hook's refs and
        // its leaveInternal can actually close them. We store the SAME
        // container objects (Maps/arrays), so producers/consumers added
        // during the minimize window (via the original handler) are
        // still reachable for teardown. See holder doc at top of file.
        liveSfuHandlesByRoom.set(rid, {
          device:           deviceRef.current,
          sendTx:           sendTxRef.current,
          recvTx:           recvTxRef.current,
          transport:        transportRef.current,
          producers:        producersRef.current,
          consumersByPid:   consumersByPid.current,
          consumerCleanups: consumerCleanupsByPid.current,
          sframeDetachers:  sframeDetachersRef.current,
          groupEncryption:  groupEncryptionRef.current,
          participantTag:   participantTagRef.current,
          handlerCleanup:   cleanupSubRef.current,  // F6
          rejoinRoom,                               // L14
          roomToken:        roomTokenRef.current,    // L14
        });

        // Publish to the floating-overlay registry so minimize works.
        // B-33 (Defect B) — preserve the last-known roster on a same-room
        // rejoin (the adopt gate can miss when a local track ended), so the
        // user doesn't see an empty grid while live consume re-attaches. A
        // different room / no prior call seeds empty; the consume + identity
        // flow overwrites with live data either way.
        const rosterSeed = seedRosterForRepublish(
          getActiveGroupCall(), rid, joined.participantTag, opts.ownDisplayName,
        );
        // BS-MINIMIZE-RING — preserve a minimize the user did WHILE it rang
        // (the early-seed registry may already be isMinimized/keepAlive). If
        // we hardcoded false here the call would un-minimize itself the
        // instant it connected behind the bubble.
        const prevReg = getActiveGroupCall();
        setActiveGroupCall({
          roomId:           rid,
          conversationId:   opts.conversationId,
          conversationName: opts.callerName,
          callType:         opts.callType,
          isHost:           joined.isHost,
          selfTag:          joined.participantTag,
          state:            'joined',
          localStream:      stream,
          remoteTiles:      rosterSeed.remoteTiles,
          identityByTag:    rosterSeed.identityByTag,
          audioLevels:      {},
          audioTrack,
          // Reflect any toggle the user made DURING the ring/connect window
          // (the boot started audio-only if they turned video off) instead
          // of hardcoding the at-join defaults.
          videoTrack:       videoTrackRef.current,
          isMuted:          audioTrackRef.current ? !audioTrackRef.current.enabled : false,
          isVideoOff:       isVideoOffRef.current,
          isMinimized:      prevReg?.isMinimized ?? false,
          keepAlive:        prevReg?.keepAlive ?? false,
          leave:            leaveInternal,
          toggleMute:       toggleMuteInternal,
          // Fix #15: register the freshest toggleVideo on the
          // registry too. Without this, the FloatingCallOverlay's
          // video toggle would call into a stale closure that
          // captured a stale localStream — turning the camera back on
          // would acquire a track but fail to splice it into the
          // currently-rendered MediaStream. The registry-sync effect
          // below also writes toggleVideo on every refresh.
          toggleVideo:      toggleVideo,
          joinedAtMs:       callStartedAtRef.current,
        });
      } catch (e) {
        if (!cancelled) {
          console.warn('[useGroupCall] boot failed:', (e as Error).message);
          setState('failed');
          // BS-MINIMIZE-RING — if the call was MINIMIZED while it was
          // connecting (the hook is unmounted, so setState('failed') is a
          // no-op), clear the registry so the floating bubble dismisses
          // instead of hanging on "connecting…" forever after a timeout /
          // no-answer / key-wait failure.
          try {
            const reg = getActiveGroupCall();
            if (reg && reg.conversationId === opts.conversationId && reg.isMinimized) {
              void endActiveGroupCall();
            }
          } catch { /* ignore */ }
        }
      }
    })();

    return () => {
      // BS-MINIMIZE-RING — on MINIMIZE (keepAlive), keep the boot/ring/call
      // running in the BACKGROUND so the floating bubble stays live and a
      // still-connecting call keeps connecting (the join/key-wait completes
      // behind the bubble). Only on a real teardown do we cancel + leave.
      const live = getActiveGroupCall();
      if (live?.keepAlive) {
        try { offReconnect?.(); } catch { /* ignore */ }
        offReconnect = null;
        return;
      }
      cancelled = true;
      // B-05 — drop the reconnect listener bound to THIS (now-unmounting)
      // hook instance.
      try { offReconnect?.(); } catch { /* ignore */ }
      offReconnect = null;
      void leaveInternal();
    };
  // Mount once per call. Re-keying happens by remounting.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Audio level poller ────────────────────────────────────
  // Drives the "loudest speaker → hero tile" logic on page 1.
  // We don't poll producer/consumer objects individually because
  // mediasoup-client doesn't expose RTCRtpReceiver.getStats() in a
  // typed way; instead we walk the recv transport's combined report
  // once every 500 ms and pluck `audioLevel` off each inbound-rtp
  // of kind='audio'. The report's `trackIdentifier` lets us join
  // back to the consumer's track, then to its participantTag.
  // Tag: [bravo.groupcall.audio-level].
  useEffect(() => {
    if (state !== 'joined') {return;}
    const recvTx = recvTxRef.current;
    if (!recvTx) {return;}
    let cancelled = false;
    const trackToTag = (): Map<string, string> => {
      // (re)build the track→tag map each tick — cheap, and consumers
      // come/go as participants join/leave.
      const m = new Map<string, string>();
      for (const c of consumersByPid.current.values()) {
        if (c.kind !== 'audio') {continue;}
        const tag = (c.appData as {participantTag?: string} | undefined)?.participantTag
          // appData isn't set today; fall back to mapping consumerId
          // back to the tile we registered.
          ?? remoteTilesRef.current.find(t => t.consumerId === c.id)?.participantTag;
        const trackId = (c.track as MediaStreamTrack | null)?.id;
        if (tag && trackId) {m.set(trackId, tag);}
      }
      return m;
    };
    // B-15 — video track→tag map, plus the set of tags whose video consumer
    // is currently UNPAUSED (a paused producer is camera-off, not a stall).
    const videoTrackToTag = (): {byTrack: Map<string, string>; unpaused: Set<string>} => {
      const byTrack = new Map<string, string>();
      const unpaused = new Set<string>();
      for (const c of consumersByPid.current.values()) {
        if (c.kind !== 'video') {continue;}
        const tag = remoteTilesRef.current.find(t => t.consumerId === c.id)?.participantTag;
        const trackId = (c.track as MediaStreamTrack | null)?.id;
        if (!tag) {continue;}
        const tile = remoteTilesRef.current.find(t => t.consumerId === c.id);
        if (!tile?.paused) {unpaused.add(tag);}
        if (trackId) {byTrack.set(trackId, tag);}
      }
      return {byTrack, unpaused};
    };
    const VIDEO_STALL_MS = 3_000;
    // DIAG + freeze-watchdog scratch state (effect-scoped; resets on state change).
    let decodeTick = 0;
    const lastKfReqByTag   = new Map<string, number>();  // last keyframe re-request per tag
    const stallSinceByTag  = new Map<string, number>();  // when a tag's CONTINUOUS stall began
    const lastRebuildByTag = new Map<string, number>();  // last consumer-rebuild per tag
    // G-C (VIDEO_CALL_RENDER_ISSUES_HANDOFF §3) — fast rebuilds per tag
    // before we accept the sender genuinely isn't emitting and slow to a
    // 60s probe (the stalled-tag overlay stays up meanwhile). Unbounded
    // 8s churn (teardown → re-consume → fresh decoder) blanked/blinked
    // the tile forever when the stall was sender-side.
    const rebuildCountByTag = new Map<string, number>();
    const MAX_FAST_REBUILDS = 3;
    const SLOW_REBUILD_MS   = 60_000;
    const tick = async (): Promise<void> => {
      // Fix #10: bail before EVERY work step if the call is leaving.
      // The 500ms interval is wide enough for leaveInternal to close
      // recvTx and null sendTxRef between ticks; without this guard
      // the next tick would fire getStats() on a closed transport
      // (mediasoup throws "transport closed") and the unhandled
      // promise rejection ends up as a noisy logcat warning every
      // half second until the unmount commits.
      if (cancelled || isLeavingRef.current) {return;}
      const live = recvTxRef.current;
      if (!live) {return;}
      try {
        const report = await (live as unknown as {getStats: () => Promise<RTCStatsReport>}).getStats();
        const map = trackToTag();
        const {byTrack: vmap, unpaused: vUnpaused} = videoTrackToTag();
        const next: AudioLevelMap = {};
        const videoFramesByTag = new Map<string, number>();
        report.forEach((s: Record<string, unknown>) => {
          const type = s.type as string | undefined;
          if (type !== 'inbound-rtp') {return;}
          if (s.kind === 'audio') {
            const trackId = (s.trackIdentifier as string | undefined) ?? '';
            const tag = map.get(trackId);
            if (!tag) {return;}
            // audioLevel comes from the spec as 0..1 (RFC 6464 voice
            // activity). Some Android stacks report a different scale;
            // clamp defensively.
            const lvl = Math.max(0, Math.min(1, Number(s.audioLevel ?? 0)));
            next[tag] = lvl;
          } else if (s.kind === 'video') {
            const trackId = (s.trackIdentifier as string | undefined) ?? '';
            const tag = vmap.get(trackId);
            if (!tag) {return;}
            videoFramesByTag.set(tag, Number(s.framesDecoded ?? 0));
          }
        });
        if (cancelled) {return;}

        // B-15 — fold the framesDecoded readings into the stall tracker.
        // A tag is "stalled" when its UNPAUSED video consumer hasn't
        // decoded a new frame for VIDEO_STALL_MS. Paused producers
        // (camera-off) are excluded — they have their own placeholder.
        const nowMs = Date.now();
        const snap = videoFrameSnapRef.current;
        const stalledNext: Record<string, boolean> = {};
        for (const tag of vUnpaused) {
          const frames = videoFramesByTag.get(tag) ?? 0;
          const prevSnap = snap.get(tag);
          if (!prevSnap) {
            snap.set(tag, {frames, lastAdvanceMs: nowMs});
            continue;
          }
          if (frames > prevSnap.frames) {
            snap.set(tag, {frames, lastAdvanceMs: nowMs});
          } else if (nowMs - prevSnap.lastAdvanceMs > VIDEO_STALL_MS) {
            stalledNext[tag] = true;
          }
        }
        // Drop snapshots for tags that no longer have an unpaused video
        // consumer so a later camera-on starts its grace window fresh.
        for (const tag of Array.from(snap.keys())) {
          if (!vUnpaused.has(tag)) {snap.delete(tag);}
        }
        // DIAG — per-tag decode health every ~3s. A remote video tag whose
        // framesDecoded stays flat (and isn't camera-off) is a decode stall:
        // either keyframe starvation or an SFrame decrypt miss. (off) marks a
        // tile we believe is paused — if a tag shows (off) while the peer's
        // camera is ON, the producer-paused match is wrong, not a decode stall.
        decodeTick++;
        if (decodeTick % 6 === 0) {
          const parts: string[] = [];
          for (const t of remoteTilesRef.current) {
            if (t.kind !== 'video') {continue;}
            const fr = videoFramesByTag.get(t.participantTag);
            parts.push(`${t.participantTag.slice(0,6)}=${fr ?? -1}${t.paused ? '(off)' : ''}`);
          }
          if (parts.length) {console.log(`[bravo.groupcall.decode] frames ${parts.join(' ')}`);}
        }
        // Freeze watchdog — recover an UNPAUSED video tile whose frames stop
        // advancing. Two-step escalation per tag:
        //   1. ≤2.5s stalled: cheap keyframe re-request (sfu.consumer.resume →
        //      server requestKeyFrame). Fixes a missed I-frame / simulcast-layer
        //      switch / dropped initial keyframe.
        //   2. >2.5s stalled (a keyframe didn't help → the hardware decoder is
        //      wedged): REBUILD the consumer for a FRESH decoder. This is the
        //      device-confirmed cure for the Redmi mid-call freeze; a keyframe
        //      alone can't un-stick a jammed hardware H.264 decoder.
        {
          const wsHeal  = transportRef.current;
          const ridHeal = roomIdRef.current;
          // Clear stall bookkeeping for any tag that has recovered (or whose
          // tile vanished mid-rebuild) so its next stall starts a fresh window.
          for (const tag of Array.from(stallSinceByTag.keys())) {
            if (!stalledNext[tag]) {
              stallSinceByTag.delete(tag);
              // G-C — a recovery resets the fast-rebuild budget.
              rebuildCountByTag.delete(tag);
            }
          }
          if (wsHeal && ridHeal) {
            for (const tag of Object.keys(stalledNext)) {
              const tile = remoteTilesRef.current.find(t => t.participantTag === tag && t.kind === 'video');
              if (!tile) {continue;}
              if (!stallSinceByTag.has(tag)) {stallSinceByTag.set(tag, nowMs);}
              const stalledForMs = nowMs - (stallSinceByTag.get(tag) ?? nowMs);
              if (stalledForMs <= 2_500) {
                // Step 1 — keyframe re-request (≤1 per 1.5s/tag).
                if (nowMs - (lastKfReqByTag.get(tag) ?? 0) >= 1_500) {
                  lastKfReqByTag.set(tag, nowMs);
                  void wsRequest<{ok: true}>(wsHeal, 'sfu.consumer.resume', {roomId: ridHeal, consumerId: tile.consumerId})
                    .then(() => console.log(`[bravo.groupcall.decode] keyframe re-request OK tag=${tag.slice(0,6)} cid=${tile.consumerId.slice(0,8)}`))
                    .catch((e) => console.log(`[bravo.groupcall.decode] keyframe re-request failed tag=${tag.slice(0,6)}: ${(e as Error).message}`));
                }
              } else {
                // Step 2 — rebuild the wedged consumer (≤1 per 8s/tag).
                // G-C — after MAX_FAST_REBUILDS the churn clearly isn't
                // fixing it (the stall is sender-side: their capture died
                // or our pause-state is wrong); drop to one probe per
                // 60s so the tile shows the stable stalled overlay
                // instead of blanking/blinking every 8s forever.
                const rebuilds = rebuildCountByTag.get(tag) ?? 0;
                const interval = rebuilds >= MAX_FAST_REBUILDS ? SLOW_REBUILD_MS : 8_000;
                if (nowMs - (lastRebuildByTag.get(tag) ?? 0) >= interval) {
                  lastRebuildByTag.set(tag, nowMs);
                  stallSinceByTag.set(tag, nowMs);
                  rebuildCountByTag.set(tag, rebuilds + 1);
                  if (rebuilds + 1 === MAX_FAST_REBUILDS) {
                    console.log(`[bravo.groupcall.decode] rebuild cap reached tag=${tag.slice(0, 6)} — slowing to ${SLOW_REBUILD_MS / 1000}s probes`);
                  }
                  rebuildVideoConsumerRef.current?.(tag);
                }
              }
            }
          }
        }
        setVideoStalledTags(prev => {
          const prevKeys = Object.keys(prev);
          const nextKeys = Object.keys(stalledNext);
          if (prevKeys.length === nextKeys.length &&
              nextKeys.every(k => prev[k])) {
            return prev; // unchanged — skip the re-render
          }
          return stalledNext;
        });
        // Only set state when something actually changed enough to
        // matter — avoid 2 Hz re-renders of the entire grid for noise.
        setAudioLevels(prev => {
          const tags = new Set([...Object.keys(prev), ...Object.keys(next)]);
          for (const t of tags) {
            const a = prev[t] ?? 0;
            const b = next[t] ?? 0;
            if (Math.abs(a - b) > 0.04) {return next;}
          }
          return prev;
        });
      } catch {
        // Stats can transiently throw mid-renegotiation. Ignore.
      }
    };
    const interval = setInterval(() => { void tick(); }, 500);
    audioPollIntervalRef.current = interval;
    return () => {
      cancelled = true;
      clearInterval(interval);
      // Belt-and-braces: leaveInternal also clears via the ref so the
      // window between leaveInternal closing recvTx and React unmount
      // committing this cleanup is closed.
      if (audioPollIntervalRef.current === interval) {audioPollIntervalRef.current = null;}
    };
  }, [state]);

  // remoteTiles ref so the audio-level poller's track→tag mapper
  // can read the LATEST tile list without re-firing the effect on
  // every tile change (the stats poll is independent of the React
  // tile list — we only need to read it once per tick).
  const remoteTilesRef = useRef<RemoteTile[]>([]);
  useEffect(() => { remoteTilesRef.current = remoteTiles; }, [remoteTiles]);

  // BS-RESUME-RECONCILE — consume producers that appeared WHILE MINIMIZED.
  // The full boot reconcileProducers/consumeProducer live inside the boot
  // IIFE and are NEVER set up on the resume/adopt path (it returns early),
  // so reconcileProducersRef is null on a restored hook and the 4s tick is
  // inert — a peer who JOINED or turned their camera ON during the minimize
  // window stays permanently tile-less after restore. This is a
  // SELF-CONTAINED, ref-based re-consume that the adopt path arms. It is
  // ADDITIVE: it never touches the working boot consume path, so a bug here
  // can only affect the rare restore-reconsume, never a live call. It
  // mirrors attemptConsume's FAIL-CLOSED SFrame contract — a remote track is
  // NEVER rendered without its decrypt transform (the SFU is the attacker).
  const consumeMissingAfterRestore = useCallback(async (): Promise<void> => {
    if (isLeavingRef.current) {return;}
    const ws   = transportRef.current;
    const rid  = roomIdRef.current;
    const recv = recvTxRef.current;
    const dev  = deviceRef.current;
    if (!ws || !rid || !recv || !dev) {return;}
    let resp: {producers: Array<{producerId: string; participantTag: string; kind: 'audio' | 'video'; paused?: boolean}>};
    try {
      resp = await wsRequest<typeof resp>(ws, 'sfu.producers', {roomId: rid});
    } catch (e) {
      console.warn('[bravo.groupcall.resume-reconcile] sfu.producers failed:', (e as Error).message);
      return;
    }
    if (isLeavingRef.current) {return;}
    const haveTile = new Set(remoteTilesRef.current.map(t => t.producerId));
    for (const p of resp.producers) {
      if (haveTile.has(p.producerId)) {continue;}
      if (consumedProducerIdsRef.current.has(p.producerId)) {continue;}
      if (inFlightConsumes.current.has(p.producerId)) {continue;}
      inFlightConsumes.current.add(p.producerId);
      let consumer: Consumer | null = null;
      let tileRegistered = false;
      try {
        const consumed = await wsRequest<{
          consumerId: string; producerId: string; kind: 'audio' | 'video';
          rtpParameters: unknown; participantTag: string; producerPaused?: boolean;
        }>(ws, 'sfu.consume', {
          roomId: rid, transportId: recv.id, producerId: p.producerId,
          rtpCapabilities: dev.rtpCapabilities,
        });
        if (isLeavingRef.current) {return;}
        consumer = await recv.consume({
          id: consumed.consumerId, producerId: consumed.producerId,
          kind: consumed.kind, rtpParameters: consumed.rtpParameters as never,
        });
        const c = consumer;
        consumersByPid.current.set(c.id, c);
        // SFrame decrypt — REQUIRED. Fail-closed: tear the consumer down
        // rather than render an unencrypted remote track.
        const encRecv = groupEncryptionRef.current;
        const rtpReceiver = (c as unknown as {rtpReceiver?: {id: string}}).rtpReceiver;
        if (encRecv && rtpReceiver) {
          try {
            const detach = await encRecv.attachReceiverCryptor(
              rtpReceiver,
              (recv as unknown as {handler?: {_pc?: unknown}}).handler?._pc,
              p.participantTag,
            );
            sframeDetachersRef.current.push(detach);
          } catch (e) {
            console.warn('[bravo.groupcall.resume-reconcile] SFrame attach failed — closing consumer:', (e as Error).message);
            try { c.close(); } catch { /* ignore */ }
            consumersByPid.current.delete(c.id);
            consumer = null;
            continue;
          }
        }
        await wsRequest<{ok: true}>(ws, 'sfu.consumer.resume', {roomId: rid, consumerId: c.id});
        const ms = new MediaStream();
        ms.addTrack(c.track as unknown as MediaStreamTrack);
        consumedProducerIdsRef.current.add(p.producerId);
        const tile: RemoteTile = {
          participantTag: p.participantTag, consumerId: c.id, producerId: p.producerId,
          kind: p.kind, stream: ms, paused: consumed.producerPaused === true,
        };
        setRemoteTiles(prev => {
          if (prev.some(t => t.consumerId === c.id)) {return prev;}
          const next = prev.concat(tile);
          patchActiveGroupCall({remoteTiles: next});
          return next;
        });
        tileRegistered = true;
        // Listener cleanup (inert after leave) — mirrors attemptConsume.
        let listenerCancelled = false;
        const cleanups: Array<() => void> = [() => { listenerCancelled = true; }];
        c.on('trackended', () => {
          if (listenerCancelled) {return;}
          setRemoteTiles(prev => prev.filter(t => t.consumerId !== c.id));
          consumersByPid.current.delete(c.id);
          consumerCleanupsByPid.current.delete(c.id);
          consumedProducerIdsRef.current.delete(p.producerId);
        });
        // See attemptConsume: paused is owned by authoritative producer
        // pause/resume frames, NOT the native 'mute' event (which also fires
        // on a decode stall and would hide+exclude a frozen tile from the
        // freeze watchdog). No mute/unmute → setPaused coupling here either.
        consumerCleanupsByPid.current.set(c.id, cleanups);
        console.log('[bravo.groupcall.resume-reconcile] consumed missed producer tag=', p.participantTag.slice(0, 8), 'kind=', p.kind);
      } catch (e) {
        console.warn('[bravo.groupcall.resume-reconcile] consume failed', p.producerId.slice(0, 8), (e as Error).message);
        if (consumer && !tileRegistered) {
          try { (consumer as Consumer).close(); } catch { /* ignore */ }
          consumersByPid.current.delete((consumer as Consumer).id);
        }
      } finally {
        inFlightConsumes.current.delete(p.producerId);
      }
    }

    // Audit L22 / GC-03 — the restore path arms THIS function (not the full
    // boot reconcileProducers, which is trapped in the boot closure), so it
    // must also do the authoritative VIDEO pause-sync and MY-OWN-producer
    // re-assert. Without this, after a minimize→restore (hardware back =
    // minimize, so the common path) a peer toggling their camera never
    // updated the visible tile — the restore handler doesn't process
    // sfu.producer-paused/-resumed and the add-only consume skipped the sync.
    if (isLeavingRef.current) {return;}
    {
      const videoPause = resp.producers.filter(p => p.kind === 'video' && p.paused !== undefined);
      if (videoPause.length > 0) {
        setRemoteTiles(prev => {
          let next = prev;
          for (const p of videoPause) { next = applyProducerPaused(next, p.producerId, p.paused === true); }
          if (next !== prev) {patchActiveGroupCall({remoteTiles: next});}
          return next;
        });
      }
    }
    // GC-01 re-assert my own camera state post-restore too.
    if (intendedVideoPausedRef.current !== null && !isLeavingRef.current) {
      const myVp = producersRef.current.find(
        p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'video'
          && !(p as unknown as {closed?: boolean}).closed,
      );
      const myPid = (myVp as unknown as {id?: string} | undefined)?.id;
      if (myPid) {
        const snap = resp.producers.find(p => p.producerId === myPid);
        if (snap?.paused !== undefined && snap.paused !== intendedVideoPausedRef.current) {
          const ev = intendedVideoPausedRef.current ? 'sfu.producer.pause' : 'sfu.producer.resume';
          void wsRequest<{ok: true}>(ws, ev, {roomId: rid, producerId: myPid}).catch(() => undefined);
        }
      }
    }
  }, []);

  // Rebuild a wedged remote VIDEO consumer with a fresh decoder. The freeze
  // watchdog escalates here when a keyframe re-request fails to un-stick a
  // stalled tile — the only reliable cure for a jammed hardware H.264 decoder
  // (device-confirmed: Redmi froze the peer's incoming video mid-call and a
  // keyframe alone didn't recover it). Clean teardown mirrors sfu.participant.
  // left (fire cleanups → stop the frozen track → close consumer → drop tile +
  // consumed-set entry), then the reconcile re-consumes the now-missing
  // producer => brand-new consumer + decoder. The ~0.5–1s blank blip while it
  // re-consumes is the accepted trade for keeping camera-release/privacy.
  const rebuildVideoConsumer = useCallback((tag: string): void => {
    if (isLeavingRef.current) {return;}
    const tile = remoteTilesRef.current.find(t => t.participantTag === tag && t.kind === 'video');
    if (!tile) {return;}
    console.log(`[bravo.groupcall.kf] REBUILD video consumer tag=${tag.slice(0,6)} pid=${tile.producerId.slice(0,8)} cid=${tile.consumerId.slice(0,8)}`);
    const cleanups = consumerCleanupsByPid.current.get(tile.consumerId);
    if (cleanups) {
      for (const cb of cleanups) { try { cb(); } catch { /* ignore */ } }
      consumerCleanupsByPid.current.delete(tile.consumerId);
    }
    // Stop the frozen track first so RTCView's last-frame buffer is invalidated.
    try {
      const tr = (tile.stream as unknown as {getTracks?: () => Array<{stop?: () => void}>}).getTracks?.();
      if (Array.isArray(tr)) { for (const x of tr) { try { x.stop?.(); } catch { /* ignore */ } } }
    } catch { /* ignore */ }
    const c = consumersByPid.current.get(tile.consumerId);
    if (c) { try { c.close(); } catch { /* ignore */ } consumersByPid.current.delete(tile.consumerId); }
    inFlightConsumes.current.delete(tile.producerId);
    consumedProducerIdsRef.current.delete(tile.producerId);
    setRemoteTiles(prev => {
      const next = prev.filter(t => t.consumerId !== tile.consumerId);
      patchActiveGroupCall({remoteTiles: next});
      return next;
    });
    // Re-consume the now-missing producer → FRESH decoder. reconcileProducersRef
    // is the boot/restore reconcile (snapshot fetch + SFrame-attached consume).
    void (reconcileProducersRef.current?.() ?? consumeMissingAfterRestore());
  }, [consumeMissingAfterRestore]);
  useEffect(() => { rebuildVideoConsumerRef.current = rebuildVideoConsumer; }, [rebuildVideoConsumer]);

  // ── Producer reconcile tick ───────────────────────────────
  // BS-MEDIA — periodically reconcile our consumers against the SFU's
  // authoritative producer list so a missed sfu.new-producer frame or a
  // retry-exhausted consume self-heals within a few seconds instead of
  // leaving a participant permanently tile-less (the "one device sees
  // everyone, another sees only some" report). 4s is invisible WS
  // traffic and well under the threshold where a missing tile is
  // annoying. Only runs while joined; reconcileProducers self-guards on
  // leaving/cancelled.
  useEffect(() => {
    if (state !== 'joined') {return;}
    // Kick once immediately on entering 'joined' (and on the 'reconnecting'
    // → 'joined' transition after an ICE restart, which is exactly when a
    // producer announced mid-blip may have been missed).
    void reconcileProducersRef.current?.();
    const interval = setInterval(() => {
      void reconcileProducersRef.current?.();
    }, 4000);
    return () => { clearInterval(interval); };
  }, [state]);

  // ── SFU WebSocket keepalive ────────────────────────────────
  // B-14 — the SFU WS idle-closed mid-call (~3min in), and because the
  // close happened silently the next `sfu.transport.restartIce` fired
  // over a dead socket and `ack_timeout`'d → call stuck in 'failed'.
  // While a call is live (joining/joined/reconnecting) send a lightweight
  // app-level `ping` every 20s. The server already answers it (`pong`).
  // Two wins: (1) regular app-level traffic keeps idle-timeout
  // intermediaries (proxy/LB/NAT) from reaping the connection, and (2) a
  // rejected ping surfaces a dead WS promptly so socket.io's auto-reconnect
  // kicks in BEFORE ICE drops — giving restartTransport an open socket to
  // recover over. Best-effort: a failed ping just logs; the transport
  // layer owns the actual reconnect.
  useEffect(() => {
    if (state !== 'joining' && state !== 'joined' && state !== 'reconnecting') {return;}
    const ws = transportRef.current;
    if (!ws) {return;}
    // Only warn after TWO consecutive misses. A single slow ack is expected
    // right after the app resumes from background — the WS is still finishing
    // its socket.io reconnect handshake, so the round-trip can briefly exceed
    // the ack window. Logging "ping failed" on that first miss was a false
    // alarm (seen in field logs as a lone `ack_timeout:ping` after wake).
    let consecutiveMisses = 0;
    const interval = setInterval(() => {
      // Don't add load while the socket is already known-down; socket.io is
      // reconnecting and the ack would just time out.
      if ((ws as unknown as {state?: string}).state !== 'connected') {return;}
      // 10s ack window — generous enough to ride out a just-resumed socket
      // without false-failing, still well under the 20s keepalive cadence.
      void ws.emitWithAck('ping', {ts: Date.now()}, 10_000)
        .then(() => { consecutiveMisses = 0; })
        .catch((e: unknown) => {
          consecutiveMisses += 1;
          if (consecutiveMisses >= 2) {
            console.warn(`[bravo.groupcall] keepalive ping failed x${consecutiveMisses}:`, (e as Error).message);
          }
        });
    }, 20_000);
    return () => { clearInterval(interval); };
  }, [state]);

  // Mirror audioLevels into the registry so the FloatingCallOverlay
  // (mounted globally, NOT inside this hook's tree) can compute the
  // active speaker on minimize. Without this the overlay would always
  // show the same first-tile, never tracking who's actually talking
  // right now. Patches only when the registry exists for this roomId
  // — guards against late writes after a fresh call replaced ours.
  // Round 4 / Perf audit: ONE coalesced mirror effect for
  // audioLevels + identityByTag + remoteTiles. The previous three
  // separate effects each called patchActiveGroupCall on every
  // dependency change — and audioLevels mutates ~2 Hz from the stats
  // poll — so the registry's listener Set was notified three separate
  // times per audio tick even when nothing the overlay cared about
  // had actually changed.
  //
  // Gate the mirror on `isMinimized` per the perf audit: the ONLY
  // consumer of these registry fields is the FloatingCallOverlay,
  // which by definition only renders when the call is minimized.
  // GroupCallScreen reads straight off the hook (no registry round-
  // trip needed), so mirroring while the screen is foreground is
  // pure waste.
  //
  // Two effects make this work:
  //   (a) Subscribe to registry.isMinimized so we can flip a local
  //       `mirrorActive` flag — when minimize toggles ON we mirror
  //       the CURRENT state once to seed the overlay; thereafter the
  //       per-tick mirror below keeps it fresh.
  //   (b) Per-tick mirror that fires when audioLevels / identityByTag
  //       / remoteTiles change AND mirrorActive is true.
  const [mirrorActive, setMirrorActive] = useState(false);
  useEffect(() => {
    return onActiveGroupCallChange(s => {
      const next = !!(s && s.roomId === roomId && s.isMinimized);
      setMirrorActive(prev => prev === next ? prev : next);
    });
  }, [roomId]);
  useEffect(() => {
    if (!mirrorActive) {return;}
    if (state !== 'joined') {return;}
    const live = getActiveGroupCall();
    if (!live || live.roomId !== roomId) {return;}
    patchActiveGroupCall({audioLevels, identityByTag, remoteTiles});
  }, [mirrorActive, audioLevels, identityByTag, remoteTiles, state, roomId]);

  // ── Controls ────────────────────────────────────────────
  // CALL-24 — generation guard for the audio-producer pause/resume sync:
  // each mute toggle bumps this so a stale retry from an earlier toggle
  // aborts and the most-recent mute state always wins on the SFU.
  const muteToggleGenRef = useRef(0);
  const toggleMuteInternal = useCallback(() => {
    const t = audioTrackRef.current;
    if (!t) {return;}
    t.enabled = !t.enabled;
    const muted = !t.enabled;
    setIsMuted(muted);
    patchActiveGroupCall({isMuted: muted});
    console.log(`[bravo.groupcall.ctl] toggleMute → muted=${muted}`);
    // CALL-24 — track.enabled only silences the LOCAL capture; peers get
    // no signal, so a muted participant looked live on every remote tile.
    // Mirror the camera-toggle path: pause/resume the AUDIO producer on
    // the SFU, whose sfu.producer-paused/-resumed broadcast flips the
    // remote tiles' paused flag (mic-off glyph in GroupCallScreen).
    const ws  = transportRef.current;
    const rid = roomIdRef.current;
    const ap  = producersRef.current.find(
      p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'audio'
        && !(p as unknown as {closed?: boolean}).closed,
    );
    const pid = (ap as unknown as {id?: string} | undefined)?.id;
    if (ws && rid && pid) {
      const myGen = ++muteToggleGenRef.current;
      const event = muted ? 'sfu.producer.pause' : 'sfu.producer.resume';
      void (async () => {
        // Same lost-under-WS-congestion rationale as syncSfuPaused in
        // toggleVideo: retry a few times, but only while THIS toggle is
        // still the latest so an old pause can't land after an unmute.
        for (let attempt = 0; attempt < 4; attempt++) {
          if (myGen !== muteToggleGenRef.current || isLeavingRef.current) {return;}
          try {
            await wsRequest<{ok: true}>(ws, event, {roomId: rid, producerId: pid});
            return;
          } catch (e) {
            if (attempt === 3) {
              console.log(`[bravo.groupcall.ctl] mute ${event} signal gave up:`, (e as Error).message);
              return;
            }
            await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
          }
        }
      })();
    }
  }, []);

  // BS-VIDEO-TOGGLE — re-entrancy guard. toggleVideo is async (getUserMedia
  // + replaceTrack/produce); without this a rapid double-tap double-acquires
  // the camera (two producers) and a later OFF only stops one.
  const togglingVideoRef = useRef(false);
  // Generation guard for the SFU pause/resume sync inside toggleVideo: each
  // toggle bumps this so a stale retry from an earlier toggle aborts and the
  // most-recent camera state always wins (no off/on race on the SFU).
  const videoToggleGenRef = useRef(0);
  // Audit GC-01 — my INTENDED camera pause state (true=off, false=on, null=no
  // video producer yet). Camera state is a STATE, not a fire-once signal: the
  // reconcile tick compares this to the authoritative sfu.producers snapshot
  // for my own producer and re-asserts pause/resume if they diverge (e.g. all
  // toggle retries failed, or a silent WS reconnect dropped my SFU tag). This
  // is what converges peers onto the right state and stops the receiver-side
  // keyframe/consumer-rebuild churn (GC-02) after a lost pause.
  const intendedVideoPausedRef = useRef<boolean | null>(null);
  // Force a fresh keyframe on EVERY remote video consumer. Fired right after a
  // local camera toggle: on single-hardware-codec phones (Redmi & most mid-
  // range Androids) re-acquiring / releasing the camera encoder contends with
  // the H.264 DECODER and starves the INCOMING remote video of a reference
  // frame — the remote tile then freezes on its last frame and never recovers
  // until a natural IDR, which on a 3-layer simulcast stream can be many
  // seconds out (device trace: peer's video froze the instant THIS device
  // toggled its own camera). Re-issuing sfu.consumer.resume drives the server's
  // requestKeyFrame so each decoder re-syncs in ~200ms. Reuses the tested
  // resume path; fire-and-forget + leave-guarded. (Emulators use a software
  // codec and never hit this, which is why it only repro'd on the phone.)
  const refreshRemoteVideoKeyframes = useCallback((reason: string): void => {
    if (isLeavingRef.current) {return;}
    const ws  = transportRef.current;
    const rid = roomIdRef.current;
    if (!ws || !rid) {return;}
    for (const tile of remoteTilesRef.current) {
      if (tile.kind !== 'video') {continue;}
      void wsRequest<{ok: true}>(ws, 'sfu.consumer.resume', {roomId: rid, consumerId: tile.consumerId})
        .then(() => console.log(`[bravo.groupcall.kf] ${reason} refresh tag=${tile.participantTag.slice(0,6)}`))
        .catch(() => { /* best-effort — the 3s stall self-heal is the backstop */ });
    }
  }, []);
  // Blanket the codec-contention window after a toggle with a few spaced
  // keyframe pulls (the freeze lands ~1–2s in, so a single immediate pull can
  // miss it). Cheap: each is one sfu.consumer.resume per remote video tile.
  const scheduleKeyframeRefresh = useCallback((reason: string): void => {
    for (const delay of [400, 1200, 2200]) {
      setTimeout(() => refreshRemoteVideoKeyframes(reason), delay);
    }
  }, [refreshRemoteVideoKeyframes]);
  const toggleVideo = useCallback(async () => {
    if (togglingVideoRef.current) {
      console.log('[bravo.groupcall.ctl] toggleVideo ignored — toggle already in progress');
      return;
    }
    togglingVideoRef.current = true;
    // Bump the toggle generation so any in-flight SFU sync retry from a
    // previous toggle aborts — the most-recent camera state must win.
    const myGen = ++videoToggleGenRef.current;
    // Reliable SFU producer pause/resume. The single fire-and-forget signal
    // was lost under WS congestion (rapid toggles → ack_timeout), leaving the
    // SFU on the WRONG state: peers kept the frozen last frame after OFF, and
    // saw no video after ON. Retry a few times, but only while THIS toggle is
    // still the latest (the gen guard) so an OFF retry can't land after an ON.
    const syncSfuPaused = async (
      ws: TransportClient, roomIdArg: string, producerId: string, paused: boolean,
    ): Promise<void> => {
      const event = paused ? 'sfu.producer.pause' : 'sfu.producer.resume';
      // Audit GC-01 — record the intended state so the reconcile tick can
      // durably re-assert it if every attempt below fails.
      intendedVideoPausedRef.current = paused;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (myGen !== videoToggleGenRef.current) {return;}
        if (isLeavingRef.current) {return;}   // don't retry into a torn-down call
        try {
          await wsRequest<{ok: true}>(ws, event, {roomId: roomIdArg, producerId});
          return; // SFU acked — peers now see the correct camera state
        } catch (e) {
          if (attempt === 3) {
            // Give up the fast path; the reconcile tick re-asserts from
            // intendedVideoPausedRef on the next poll until the SFU agrees.
            console.log(`[bravo.groupcall.ctl] producer ${paused ? 'pause' : 'resume'} signal gave up (reconcile will re-assert):`, (e as Error).message);
            return;
          }
          await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
        }
      }
    };
    try {
      // ── OFF — release the camera but KEEP the producer ──────────────
      // Stop the capturer (powers the camera + privacy LED down) and PAUSE
      // (not close) the mediasoup producer, so its RTPSender + SFrame
      // transform + simulcast encodings all survive. Re-enabling is then an
      // instant, reliable `replaceTrack` (below). The previous build CLOSED
      // the producer, forcing ON down a fragile full re-produce + re-attach
      // path that failed — the camera "stayed off forever". OFF must work
      // even without the send transport, so its guard lives on the ON path.
      if (videoTrackRef.current) {
        const t = videoTrackRef.current;
        const vp = producersRef.current.find(
          p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'video'
            && !(p as unknown as {closed?: boolean}).closed,
        );
        const wsToggle  = transportRef.current;
        const ridToggle = roomIdRef.current;
        const pidToggle = (vp as unknown as {id?: string} | undefined)?.id;
        if (wsToggle && ridToggle && pidToggle) {
          void syncSfuPaused(wsToggle, ridToggle, pidToggle, true);
        }
        try { (vp as unknown as {pause?: () => void})?.pause?.(); } catch { /* ignore */ }
        try { t.stop(); } catch { /* ignore */ }   // releases the camera + LED
        videoTrackRef.current = null;
        const rebuilt = new MediaStream(
          audioTrackRef.current ? [audioTrackRef.current] : [],
        );
        setLocalStream(rebuilt);
        setIsVideoOff(true);
        patchActiveGroupCall({localStream: rebuilt, videoTrack: null, isVideoOff: true});
        console.log('[bravo.groupcall.ctl] toggleVideo OFF — camera released (producer paused)');
        // Stopping the local camera releases the hardware encoder, which on a
        // single-codec phone briefly knocks out the INCOMING video decoder —
        // re-sync every remote tile so a peer's video doesn't freeze on us.
        scheduleKeyframeRefresh('post-off');
        return;
      }

      // ── ON — (re)acquire the camera ─────────────────────────────────
      let newTrack: MediaStreamTrack | null = null;
      try {
        const facing = isFrontCameraRef.current ? 'user' : 'environment';
        const fresh = await mediaDevices.getUserMedia({audio: false, video: {facingMode: facing}});
        newTrack = fresh.getVideoTracks()[0] ?? null;
      } catch (e) {
        console.warn('[bravo.groupcall.ctl] toggleVideo getUserMedia failed:', (e as Error).message);
        try { useMessengerStore.getState().setError('Camera unavailable — check permissions'); } catch { /* ignore */ }
        return;
      }
      if (!newTrack) {
        try { useMessengerStore.getState().setError('Camera unavailable'); } catch { /* ignore */ }
        return;
      }

      // RE-ENABLE an existing (paused) producer via replaceTrack. The
      // RTPSender's SFrame transform + simulcast encodings persist, so frames
      // stay encrypted with NO re-attach — the proven recoverGroupCamera path
      // and the reliable fix for "video won't turn back on".
      const existingVp = producersRef.current.find(
        p => (p as unknown as {kind?: string; closed?: boolean}).kind === 'video'
          && !(p as unknown as {closed?: boolean}).closed,
      );
      if (existingVp) {
        try {
          await (existingVp as unknown as {replaceTrack: (o: {track: unknown}) => Promise<void>})
            .replaceTrack({track: newTrack});
          try { (existingVp as unknown as {resume?: () => void}).resume?.(); } catch { /* ignore */ }
          const wsR  = transportRef.current;
          const ridR = roomIdRef.current;
          const pidR = (existingVp as unknown as {id?: string}).id;
          if (wsR && ridR && pidR) {
            void syncSfuPaused(wsR, ridR, pidR, false);
          }
          videoTrackRef.current = newTrack;
          const rebuilt = new MediaStream(
            audioTrackRef.current ? [audioTrackRef.current, newTrack] : [newTrack],
          );
          setLocalStream(rebuilt);
          setIsVideoOff(false);
          patchActiveGroupCall({localStream: rebuilt, videoTrack: newTrack, isVideoOff: false});
          console.log('[bravo.groupcall.ctl] toggleVideo ON — camera re-acquired (replaceTrack)');
          // Re-acquiring the camera (new encoder session) is the exact moment
          // the incoming decoder stalls on a single-codec phone — re-sync every
          // remote tile so peers' video doesn't freeze when WE turn ours on.
          scheduleKeyframeRefresh('post-on');
        } catch (e) {
          console.warn('[bravo.groupcall.ctl] toggleVideo replaceTrack failed:', (e as Error).message);
          try { newTrack.stop(); } catch { /* ignore */ }
          try { useMessengerStore.getState().setError('Could not turn the camera back on'); } catch { /* ignore */ }
        }
        return;
      }

      // FIRST video (audio-only call → video upgrade): no producer yet, so
      // produce fresh WITH the boot simulcast ladder + SFrame attach (same
      // no-plaintext refusal contract as boot). Needs the send transport.
      const sendTx = sendTxRef.current;
      if (!sendTx) {
        // The call hasn't built its send transport yet — it's still
        // connecting or stuck waiting for the group key (e.g. a mission Ops
        // Room whose owner is offline). DON'T abandon the camera: show it as
        // a LOCAL PREVIEW so the toggle always works visually. The boot's
        // video-produce picks up videoTrackRef.current once the call goes
        // live (peers see it then). This is the fix for "toggle off works
        // but toggle on shows nothing" on a not-yet-connected call.
        console.log('[bravo.groupcall.ctl] toggleVideo ON — local preview only (call not yet connected)');
        videoTrackRef.current = newTrack;
        const lsPv = localStream;
        const rebuiltPv = new MediaStream(
          lsPv ? [...lsPv.getTracks().filter(x => x.kind === 'audio'), newTrack] : [newTrack],
        );
        setLocalStream(rebuiltPv);
        setIsVideoOff(false);
        patchActiveGroupCall({localStream: rebuiltPv, videoTrack: newTrack, isVideoOff: false});
        return;
      }
      const t0 = newTrack;
      try {
        // GC-06 — blank the track for the produce→attach window (every
        // failure path below stops the track, so only the success path
        // needs the restore after the cryptor is live).
        const t0Enabled = t0 as unknown as {enabled: boolean};
        t0Enabled.enabled = false;
        const producer = await sendTx.produce({
          track: t0 as never,
          encodings: [
            {rid: 'r0', maxBitrate:  150_000, scaleResolutionDownBy: 4, maxFramerate: 15},
            {rid: 'r1', maxBitrate:  500_000, scaleResolutionDownBy: 2, maxFramerate: 24},
            {rid: 'r2', maxBitrate: 1_200_000,                          maxFramerate: 30},
          ],
          codecOptions: {videoGoogleStartBitrate: 200},
        } as never);
        const enc = groupEncryptionRef.current;
        const rtpSender = (producer as unknown as {rtpSender?: {id: string}}).rtpSender;
        if (!enc || !rtpSender) {
          console.warn('[bravo.groupcall.ctl] toggleVideo refusing — no SFrame encryptor/rtpSender; closing producer');
          try { producer.close(); } catch { /* ignore */ }
          try { t0.stop(); } catch { /* ignore */ }
          armVideoEncryptorRetry({
            hasEncryptor: () => !!groupEncryptionRef.current,
            subscribe:    (cb) => useMessengerStore.subscribe(() => cb()),
            isCancelled:  () => isLeavingRef.current,
            notify:       (m) => { try { useMessengerStore.getState().setError(m); } catch { /* ignore */ } },
            retry:        () => { void toggleVideoRef.current?.(); },
            isArmed:      () => videoRetryArmedRef.current,
            setArmed:     (v) => { videoRetryArmedRef.current = v; },
          });
          return;
        }
        try {
          const detach = await enc.attachSenderCryptor(
            rtpSender,
            (sendTx as unknown as {handler?: {_pc?: unknown}}).handler?._pc,
            'video',
          );
          sframeDetachersRef.current.push(detach);
          console.log('[bravo.groupcall.sframe] mid-call video producer attached (FrameCryptor)');
        } catch (e) {
          console.warn('[bravo.groupcall.sframe] mid-call video attach FAILED — refusing:', (e as Error).message);
          try { producer.close(); } catch { /* ignore */ }
          try { t0.stop(); } catch { /* ignore */ }
          return;
        }
        t0Enabled.enabled = true;   // GC-06 — cryptor live, unblank
        producersRef.current.push(producer);
        videoTrackRef.current = t0;
        const ls = localStream;
        const rebuilt = new MediaStream(
          ls ? [...ls.getTracks().filter(x => x.kind === 'audio'), t0] : [t0],
        );
        setLocalStream(rebuilt);
        setIsVideoOff(false);
        patchActiveGroupCall({localStream: rebuilt, videoTrack: t0, isVideoOff: false});
        console.log('[bravo.groupcall.ctl] toggleVideo ON — first video (new producer)');
        scheduleKeyframeRefresh('post-first-video');
      } catch (e) {
        console.warn('[bravo.groupcall.ctl] toggleVideo enable failed:', (e as Error).message);
        try { t0.stop(); } catch { /* ignore */ }
        try { useMessengerStore.getState().setError('Could not turn the camera on'); } catch { /* ignore */ }
      }
    } finally {
      togglingVideoRef.current = false;
    }
  }, [localStream, scheduleKeyframeRefresh]);

  // Flip front ↔ back camera. The react-native-webrtc camera track
  // exposes a non-standard `_switchCamera()` that re-targets the
  // underlying capturer in place: the same MediaStreamTrack keeps its
  // identity, so the mediasoup producer + its SFrame FrameCryptor stay
  // attached and streaming. Nothing crosses the wire — purely a local
  // capturer swap. Returns false when there's no live video track
  // (audio call, or camera currently off) so the UI can no-op cleanly.
  const switchCamera = useCallback((): boolean => {
    const track = videoTrackRef.current;
    if (!track?.enabled) {
      console.log('[bravo.groupcall.ctl] switchCamera skipped — no live video track');
      return false;
    }
    const flip = (track as unknown as {_switchCamera?: () => void })._switchCamera;
    if (typeof flip !== 'function') {
      console.warn('[bravo.groupcall.ctl] switchCamera unsupported — track has no _switchCamera');
      return false;
    }
    try {
      flip.call(track);
      setIsFrontCamera(prev => !prev);
      console.log('[bravo.groupcall.ctl] switchCamera → flipped');
      return true;
    } catch (e) {
      console.warn('[bravo.groupcall.ctl] switchCamera failed:', (e as Error).message);
      return false;
    }
  }, []);

  const muteParticipant = useCallback(async (tag: string) => {
    const ws = transportRef.current;
    if (!ws || !roomId) {return;}
    try {
      await wsRequest<{ok: true}>(ws, 'sfu.mute-target', {roomId, targetTag: tag});
    } catch (e) {
      console.warn('[useGroupCall] mute-target failed:', (e as Error).message);
    }
  }, [roomId]);

  const inviteUsers = useCallback(async (userIds: string[]) => {
    const ws = transportRef.current;
    if (!ws || !roomId || userIds.length === 0) {return;}
    // Retry once on `peer_offline` — the server fires a VoIP push
    // notification when the recipient isn't currently connected, but
    // there's a 1-3s window where their socket is reconnecting (e.g.
    // they just woke their phone) during which the ring lands as
    // peer_offline despite them being moments-from-online. Without
    // this retry, the host's "Add Call" reports failure and the user
    // taps Add again manually. Server is idempotent on `sfu.ring`
    // (push collapseKey ensures only ONE ring lands on the device
    // even if we hit it twice), so a duplicate is safe.
    const attemptRing = async (): Promise<void> => {
      await wsRequest<{ok: true}>(ws, 'sfu.ring', {
        roomId,
        conversationId:   opts.conversationId,
        callType:         opts.callType,
        callerName:       opts.callerName,
        recipientUserIds: userIds,
      });
    };
    try {
      await attemptRing();
      console.log('[bravo.groupcall.invite] rang', userIds.length, 'user(s)');
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (msg.includes('peer_offline') || msg.includes('not_connected')) {
        console.warn('[bravo.groupcall.invite] peer_offline — retrying once after 1.5s');
        await new Promise(r => setTimeout(r, 1500));
        try {
          await attemptRing();
          console.log('[bravo.groupcall.invite] retry succeeded');
          return;
        } catch (retryErr) {
          console.warn('[bravo.groupcall.invite] retry failed:', (retryErr as Error).message);
          throw retryErr;
        }
      }
      console.warn('[bravo.groupcall.invite] failed:', msg);
      throw e;
    }
  }, [roomId, opts.conversationId, opts.callType, opts.callerName]);

  /**
   * Host-initiated re-ring. Tap from the per-recipient pill when the
   * 30s ring window has expired and the recipient still hasn't joined.
   * Bumps `ringStartedAt` so the UI flips back to a fresh "Re-ringing"
   * status, and marks the user in `reRungUserIds` so the pill label
   * reads "Re-ringing" instead of the initial "Ringing".
   */
  const reRing = useCallback(async (userIds: string[]) => {
    const ws = transportRef.current;
    if (!ws || !roomId || userIds.length === 0) {return;}
    try {
      await wsRequest<{ok: true}>(ws, 'sfu.ring', {
        roomId,
        conversationId:   opts.conversationId,
        callType:         opts.callType,
        callerName:       opts.callerName,
        recipientUserIds: userIds,
      });
      setRingStartedAt(Date.now());
      setReRungUserIds(prev => {
        const next = new Set(prev);
        for (const u of userIds) {next.add(u);}
        return next;
      });
      console.log('[bravo.groupcall.rering] sent to', userIds.length, 'user(s)');
    } catch (e) {
      console.warn('[bravo.groupcall.rering] failed:', (e as Error).message);
      throw e;
    }
  }, [roomId, opts.conversationId, opts.callType, opts.callerName]);

  const kickParticipant = useCallback(async (tag: string) => {
    const ws = transportRef.current;
    if (!ws || !roomId) {return;}
    try {
      await wsRequest<{ok: true}>(ws, 'sfu.kick', {roomId, targetTag: tag});
      // The server-side leaveRoom fires participant.left to peers, so
      // our remoteTiles will drop the kicked tile via the dispatcher
      // path — no need to mutate here.
    } catch (e) {
      console.warn('[useGroupCall] kick failed:', (e as Error).message);
    }
  }, [roomId]);

  const leaveInternal = useCallback(async () => {
    // Idempotent — multiple paths can call this (BackHandler, End btn,
    // overlay End, peer-leave-and-room-empty). Only the first run does
    // real work; subsequent calls are silent no-ops.
    if (isLeavingRef.current) {return;}
    isLeavingRef.current = true;
    // B-37 — flip to a TERMINAL state IMMEDIATELY, BEFORE the synchronous
    // producer/consumer/transport/stream teardown below. Leaving call.state
    // at 'joined' during teardown let GroupCallScreen's animated, clipping
    // tile grid keep re-rendering while native views were being detached,
    // and Fabric crashed with "The specified child already has a parent"
    // (addViewAt). Flipping terminal first lets the screen swap to the
    // static "Call ended" view (early-return) in ONE clean unmount before
    // any native teardown. The terminal setState at the END of this fn is
    // now an idempotent no-op.
    setState(prev =>
      prev === 'kicked' ? 'kicked' :
      wasHostEndedRef.current ? 'ended-by-host' :
      'left',
    );
    // Fix #13: read roomId from the ref so we use the LATEST value.
    // The useCallback closure captures the roomId at the time the
    // callback was last memoized, but external paths (FloatingCall-
    // Overlay's End button, BackHandler) may invoke it via a ref bound
    // earlier — using the state directly would clear identities for
    // an old roomId and miss the live one.
    const rid = roomIdRef.current ?? roomId;
    console.log(`[bravo.groupcall.leave] tearing down roomId=${rid ?? '-'} kicked=${wasKickedRef.current}`);
    const ws = transportRef.current;
    cleanupSubRef.current?.();
    cleanupSubRef.current = null;
    cleanupIdentSub.current?.();
    cleanupIdentSub.current = null;
    // Fix #10: stop the audio-level interval HERE, before the recv
    // transport closes. The effect's React-cleanup runs on unmount
    // commit, which can be 1-2 ticks later — ample time for one more
    // tick() to fire on a closed transport and produce noisy logs.
    if (audioPollIntervalRef.current) {
      clearInterval(audioPollIntervalRef.current);
      audioPollIntervalRef.current = null;
    }

    // S6 / P0-C1 — fire SFrame detachers BEFORE closing mediasoup
    // transports. Each detacher aborts the in-flight TransformStream
    // pipeTo() that ties the producer/consumer to its SFrame
    // encrypt/decrypt pipe; if we close the transport first, the pipe
    // tries to write to a closed stream and the native bridge crashes.
    // Dispose the GroupCallEncryption instance last so any final
    // in-flight encrypt/decrypt has its sender/receiver state intact.
    for (const detach of sframeDetachersRef.current) {
      try {detach();} catch { /* ignore */ }
    }
    sframeDetachersRef.current = [];
    if (groupEncryptionRef.current) {
      try {groupEncryptionRef.current.dispose();} catch { /* ignore */ }
      groupEncryptionRef.current = null;
    }

    // CLOSE LOCAL MEDIA FIRST — synchronous, fast, kills inbound audio
    // and outbound capture immediately. Was previously sequenced AFTER
    // two awaited wsRequest calls (sfu.ring.cancel + sfu.leave), which
    // each carry an 8-second ack timeout — so a slow/unhealthy WS at
    // hangup time meant the user kept hearing peer audio for up to 16s
    // while the screen froze. The WS frames are best-effort hints
    // (server tears us down on disconnect anyway); they MUST NOT block
    // the audio teardown. Reproduce path: host of a group call presses
    // End → freeze + peer audio bleed for 16s + remaining peers stuck
    // talking to each other in a hostless ghost room.
    //
    // Fix #9: detach per-consumer track listeners BEFORE close. The
    // `cancelled` flag inside each cleanup makes any late-firing
    // 'mute'/'unmute'/'trackended' callback a no-op, which avoids
    // setRemoteTiles running on the unmounted hook. Run cleanups for
    // ALL consumers up-front, THEN walk the map again to close.
    for (const cleanups of consumerCleanupsByPid.current.values()) {
      for (const cb of cleanups) { try { cb(); } catch { /* ignore */ } }
    }
    consumerCleanupsByPid.current.clear();

    for (const p of producersRef.current) {try { p.close(); } catch { /* ignore */ }}
    producersRef.current = [];
    for (const c of consumersByPid.current.values()) {try { c.close(); } catch { /* ignore */ }}
    consumersByPid.current.clear();
    inFlightConsumes.current.clear();
    consumedProducerIdsRef.current.clear();
    reconcileProducersRef.current = null;
    earlyProducerBufferRef.current = null;
    try { sendTxRef.current?.close(); } catch { /* ignore */ }
    try { recvTxRef.current?.close(); } catch { /* ignore */ }
    sendTxRef.current = null; recvTxRef.current = null;
    audioTrackRef.current?.stop(); audioTrackRef.current = null;
    videoTrackRef.current?.stop(); videoTrackRef.current = null;
    setLocalStream(null);
    setRemoteTiles([]);
    // B-15 — clear video-stall tracking so a fresh call starts clean.
    setVideoStalledTags({});
    videoFrameSnapRef.current.clear();

    // When the server already told us the host left (sfu.room.ended),
    // it has already closed our consumers/transports and deleted the
    // room state — sending sfu.leave would error out (unknown
    // participant) or pointlessly add latency. Same for sfu.ring.cancel:
    // the server torn-down everyone, including the ring queue.
    if (!wasHostEndedRef.current) {
      // Round 4 / server-contract drift fix: if WE were the host AND a
      // ring is still in flight (recipients haven't all joined yet),
      // tell the server to dismiss those recipients' ringing screens.
      // Without this, callees that didn't pick up before the host hung
      // up keep ringing for the full 30s ring window — server already
      // supports sfu.ring.cancel but no client codepath was sending it.
      //
      // B-12: the decision is factored into shouldSendRingCancel so it
      // no longer requires ringStartedAtRef (set only AFTER the sfu.ring
      // ack lands). A host who taps End in the window between "sendTx
      // connected" and the ack now still cancels via sentRingRef.
      //
      // FIRE-AND-FORGET: the call was previously awaited synchronously,
      // blocking media teardown. Now non-blocking.
      const recipientIds = Array.isArray(opts.recipientUserIds) ? opts.recipientUserIds : [];
      const stillRinging = recipientIds.filter(
        uid => uid && !joinedUserIdsRef.current.has(uid),
      );
      if (
        ws && rid
        && shouldSendRingCancel({
          isHost:            isHostRef.current,
          direction:         opts.direction,
          sentRing:          sentRingRef.current,
          ringStartedAt:     ringStartedAtRef.current,
          recipientCount:    recipientIds.length,
          stillRingingCount: stillRinging.length,
        })
      ) {
        void wsRequest<{ok: true}>(ws, 'sfu.ring.cancel', {
          roomId:           rid,
          conversationId:   opts.conversationId,
          recipientUserIds: stillRinging,
          // Audit row #5 (C2) — host's self-token (minted at
          // POST /sfu/rooms). Gateway rejects cancels from non-hosts
          // and (when secret is set) requires this token.
          roomToken:        roomTokenRef.current,
        }).catch(() => { /* best-effort — recipients time out at 30s */ });
      }

      // sfu.leave is best-effort — server tears us down on disconnect
      // anyway. Fire-and-forget so a slow/unhealthy WS doesn't block
      // the user-visible hangup.
      if (ws && rid) {
        void wsRequest<{ok: true}>(ws, 'sfu.leave', {roomId: rid})
          .catch(() => { /* swallow — we're tearing down */ });
      }
    }

    // Append a call_meta history bubble before clearing the registry.
    // Skip for kicked (rude exit, no chat record) and for sub-2s leaves
    // (misclick / never-connected). Use the kicked ref because React
    // state updates from the dispatcher branch above haven't flushed yet.
    //
    // Outcome distinguishes:
    //   - kicked         → no bubble (handled above)
    //   - host ended     → 'ended-by-host' so the calls log shows
    //                      "Group call ended by host" on the peer side,
    //                      matching what they just saw on screen
    //   - normal hangup  → 'answered' (we participated and walked away)
    if (callStartedAtRef.current && !wasKickedRef.current) {
      const durationSec = Math.max(0, Math.round((Date.now() - callStartedAtRef.current) / 1000));
      if (durationSec >= 2) {
        appendGroupCallHistoryBubble({
          conversationId: opts.conversationId,
          callType:       opts.callType,
          durationSec,
          outcome:        wasHostEndedRef.current ? 'ended-by-host' : 'answered',
        });
      }
    }
    callStartedAtRef.current = null;

    if (rid) {clearRoomIdentities(rid);}
    // Audit BS-LEAK — drop the stashed handles now that we've closed
    // them, so a later same-room call can't adopt dead transports.
    if (rid) {liveSfuHandlesByRoom.delete(rid);}
    // Fix #14: only clear the registry if it still points at OUR
    // roomId — between leaveInternal entering and reaching this line,
    // a fresh call could have replaced the slot (rare, but the
    // hangup-and-immediately-call-someone-else path makes it
    // possible). Comparing against roomIdRef.current ensures we
    // never null-out someone else's call.
    const reg = getActiveGroupCall();
    if (reg && reg.roomId === rid) {setActiveGroupCall(null);}

    setState(prev =>
      prev === 'kicked' ? 'kicked' :
      wasHostEndedRef.current ? 'ended-by-host' :
      'left',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- leaveInternal is mirrored via leaveInternalRef (see below); opts.direction is not read here
  }, [roomId, opts.conversationId, opts.callType, opts.recipientUserIds]);

  // Fix #7: keep leaveInternalRef pointing at the freshest closure so
  // the resume-path SFU handler can call leave without depending on
  // the useCallback's identity (which changes on every roomId update).
  useEffect(() => { leaveInternalRef.current = leaveInternal; }, [leaveInternal]);

  // B-07 — keep toggleVideoRef on the freshest closure so the
  // encryptor-arrival retry hits the up-to-date implementation.
  useEffect(() => { toggleVideoRef.current = toggleVideo; }, [toggleVideo]);

  // Keep the registry's leave/toggleMute/toggleVideo references in
  // sync with the freshest closures so the floating overlay always
  // invokes the right ones (closures capture state — without this,
  // an early-bound leave would use a stale roomId, and toggleVideo
  // would splice a fresh track into a stale localStream).
  // Fix #15: include toggleVideo in this sync so the overlay's video
  // button always hits the up-to-date implementation.
  useEffect(() => {
    if (state !== 'joined') {return;}
    patchActiveGroupCall({leave: leaveInternal, toggleMute: toggleMuteInternal, toggleVideo});
  }, [state, leaveInternal, toggleMuteInternal, toggleVideo]);

  return {
    state, roomId, isHost, selfTag,
    localStream, remoteTiles, identityByTag,
    isMuted, isVideoOff, isFrontCamera,
    audioLevels,
    videoStalledTags,
    toggleMute: toggleMuteInternal, toggleVideo, switchCamera,
    inviteUsers,
    reRing,
    ringStartedAt,
    reRungUserIds,
    recipientUserIds: opts.recipientUserIds,
    muteParticipant, kickParticipant,
    leave: leaveInternal,
  };
}

// ─── helpers ────────────────────────────────────────────────────────

function wsRequest<T>(ws: TransportClient, event: string, data: unknown): Promise<T> {
  return ws.emitWithAck<T>(event, data);
}

/**
 * Pull short-lived TURN credentials from messenger-service. Falls back
 * to STUN-only if the request fails — STUN-only works on most networks;
 * only symmetric-NAT clients hard-fail without TURN, and they'll see
 * the same network errors the 1:1 path surfaces.
 */
async function fetchTurnCredentials(): Promise<Array<{urls: string | string[]; username?: string; credential?: string}>> {
  try {
    // signalDeviceId is hardcoded to 1 across the app (Phase-1 single
    // device — see productionRuntime.ts default). Server's JwtHttpGuard
    // rejects with 400 missing_signal_device_id without this header.
    //
    // fetchWithRefresh handles the access-token attach AND auto-refresh
    // on 401. Plain fetch() with a stale 15-min-expired token was the
    // source of the chronic `turn 401` warning that pushed every group
    // call onto STUN-only and broke ICE through symmetric NATs.

    const {fetchWithRefresh} = require('@/services/api') as typeof import('@/services/api');
    const res = await fetchWithRefresh(`${MSG_BASE_URL}/webrtc/turn-credentials`, {
      headers: {'X-Signal-Device-Id': '1'},
    });
    if (!res.ok) {throw new Error(`turn ${res.status}`);}
    const body = await res.json() as {urls: string[]; username: string; credential: string};
    // BS-GC-ICE — log WHAT we got: a relay-capable set (turn:/turns: URLs)
    // vs STUN-only. A media-won't-flow device with no turn: URL here has
    // no relay fallback and dies on any UDP-blocked path.
    const urls = Array.isArray(body.urls) ? body.urls : [body.urls];
    const hasTurn = urls.some(u => typeof u === 'string' && /^turns?:/.test(u));
    crashLog(`[bravo.groupcall.ice] TURN ok urls=${urls.length} hasTurn=${hasTurn} sample=${urls[0] ?? '-'}`);
    return [{urls: body.urls, username: body.username, credential: body.credential}];
  } catch (e) {
    console.warn('[useGroupCall] TURN fetch failed; falling back to STUN-only:', (e as Error).message);
    crashLog(`[bravo.groupcall.ice] TURN FETCH FAILED → STUN-only fallback (no relay): ${(e as Error).message.slice(0, 60)}`);
    return [{urls: 'stun:stun.l.google.com:19302'}];
  }
}

function appendGroupCallHistoryBubble(args: {
  conversationId: string;
  callType:       'voice' | 'video';
  durationSec:    number;
  /** 'answered' for normal hangup, 'ended-by-host' when the server
   *  fired sfu.room.ended (host left, we got tornd own). */
  outcome?:       'answered' | 'ended-by-host';
}): void {
  // Round 2 / Security audit: replace Math.random() with crypto-grade
  // random bytes. This id ends up as the local message id for the
  // call-history bubble; a predictable id makes it easier to
  // collide-replace a victim's outbound entry. crypto.getRandomValues
  // is guaranteed by polyfills.ts boot order.
  const c = (globalThis as {crypto?: {getRandomValues?: (a: Uint8Array) => Uint8Array}}).crypto;
  let suffix: string;
  if (c?.getRandomValues) {
    const b = new Uint8Array(4);
    c.getRandomValues(b);
    suffix = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  } else {
    suffix = Math.random().toString(36).slice(2, 10); // best-effort fallback
  }
  const id = `gc_${Date.now().toString(36)}_${suffix}`;
  const msg: LocalMessage = {
    id,
    conversation_id: args.conversationId,
    sender_id:       'self',
    type:            'call',
    content:         '',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      new Date().toISOString(),
    // Group calls don't have a single peer; placeholder address keeps
    // the LocalMessage shape happy and CallRecordRow's relaunch path
    // ignores it for group calls (see ChatScreen wire-up).
    peer:            {userId: 'group-call', deviceId: 0},
    call_meta: {
      kind:      args.callType,
      direction: 'outgoing',
      outcome:   args.outcome ?? 'answered',
      duration:  args.durationSec,
      // Marker so the chat renderer knows this is the group variant —
      // tapping should re-launch a group call, not 1:1.
      groupCall: true,
    },
  };
  useMessengerStore.getState().appendMessage(args.conversationId, msg);
}

/**
 * B-12 — append an INCOMING "missed group call" history bubble. Called by
 * IncomingGroupCallScreen when the host cancels the ring before the user
 * accepted (host abandoned the call). Without this the ring just vanished
 * with no record — the WhatsApp behaviour is a "Missed group call" entry.
 * Idempotent-ish at the call site via a per-roomId settled guard.
 */
export function appendMissedGroupCallBubble(args: {
  conversationId: string;
  callType:       'voice' | 'video';
  /**
   * Finding #8(a) — stable id for idempotent dedup. The server's
   * `sfu.ring.missed` can REPLAY on reconnect, so the runtime passes
   * `missed-group-<roomId>` here; appendMessage dedups on id so the same
   * missed marker never doubles the Calls log. Omitted (random id) for the
   * host-cancelled-ring call site where each dismissal is distinct.
   */
  stableId?:      string;
  /** Optional server timestamp (ms) for the missed marker. */
  at?:            number;
}): void {
  let id: string;
  if (args.stableId) {
    id = args.stableId;
  } else {
    const c = (globalThis as {crypto?: {getRandomValues?: (a: Uint8Array) => Uint8Array}}).crypto;
    let suffix: string;
    if (c?.getRandomValues) {
      const b = new Uint8Array(4);
      c.getRandomValues(b);
      suffix = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    } else {
      suffix = Math.random().toString(36).slice(2, 10);
    }
    id = `gc_${Date.now().toString(36)}_${suffix}`;
  }
  const msg: LocalMessage = {
    id,
    conversation_id: args.conversationId,
    sender_id:       'self',
    type:            'call',
    content:         '',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      new Date(args.at ?? Date.now()).toISOString(),
    peer:            {userId: 'group-call', deviceId: 0},
    call_meta: {
      kind:      args.callType,
      direction: 'incoming',
      outcome:   'missed',
      duration:  0,
      groupCall: true,
    },
  };
  useMessengerStore.getState().appendMessage(args.conversationId, msg);
}

// Helper used by the floating overlay's hangup path. Re-exported so
// FloatingCallOverlay doesn't need to import groupCallRegistry directly.
export {endActiveGroupCall};
