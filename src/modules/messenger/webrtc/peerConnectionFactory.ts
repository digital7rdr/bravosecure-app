/**
 * Real RTCPeerConnection factory using `react-native-webrtc`.
 *
 * The WebRTC stack in this module was designed factory-first so the
 * tests could inject a fake. This file wires the production factory.
 *
 * All native imports live here; the orchestrator (CallController) and
 * everything above it stay dependency-free so unit tests keep running
 * in node-jest without a native module.
 */
import {Platform, PermissionsAndroid} from 'react-native';
import {
  RTCPeerConnection,
  mediaDevices,
  type MediaStream,
  type MediaStreamTrack,
} from 'react-native-webrtc';
import type {PeerConnectionFactory, PeerConnectionLike} from './types';

export const rtcPeerConnectionFactory: PeerConnectionFactory =
  (cfg) => new RTCPeerConnection(cfg) as unknown as PeerConnectionLike;

/**
 * Acquire local audio (always) + video (if requested) tracks. Camera
 * defaults to the front-facing lens — the call UI exposes a flip
 * button that swaps the video track in place.
 */
export async function getLocalMedia(opts: {video: boolean}): Promise<{
  stream: MediaStream;
  audioTrack: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
}> {
  // Round 7 / WebRTC audit fix W3 — request Android runtime permissions
  // BEFORE calling getUserMedia. Previously the two ran in parallel:
  // mediaDevices.getUserMedia({video:true}) opened the camera while
  // PermissionsAndroid was still showing the prompt. On a first-tap
  // video call this raced — the OS rejected the camera because
  // permission hadn't resolved yet, the call landed in 'failed', and
  // the user had to retry to get past the prompt. Awaiting the prompt
  // up front makes the second-tap-required pattern go away.
  if (Platform.OS === 'android') {
    const need: Array<keyof typeof PermissionsAndroid.PERMISSIONS> = ['RECORD_AUDIO'];
    if (opts.video) {need.push('CAMERA');}
    try {
      const perms = need.map(k => PermissionsAndroid.PERMISSIONS[k]);
      // requestMultiple resolves AFTER the user has dismissed every
      // dialog, including denials — getUserMedia will then surface a
      // proper "permission denied" rather than the racing-prompt
      // "device not available" error.
      await PermissionsAndroid.requestMultiple(perms);
    } catch {
      // PermissionsAndroid throws on unsupported APIs only; let
      // getUserMedia surface the actual error.
    }
  }

  // Bias the camera toward 480p@30 as the IDEAL, not the floor. Without
  // explicit constraints RN-WebRTC defaults to whatever the camera's
  // top mode is (often 1080p@30 on modern phones) — that pegs the
  // encoder at ~2 Mbps and freezes hard the moment the link drops to
  // 3G speeds. 480p is what WhatsApp/FaceTime ship as the "good cell"
  // baseline; the encoder still down-scales to 240p on bad links via
  // the maintain-framerate policy set in useCall.attachLocalMedia.
  // Tag for logcat: [bravo.callquality].
  const constraints: Record<string, unknown> = {
    // BS-CALL-ECHO (reverted) — use the bare `audio: true` constraint.
    // Why: the detailed object form (echoCancellation:true + a legacy
    // `mandatory: { goog* }` block) was added to force AEC on for the few
    // answerers who opened the mic without it. But mixing the spec-style
    // booleans with the legacy goog `mandatory` object trips a constraint-
    // parse path in react-native-webrtc on many Android builds, which then
    // falls back to opening the mic with NO audio-processing module at all
    // — AEC OFF for EVERYONE. That's the regression where the caller hears
    // their own voice looped back. Plain `audio: true` lets the platform
    // apply its default APM (AEC + NS + AGC), which is what worked before.
    // If the original answerer-no-AEC edge case resurfaces, fix it with the
    // spec booleans ONLY (no `mandatory` goog block), not this mixed shape.
    audio: true,
    video: opts.video ? {
      facingMode: 'user',
      width:      {ideal: 640,  max: 1280},
      height:     {ideal: 480,  max: 720},
      frameRate:  {ideal: 30,   max: 30},
    } : false,
  };
  const stream = await mediaDevices.getUserMedia(constraints);
  const tracks = stream.getTracks();
  const audioTrack = tracks.find(t => t.kind === 'audio') ?? null;
  const videoTrack = tracks.find(t => t.kind === 'video') ?? null;
  console.log(`[bravo.callquality] getLocalMedia video=${opts.video} tracks=${tracks.map(t => t.kind).join(',')}`);
  return {stream, audioTrack, videoTrack};
}

/**
 * Swap the camera in place by stopping the existing video track and
 * acquiring a new one with the opposite facing mode. The new track
 * is added to the same RTCRtpSender so the SDP doesn't have to
 * renegotiate — only the source upstream of the encoder changes.
 *
 * Optional `localStream` parameter: if provided, the helper will
 * remove the previous video track from the stream and add the new one
 * before returning. This keeps any RTCView pinned to that stream
 * showing the live camera instead of the now-stopped previous track.
 * Without it, callers had to rebuild the MediaStream by hand AND set
 * a new state, which was easy to forget and produced the "PiP frozen
 * on last frame" symptom.
 */
