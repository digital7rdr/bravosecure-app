/**
 * Bravo-shipped call tones.
 *
 * Why we don't use InCallManager.startRingtone/Ringback('_DEFAULT_'):
 * the library resolves '_DEFAULT_' to `Settings.System.DEFAULT_RINGTONE_URI`
 * and reads it via `MediaPlayer.setDataSource(ContentResolver, uri)`.
 * On Android 14 + some OEM Pixels (incl. our test Pixel 6a) the
 * default URI's content provider answers the openTypedAssetFile call
 * with FileNotFoundException. The library swallows this silently and
 * the user hears nothing while a call is ringing — observed in logcat:
 *
 *   W MediaPlayer: Error setting data source via ContentResolver
 *   W MediaPlayer: java.io.FileNotFoundException: open failed: ENOENT
 *     at com.zxcpoiu.incallmanager.InCallManagerModule$myMediaPlayer.startPlay
 *
 * Fix: ship our own WAV assets (assets/ringback.wav for outgoing,
 * assets/ringtone.wav for incoming) and play them via expo-av's
 * `Audio.Sound`. This sidesteps both the broken URI resolver AND the
 * audio-stream confusion (InCallManager routes ringtones via
 * MODE_IN_COMMUNICATION which on some BT stacks defaults to a
 * whispered earpiece volume).
 *
 * expo-av is already a dep (used by VoiceNoteRecorder). On iOS the
 * same path works — Audio.Sound respects Audio.setAudioModeAsync's
 * `playsInSilentModeIOS` so the tone plays even with the ringer
 * switch off, matching the Telephony app behaviour.
 */
import {Audio} from 'expo-av';

/**
 * Fix #13: replace the dual-boolean (`ringback` + `ringbackBusy`)
 * pair with an explicit state machine. Two booleans encode FOUR
 * states (00, 01, 10, 11) but only THREE are legal — the fourth
 * (`ringback != null && ringbackBusy === true`, "loaded but mid-
 * load") is unreachable in normal flow but easy to drift into
 * under rapid start/stop racing (user mashes accept-then-decline,
 * or a network glitch fires both `call.answer` and `call.hangup`
 * inside one frame). The state machine makes every transition
 * explicit and rejects illegal ones.
 */
type ToneState = 'idle' | 'starting' | 'started' | 'stopping';

interface ToneSlot {
  state: ToneState;
  sound: Audio.Sound | null;
}

const ringbackSlot: ToneSlot = {state: 'idle', sound: null};
const ringtoneSlot: ToneSlot = {state: 'idle', sound: null};

const RINGBACK_ASSET = require('../../../../assets/ringback.wav');
const RINGTONE_ASSET = require('../../../../assets/ringtone.wav');

async function startSlot(
  slot: ToneSlot,
  asset: number,
  volume: number,
  label: string,
  throughEarpiece: boolean,
): Promise<void> {
  // Only 'idle' can transition to 'starting'. 'starting' or 'started'
  // means a previous call already covered us; 'stopping' means we're
  // mid-tear-down and starting again would race the unload.
  if (slot.state !== 'idle') {return;}
  slot.state = 'starting';
  try {
    // Why: expo-av re-applies setSpeakerphoneOn(!playThroughEarpieceAndroid)
    // every time it touches the audio session (play, focus changes, unload),
    // clobbering InCallManager's in-call routing — the device ended on
    // loudspeaker while the UI said earpiece. Setting the mode to match the
    // call's desired route BEFORE playing means every re-apply lands on the
    // same route the call wants, so there is nothing to clobber.
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: throughEarpiece,
    });
    const {sound} = await Audio.Sound.createAsync(
      asset, {shouldPlay: true, isLooping: true, volume},
    );
    // Race guard: if `stop` was called while we were awaiting the
    // load, the slot is now 'stopping' (or 'idle' after a hard reset).
    // Don't claim ownership of the freshly-loaded sound — unload it.
    if (slot.state !== 'starting') {
      try { await sound.unloadAsync(); } catch { /* ignore */ }
      return;
    }
    slot.sound = sound;
    slot.state = 'started';
    console.log(`[bravo.tones] ${label} started`);
  } catch (e) {
    slot.state = 'idle';
    console.warn(`[bravo.tones] ${label} failed:`, (e as Error).message);
  }
}

async function stopSlot(slot: ToneSlot, label: string): Promise<void> {
  // Idle → no-op. Starting → mark stopping; the in-flight `start`
  // sees the changed state on resolve and unloads itself. Started →
  // tear down now. Stopping → already in progress; skip.
  if (slot.state === 'idle') {return;}
  if (slot.state === 'stopping') {return;}
  if (slot.state === 'starting') {
    slot.state = 'stopping';
    return; // start handler will unload the sound when it resolves
  }
  // 'started'
  slot.state = 'stopping';
  const s = slot.sound;
  slot.sound = null;
  try { await s?.stopAsync(); } catch { /* ignore */ }
  try { await s?.unloadAsync(); } catch { /* ignore */ }
  slot.state = 'idle';
  console.log(`[bravo.tones] ${label} stopped`);
}

/**
 * Outgoing-call ringback. Plays a 440+480 Hz dual tone (1s on, 3s off
 * cycle). Looped until stopRingback().
 *
 * `throughEarpiece` — pass true for VOICE calls (the caller is holding
 * the phone to their ear, like the system dialer) and false for VIDEO
 * calls (phone held in front, speaker is correct).
 */
export async function startRingback(throughEarpiece = false): Promise<void> {
  await startSlot(ringbackSlot, RINGBACK_ASSET, 0.85, 'ringback', throughEarpiece);
}

export async function stopRingback(): Promise<void> {
  await stopSlot(ringbackSlot, 'ringback');
}

/**
 * Incoming-call ringtone. Plays an 800+1000 Hz alert pattern (0.4s on,
 * 0.2s off, repeat) which is louder + more attention-grabbing than the
 * default ringback. Looped until stopRingtone().
 */
export async function startRingtone(): Promise<void> {
  // Ringtone always through the loudspeaker — an incoming call must be
  // audible from across the room.
  await startSlot(ringtoneSlot, RINGTONE_ASSET, 1.0, 'ringtone', false);
}

export async function stopRingtone(): Promise<void> {
  await stopSlot(ringtoneSlot, 'ringtone');
}

/**
 * Emergency stop everything — used on call.end / app-background to
 * avoid runaway tones if a normal stop missed for any reason.
 */
export async function stopAllTones(): Promise<void> {
  await Promise.all([stopRingback(), stopRingtone()]);
}
