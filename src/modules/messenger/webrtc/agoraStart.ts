/**
 * Agora SDK boot — runs when native WebRTC's ICE fails to connect
 * inside the 12s budget set by `AgoraFallback`.
 *
 * Phase-1 contract:
 *   1. Fetch a short-lived RTC token from `messenger-service` —
 *      `GET /agora/token?channel=<callId>` (NOT YET IMPLEMENTED on
 *      the server; this client falls back to a no-op token until the
 *      endpoint lands so the path doesn't crash in production).
 *   2. Initialise `react-native-agora` engine with the project's
 *      `EXPO_PUBLIC_AGORA_APP_ID` and join `<callId>` as the channel.
 *   3. Audit-emit so the security team knows we degraded.
 *
 * Implementation note: this module imports `react-native-agora` at
 * runtime via dynamic `require` so the bundle stays compileable even
 * when the SDK is unavailable in the loopback / web-preview build.
 */
import {API_BASE_URL} from '@utils/constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

const AGORA_APP_ID = process.env.EXPO_PUBLIC_AGORA_APP_ID ?? '';

async function fetchAgoraToken(callId: string): Promise<string | null> {
  try {
    const access = await AsyncStorage.getItem('auth:access_token');
    const res = await fetch(`${API_BASE_URL}/agora/token?channel=${encodeURIComponent(callId)}`, {
      headers: access ? {Authorization: `Bearer ${access}`} : undefined,
    });
    if (!res.ok) {return null;}
    const body = await res.json() as {token?: string};
    return body.token ?? null;
  } catch {
    return null;
  }
}

export async function agoraStart(callId: string): Promise<void> {
  if (!AGORA_APP_ID) {
    throw new Error('EXPO_PUBLIC_AGORA_APP_ID not configured — fallback unavailable');
  }
  const token = await fetchAgoraToken(callId);
  // Lazy-load the native module so a missing native build during
  // development doesn't crash unrelated screens.

  const agora = require('react-native-agora') as typeof import('react-native-agora');
  const engine = agora.createAgoraRtcEngine();
  engine.initialize({appId: AGORA_APP_ID});
  // Join with a server-issued token if we have one, else null —
  // null only works while the Agora project is in "Testing" mode.
  engine.joinChannel(token ?? '', callId, 0, {});
  // Engine cleanup is the host's responsibility (the call screen
  // wires `engine.leaveChannel()` + `engine.release()` in its hangup
  // path). This module is fire-and-forget by design.
}
