/**
 * HTTP relay client — talks to messenger-service :3100. Polled (no
 * socket.io for now). Every call carries:
 *   - Authorization: Bearer <messenger ticket>   (5-min JWT)
 *   - X-Signal-Device-Id: <number>               (relay keys per-device queues)
 *
 * Audit fix 0.4 — was reading bravo_ops_token from localStorage; now
 * uses a short-lived ticket fetched from /auth/messenger-ticket via the
 * cookie-authenticated session. The ticket lives in memory only.
 */

import type {SessionAddress} from '@bravo/messenger-core';
import {getMessengerTicket} from '@/lib/api';

// Honour BOTH env names: the staging compose sets NEXT_PUBLIC_MSG_BASE_URL,
// while local/dev uses the longer NEXT_PUBLIC_MESSENGER_BASE_URL. Reading only
// the long name left the relay pointing at localhost:3100 in the deployed
// build → CSP blocked it → "pull HTTP failed: Failed to fetch". Mirrors
// middleware.ts's resolution order.
// Audit AUTH-07 — warn loudly on a misconfigured prod build instead of
// silently pointing the relay at localhost. NOT a throw: module-load code
// reachable from the root layout, so a throw would crash the whole console.
const RELAY_BASE =
  process.env.NEXT_PUBLIC_MESSENGER_BASE_URL ??
  process.env.NEXT_PUBLIC_MSG_BASE_URL ??
  (() => {
    if (process.env.NODE_ENV === 'production' && typeof console !== 'undefined') {
      console.error('[relay] NEXT_PUBLIC_MESSENGER_BASE_URL / NEXT_PUBLIC_MSG_BASE_URL not set in a production build — falling back to localhost:3100.');
    }
    return 'http://localhost:3100';
  })();

async function headers(deviceId: number): Promise<HeadersInit> {
  const token = await getMessengerTicket();
  return {
    'Content-Type':       'application/json',
    Authorization:        `Bearer ${token}`,
    'X-Signal-Device-Id': String(deviceId),
  };
}

async function call<T>(path: string, deviceId: number, init?: RequestInit): Promise<T> {
  const res = await fetch(`${RELAY_BASE}${path}`, {
    ...init,
    headers: {...(await headers(deviceId)), ...(init?.headers ?? {})},
    cache:   'no-store',
  });
  // Auto-refresh ticket once on 401 (covers exp at the boundary of a long
  // poll). One retry only — if the second 401 comes back the cookie
  // session itself is gone and the caller will see the error.
  if (res.status === 401) {
    const fresh = await getMessengerTicket(true);
    const retry = await fetch(`${RELAY_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type':       'application/json',
        Authorization:        `Bearer ${fresh}`,
        'X-Signal-Device-Id': String(deviceId),
        ...(init?.headers ?? {}),
      },
      cache: 'no-store',
    });
    if (retry.status === 204) return undefined as never;
    if (!retry.ok) {
      const text = await retry.text();
      throw new Error(`relay ${path} ${retry.status}: ${text}`);
    }
    return retry.json() as Promise<T>;
  }
  if (res.status === 204) return undefined as never;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`relay ${path} ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface StoredEnvelope {
  envelopeId:    string;
  recipient:     {userId: string; deviceId: number};
  /** Sealed Sender v2 outer ECIES wrap (base64). */
  outerSealed:   string;
  clientMsgId?:  string;
  timestamp:     number;       // server-assigned ms epoch
  expiresAtSec?: number;
}

export const relay = {
  send: (
    deviceId: number,
    body: {
      recipient:    SessionAddress;
      /** Sealed Sender v2 outer ECIES wrap (base64). */
      outerSealed:  string;
      clientMsgId?: string;
      expiresAtSec?: number;
    },
  ) =>
    call<{envelopeId: string; clientMsgId?: string; deliveredNow: boolean}>(
      '/envelopes', deviceId,
      {method: 'POST', body: JSON.stringify(body)},
    ),

  pull: (deviceId: number, after?: number, limit = 50) => {
    const qs = new URLSearchParams();
    if (after != null) qs.set('after', String(after));
    qs.set('limit', String(limit));
    return call<{envelopes: StoredEnvelope[]}>(
      `/envelopes?${qs.toString()}`, deviceId,
    );
  },

  ack: (deviceId: number, envelopeId: string) =>
    call<void>(`/envelopes/${envelopeId}/ack`, deviceId, {method: 'POST'}),
};
