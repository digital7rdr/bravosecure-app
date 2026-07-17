/**
 * B-20 — `recoverCamera` re-acquires the camera (keeping the CURRENT
 * facing) and replaceTrack()s it onto the existing video sender, so a
 * mid-call camera theft (another app grabbed the device) heals on resume
 * with no SDP renegotiation. The native getUserMedia + RTCPeerConnection
 * are mocked; this pins the sender-selection + facing + stream-swap rules
 * that can't be exercised on BlueStacks (which reports the stolen track as
 * 'live').
 */

jest.mock('react-native', () => ({
  Platform:           {OS: 'android', Version: 31},
  PermissionsAndroid: {PERMISSIONS: {RECORD_AUDIO: 'a', CAMERA: 'c'}, requestMultiple: jest.fn(async () => ({}))},
}));

const mockGetUserMedia = jest.fn();
jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: class {},
  mediaDevices:      {getUserMedia: (...a: unknown[]) => mockGetUserMedia(...a)},
  RTCView:           () => null,
}));

import {recoverCamera} from '../webrtc/peerConnectionFactory';

type FakeTrack = {kind: 'audio' | 'video'; id: string; readyState: string; stop: jest.Mock};
function track(kind: 'audio' | 'video', id: string, readyState = 'live'): FakeTrack {
  return {kind, id, readyState, stop: jest.fn()};
}

function fakePc(senders: Array<{track: FakeTrack | null; replaceTrack: jest.Mock}>) {
  return {getSenders: () => senders} as never;
}

function freshStreamWith(videoTrack: FakeTrack | null) {
  return {getVideoTracks: () => (videoTrack ? [videoTrack] : [])};
}

beforeEach(() => { mockGetUserMedia.mockReset(); });

describe('recoverCamera — B-20 camera-loss recovery', () => {
  test('no video sender (audio-only call) → returns null and never opens the camera', async () => {
    const pc = fakePc([{track: track('audio', 'a1'), replaceTrack: jest.fn()}]);
    const out = await recoverCamera({pc, facing: 'user', currentTrack: null});
    expect(out).toBeNull();
    expect(mockGetUserMedia).not.toHaveBeenCalled();
  });

  test('replaces the dead track on the existing video sender, keeping facing', async () => {
    const dead    = track('video', 'old', 'ended');
    const replace = jest.fn(async () => undefined);
    const pc = fakePc([
      {track: track('audio', 'a1'), replaceTrack: jest.fn()},
      {track: dead,                 replaceTrack: replace},
    ]);
    const newTrack = track('video', 'new');
    mockGetUserMedia.mockResolvedValue(freshStreamWith(newTrack));

    const out = await recoverCamera({pc, facing: 'environment', currentTrack: dead});

    // Acquired with the SAME facing (not flipped), audio off.
    expect(mockGetUserMedia).toHaveBeenCalledWith({audio: false, video: {facingMode: 'environment'}});
    // Swapped onto the existing sender — no renegotiation.
    expect(replace).toHaveBeenCalledWith(newTrack);
    // Old (stolen) track released so the privacy light goes off.
    expect(dead.stop).toHaveBeenCalled();
    expect(out).toBe(newTrack);
  });

  test('splices the new track into the provided localStream and drops the old video track', async () => {
    const dead    = track('video', 'old', 'ended');
    const pc = fakePc([{track: dead, replaceTrack: jest.fn(async () => undefined)}]);
    const newTrack = track('video', 'new');
    mockGetUserMedia.mockResolvedValue(freshStreamWith(newTrack));

    const oldVideo = track('video', 'old');
    const addTrack = jest.fn();
    const removeTrack = jest.fn();
    const localStream = {
      addTrack,
      removeTrack,
      getVideoTracks: () => [oldVideo],
    } as never;

    await recoverCamera({pc, facing: 'user', currentTrack: dead, localStream});
    expect(addTrack).toHaveBeenCalledWith(newTrack);
    expect(removeTrack).toHaveBeenCalledWith(oldVideo);
  });

  test('getUserMedia returns no video track → returns null (no crash)', async () => {
    const dead = track('video', 'old', 'ended');
    const pc = fakePc([{track: dead, replaceTrack: jest.fn()}]);
    mockGetUserMedia.mockResolvedValue(freshStreamWith(null));
    const out = await recoverCamera({pc, facing: 'user', currentTrack: dead});
    expect(out).toBeNull();
  });
});