export async function flipCamera(args: {
  pc: PeerConnectionLike;
  currentTrack: MediaStreamTrack | null;
  facing: 'user' | 'environment';
  localStream?: MediaStream;
}): Promise<MediaStreamTrack | null> {
  const next = args.facing === 'user' ? 'environment' : 'user';
  const fresh = await mediaDevices.getUserMedia({audio: false, video: {facingMode: next}});
  const newTrack = fresh.getVideoTracks()[0] ?? null;
  if (!newTrack) {return null;}

  // Replace the sender's track if present — keeps SDP / SRTP untouched.
  const senders = (args.pc as unknown as {getSenders?: () => Array<{track: MediaStreamTrack | null; replaceTrack: (t: MediaStreamTrack) => Promise<void>}>}).getSenders?.() ?? [];
  const videoSender = senders.find(s => s.track?.kind === 'video');
  if (videoSender) {await videoSender.replaceTrack(newTrack);}

  // Splice the new track into the local MediaStream so RTCView
  // attached to that stream picks up the new camera without the
  // caller having to rebuild the stream by hand. Order: add new
  // track first, then stop+remove the old one — minimises the
  // window where the stream has zero video tracks.
  if (args.localStream) {
    try {
      args.localStream.addTrack(newTrack);
      const oldVideo = args.localStream.getVideoTracks().find(t => t.id !== newTrack.id);
      if (oldVideo) { try { args.localStream.removeTrack(oldVideo); } catch { /* ignore */ } }
    } catch { /* RN-WebRTC quirks — fall through to caller-managed stream */ }
  }

  if (args.currentTrack) {try { args.currentTrack.stop(); } catch { /* ignore */ }}
  return newTrack;
}

/**
 * B-20 — re-acquire the camera after another app grabbed it mid-call.
 *
 * When the OS hands the camera to a foreground camera app, our capture
 * track ends or mutes; on return the encoder keeps "sending" null frames
 * (the magenta/black tile) and there is no `onCameraDisconnected` to hook.
 * Same mechanism as `flipCamera` (acquire a fresh track + `replaceTrack`
 * onto the EXISTING video sender, so SDP/SRTP — and any FrameCryptor
 * transform attached to that sender — stay untouched) but KEEPS the
 * current facing instead of flipping it.
 *
 * Returns the new track (caller updates its ref + local PiP stream), or
 * null when there is no video sender (audio-only call) or acquisition
 * fails (e.g. the other app is still holding the camera — the resume
 * handler simply retries on the next foreground).
 */
export async function recoverCamera(args: {
  pc: PeerConnectionLike;
  facing: 'user' | 'environment';
  currentTrack: MediaStreamTrack | null;
  localStream?: MediaStream;
}): Promise<MediaStreamTrack | null> {
  // Only meaningful when a video sender exists. A dead/muted capture
  // track keeps its `kind: 'video'` so the sender is still findable.
  const senders = (args.pc as unknown as {getSenders?: () => Array<{track: MediaStreamTrack | null; replaceTrack: (t: MediaStreamTrack) => Promise<void>}>}).getSenders?.() ?? [];
  const videoSender = senders.find(s => s.track?.kind === 'video');
  if (!videoSender) {return null;}

  const fresh = await mediaDevices.getUserMedia({audio: false, video: {facingMode: args.facing}});
  const newTrack = fresh.getVideoTracks()[0] ?? null;
  if (!newTrack) {return null;}

  await videoSender.replaceTrack(newTrack);

  if (args.localStream) {
    try {
      args.localStream.addTrack(newTrack);
      const oldVideo = args.localStream.getVideoTracks().find(t => t.id !== newTrack.id);
      if (oldVideo) { try { args.localStream.removeTrack(oldVideo); } catch { /* ignore */ } }
    } catch { /* RN-WebRTC quirks — caller rebuilds the stream from state */ }
  }

  if (args.currentTrack) {try { args.currentTrack.stop(); } catch { /* ignore */ }}
  return newTrack;
}

/**
 * B-20 (group) — re-acquire the camera after another app grabbed it mid
 * group-call. Same intent as `recoverCamera`, but the group path sends
 * through a mediasoup Producer, not a raw RTCRtpSender.
 *
 * `producer.replaceTrack({track})` swaps the source upstream of the
 * encoder while keeping the SAME underlying RTCRtpSender — so the SFrame
 * FrameCryptor transform attached to that sender stays in place and the
 * recovered video remains E2E-encrypted. Do NOT close + recreate the
 * producer here: that path (useGroupCall.toggleVideo's fresh-camera
 * branch) must re-attach the encryptor and risks a plaintext-video window
 * — a security stop-condition.
 *
 * Returns the new track (caller updates its ref + local PiP stream), or
 * null when there is no producer or acquisition fails (e.g. the other app
 * is still holding the camera — the resume handler retries on the next
 * foreground).
 */
export async function recoverGroupCamera(args: {
  producer: {replaceTrack: (a: {track: MediaStreamTrack}) => Promise<void>} | null;
  facing: 'user' | 'environment';
  currentTrack: MediaStreamTrack | null;
}): Promise<MediaStreamTrack | null> {
  if (!args.producer) {return null;}
  const fresh = await mediaDevices.getUserMedia({audio: false, video: {facingMode: args.facing}});
  const newTrack = fresh.getVideoTracks()[0] ?? null;
  if (!newTrack) {return null;}
  // Keeps the same RTCRtpSender → same SFrame transform → still encrypted.
  await args.producer.replaceTrack({track: newTrack});
  if (args.currentTrack) {try { args.currentTrack.stop(); } catch { /* ignore */ }}
  return newTrack;
}

export type {MediaStream, MediaStreamTrack} from 'react-native-webrtc';
export {RTCView} from 'react-native-webrtc';
