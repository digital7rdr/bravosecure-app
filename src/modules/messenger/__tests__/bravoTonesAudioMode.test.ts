/**
 * bravoTones must pin expo-av's Android audio mode BEFORE playing each
 * tone: expo-av re-applies setSpeakerphoneOn(!playThroughEarpieceAndroid)
 * on every audio-session touch (play / focus change / unload), which
 * clobbered InCallManager's in-call routing — the device sat on
 * loudspeaker while the call UI said earpiece. Voice ringback must run
 * through the earpiece; ringtone always through the speaker.
 */

const mockSetAudioModeAsync = jest.fn(async (..._args: unknown[]) => undefined);
const mockCreateAsync = jest.fn(async (..._args: unknown[]) => ({
  sound: {
    stopAsync: jest.fn(async () => undefined),
    unloadAsync: jest.fn(async () => undefined),
  },
}));

jest.mock('expo-av', () => ({
  Audio: {
    setAudioModeAsync: (...a: unknown[]) => mockSetAudioModeAsync(...a),
    Sound: {createAsync: (...a: unknown[]) => mockCreateAsync(...a)},
  },
}));

jest.mock('../../../../assets/ringback.wav', () => 1, {virtual: true});
jest.mock('../../../../assets/ringtone.wav', () => 2, {virtual: true});

import {startRingback, startRingtone, stopAllTones} from '../runtime/bravoTones';

describe('bravoTones audio mode', () => {
  beforeEach(async () => {
    await stopAllTones();
    mockSetAudioModeAsync.mockClear();
    mockCreateAsync.mockClear();
  });

  it('voice ringback pins playThroughEarpieceAndroid=true before playing', async () => {
    await startRingback(true);
    expect(mockSetAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({playThroughEarpieceAndroid: true}),
    );
    expect(mockSetAudioModeAsync.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateAsync.mock.invocationCallOrder[0],
    );
  });

  it('video ringback uses the speaker (playThroughEarpieceAndroid=false)', async () => {
    await startRingback(false);
    expect(mockSetAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({playThroughEarpieceAndroid: false}),
    );
  });

  it('ringback defaults to speaker when no argument is given', async () => {
    await startRingback();
    expect(mockSetAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({playThroughEarpieceAndroid: false}),
    );
  });

  it('ringtone always plays through the speaker', async () => {
    await startRingtone();
    expect(mockSetAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({playThroughEarpieceAndroid: false}),
    );
  });
});
