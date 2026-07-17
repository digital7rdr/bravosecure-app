/**
 * JS bridge to the native CallForegroundService (Kotlin).
 *
 * Why: Android 14+ kills mic/camera capture seconds after the activity
 * loses window focus (screen off, app backgrounded). Without a
 * foreground service holding the right typed permissions, calls
 * silently die when the user locks the phone. WhatsApp/Signal/Telegram
 * all run a foreground service for active calls — this is parity.
 *
 * Lifecycle:
 *   • startCallForegroundService({kind, peer}) — call on call mount
 *     (after the user accepts / after outgoing offer is sent). Posts
 *     the persistent notification + flips the service to FOREGROUND
 *     with FOREGROUND_SERVICE_TYPE_MICROPHONE (+ CAMERA when video).
 *   • stopCallForegroundService() — call on call unmount, but ONLY
 *     when the call is truly ending (not minimized). The
 *     FloatingCallOverlay path keeps the call alive across navigation,
 *     so we leave the service running until the registry actually
 *     clears.
 *
 * iOS is a no-op — CallKit-style background execution lives in a
 * separate path (out of scope for this fix).
 */
import {DeviceEventEmitter, NativeModules, Platform} from 'react-native';

interface CallForegroundNative {
  start: (opts: {kind: 'voice' | 'video'; peer: string}) => void;
  stop:  () => void;
}

const native: CallForegroundNative | null =
  Platform.OS === 'android' && (NativeModules as Record<string, unknown>).BravoCallForeground
    ? (NativeModules as unknown as {BravoCallForeground: CallForegroundNative}).BravoCallForeground
    : null;

let active = false;

// B-64: the FGS notification's "Hang up" action. The native side has already
// stopped the service + dismissed the notification (so a dead JS runtime can
// never strand it); here we end the call for real — send call.hangup, stop
// InCallManager, clear the registry slot. Lazy requires: callRegistry
// require()s this module, a static import would cycle.
if (native) {
  DeviceEventEmitter.addListener('bravoCallFgHangup', () => {
    active = false;
    console.log('[bravo.callfg] hangup action from FGS notification');
    try {
      const reg = require('./callRegistry') as typeof import('./callRegistry');
      reg.endActiveCall('ended', 'local');
    } catch (e) {
      console.warn('[bravo.callfg] 1:1 hangup handling failed:', (e as Error).message);
    }
    try {
      const greg = require('./groupCallRegistry') as typeof import('./groupCallRegistry');
      void greg.endActiveGroupCall();
    } catch (e) {
      console.warn('[bravo.callfg] group hangup handling failed:', (e as Error).message);
    }
  });
}

export function startCallForegroundService(opts: {kind: 'voice' | 'video'; peer: string}): void {
  if (!native) {
    console.log('[bravo.callfg] native module unavailable (iOS or unbuilt) — no-op');
    return;
  }
  try {
    native.start(opts);
    active = true;
    console.log(`[bravo.callfg] service started kind=${opts.kind} peer=${opts.peer}`);
  } catch (e) {
    // Caught: missing notification permission on API 33+, etc.
    // We never throw out of this path — the call should still proceed
    // even if the OS is going to suspend it later.
    console.warn('[bravo.callfg] start failed:', (e as Error).message);
  }
}

export function stopCallForegroundService(): void {
  if (!native || !active) {return;}
  try {
    native.stop();
    active = false;
    console.log('[bravo.callfg] service stopped');
  } catch (e) {
    console.warn('[bravo.callfg] stop failed:', (e as Error).message);
  }
}

export function isCallForegroundActive(): boolean {
  return active;
}
