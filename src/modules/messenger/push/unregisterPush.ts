/**
 * P0-N2 — server-side push-token revocation on logout.
 *
 * Without this, the previous user's FCM token + iOS PushKit token stay
 * registered against their userId on messenger-service. When the next
 * user signs in on the same physical device, the OS hands out the same
 * FCM token; until that user re-runs `/push/register*`, EVERY chat-wake
 * and VoIP-wake sent to the OLD userId hits the NEW user's lock screen.
 *
 * Best-effort: every call is wrapped in try/catch because the only
 * thing worse than a stale push token is a logout flow that hangs
 * trying to talk to a relay that's offline. Both DELETEs hit
 * `/push/register*` which are JWT-gated; we send the still-valid
 * access token sourced from AsyncStorage at the moment of signOut.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {MSG_BASE_URL} from '@utils/constants';

const DELETE_TIMEOUT_MS = 4_000;

async function deleteWithTimeout(path: string, accessToken: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DELETE_TIMEOUT_MS);
  try {
    await fetch(`${MSG_BASE_URL}${path}`, {
      method: 'DELETE',
      headers: {
        Authorization:        `Bearer ${accessToken}`,
        'X-Signal-Device-Id': '1',
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function revokeServerPushTokens(): Promise<void> {
  const access = await AsyncStorage.getItem('auth:access_token').catch(() => null);
  if (!access) {return;}
  await Promise.allSettled([
    deleteWithTimeout('/push/register',      access),
    deleteWithTimeout('/push/register-voip', access),
  ]);
}
