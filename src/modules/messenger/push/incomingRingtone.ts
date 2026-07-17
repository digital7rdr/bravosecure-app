/**
 * JS bridge for BravoRingtoneModule — plays the DEVICE-DEFAULT ringtone
 * (RingtoneManager.TYPE_RINGTONE) for an incoming call, WhatsApp-style.
 *
 * Why this exists (call-UI parity plan §4 / docs/planning/CALL_UI_WHATSAPP_PARITY.md):
 *   - the notifee channel `sound: 'default'` plays the short NOTIFICATION
 *     chime, not the user's ringtone;
 *   - our Telecom ConnectionService is selfManaged, so the OS never rings
 *     for us — the app owns ring audio.
 *
 * Contract:
 *   - start is bounded NATIVELY (the module auto-stops after RING_TIMEOUT_MS)
 *     because the killed-app headless JS context that starts the ring can die
 *     before any JS stop fires — see PUSH-B5.
 *   - stop is called from the single dismiss funnel (dismissCallNotif), which
 *     every exit path already routes through: accept, decline, remote hangup,
 *     slim killed-app tap handler.
 *   - Missing native module (old APK / iOS / tests) degrades to a silent
 *     no-op — the notification card + vibration still work.
 */
import {NativeModules, Platform} from 'react-native';

/** Must match the ring notification's `timeoutAfter` (PUSH-B5, 45s). */
export const RING_TIMEOUT_MS = 45_000;

interface BravoRingtoneNative {
  start(callId: string, timeoutMs: number): void;
  stop(callId: string | null): void;
}

function native(): BravoRingtoneNative | null {
  if (Platform.OS !== 'android') {return null;}
  const mod = (NativeModules as Record<string, unknown>).BravoRingtone as BravoRingtoneNative | undefined;
  return mod ?? null;
}

export function startIncomingRingtone(callId: string): void {
  try {
    const mod = native();
    if (!mod) {return;}
    mod.start(callId, RING_TIMEOUT_MS);
    console.log('[bravo.ring] start call=' + callId);
  } catch (e) {
    console.warn('[bravo.ring] start failed:', (e as Error).message);
  }
}

/** callId null = stop whatever is ringing (defensive sweep on logout/teardown). */
export function stopIncomingRingtone(callId: string | null, reason: string): void {
  try {
    const mod = native();
    if (!mod) {return;}
    mod.stop(callId);
    console.log('[bravo.ring] stop reason=' + reason + ' call=' + (callId ?? 'any'));
  } catch (e) {
    console.warn('[bravo.ring] stop failed:', (e as Error).message);
  }
}
